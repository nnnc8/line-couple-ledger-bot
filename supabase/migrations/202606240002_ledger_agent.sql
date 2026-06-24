alter type public.pending_action_type add value if not exists 'batch_update_expenses';

alter table public.expenses add column if not exists category_label text;

update public.expenses
set category_label = category::text
where category_label is null or btrim(category_label) = '';

create or replace function public.fill_expense_category_label()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.category_label is null or btrim(new.category_label) = '' then
    new.category_label := new.category::text;
  else
    new.category_label := left(btrim(new.category_label), 40);
  end if;
  return new;
end;
$$;

drop trigger if exists expenses_fill_category_label on public.expenses;
create trigger expenses_fill_category_label
before insert or update of category, category_label on public.expenses
for each row execute function public.fill_expense_category_label();

alter table public.expenses alter column category_label set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'expenses_category_label_check'
      and conrelid = 'public.expenses'::regclass
  ) then
    alter table public.expenses
      add constraint expenses_category_label_check
      check (length(btrim(category_label)) between 1 and 40);
  end if;
end;
$$;

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  group_id uuid references public.groups(id),
  report_id uuid references public.accountant_reports(id) on delete set null,
  scope text not null check (scope in ('shared', 'private', 'combined')),
  time_range text not null check (time_range in ('this_month', 'last_month', 'last_3_months', 'this_year', 'all')),
  message text not null check (length(message) between 1 and 500),
  answer text not null check (length(answer) between 1 and 2000),
  tool_calls jsonb not null default '[]'::jsonb check (jsonb_typeof(tool_calls) = 'array'),
  suggestions jsonb not null default '[]'::jsonb check (jsonb_typeof(suggestions) = 'array'),
  created_at timestamptz not null default now()
);

create index if not exists agent_runs_user_created_idx
  on public.agent_runs (user_id, created_at desc);
create index if not exists agent_runs_group_created_idx
  on public.agent_runs (group_id, created_at desc);

alter table public.agent_runs enable row level security;
revoke all on public.agent_runs from anon, authenticated;
grant select, insert, update, delete on public.agent_runs to service_role;

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
  label_value text;
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
    label_value := left(btrim(update_item ->> 'category_label'), 40);
    if label_value is null or length(label_value) < 1 then
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
    set category_label = label_value,
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

revoke all on function public.fill_expense_category_label() from public, anon, authenticated;
revoke all on function public.confirm_batch_update_expenses(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.confirm_batch_update_expenses(uuid, text, boolean) to service_role;
