-- accountant_sessions: multi-turn conversation state for agentic accountant
-- Sessions expire after 2 hours of inactivity (enforced in app code)

create table public.accountant_sessions (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  group_id uuid not null references public.groups(id),
  user_id uuid not null references public.users(id) on delete cascade,
  messages jsonb not null default '[]'::jsonb check (jsonb_typeof(messages) = 'array'),
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);

create index accountant_sessions_user_idx
  on public.accountant_sessions (user_id, last_active_at desc);

alter table public.accountant_sessions enable row level security;
revoke all on public.accountant_sessions from anon, authenticated;
grant select, insert, update, delete on public.accountant_sessions to service_role;
