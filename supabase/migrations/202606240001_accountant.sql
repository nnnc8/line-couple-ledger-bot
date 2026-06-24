alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('expense', 'settlement', 'budget', 'recurring', 'receipt', 'accountant'));

create table public.accountant_reports (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  group_id uuid references public.groups(id),
  owner_user_id uuid references public.users(id) on delete cascade,
  report_type text not null check (report_type in ('manual_question', 'monthly_health', 'cleanup_review')),
  scope text not null check (scope in ('shared', 'private', 'combined')),
  month date not null check (month = date_trunc('month', month)::date),
  question text check (question is null or length(question) between 1 and 500),
  title text not null check (length(title) between 1 and 80),
  summary text not null check (length(summary) between 1 and 1000),
  facts jsonb not null check (jsonb_typeof(facts) = 'object'),
  findings jsonb not null default '[]'::jsonb check (jsonb_typeof(findings) = 'array'),
  suggestions jsonb not null default '[]'::jsonb check (jsonb_typeof(suggestions) = 'array'),
  source text not null check (source in ('llm', 'fallback')),
  dedupe_key text not null unique,
  created_at timestamptz not null default now(),
  check (
    (scope = 'shared' and group_id is not null and owner_user_id is null)
    or (scope = 'private' and group_id is null and owner_user_id is not null)
    or (scope = 'combined' and group_id is not null and owner_user_id is not null)
  )
);

create index accountant_reports_group_idx
  on public.accountant_reports (group_id, created_at desc)
  where owner_user_id is null;
create index accountant_reports_owner_idx
  on public.accountant_reports (owner_user_id, created_at desc);

alter table public.accountant_reports enable row level security;
revoke all on public.accountant_reports from anon, authenticated;
grant select, insert, update, delete on public.accountant_reports to service_role;
