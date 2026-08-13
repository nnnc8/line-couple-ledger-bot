-- V2 workflow primitives. Additive and gated; no V1 table is rewritten.

-- The V1 bucket predates V2 PDF receipts. Keep the same private bucket and
-- widen only its allow-list; V2 still enforces the 10 MB/file boundary.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts', 'receipts', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table ledger_v2.recurring_rules (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  ledger_id uuid not null,
  created_by_user_id uuid not null references public.users(id),
  name text not null check (length(name) between 1 and 120),
  amount_twd bigint not null check (amount_twd > 0),
  frequency text not null check (frequency in ('weekly', 'monthly', 'yearly')),
  anchor_day smallint not null check (anchor_day between 1 and 31),
  next_run_date date not null,
  end_date date,
  active boolean not null default true,
  split_method text not null check (split_method in ('equal', 'exact', 'percentage', 'weights')),
  payments jsonb not null check (jsonb_typeof(payments) = 'array'),
  shares jsonb not null check (jsonb_typeof(shares) = 'array'),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (created_by_user_id, couple_id)
    references public.users(id, couple_id),
  unique (id, ledger_id, couple_id),
  foreign key (ledger_id, couple_id)
    references ledger_v2.ledgers(id, couple_id) on delete cascade,
  -- Once the final occurrence has posted, next_run_date may move beyond the
  -- end date while the rule is inactive. Active rules still cannot point
  -- beyond their configured end.
  check (end_date is null or end_date >= next_run_date or not active)
);

create index recurring_rules_due_idx
  on ledger_v2.recurring_rules (next_run_date, id)
  where active;

create table ledger_v2.recurring_runs (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references ledger_v2.recurring_rules(id) on delete cascade,
  scheduled_for date not null,
  status text not null check (status in ('claimed', 'applied', 'failed', 'skipped')),
  transaction_id uuid references ledger_v2.transactions(id),
  error_code text,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (rule_id, scheduled_for)
);

create table ledger_v2.attachments (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  ledger_id uuid not null,
  transaction_id uuid,
  owner_user_id uuid not null references public.users(id),
  storage_path text not null unique check (length(storage_path) between 1 and 500),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  status text not null default 'uploaded' check (status in ('uploaded', 'ready', 'failed', 'deleted')),
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (owner_user_id, couple_id)
    references public.users(id, couple_id),
  foreign key (ledger_id, couple_id)
    references ledger_v2.ledgers(id, couple_id) on delete cascade,
  foreign key (transaction_id, ledger_id, couple_id)
    references ledger_v2.transactions(id, ledger_id, couple_id) on delete cascade
);

create index attachments_transaction_idx on ledger_v2.attachments (transaction_id, created_at desc);

create table ledger_v2.line_inbox (
  id bigint generated always as identity primary key,
  provider text not null default 'line',
  channel text not null,
  webhook_event_id text not null,
  source_user_id text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  status text not null default 'received' check (status in ('received', 'processing', 'processed', 'failed', 'ignored')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, channel, webhook_event_id)
);

create index line_inbox_worker_idx
  on ledger_v2.line_inbox (status, next_attempt_at, received_at);

create table ledger_v2.notification_outbox (
  id bigint generated always as identity primary key,
  couple_id smallint not null references public.couples(id) on delete cascade,
  recipient_user_id uuid not null references public.users(id) on delete cascade,
  kind text not null,
  dedupe_key text not null unique,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index notification_outbox_worker_idx
  on ledger_v2.notification_outbox (status, next_attempt_at, created_at);

alter table ledger_v2.recurring_rules enable row level security;
alter table ledger_v2.recurring_runs enable row level security;
alter table ledger_v2.attachments enable row level security;
alter table ledger_v2.line_inbox enable row level security;
alter table ledger_v2.notification_outbox enable row level security;

revoke all on all tables in schema ledger_v2 from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema ledger_v2 to service_role;
grant usage, select on all sequences in schema ledger_v2 to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'ledger_runtime') then
    execute 'grant usage on schema ledger_v2 to ledger_runtime';
    execute 'grant select, insert, update, delete on all tables in schema ledger_v2 to ledger_runtime';
    execute 'grant usage, select on all sequences in schema ledger_v2 to ledger_runtime';
  end if;
end;
$$;

-- Once a couple is cut over, legacy financial tables must not become a second
-- accounting writer. The guard is intentionally database-side so old API,
-- LINE, cron, or an ad-hoc service cannot silently reintroduce V1 rows.
create or replace function ledger_v2.prevent_v1_financial_write()
returns trigger
language plpgsql
security definer
set search_path = ledger_v2, public
as $$
declare
  target_couple smallint;
  control ledger_v2.writer_control%rowtype;
begin
  if tg_table_name = 'expense_splits' then
    select e.couple_id into target_couple
    from public.expenses e
    where e.id = coalesce(
      case when tg_op = 'DELETE' then to_jsonb(old)->>'expense_id' else to_jsonb(new)->>'expense_id' end,
      ''
    )::uuid;
  else
    target_couple := coalesce(
      case when tg_op = 'DELETE' then to_jsonb(old)->>'couple_id' else to_jsonb(new)->>'couple_id' end,
      ''
    )::smallint;
  end if;

  select * into control
  from ledger_v2.writer_control
  where couple_id = target_couple;

  if control.active_plane = 'v2' or control.mutation_fence then
    raise exception 'V1 financial writer is fenced for couple %', target_couple
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function ledger_v2.prevent_v1_financial_write() from public, anon, authenticated;
grant execute on function ledger_v2.prevent_v1_financial_write() to service_role;

create trigger prevent_v1_expense_write
before insert or update or delete on public.expenses
for each row execute function ledger_v2.prevent_v1_financial_write();

create trigger prevent_v1_expense_split_write
before insert or update or delete on public.expense_splits
for each row execute function ledger_v2.prevent_v1_financial_write();

create trigger prevent_v1_settlement_write
before insert or update or delete on public.settlements
for each row execute function ledger_v2.prevent_v1_financial_write();

create trigger prevent_v1_group_write
before insert or update or delete on public.groups
for each row execute function ledger_v2.prevent_v1_financial_write();
