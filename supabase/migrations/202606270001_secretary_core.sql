-- secretary_sessions: couple-level conversation state for secretary agent
-- Separate from accountant_sessions (which is per-user) so the secretary
-- can maintain shared context across both partners' messages.

create table public.secretary_sessions (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  group_id uuid not null references public.groups(id),
  messages jsonb not null default '[]'::jsonb check (jsonb_typeof(messages) = 'array'),
  last_active_user_id uuid references public.users(id),
  last_active_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index secretary_sessions_couple_group_idx
  on public.secretary_sessions (couple_id, group_id, last_active_at desc);

alter table public.secretary_sessions enable row level security;
revoke all on public.secretary_sessions from anon, authenticated;
grant select, insert, update, delete on public.secretary_sessions to service_role;

-- assistant_tasks: secretary's to-do queue
-- Tracks items that need user attention: confirmations, reviews, suggestions.

create table public.assistant_tasks (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  group_id uuid not null references public.groups(id),
  owner_user_id uuid references public.users(id),
  type text not null check (type in (
    'confirm_expense',
    'fix_uncertain_receipt',
    'review_unmatched_bank_items',
    'settlement_suggestion',
    'budget_warning',
    'duplicate_expense_review',
    'merchant_rule_suggestion',
    'missing_daily_entry',
    'category_cleanup',
    'recurring_expense_review'
  )),
  title text not null check (length(title) between 1 and 200),
  summary text,
  payload jsonb check (payload is null or jsonb_typeof(payload) = 'object'),
  status text not null default 'open' check (status in (
    'open', 'snoozed', 'done', 'dismissed', 'expired'
  )),
  priority text not null default 'normal' check (priority in (
    'low', 'normal', 'high'
  )),
  due_at timestamptz,
  snooze_until timestamptz,
  source text check (source in (
    'line', 'cron', 'receipt', 'bank_import', 'accountant', 'user'
  )),
  related_pending_action_id uuid references public.pending_actions(id),
  related_expense_id uuid references public.expenses(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index assistant_tasks_couple_status_idx
  on public.assistant_tasks (couple_id, status, priority, created_at desc);

create index assistant_tasks_group_idx
  on public.assistant_tasks (group_id, status);

alter table public.assistant_tasks enable row level security;
revoke all on public.assistant_tasks from anon, authenticated;
grant select, insert, update, delete on public.assistant_tasks to service_role;

-- assistant_memories: user preferences, merchant rules, routines, and learned patterns.

create table public.assistant_memories (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  group_id uuid references public.groups(id),
  user_id uuid references public.users(id),
  scope text not null check (scope in ('user', 'couple', 'group')),
  kind text not null check (kind in (
    'merchant_rule', 'category_rule', 'split_rule', 'routine', 'wording_preference'
  )),
  key text not null check (length(key) between 1 and 200),
  value jsonb not null check (jsonb_typeof(value) = 'object'),
  confidence float not null default 1.0 check (confidence between 0 and 1),
  source text check (source in ('line', 'cron', 'accountant', 'user', 'system')),
  approved_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index assistant_memories_couple_idx
  on public.assistant_memories (couple_id, kind, key);

create index assistant_memories_user_idx
  on public.assistant_memories (user_id, kind);

alter table public.assistant_memories enable row level security;
revoke all on public.assistant_memories from anon, authenticated;
grant select, insert, update, delete on public.assistant_memories to service_role;
