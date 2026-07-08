-- agent_events: write-behind audit log for all agent interactions.
-- Every LINE message, LIFF action, and cron job that touches the agent
-- surface writes an event here AFTER the main business logic completes.
-- This is strictly an audit/observability layer — failures here never
-- block the primary write path.

create table public.agent_events (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  group_id uuid references public.groups(id),
  user_id uuid not null references public.users(id),
  source text not null check (source in ('line', 'liff', 'cron', 'system')),
  source_event_id text,
  kind text not null check (kind in (
    'text_expense', 'text_query', 'text_other',
    'image_rejected', 'audio_transcribed',
    'needs_group', 'action_executed', 'action_failed',
    'task_created', 'cron_recurring', 'cron_report'
  )),
  status text not null default 'completed' check (status in (
    'completed', 'failed', 'needs_group', 'rejected'
  )),
  input_text text,
  reply_text text,
  payload jsonb check (payload is null or jsonb_typeof(payload) = 'object'),
  pending_action_id uuid references public.pending_actions(id),
  task_id uuid references public.assistant_tasks(id),
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

-- Unique on non-null source_event_id to enable idempotent event logging
create unique index agent_events_source_event_uniq
  on public.agent_events (source, source_event_id)
  where source_event_id is not null;

create index agent_events_couple_recent_idx
  on public.agent_events (couple_id, created_at desc);

create index agent_events_user_recent_idx
  on public.agent_events (user_id, created_at desc);

alter table public.agent_events enable row level security;
revoke all on public.agent_events from anon, authenticated;
grant select, insert, update on public.agent_events to service_role;
