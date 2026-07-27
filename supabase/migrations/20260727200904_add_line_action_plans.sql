begin;

create unique index users_id_couple_line_plan_uidx
  on public.users (id, couple_id);
create unique index groups_id_couple_line_plan_uidx
  on public.groups (id, couple_id);

create table public.line_action_plans (
  source_event_id text primary key
    check (length(source_event_id) between 1 and 255),
  couple_id smallint not null,
  group_id uuid not null,
  user_id uuid not null,
  plan_version smallint not null default 1
    check (plan_version = 1),
  result jsonb not null
    check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (user_id, couple_id)
    references public.users(id, couple_id) on delete cascade,
  foreign key (group_id, couple_id)
    references public.groups(id, couple_id) on delete cascade
);

comment on table public.line_action_plans is
  'Immutable first financial action plan for a LINE webhook event. Redeliveries replay this exact plan instead of asking the model again.';

create index line_action_plans_created_at_idx
  on public.line_action_plans (created_at desc);

alter table public.line_action_plans enable row level security;
revoke all on public.line_action_plans
  from anon, authenticated, service_role;
grant select, insert on public.line_action_plans to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'ledger_runtime') then
    execute 'revoke all on public.line_action_plans from ledger_runtime';
  end if;
end;
$$;

commit;
