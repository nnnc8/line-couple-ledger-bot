create extension if not exists pgcrypto;

create type public.user_role as enum ('owner', 'partner');
create type public.ledger_type as enum ('shared', 'private');
create type public.split_method as enum ('equal', 'exact', 'percentage');
create type public.expense_category as enum (
  'food', 'transport', 'groceries', 'household', 'entertainment',
  'shopping', 'medical', 'travel', 'other'
);
create type public.pending_action_type as enum (
  'create_expense', 'delete_expense', 'settle'
);
create type public.pending_action_status as enum (
  'pending', 'confirmed', 'cancelled', 'expired'
);

create table public.couples (
  id smallint primary key default 1 check (id = 1),
  currency text not null default 'TWD' check (currency = 'TWD'),
  time_zone text not null default 'Asia/Taipei' check (time_zone = 'Asia/Taipei'),
  created_at timestamptz not null default now()
);

insert into public.couples (id) values (1);

create table public.users (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null default 1 references public.couples(id) on delete cascade,
  line_user_id text not null unique check (length(line_user_id) between 1 and 100),
  role public.user_role not null,
  created_at timestamptz not null default now(),
  unique (couple_id, role)
);

create table public.pending_actions (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  requested_by_user_id uuid not null references public.users(id) on delete cascade,
  action_type public.pending_action_type not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  source_event_id text not null unique,
  status public.pending_action_status not null default 'pending',
  expires_at timestamptz not null,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  ledger public.ledger_type not null,
  description text not null check (length(description) between 1 and 100),
  category public.expense_category not null default 'other',
  amount_twd bigint not null check (amount_twd between 1 and 100000000),
  paid_by_user_id uuid not null references public.users(id),
  created_by_user_id uuid not null references public.users(id),
  expense_date date not null,
  split_method public.split_method not null default 'equal',
  source_action_id uuid not null unique references public.pending_actions(id),
  deleted_at timestamptz,
  deleted_by_user_id uuid references public.users(id),
  created_at timestamptz not null default now()
);

create table public.expense_splits (
  expense_id uuid not null references public.expenses(id) on delete cascade,
  user_id uuid not null references public.users(id),
  amount_twd bigint not null check (amount_twd >= 0),
  primary key (expense_id, user_id)
);

create table public.settlements (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  from_user_id uuid not null references public.users(id),
  to_user_id uuid not null references public.users(id),
  amount_twd bigint not null check (amount_twd > 0),
  source_action_id uuid not null unique references public.pending_actions(id),
  created_at timestamptz not null default now(),
  check (from_user_id <> to_user_id)
);

create index expenses_couple_date_idx
  on public.expenses (couple_id, expense_date desc)
  where deleted_at is null;
create index expenses_latest_idx
  on public.expenses (couple_id, created_at desc)
  where deleted_at is null;
create index settlements_couple_idx
  on public.settlements (couple_id, created_at);
create index pending_actions_user_status_idx
  on public.pending_actions (requested_by_user_id, status, expires_at);

alter table public.couples enable row level security;
alter table public.users enable row level security;
alter table public.pending_actions enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_splits enable row level security;
alter table public.settlements enable row level security;

revoke all on public.couples from anon, authenticated;
revoke all on public.users from anon, authenticated;
revoke all on public.pending_actions from anon, authenticated;
revoke all on public.expenses from anon, authenticated;
revoke all on public.expense_splits from anon, authenticated;
revoke all on public.settlements from anon, authenticated;

grant select, insert, update, delete on public.couples to service_role;
grant select, insert, update, delete on public.users to service_role;
grant select, insert, update, delete on public.pending_actions to service_role;
grant select, insert, update, delete on public.expenses to service_role;
grant select, insert, update, delete on public.expense_splits to service_role;
grant select, insert, update, delete on public.settlements to service_role;

create or replace function public.claim_user(p_line_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_user public.users%rowtype;
  new_role public.user_role;
  user_count integer;
begin
  if p_line_user_id is null or length(p_line_user_id) not between 1 and 100 then
    raise exception 'invalid line user id';
  end if;

  select * into existing_user
  from public.users
  where line_user_id = p_line_user_id;
  if found then
    return jsonb_build_object(
      'result', 'already_joined',
      'role', existing_user.role
    );
  end if;

  lock table public.users in exclusive mode;

  select * into existing_user
  from public.users
  where line_user_id = p_line_user_id;
  if found then
    return jsonb_build_object(
      'result', 'already_joined',
      'role', existing_user.role
    );
  end if;

  select count(*) into user_count from public.users where couple_id = 1;
  if user_count >= 2 then
    return jsonb_build_object('result', 'full');
  end if;

  new_role := case when user_count = 0 then 'owner'::public.user_role
                   else 'partner'::public.user_role end;
  insert into public.users (line_user_id, role)
  values (p_line_user_id, new_role);

  return jsonb_build_object('result', 'joined', 'role', new_role);
end;
$$;

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
  paid_by_id uuid;
  other_user_id uuid;
  expense_id uuid;
  from_user_id uuid;
  to_user_id uuid;
  amount_twd bigint;
  current_balance bigint;
  ledger_value public.ledger_type;
  category_value public.expense_category;
begin
  select * into requester
  from public.users
  where line_user_id = p_line_user_id;
  if not found then
    return jsonb_build_object('result', 'not_found', 'action_type', null);
  end if;

  select * into action_row
  from public.pending_actions
  where id = p_action_id
    and requested_by_user_id = requester.id
  for update;
  if not found then
    return jsonb_build_object('result', 'not_found', 'action_type', null);
  end if;

  if action_row.status <> 'pending' then
    return jsonb_build_object(
      'result', 'already_done',
      'action_type', action_row.action_type
    );
  end if;

  if action_row.expires_at <= now() then
    update public.pending_actions
    set status = 'expired', processed_at = now()
    where id = action_row.id;
    return jsonb_build_object(
      'result', 'expired',
      'action_type', action_row.action_type
    );
  end if;

  if not p_confirm then
    update public.pending_actions
    set status = 'cancelled', processed_at = now()
    where id = action_row.id;
    return jsonb_build_object(
      'result', 'cancelled',
      'action_type', action_row.action_type
    );
  end if;

  if action_row.action_type = 'create_expense' then
    if jsonb_typeof(action_row.payload -> 'amount_twd') <> 'number' then
      return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type);
    end if;

    amount_twd := (action_row.payload ->> 'amount_twd')::bigint;
    paid_by_id := (action_row.payload ->> 'paid_by_user_id')::uuid;
    ledger_value := (action_row.payload ->> 'ledger')::public.ledger_type;
    category_value := (action_row.payload ->> 'category')::public.expense_category;

    if amount_twd not between 1 and 100000000
      or length(action_row.payload ->> 'description') not between 1 and 100
      or not exists (
        select 1 from public.users
        where id = paid_by_id and couple_id = requester.couple_id
      )
      or (ledger_value = 'private' and paid_by_id <> requester.id)
    then
      return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type);
    end if;

    if ledger_value = 'shared' then
      select id into other_user_id
      from public.users
      where couple_id = requester.couple_id and id <> paid_by_id;
      if not found then
        return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type);
      end if;
    else
      other_user_id := null;
    end if;

    insert into public.expenses (
      couple_id, ledger, description, category, amount_twd,
      paid_by_user_id, created_by_user_id, expense_date,
      split_method, source_action_id
    ) values (
      requester.couple_id,
      ledger_value,
      action_row.payload ->> 'description',
      category_value,
      amount_twd,
      paid_by_id,
      requester.id,
      (action_row.payload ->> 'expense_date')::date,
      'equal',
      action_row.id
    ) returning id into expense_id;

    if ledger_value = 'private' then
      insert into public.expense_splits (expense_id, user_id, amount_twd)
      values (expense_id, requester.id, amount_twd);
    else
      insert into public.expense_splits (expense_id, user_id, amount_twd)
      values
        (expense_id, paid_by_id, (amount_twd + 1) / 2),
        (expense_id, other_user_id, amount_twd / 2);
    end if;

  elsif action_row.action_type = 'delete_expense' then
    expense_id := (action_row.payload ->> 'expense_id')::uuid;
    update public.expenses
    set deleted_at = now(), deleted_by_user_id = requester.id
    where id = expense_id
      and couple_id = requester.couple_id
      and deleted_at is null
      and (ledger = 'shared' or created_by_user_id = requester.id);
    if not found then
      return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type);
    end if;

  elsif action_row.action_type = 'settle' then
    from_user_id := (action_row.payload ->> 'from_user_id')::uuid;
    to_user_id := (action_row.payload ->> 'to_user_id')::uuid;
    amount_twd := (action_row.payload ->> 'amount_twd')::bigint;

    if amount_twd <= 0 or from_user_id = to_user_id
      or not exists (
        select 1 from public.users
        where id = from_user_id and couple_id = requester.couple_id
      )
      or not exists (
        select 1 from public.users
        where id = to_user_id and couple_id = requester.couple_id
      )
    then
      return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type);
    end if;

    select
      coalesce((
        select sum(e.amount_twd) from public.expenses e
        where e.couple_id = requester.couple_id
          and e.ledger = 'shared'
          and e.deleted_at is null
          and e.paid_by_user_id = from_user_id
      ), 0)
      - coalesce((
        select sum(es.amount_twd)
        from public.expense_splits es
        join public.expenses e on e.id = es.expense_id
        where e.couple_id = requester.couple_id
          and e.ledger = 'shared'
          and e.deleted_at is null
          and es.user_id = from_user_id
      ), 0)
      + coalesce((
        select sum(s.amount_twd) from public.settlements s
        where s.couple_id = requester.couple_id
          and s.from_user_id = from_user_id
      ), 0)
      - coalesce((
        select sum(s.amount_twd) from public.settlements s
        where s.couple_id = requester.couple_id
          and s.to_user_id = from_user_id
      ), 0)
    into current_balance;

    if current_balance <> -amount_twd then
      return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type);
    end if;

    insert into public.settlements (
      couple_id, from_user_id, to_user_id, amount_twd, source_action_id
    ) values (
      requester.couple_id, from_user_id, to_user_id, amount_twd, action_row.id
    );
  end if;

  update public.pending_actions
  set status = 'confirmed', processed_at = now()
  where id = action_row.id;

  return jsonb_build_object(
    'result', 'confirmed',
    'action_type', action_row.action_type
  );
exception
  when invalid_text_representation or numeric_value_out_of_range or check_violation then
    return jsonb_build_object(
      'result', 'stale',
      'action_type', action_row.action_type
    );
end;
$$;

revoke all on function public.claim_user(text) from public, anon, authenticated;
revoke all on function public.confirm_pending_action(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.claim_user(text) to service_role;
grant execute on function public.confirm_pending_action(uuid, text, boolean) to service_role;
