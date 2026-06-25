alter type public.pending_action_type add value if not exists 'batch_create_expenses';

alter table public.expenses drop constraint if exists expenses_source_action_id_key;

create index if not exists expenses_source_action_id_idx
  on public.expenses (source_action_id);

create or replace function public.confirm_batch_create_expenses(
  p_action_id uuid,
  p_line_user_id text,
  p_confirm boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  action_row public.pending_actions%rowtype;
  requester public.users%rowtype;
  expense_item jsonb;
  paid_by_id uuid;
  other_user_id uuid;
  v_expense_id uuid;
  group_id_value uuid;
  notification_group_id uuid;
  amount_twd bigint;
  split_total bigint;
  split_count integer;
  ledger_value public.ledger_type;
  category_value public.expense_category;
  split_method_value public.split_method;
  created_count integer := 0;
begin
  select * into requester from public.users where line_user_id = p_line_user_id;
  if not found then
    return jsonb_build_object('result', 'not_found', 'action_type', null);
  end if;

  select * into action_row
  from public.pending_actions
  where id = p_action_id and requested_by_user_id = requester.id
  for update;
  if not found then
    return jsonb_build_object('result', 'not_found', 'action_type', null);
  end if;
  if action_row.status <> 'pending' then
    return jsonb_build_object('result', 'already_done', 'action_type', action_row.action_type);
  end if;
  if action_row.expires_at <= now() then
    update public.pending_actions set status = 'expired', processed_at = now() where id = action_row.id;
    return jsonb_build_object('result', 'expired', 'action_type', action_row.action_type);
  end if;
  if not p_confirm then
    update public.pending_actions set status = 'cancelled', processed_at = now() where id = action_row.id;
    return jsonb_build_object('result', 'cancelled', 'action_type', action_row.action_type);
  end if;
  if action_row.action_type::text <> 'batch_create_expenses'
    or jsonb_typeof(action_row.payload -> 'items') <> 'array'
    or jsonb_array_length(action_row.payload -> 'items') < 1
    or jsonb_array_length(action_row.payload -> 'items') > 50
  then
    return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type);
  end if;

  for expense_item in select value from jsonb_array_elements(action_row.payload -> 'items')
  loop
    amount_twd := (expense_item ->> 'amount_twd')::bigint;
    paid_by_id := (expense_item ->> 'paid_by_user_id')::uuid;
    ledger_value := (expense_item ->> 'ledger')::public.ledger_type;
    category_value := (expense_item ->> 'category')::public.expense_category;
    split_method_value := coalesce((expense_item ->> 'split_method')::public.split_method, 'equal');
    group_id_value := coalesce(
      nullif(expense_item ->> 'group_id', '')::uuid,
      action_row.group_id,
      (select active_group_id from public.user_preferences where user_id = requester.id)
    );

    if amount_twd not between 1 and 100000000
      or length(expense_item ->> 'description') not between 1 and 100
      or not exists (select 1 from public.users where id = paid_by_id and couple_id = requester.couple_id)
      or (ledger_value = 'private' and paid_by_id <> requester.id)
      or (ledger_value = 'shared' and not exists (
        select 1 from public.groups where id = group_id_value and couple_id = requester.couple_id and archived_at is null
      ))
      or (nullif(expense_item ->> 'receipt_id', '') is not null and not exists (
        select 1 from public.receipts
        where id = (expense_item ->> 'receipt_id')::uuid
          and owner_user_id = requester.id
          and status = 'ready'
          and expense_id is null
      ))
    then
      return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type);
    end if;

    if ledger_value = 'private' then
      group_id_value := null;
      split_total := amount_twd;
      split_count := 1;
    elsif expense_item ? 'splits' then
      select coalesce(sum(value::text::bigint), 0), count(*)
      into split_total, split_count
      from jsonb_each(expense_item -> 'splits');
      if exists (
        select 1 from jsonb_each(expense_item -> 'splits') item
        where item.value::text::bigint < 0
          or not exists (
            select 1 from public.users u
            where u.id = item.key::uuid and u.couple_id = requester.couple_id
          )
      ) then
        return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type);
      end if;
    else
      select id into other_user_id
      from public.users
      where couple_id = requester.couple_id and id <> paid_by_id;
      split_total := amount_twd;
      split_count := 2;
    end if;

    if split_total <> amount_twd
      or (ledger_value = 'shared' and split_count <> 2)
      or (ledger_value = 'private' and split_count <> 1)
    then
      return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type);
    end if;

    insert into public.expenses (
      couple_id, group_id, ledger, description, merchant, notes, category, category_label,
      amount_twd, paid_by_user_id, created_by_user_id, expense_date, split_method, source_action_id
    ) values (
      requester.couple_id, group_id_value, ledger_value, expense_item ->> 'description',
      nullif(expense_item ->> 'merchant', ''), nullif(expense_item ->> 'notes', ''),
      category_value, left(coalesce(nullif(btrim(expense_item ->> 'category_label'), ''), category_value::text), 40),
      amount_twd, paid_by_id, requester.id,
      (expense_item ->> 'expense_date')::date, split_method_value, action_row.id
    ) returning id into v_expense_id;

    if ledger_value = 'private' then
      insert into public.expense_splits values (v_expense_id, requester.id, amount_twd);
    elsif expense_item ? 'splits' then
      insert into public.expense_splits (expense_id, user_id, amount_twd)
      select v_expense_id, key::uuid, value::text::bigint from jsonb_each(expense_item -> 'splits');
      notification_group_id := coalesce(notification_group_id, group_id_value);
    else
      select id into other_user_id
      from public.users
      where couple_id = requester.couple_id and id <> paid_by_id;
      insert into public.expense_splits values
        (v_expense_id, paid_by_id, (amount_twd + 1) / 2),
        (v_expense_id, other_user_id, amount_twd / 2);
      notification_group_id := coalesce(notification_group_id, group_id_value);
    end if;

    if nullif(expense_item ->> 'receipt_id', '') is not null then
      update public.receipts
      set expense_id = v_expense_id, group_id = group_id_value, updated_at = now()
      where id = (expense_item ->> 'receipt_id')::uuid
        and owner_user_id = requester.id
        and expense_id is null;
    end if;

    insert into public.activity_events (
      couple_id, group_id, actor_user_id, entity_type, entity_id, action, after_state
    ) values (
      requester.couple_id, group_id_value, requester.id, 'expense', v_expense_id::text, 'create',
      (select to_jsonb(e) from public.expenses e where e.id = v_expense_id)
    );

    created_count := created_count + 1;
  end loop;

  if created_count = 0 then
    return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type);
  end if;

  update public.pending_actions
  set status = 'confirmed', processed_at = now()
  where id = action_row.id;

  insert into public.notifications (recipient_user_id, group_id, kind, title, body, entity_type, entity_id, dedupe_key)
  select u.id, notification_group_id, 'expense', '共同帳本已更新',
    '另一半新增了一批支出', 'expense', action_row.id::text,
    'batch-create:' || action_row.id::text || ':user:' || u.id::text
  from public.users u
  where u.couple_id = requester.couple_id
    and u.id <> requester.id
    and notification_group_id is not null;

  return jsonb_build_object(
    'result', 'confirmed',
    'action_type', action_row.action_type,
    'created_count', created_count
  );
exception
  when invalid_text_representation or numeric_value_out_of_range or check_violation or foreign_key_violation then
    return jsonb_build_object(
      'result', 'stale',
      'action_type', coalesce(action_row.action_type::text, null)
    );
end;
$$;

revoke all on function public.confirm_batch_create_expenses(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.confirm_batch_create_expenses(uuid, text, boolean) to service_role;
