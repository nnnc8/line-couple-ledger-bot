-- Couple Ledger V2 shadow model.
--
-- This migration is intentionally additive. It creates a private, TWD-only
-- data plane beside the V1 public tables. No V1 row is changed or backfilled
-- here; migration and cutover are separate, observable operations.

create schema if not exists ledger_v2;

-- The V2 child tables carry couple_id in every row so a ledger cannot point
-- at a member from a different couple. PostgreSQL requires an explicit
-- matching unique key for that composite FK even though users.id is already
-- a primary key.
create unique index if not exists users_id_couple_uidx
  on public.users (id, couple_id);

revoke all on schema ledger_v2 from public, anon, authenticated;
grant usage on schema ledger_v2 to service_role;

create table ledger_v2.ledgers (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  name text not null check (length(name) between 1 and 40),
  color text not null default '#173B63' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  status text not null default 'active' check (status in ('active', 'archived')),
  version integer not null default 1 check (version > 0),
  created_by_user_id uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, couple_id),
  foreign key (created_by_user_id, couple_id)
    references public.users(id, couple_id)
);

create table ledger_v2.ledger_members (
  ledger_id uuid not null,
  couple_id smallint not null,
  user_id uuid not null references public.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (ledger_id, user_id),
  foreign key (ledger_id, couple_id)
    references ledger_v2.ledgers(id, couple_id) on delete cascade,
  foreign key (user_id, couple_id)
    references public.users(id, couple_id) on delete cascade
);

create table ledger_v2.ledger_default_shares (
  ledger_id uuid not null,
  couple_id smallint not null,
  user_id uuid not null references public.users(id) on delete cascade,
  weight bigint not null check (weight >= 0),
  primary key (ledger_id, user_id),
  foreign key (ledger_id, couple_id)
    references ledger_v2.ledgers(id, couple_id) on delete cascade,
  foreign key (user_id, couple_id)
    references public.users(id, couple_id) on delete cascade
);

create table ledger_v2.user_preferences (
  user_id uuid primary key references public.users(id) on delete cascade,
  couple_id smallint not null references public.couples(id) on delete cascade,
  active_ledger_id uuid not null,
  updated_at timestamptz not null default now(),
  foreign key (user_id, couple_id)
    references public.users(id, couple_id),
  foreign key (active_ledger_id, couple_id)
    references ledger_v2.ledgers(id, couple_id)
);

create table ledger_v2.transactions (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  ledger_id uuid not null,
  type text not null check (type in ('expense', 'income', 'transfer')),
  amount_twd bigint not null check (amount_twd > 0),
  occurred_on date not null,
  description text not null check (length(description) between 1 and 120),
  category text check (category is null or length(category) between 1 and 40),
  note text check (note is null or length(note) <= 1000),
  split_method text not null default 'equal'
    check (split_method in ('none', 'equal', 'exact', 'percentage', 'weights')),
  status text not null default 'posted'
    check (status in ('posted', 'voided', 'deleted')),
  version integer not null default 1 check (version > 0),
  created_by_user_id uuid not null references public.users(id),
  idempotency_key text,
  legacy_group_id uuid,
  source_table text,
  source_id text,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, ledger_id, couple_id),
  foreign key (ledger_id, couple_id)
    references ledger_v2.ledgers(id, couple_id),
  check ((type = 'transfer' and split_method = 'none')
    or (type in ('expense', 'income') and split_method <> 'none')),
  check ((status = 'voided' and voided_at is not null)
    or (status <> 'voided')),
  foreign key (created_by_user_id, couple_id)
    references public.users(id, couple_id)
);

create unique index transactions_idempotency_idx
  on ledger_v2.transactions (couple_id, idempotency_key)
  where idempotency_key is not null;

create index transactions_ledger_date_idx
  on ledger_v2.transactions (ledger_id, occurred_on desc, created_at desc);

create table ledger_v2.transaction_payments (
  transaction_id uuid not null,
  ledger_id uuid not null,
  couple_id smallint not null,
  user_id uuid not null references public.users(id),
  amount_twd bigint not null check (amount_twd > 0),
  primary key (transaction_id, user_id),
  foreign key (transaction_id, ledger_id, couple_id)
    references ledger_v2.transactions(id, ledger_id, couple_id) on delete cascade,
  foreign key (user_id, couple_id)
    references public.users(id, couple_id)
);

create table ledger_v2.transaction_shares (
  transaction_id uuid not null,
  ledger_id uuid not null,
  couple_id smallint not null,
  user_id uuid not null references public.users(id),
  amount_twd bigint not null check (amount_twd >= 0),
  primary key (transaction_id, user_id),
  foreign key (transaction_id, ledger_id, couple_id)
    references ledger_v2.transactions(id, ledger_id, couple_id) on delete cascade,
  foreign key (user_id, couple_id)
    references public.users(id, couple_id)
);

create index transaction_payments_ledger_idx
  on ledger_v2.transaction_payments (ledger_id, user_id);
create index transaction_shares_ledger_idx
  on ledger_v2.transaction_shares (ledger_id, user_id);

create table ledger_v2.transaction_events (
  id bigint generated always as identity primary key,
  couple_id smallint not null references public.couples(id) on delete cascade,
  ledger_id uuid not null,
  transaction_id uuid,
  actor_user_id uuid not null references public.users(id),
  action text not null check (action in ('create', 'update', 'void', 'restore', 'delete')),
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now(),
  foreign key (ledger_id, couple_id)
    references ledger_v2.ledgers(id, couple_id) on delete cascade,
  foreign key (actor_user_id, couple_id)
    references public.users(id, couple_id)
);

create index transaction_events_ledger_idx
  on ledger_v2.transaction_events (ledger_id, created_at desc);

create table ledger_v2.command_receipts (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  ledger_id uuid,
  idempotency_key text not null,
  request_hash text not null,
  status text not null check (status in ('applied', 'rejected')),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_by_user_id uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  unique (couple_id, idempotency_key),
  foreign key (created_by_user_id, couple_id)
    references public.users(id, couple_id),
  foreign key (ledger_id, couple_id)
    references ledger_v2.ledgers(id, couple_id)
);

create table ledger_v2.proposals (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  ledger_id uuid,
  created_by_user_id uuid not null references public.users(id),
  ledger_version integer not null check (ledger_version > 0),
  digest text not null,
  commands jsonb not null check (jsonb_typeof(commands) = 'array'),
  status text not null default 'proposed'
    check (status in ('proposed', 'confirmed', 'cancelled', 'expired')),
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  result jsonb check (result is null or jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (created_by_user_id, couple_id)
    references public.users(id, couple_id),
  foreign key (ledger_id, couple_id)
    references ledger_v2.ledgers(id, couple_id)
);

create index proposals_pending_idx
  on ledger_v2.proposals (couple_id, status, expires_at);

create table ledger_v2.migration_batches (
  id uuid primary key default gen_random_uuid(),
  batch_key text not null unique,
  status text not null default 'planned'
    check (status in ('planned', 'running', 'verified', 'failed', 'rolled_back')),
  source_high_watermark timestamptz,
  summary jsonb check (summary is null or jsonb_typeof(summary) = 'object'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table ledger_v2.migration_map (
  id bigint generated always as identity primary key,
  batch_id uuid not null references ledger_v2.migration_batches(id) on delete cascade,
  source_table text not null check (source_table in ('groups', 'expenses', 'settlements')),
  source_id text not null,
  source_group_id uuid,
  ledger_id uuid,
  transaction_id uuid,
  mapping_kind text not null check (mapping_kind in ('ledger', 'transaction', 'excluded_mirror', 'excluded_private', 'quarantine')),
  source_row_hash text not null,
  created_at timestamptz not null default now(),
  unique (source_table, source_id),
  foreign key (ledger_id) references ledger_v2.ledgers(id),
  foreign key (transaction_id) references ledger_v2.transactions(id)
);

create table ledger_v2.migration_quarantine (
  id bigint generated always as identity primary key,
  batch_id uuid not null references ledger_v2.migration_batches(id) on delete cascade,
  source_table text not null,
  source_id text not null,
  reason text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);

create table ledger_v2.writer_control (
  couple_id smallint primary key references public.couples(id) on delete cascade,
  writer_epoch bigint not null default 0 check (writer_epoch >= 0),
  active_plane text not null default 'v1' check (active_plane in ('v1', 'v2')),
  mutation_fence boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into ledger_v2.writer_control (couple_id)
select id from public.couples
on conflict (couple_id) do nothing;

create or replace function ledger_v2.assert_ledger_shape(p_ledger_id uuid)
returns void
language plpgsql
set search_path = ledger_v2, public
as $$
declare
  member_count integer;
  default_count integer;
  default_weight bigint;
  ledger_couple smallint;
begin
  select couple_id into ledger_couple
  from ledger_v2.ledgers
  where id = p_ledger_id;

  if ledger_couple is null then
    return;
  end if;

  select count(*) into member_count
  from ledger_v2.ledger_members
  where ledger_id = p_ledger_id;
  if member_count <> 2 then
    raise exception 'ledger % must contain exactly two members', p_ledger_id
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from ledger_v2.ledger_members lm
    left join public.users u on u.id = lm.user_id and u.couple_id = ledger_couple
    where lm.ledger_id = p_ledger_id and u.id is null
  ) then
    raise exception 'ledger % contains a member outside its couple', p_ledger_id
      using errcode = '23514';
  end if;

  select count(*), coalesce(sum(weight), 0)
  into default_count, default_weight
  from ledger_v2.ledger_default_shares
  where ledger_id = p_ledger_id;
  if default_count <> 2 or default_weight <= 0 then
    raise exception 'ledger % must have two default split weights', p_ledger_id
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from ledger_v2.ledger_default_shares ds
    where ds.ledger_id = p_ledger_id
      and not exists (
        select 1 from ledger_v2.ledger_members lm
        where lm.ledger_id = ds.ledger_id and lm.user_id = ds.user_id
      )
  ) then
    raise exception 'ledger % default split contains a non-member', p_ledger_id
      using errcode = '23514';
  end if;
end;
$$;

create or replace function ledger_v2.assert_transaction_integrity()
returns trigger
language plpgsql
set search_path = ledger_v2, public
as $$
declare
  transaction_id_value uuid;
  tx ledger_v2.transactions%rowtype;
  payment_count integer;
  share_count integer;
  payment_sum bigint;
  share_sum bigint;
  payment_user uuid;
  share_user uuid;
begin
  if tg_op = 'DELETE' then
    transaction_id_value := (
      case
        when tg_table_name = 'transactions' then to_jsonb(old)->>'id'
        else to_jsonb(old)->>'transaction_id'
      end
    )::uuid;
  else
    transaction_id_value := (
      case
        when tg_table_name = 'transactions' then to_jsonb(new)->>'id'
        else to_jsonb(new)->>'transaction_id'
      end
    )::uuid;
  end if;

  select * into tx from ledger_v2.transactions where id = transaction_id_value;
  if not found then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if exists (
    select 1
    from ledger_v2.transaction_payments p
    left join ledger_v2.ledger_members lm
      on lm.ledger_id = tx.ledger_id and lm.user_id = p.user_id
    left join public.users u
      on u.id = p.user_id and u.couple_id = tx.couple_id
    where p.transaction_id = tx.id
      and (p.ledger_id <> tx.ledger_id or p.couple_id <> tx.couple_id
        or lm.user_id is null or u.id is null)
  ) or exists (
    select 1
    from ledger_v2.transaction_shares s
    left join ledger_v2.ledger_members lm
      on lm.ledger_id = tx.ledger_id and lm.user_id = s.user_id
    left join public.users u
      on u.id = s.user_id and u.couple_id = tx.couple_id
    where s.transaction_id = tx.id
      and (s.ledger_id <> tx.ledger_id or s.couple_id <> tx.couple_id
        or lm.user_id is null or u.id is null)
  ) then
    raise exception 'transaction % contains an out-of-scope participant', tx.id
      using errcode = '23514';
  end if;

  select count(*), coalesce(sum(amount_twd), 0)
  into payment_count, payment_sum
  from ledger_v2.transaction_payments
  where transaction_id = tx.id;
  select count(*), coalesce(sum(amount_twd), 0)
  into share_count, share_sum
  from ledger_v2.transaction_shares
  where transaction_id = tx.id;

  select user_id into payment_user
  from ledger_v2.transaction_payments
  where transaction_id = tx.id
  order by user_id
  limit 1;
  select user_id into share_user
  from ledger_v2.transaction_shares
  where transaction_id = tx.id
  order by user_id
  limit 1;

  if payment_sum <> tx.amount_twd or share_sum <> tx.amount_twd then
    raise exception 'transaction % payments and shares must each sum to amount_twd', tx.id
      using errcode = '23514';
  end if;

  if tx.type in ('expense', 'income') then
    if share_count <> 2 or payment_count not between 1 and 2 then
      raise exception 'transaction % requires two shares and one or two payments', tx.id
        using errcode = '23514';
    end if;
  elsif payment_count <> 1 or share_count <> 1 or payment_user = share_user then
    raise exception 'transfer % requires different single payer and receiver', tx.id
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function ledger_v2.prevent_posted_financial_mutation()
returns trigger
language plpgsql
set search_path = ledger_v2, public
as $$
begin
  if old.status = 'posted' and (
    new.type is distinct from old.type
    or new.amount_twd is distinct from old.amount_twd
    or new.couple_id is distinct from old.couple_id
    or new.ledger_id is distinct from old.ledger_id
  ) then
    raise exception 'posted transaction financial fields are immutable; void and replace it'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function ledger_v2.prevent_posted_child_mutation()
returns trigger
language plpgsql
set search_path = ledger_v2, public
as $$
declare
  transaction_status text;
begin
  select status into transaction_status
  from ledger_v2.transactions
  where id = coalesce(
    case when tg_op = 'DELETE' then to_jsonb(old)->>'transaction_id' else to_jsonb(new)->>'transaction_id' end,
    ''
  )::uuid;
  if transaction_status = 'posted' and tg_op in ('UPDATE', 'DELETE') then
    raise exception 'posted transaction payments and shares are immutable; void and replace it'
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function ledger_v2.assert_ledger_shape_trigger()
returns trigger
language plpgsql
set search_path = ledger_v2, public
as $$
declare
  ledger_id_value uuid;
begin
  if tg_op = 'DELETE' then
    ledger_id_value := (
      case
        when tg_table_name = 'ledgers' then to_jsonb(old)->>'id'
        else to_jsonb(old)->>'ledger_id'
      end
    )::uuid;
  else
    ledger_id_value := (
      case
        when tg_table_name = 'ledgers' then to_jsonb(new)->>'id'
        else to_jsonb(new)->>'ledger_id'
      end
    )::uuid;
  end if;
  perform ledger_v2.assert_ledger_shape(ledger_id_value);
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create constraint trigger ledger_shape_on_ledger
after insert or update on ledger_v2.ledgers
deferrable initially deferred
for each row execute function ledger_v2.assert_ledger_shape_trigger();

create constraint trigger ledger_shape_on_member
after insert or update or delete on ledger_v2.ledger_members
deferrable initially deferred
for each row execute function ledger_v2.assert_ledger_shape_trigger();

create constraint trigger ledger_shape_on_default
after insert or update or delete on ledger_v2.ledger_default_shares
deferrable initially deferred
for each row execute function ledger_v2.assert_ledger_shape_trigger();

create constraint trigger transaction_integrity_on_header
after insert or update or delete on ledger_v2.transactions
deferrable initially deferred
for each row execute function ledger_v2.assert_transaction_integrity();

create constraint trigger transaction_integrity_on_payment
after insert or update or delete on ledger_v2.transaction_payments
deferrable initially deferred
for each row execute function ledger_v2.assert_transaction_integrity();

create constraint trigger transaction_integrity_on_share
after insert or update or delete on ledger_v2.transaction_shares
deferrable initially deferred
for each row execute function ledger_v2.assert_transaction_integrity();

create trigger prevent_posted_financial_mutation
before update of type, amount_twd, couple_id, ledger_id on ledger_v2.transactions
for each row execute function ledger_v2.prevent_posted_financial_mutation();

create trigger prevent_posted_payment_mutation
before update or delete on ledger_v2.transaction_payments
for each row execute function ledger_v2.prevent_posted_child_mutation();

create trigger prevent_posted_share_mutation
before update or delete on ledger_v2.transaction_shares
for each row execute function ledger_v2.prevent_posted_child_mutation();

alter table ledger_v2.ledgers enable row level security;
alter table ledger_v2.ledger_members enable row level security;
alter table ledger_v2.ledger_default_shares enable row level security;
alter table ledger_v2.user_preferences enable row level security;
alter table ledger_v2.transactions enable row level security;
alter table ledger_v2.transaction_payments enable row level security;
alter table ledger_v2.transaction_shares enable row level security;
alter table ledger_v2.transaction_events enable row level security;
alter table ledger_v2.command_receipts enable row level security;
alter table ledger_v2.proposals enable row level security;
alter table ledger_v2.migration_batches enable row level security;
alter table ledger_v2.migration_map enable row level security;
alter table ledger_v2.migration_quarantine enable row level security;
alter table ledger_v2.writer_control enable row level security;

revoke all on all tables in schema ledger_v2 from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema ledger_v2 to service_role;
grant usage, select on all sequences in schema ledger_v2 to service_role;

-- The application ACID pool uses the least-privileged ledger_runtime role,
-- not Supabase's HTTP service_role. Keep the schema private to these two
-- server-side roles; the writer-control gate remains the authority for V2
-- mutations and the V1 fence is enforced by database triggers after cutover.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'ledger_runtime') then
    execute 'grant usage on schema ledger_v2 to ledger_runtime';
    execute 'grant select, insert, update, delete on all tables in schema ledger_v2 to ledger_runtime';
    execute 'grant usage, select on all sequences in schema ledger_v2 to ledger_runtime';
  end if;
end;
$$;
