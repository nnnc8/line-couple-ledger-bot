create table public.groups (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  name text not null check (length(name) between 1 and 40),
  color text not null default '#173B63' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_by_user_id uuid references public.users(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.groups (couple_id, name)
select id, '共同生活' from public.couples
where not exists (select 1 from public.groups);

create table public.user_preferences (
  user_id uuid primary key references public.users(id) on delete cascade,
  active_group_id uuid not null references public.groups(id),
  updated_at timestamptz not null default now()
);

insert into public.user_preferences (user_id, active_group_id)
select u.id, g.id
from public.users u
join lateral (
  select id from public.groups where couple_id = u.couple_id order by created_at limit 1
) g on true
on conflict (user_id) do nothing;

create or replace function public.ensure_user_preferences()
returns trigger language plpgsql security definer set search_path = public as $$
declare default_group_id uuid;
begin
  select id into default_group_id from public.groups
  where couple_id = new.couple_id and archived_at is null
  order by created_at limit 1;
  insert into public.user_preferences (user_id, active_group_id)
  values (new.id, default_group_id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger users_create_preferences
after insert on public.users
for each row execute function public.ensure_user_preferences();

alter table public.expenses
  add column group_id uuid references public.groups(id),
  add column merchant text check (merchant is null or length(merchant) between 1 and 100),
  add column notes text check (notes is null or length(notes) <= 500),
  add column version integer not null default 1 check (version > 0),
  add column updated_at timestamptz not null default now();

update public.expenses e set group_id = g.id
from public.groups g
where e.ledger = 'shared' and g.couple_id = e.couple_id;

alter table public.expenses add constraint expenses_group_scope_check
check ((ledger = 'shared' and group_id is not null) or (ledger = 'private' and group_id is null));

alter table public.settlements add column group_id uuid references public.groups(id);
update public.settlements s set group_id = g.id
from public.groups g where g.couple_id = s.couple_id;
alter table public.settlements alter column group_id set not null;

alter table public.pending_actions
  add column group_id uuid references public.groups(id),
  add column idempotency_key text;
create unique index pending_actions_idempotency_idx
  on public.pending_actions (idempotency_key) where idempotency_key is not null;

create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  owner_user_id uuid not null references public.users(id),
  group_id uuid references public.groups(id),
  expense_id uuid references public.expenses(id),
  storage_path text not null unique check (length(storage_path) between 1 and 500),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  source_event_id text unique,
  status text not null default 'uploaded' check (status in ('uploaded', 'processing', 'ready', 'failed')),
  extraction jsonb check (extraction is null or jsonb_typeof(extraction) = 'object'),
  failure_reason text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  category public.expense_category,
  month date not null check (month = date_trunc('month', month)::date),
  limit_twd bigint not null check (limit_twd between 1 and 100000000),
  created_by_user_id uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index budgets_group_month_total_unique
  on public.budgets (group_id, month) where category is null;
create unique index budgets_group_month_category_unique
  on public.budgets (group_id, month, category) where category is not null;

create table public.recurring_expenses (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  group_id uuid references public.groups(id),
  created_by_user_id uuid not null references public.users(id),
  paid_by_user_id uuid not null references public.users(id),
  ledger public.ledger_type not null,
  description text not null check (length(description) between 1 and 100),
  category public.expense_category not null default 'other',
  amount_twd bigint not null check (amount_twd between 1 and 100000000),
  split_method public.split_method not null default 'equal',
  splits jsonb not null check (jsonb_typeof(splits) = 'object'),
  frequency text not null check (frequency in ('weekly', 'monthly', 'yearly')),
  anchor_day smallint not null check (anchor_day between 1 and 31),
  next_run_date date not null,
  end_date date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((ledger = 'shared' and group_id is not null) or (ledger = 'private' and group_id is null)),
  check (end_date is null or end_date >= next_run_date)
);

create table public.activity_events (
  id bigint generated always as identity primary key,
  couple_id smallint not null references public.couples(id) on delete cascade,
  group_id uuid references public.groups(id),
  actor_user_id uuid not null references public.users(id),
  entity_type text not null check (entity_type in ('group', 'expense', 'settlement', 'budget', 'recurring')),
  entity_id text not null,
  action text not null check (action in ('create', 'update', 'delete', 'restore', 'archive', 'settle')),
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);

create table public.notifications (
  id bigint generated always as identity primary key,
  recipient_user_id uuid not null references public.users(id) on delete cascade,
  group_id uuid references public.groups(id),
  kind text not null check (kind in ('expense', 'settlement', 'budget', 'recurring', 'receipt')),
  title text not null check (length(title) between 1 and 100),
  body text not null check (length(body) between 1 and 500),
  entity_type text,
  entity_id text,
  dedupe_key text unique,
  read_at timestamptz,
  line_status text not null default 'pending' check (line_status in ('pending', 'sent', 'skipped', 'failed')),
  created_at timestamptz not null default now()
);

create index groups_couple_active_idx on public.groups (couple_id, created_at) where archived_at is null;
create index expenses_group_date_idx on public.expenses (group_id, expense_date desc) where deleted_at is null;
create index receipts_owner_idx on public.receipts (owner_user_id, created_at desc);
create index recurring_due_idx on public.recurring_expenses (next_run_date) where active;
create index activity_group_idx on public.activity_events (group_id, created_at desc);
create index notifications_recipient_idx on public.notifications (recipient_user_id, created_at desc);

alter table public.groups enable row level security;
alter table public.user_preferences enable row level security;
alter table public.receipts enable row level security;
alter table public.budgets enable row level security;
alter table public.recurring_expenses enable row level security;
alter table public.activity_events enable row level security;
alter table public.notifications enable row level security;

revoke all on public.groups, public.user_preferences, public.receipts, public.budgets,
  public.recurring_expenses, public.activity_events, public.notifications from anon, authenticated;
grant select, insert, update, delete on public.groups, public.user_preferences, public.receipts,
  public.budgets, public.recurring_expenses, public.activity_events, public.notifications to service_role;
grant usage, select on all sequences in schema public to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts', 'receipts', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.group_balances(p_group_id uuid)
returns table (user_id uuid, balance_twd bigint)
language sql security definer set search_path = public stable as $$
  select u.id,
    coalesce((select sum(e.amount_twd) from public.expenses e
      where e.group_id = p_group_id and e.ledger = 'shared' and e.deleted_at is null and e.paid_by_user_id = u.id), 0)
    - coalesce((select sum(es.amount_twd) from public.expense_splits es
      join public.expenses e on e.id = es.expense_id
      where e.group_id = p_group_id and e.ledger = 'shared' and e.deleted_at is null and es.user_id = u.id), 0)
    + coalesce((select sum(s.amount_twd) from public.settlements s
      where s.group_id = p_group_id and s.from_user_id = u.id), 0)
    - coalesce((select sum(s.amount_twd) from public.settlements s
      where s.group_id = p_group_id and s.to_user_id = u.id), 0) as balance_twd
  from public.users u
  join public.groups g on g.couple_id = u.couple_id
  where g.id = p_group_id;
$$;

revoke all on function public.group_balances(uuid) from public, anon, authenticated;
grant execute on function public.group_balances(uuid) to service_role;

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
  category_value public.expense_category;
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
    category_value := (action_row.payload ->> 'category')::public.expense_category;
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
        couple_id, group_id, ledger, description, merchant, notes, category, amount_twd,
        paid_by_user_id, created_by_user_id, expense_date, split_method, source_action_id
      ) values (
        requester.couple_id, group_id_value, ledger_value, action_row.payload ->> 'description',
        nullif(action_row.payload ->> 'merchant', ''), nullif(action_row.payload ->> 'notes', ''),
        category_value, amount_twd, paid_by_id, requester.id,
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
        category = category_value, amount_twd = amount_twd, paid_by_user_id = paid_by_id,
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

revoke all on function public.ensure_user_preferences() from public, anon, authenticated;
revoke all on function public.confirm_pending_action(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.confirm_pending_action(uuid, text, boolean) to service_role;
