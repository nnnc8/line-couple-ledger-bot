-- Tag system migration: replace category enum + category_label with free-form tag
-- Idempotent: safe to run multiple times

-- 1. Add tag column to expenses
alter table public.expenses add column if not exists tag text;

-- 2. Backfill tag from category_label / category
update public.expenses
set tag = coalesce(
  nullif(btrim(category_label), ''),
  category::text,
  '其他'
)
where tag is null or btrim(tag) = '';

-- 3. Fill trigger: auto-set tag on insert/update
create or replace function public.fill_expense_tag()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.tag is null or btrim(new.tag) = '' then
    new.tag := '其他';
  else
    new.tag := left(btrim(new.tag), 40);
  end if;
  return new;
end;
$$;

drop trigger if exists expenses_fill_tag on public.expenses;
create trigger expenses_fill_tag
before insert or update of tag on public.expenses
for each row execute function public.fill_expense_tag();

-- 4. Set NOT NULL + constraints
alter table public.expenses alter column tag set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'expenses_tag_check'
      and conrelid = 'public.expenses'::regclass
  ) then
    alter table public.expenses
      add constraint expenses_tag_check
      check (length(btrim(tag)) between 1 and 40);
  end if;
end;
$$;

-- 5. Rewrite confirm_pending_action to use tag
create or replace function public.confirm_pending_action(
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
  expense_row public.expenses%rowtype;
  paid_by_id uuid;
  other_user_id uuid;
  v_expense_id uuid;
  group_id_value uuid;
  from_user_id uuid;
  to_user_id uuid;
  amount_twd bigint;
  current_balance bigint;
  target_balance bigint;
  expected_balance bigint;
  split_total bigint;
  split_count integer;
  ledger_value public.ledger_type;
  tag_value text;
  split_method_value public.split_method;
  before_state jsonb;
begin
  select * into requester from public.users where line_user_id = p_line_user_id;
  if not found then return jsonb_build_object('result', 'not_found', 'action_type', null); end if;

  select * into action_row from public.pending_actions
  where id = p_action_id and requested_by_user_id = requester.id for update;
  if not found then return jsonb_build_object('result', 'not_found', 'action_type', null); end if;
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

  if action_row.action_type in ('create_expense', 'update_expense') then
    amount_twd := (action_row.payload ->> 'amount_twd')::bigint;
    paid_by_id := (action_row.payload ->> 'paid_by_user_id')::uuid;
    ledger_value := (action_row.payload ->> 'ledger')::public.ledger_type;
    tag_value := left(btrim(coalesce(action_row.payload ->> 'tag', '其他')), 40);
    split_method_value := coalesce((action_row.payload ->> 'split_method')::public.split_method, 'equal');
    group_id_value := coalesce(
      nullif(action_row.payload ->> 'group_id', '')::uuid,
      action_row.group_id,
      (select active_group_id from public.user_preferences where user_id = requester.id)
    );

    if amount_twd not between 1 and 100000000
      or length(action_row.payload ->> 'description') not between 1 and 100
      or not exists (select 1 from public.users where id = paid_by_id and couple_id = requester.couple_id)
      or (ledger_value = 'private' and paid_by_id <> requester.id)
      or (ledger_value = 'shared' and not exists (
        select 1 from public.groups where id = group_id_value and couple_id = requester.couple_id and archived_at is null
      ))
      or (nullif(action_row.payload ->> 'receipt_id', '') is not null and not exists (
        select 1 from public.receipts
        where id = (action_row.payload ->> 'receipt_id')::uuid
          and owner_user_id = requester.id and status = 'ready'
          and (expense_id is null or expense_id = nullif(action_row.payload ->> 'expense_id', '')::uuid)
      ))
    then return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type); end if;

    if ledger_value = 'private' then
      group_id_value := null;
      split_total := amount_twd;
      split_count := 1;
    elsif action_row.payload ? 'splits' then
      select coalesce(sum(value::text::bigint), 0), count(*) into split_total, split_count
      from jsonb_each(action_row.payload -> 'splits');
      if exists (
        select 1 from jsonb_each(action_row.payload -> 'splits') item
        where item.value::text::bigint < 0 or not exists (
          select 1 from public.users u where u.id = item.key::uuid and u.couple_id = requester.couple_id
        )
      ) then return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type); end if;
    else
      select id into other_user_id from public.users
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

    if action_row.action_type = 'create_expense' then
      insert into public.expenses (
        couple_id, group_id, ledger, description, merchant, notes, tag, amount_twd,
        paid_by_user_id, created_by_user_id, expense_date, split_method, source_action_id
      ) values (
        requester.couple_id, group_id_value, ledger_value, action_row.payload ->> 'description',
        nullif(action_row.payload ->> 'merchant', ''), nullif(action_row.payload ->> 'notes', ''),
        tag_value, amount_twd, paid_by_id, requester.id,
        (action_row.payload ->> 'expense_date')::date, split_method_value, action_row.id
      ) returning id into v_expense_id;
    else
      v_expense_id := (action_row.payload ->> 'expense_id')::uuid;
      select * into expense_row from public.expenses
      where id = v_expense_id and couple_id = requester.couple_id and deleted_at is null for update;
      if not found or expense_row.version <> (action_row.payload ->> 'expected_version')::integer
        or expense_row.ledger <> ledger_value
        or (expense_row.ledger = 'private' and expense_row.created_by_user_id <> requester.id)
      then return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type); end if;
      before_state := to_jsonb(expense_row);
      update public.expenses set
        group_id = group_id_value, ledger = ledger_value, description = action_row.payload ->> 'description',
        merchant = nullif(action_row.payload ->> 'merchant', ''), notes = nullif(action_row.payload ->> 'notes', ''),
        tag = tag_value, amount_twd = amount_twd, paid_by_user_id = paid_by_id,
        expense_date = (action_row.payload ->> 'expense_date')::date, split_method = split_method_value,
        version = version + 1, updated_at = now()
      where id = v_expense_id;
      delete from public.expense_splits es where es.expense_id = v_expense_id;
    end if;

    if ledger_value = 'private' then
      insert into public.expense_splits values (v_expense_id, requester.id, amount_twd);
    elsif action_row.payload ? 'splits' then
      insert into public.expense_splits (expense_id, user_id, amount_twd)
      select v_expense_id, key::uuid, value::text::bigint from jsonb_each(action_row.payload -> 'splits');
    else
      select id into other_user_id from public.users where couple_id = requester.couple_id and id <> paid_by_id;
      insert into public.expense_splits values
        (v_expense_id, paid_by_id, (amount_twd + 1) / 2),
        (v_expense_id, other_user_id, amount_twd / 2);
    end if;

    if nullif(action_row.payload ->> 'receipt_id', '') is not null then
      update public.receipts set expense_id = v_expense_id, group_id = group_id_value, updated_at = now()
      where id = (action_row.payload ->> 'receipt_id')::uuid
        and owner_user_id = requester.id and (expense_id is null or expense_id = v_expense_id);
    end if;

    insert into public.activity_events (
      couple_id, group_id, actor_user_id, entity_type, entity_id, action, before_state, after_state
    ) values (
      requester.couple_id, group_id_value, requester.id, 'expense', v_expense_id::text,
      case when action_row.action_type = 'create_expense' then 'create' else 'update' end,
      before_state, (select to_jsonb(e) from public.expenses e where e.id = v_expense_id)
    );

  elsif action_row.action_type in ('delete_expense', 'restore_expense') then
    v_expense_id := (action_row.payload ->> 'expense_id')::uuid;
    select * into expense_row from public.expenses
    where id = v_expense_id and couple_id = requester.couple_id for update;
    if not found or (expense_row.ledger = 'private' and expense_row.created_by_user_id <> requester.id)
      or (action_row.payload ? 'expected_version' and expense_row.version <> (action_row.payload ->> 'expected_version')::integer)
    then return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type); end if;
    before_state := to_jsonb(expense_row);
    if action_row.action_type = 'delete_expense' and expense_row.deleted_at is null then
      update public.expenses set deleted_at = now(), deleted_by_user_id = requester.id,
        version = version + 1, updated_at = now() where id = v_expense_id;
      update public.receipts set deleted_at = now(), updated_at = now() where expense_id = v_expense_id;
    elsif action_row.action_type = 'restore_expense' and expense_row.deleted_at > now() - interval '30 days' then
      update public.expenses set deleted_at = null, deleted_by_user_id = null,
        version = version + 1, updated_at = now() where id = v_expense_id;
      update public.receipts set deleted_at = null, updated_at = now() where expense_id = v_expense_id;
    else return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type); end if;
    insert into public.activity_events (
      couple_id, group_id, actor_user_id, entity_type, entity_id, action, before_state, after_state
    ) values (
      requester.couple_id, expense_row.group_id, requester.id, 'expense', v_expense_id::text,
      case when action_row.action_type = 'delete_expense' then 'delete' else 'restore' end,
      before_state, (select to_jsonb(e) from public.expenses e where e.id = v_expense_id)
    );

  elsif action_row.action_type = 'settle' then
    group_id_value := coalesce(
      nullif(action_row.payload ->> 'group_id', '')::uuid,
      action_row.group_id,
      (select active_group_id from public.user_preferences where user_id = requester.id)
    );
    from_user_id := (action_row.payload ->> 'from_user_id')::uuid;
    to_user_id := (action_row.payload ->> 'to_user_id')::uuid;
    amount_twd := (action_row.payload ->> 'amount_twd')::bigint;
    select balance_twd into current_balance from public.group_balances(group_id_value)
      where user_id = from_user_id;
    select balance_twd into target_balance from public.group_balances(group_id_value)
      where user_id = to_user_id;
    expected_balance := coalesce((action_row.payload ->> 'expected_balance_twd')::bigint, current_balance);
    if current_balance <> expected_balance or current_balance >= 0 or target_balance <> -current_balance or amount_twd <= 0
      or amount_twd > abs(current_balance) or from_user_id = to_user_id
    then return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type); end if;
    insert into public.settlements (
      couple_id, group_id, from_user_id, to_user_id, amount_twd, source_action_id
    ) values (
      requester.couple_id, group_id_value, from_user_id, to_user_id, amount_twd, action_row.id
    );
    insert into public.activity_events (
      couple_id, group_id, actor_user_id, entity_type, entity_id, action, after_state
    ) values (
      requester.couple_id, group_id_value, requester.id, 'settlement', action_row.id::text, 'settle',
      jsonb_build_object('from_user_id', from_user_id, 'to_user_id', to_user_id, 'amount_twd', amount_twd)
    );
  end if;

  update public.pending_actions set status = 'confirmed', processed_at = now() where id = action_row.id;
  insert into public.notifications (recipient_user_id, group_id, kind, title, body, entity_type, entity_id, dedupe_key)
  select u.id, group_id_value,
    case when action_row.action_type = 'settle' then 'settlement' else 'expense' end,
    case when action_row.action_type = 'settle' then '帳務已結清' else '共同帳本已更新' end,
    case when action_row.action_type = 'settle' then '另一半新增了一筆結清紀錄' else '另一半更新了一筆支出' end,
    case when action_row.action_type = 'settle' then 'settlement' else 'expense' end,
    coalesce(v_expense_id::text, action_row.id::text), 'action:' || action_row.id::text || ':user:' || u.id::text
  from public.users u
  where u.couple_id = requester.couple_id and u.id <> requester.id and group_id_value is not null;
  return jsonb_build_object('result', 'confirmed', 'action_type', action_row.action_type);
exception
  when invalid_text_representation or numeric_value_out_of_range or check_violation or foreign_key_violation then
    return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type);
end;
$$;

-- 6. Rewrite confirm_batch_create_expenses to use tag
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
  tag_value text;
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
    tag_value := left(btrim(coalesce(expense_item ->> 'tag', '其他')), 40);
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
      couple_id, group_id, ledger, description, merchant, notes, tag,
      amount_twd, paid_by_user_id, created_by_user_id, expense_date, split_method, source_action_id
    ) values (
      requester.couple_id, group_id_value, ledger_value, expense_item ->> 'description',
      nullif(expense_item ->> 'merchant', ''), nullif(expense_item ->> 'notes', ''),
      tag_value,
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

-- 7. Rewrite confirm_batch_update_expenses to use tag
create or replace function public.confirm_batch_update_expenses(
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
  expense_row public.expenses%rowtype;
  update_item jsonb;
  tag_value text;
  updated_count integer := 0;
  before_state jsonb;
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
  if action_row.action_type::text <> 'batch_update_expenses'
    or jsonb_typeof(action_row.payload -> 'updates') <> 'array'
  then
    return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type);
  end if;

  for update_item in select value from jsonb_array_elements(action_row.payload -> 'updates')
  loop
    tag_value := left(btrim(coalesce(update_item ->> 'tag', update_item ->> 'category_label')), 40);
    if tag_value is null or length(tag_value) < 1 then
      return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type);
    end if;

    select * into expense_row
    from public.expenses
    where id = (update_item ->> 'expense_id')::uuid
      and couple_id = requester.couple_id
    for update;
    if not found
      or expense_row.deleted_at is not null
      or expense_row.version <> (update_item ->> 'expected_version')::integer
      or (expense_row.ledger = 'private' and expense_row.created_by_user_id <> requester.id)
      or (expense_row.ledger = 'shared' and expense_row.group_id <> action_row.group_id)
    then
      return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type);
    end if;

    before_state := to_jsonb(expense_row);
    update public.expenses
    set tag = tag_value,
      version = version + 1,
      updated_at = now()
    where id = expense_row.id;
    updated_count := updated_count + 1;

    insert into public.activity_events (
      couple_id, group_id, actor_user_id, entity_type, entity_id, action, before_state, after_state
    ) values (
      requester.couple_id, expense_row.group_id, requester.id, 'expense', expense_row.id::text, 'update',
      before_state, (select to_jsonb(e) from public.expenses e where e.id = expense_row.id)
    );
  end loop;

  if updated_count = 0 then
    return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type);
  end if;

  update public.pending_actions set status = 'confirmed', processed_at = now() where id = action_row.id;

  insert into public.notifications (recipient_user_id, group_id, kind, title, body, entity_type, entity_id, dedupe_key)
  select u.id, action_row.group_id, 'expense', '分類整理已套用',
    '另一半套用了一批分類整理', 'expense', action_row.id::text,
    'batch-category:' || action_row.id::text || ':user:' || u.id::text
  from public.users u
  where u.couple_id = requester.couple_id
    and u.id <> requester.id
    and action_row.group_id is not null;

  return jsonb_build_object('result', 'confirmed', 'action_type', action_row.action_type);
exception
  when invalid_text_representation or numeric_value_out_of_range or check_violation or foreign_key_violation then
    return jsonb_build_object('result', 'stale', 'action_type', coalesce(action_row.action_type::text, null));
end;
$$;

-- 8. Rewrite sync_private_mirrors_for_expense to use tag
create or replace function public.sync_private_mirrors_for_expense(p_source_expense_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  source_row public.expenses%rowtype;
  owner_id uuid;
  share_twd bigint;
  mirror_id uuid;
begin
  select * into source_row
  from public.expenses
  where id = p_source_expense_id and ledger = 'shared';
  if not found then
    return;
  end if;

  for owner_id in
    select source_row.created_by_user_id
    union
    select created_by_user_id
    from public.expenses
    where mirror_kind = 'shared_share'
      and mirror_source_expense_id = source_row.id
  loop
    select amount_twd into share_twd
    from public.expense_splits
    where expense_id = source_row.id and user_id = owner_id;

    if coalesce(share_twd, 0) <= 0 then
      update public.expenses
      set deleted_at = coalesce(source_row.deleted_at, now()),
        deleted_by_user_id = source_row.deleted_by_user_id,
        version = version + 1,
        updated_at = now()
      where mirror_kind = 'shared_share'
        and mirror_source_expense_id = source_row.id
        and created_by_user_id = owner_id;
      continue;
    end if;

    insert into public.expenses (
      couple_id, group_id, ledger, description, merchant, notes, tag,
      amount_twd, paid_by_user_id, created_by_user_id, expense_date, split_method,
      source_action_id, mirror_kind, mirror_source_expense_id, deleted_at, deleted_by_user_id
    ) values (
      source_row.couple_id, null, 'private', source_row.description, source_row.merchant,
      source_row.notes, source_row.tag, share_twd,
      owner_id, owner_id, source_row.expense_date, 'equal', null, 'shared_share',
      source_row.id, source_row.deleted_at, source_row.deleted_by_user_id
    )
    on conflict (mirror_source_expense_id, created_by_user_id)
      where mirror_kind = 'shared_share'
    do update set
      description = excluded.description,
      merchant = excluded.merchant,
      notes = excluded.notes,
      tag = excluded.tag,
      amount_twd = excluded.amount_twd,
      paid_by_user_id = excluded.paid_by_user_id,
      expense_date = excluded.expense_date,
      split_method = excluded.split_method,
      deleted_at = excluded.deleted_at,
      deleted_by_user_id = excluded.deleted_by_user_id,
      version = public.expenses.version + 1,
      updated_at = now()
    returning id into mirror_id;

    insert into public.expense_splits (expense_id, user_id, amount_twd)
    values (mirror_id, owner_id, share_twd)
    on conflict (expense_id, user_id)
    do update set amount_twd = excluded.amount_twd;
  end loop;
end;
$$;

-- 9. Update trigger column list for sync_private_mirrors
drop trigger if exists expenses_sync_private_mirrors on public.expenses;
create trigger expenses_sync_private_mirrors
after update of description, merchant, notes, tag, amount_twd, expense_date, deleted_at, deleted_by_user_id
on public.expenses
for each row
when (new.ledger = 'shared')
execute function public.sync_private_mirrors_from_expense_trigger();

-- 10. Update budgets table: add tag, drop category/category_label
alter table public.budgets add column if not exists tag text;

update public.budgets
set tag = coalesce(
  nullif(btrim(category_label), ''),
  category::text,
  '總預算'
)
where tag is null and (category is not null or category_label is not null);

-- Drop old budget indexes
drop index if exists public.budgets_group_month_total_unique;
drop index if exists public.budgets_group_month_category_unique;
drop index if exists public.budgets_group_month_label_unique;

-- Drop old constraints
alter table public.budgets drop constraint if exists budgets_category_label_check;

-- Create new budget indexes with tag
create unique index budgets_group_month_tag_unique
  on public.budgets (group_id, month, tag) where tag is not null;
create unique index budgets_group_month_total_unique
  on public.budgets (group_id, month) where tag is null;

-- 11. Update recurring_expenses: add tag, drop category
alter table public.recurring_expenses add column if not exists tag text;

update public.recurring_expenses
set tag = coalesce(category::text, '其他')
where tag is null;

alter table public.recurring_expenses alter column tag set default '其他';

-- 12. Update assistant_memories kind: add tag_rule
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'assistant_memories_kind_check'
      and conrelid = 'public.assistant_memories'::regclass
  ) then
    -- constraint doesn't exist, nothing to alter
  end if;
end;
$$;

-- Update the kind check constraint to include tag_rule
alter table public.assistant_memories drop constraint if exists assistant_memories_kind_check;
alter table public.assistant_memories add constraint assistant_memories_kind_check
  check (kind in ('merchant_rule', 'category_rule', 'tag_rule', 'split_rule', 'routine', 'wording_preference'));

-- 13. Update assistant_tasks: rename budget_warning → remove, category_cleanup → tag_cleanup
alter table public.assistant_tasks drop constraint if exists assistant_tasks_type_check;
alter table public.assistant_tasks add constraint assistant_tasks_type_check
  check (type in (
    'confirm_expense',
    'fix_uncertain_receipt',
    'review_unmatched_bank_items',
    'settlement_suggestion',
    'duplicate_expense_review',
    'merchant_rule_suggestion',
    'missing_daily_entry',
    'tag_cleanup',
    'recurring_expense_review'
  ));

-- 14. Drop old trigger before dropping columns
drop trigger if exists expenses_fill_category_label on public.expenses;
drop function if exists public.fill_expense_category_label();

-- 15. Drop old category columns from expenses
alter table public.expenses drop column if exists category;
alter table public.expenses drop column if exists category_label;

-- 16. Drop old category columns from budgets
alter table public.budgets drop column if exists category;
alter table public.budgets drop column if exists category_label;

-- 17. Drop old category columns from recurring_expenses
alter table public.recurring_expenses drop column if exists category;

-- 18. Drop the expense_category enum type
drop type if exists public.expense_category;

-- 19. Drop canonical_labels table (pure free-form tags now)
drop table if exists public.canonical_labels;

-- 20. Revoke grants on dropped objects (canonical_labels table gone)
-- Grants on new functions
revoke all on function public.fill_expense_tag() from public, anon, authenticated;
revoke all on function public.confirm_pending_action(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.confirm_batch_create_expenses(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.confirm_batch_update_expenses(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.sync_private_mirrors_for_expense(uuid) from public, anon, authenticated;
revoke all on function public.sync_private_mirrors_from_expense_trigger() from public, anon, authenticated;
revoke all on function public.sync_private_mirrors_from_split_trigger() from public, anon, authenticated;
grant execute on function public.fill_expense_tag() to service_role;
grant execute on function public.confirm_pending_action(uuid, text, boolean) to service_role;
grant execute on function public.confirm_batch_create_expenses(uuid, text, boolean) to service_role;
grant execute on function public.confirm_batch_update_expenses(uuid, text, boolean) to service_role;
grant execute on function public.sync_private_mirrors_for_expense(uuid) to service_role;
