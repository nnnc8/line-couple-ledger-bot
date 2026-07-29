begin;

create table public.line_menu_amount_drafts (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null,
  group_id uuid,
  requested_by_user_id uuid not null,
  draft_type text not null
    check (draft_type in ('expense', 'transfer')),
  draft_version smallint not null default 1
    check (draft_version = 1),
  payload jsonb not null
    check (jsonb_typeof(payload) = 'object'),
  status text not null default 'active'
    check (status in ('active', 'consumed', 'cancelled', 'expired', 'superseded')),
  started_by_event_id text not null unique
    check (length(started_by_event_id) between 1 and 255),
  finished_by_event_id text unique
    check (
      finished_by_event_id is null
      or length(finished_by_event_id) between 1 and 255
    ),
  amount_twd bigint
    check (amount_twd between 1 and 100000000),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (requested_by_user_id, couple_id)
    references public.users(id, couple_id) on delete cascade,
  foreign key (group_id, couple_id)
    references public.groups(id, couple_id) on delete cascade,
  check (
    (
      draft_type = 'transfer'
      and payload ->> 'type' = 'transfer'
      and group_id is not null
    )
    or (
      draft_type = 'expense'
      and payload ->> 'type' = 'expense'
      and (
        (payload ->> 'ledger' = 'private' and group_id is null)
        or (payload ->> 'ledger' = 'shared' and group_id is not null)
      )
    )
  ),
  check (
    (
      status = 'active'
      and finished_by_event_id is null
      and amount_twd is null
      and finished_at is null
    )
    or (
      status = 'consumed'
      and finished_by_event_id is not null
      and amount_twd is not null
      and finished_at is not null
    )
    or (
      status = 'cancelled'
      and finished_by_event_id is not null
      and amount_twd is null
      and finished_at is not null
    )
    or (
      status in ('expired', 'superseded')
      and finished_by_event_id is null
      and amount_twd is null
      and finished_at is not null
    )
  )
);

create unique index line_menu_amount_drafts_one_active_user_idx
  on public.line_menu_amount_drafts (requested_by_user_id)
  where status = 'active';

create index line_menu_amount_drafts_user_created_idx
  on public.line_menu_amount_drafts (requested_by_user_id, created_at desc);

create index line_menu_amount_drafts_terminal_cleanup_idx
  on public.line_menu_amount_drafts (finished_at)
  where status <> 'active';

alter table public.line_menu_amount_drafts enable row level security;

revoke all on table public.line_menu_amount_drafts
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on table public.line_menu_amount_drafts
  to service_role;

create function public.start_line_menu_amount_draft(
  p_couple_id smallint,
  p_user_id uuid,
  p_group_id uuid,
  p_draft_type text,
  p_payload jsonb,
  p_source_event_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_row public.line_menu_amount_drafts%rowtype;
  draft_row public.line_menu_amount_drafts%rowtype;
begin
  perform 1
  from public.users
  where id = p_user_id
    and couple_id = p_couple_id
  for update;
  if not found then
    raise exception 'line_menu_draft_owner_invalid';
  end if;

  select *
  into existing_row
  from public.line_menu_amount_drafts
  where started_by_event_id = p_source_event_id
  for update;

  if found then
    if existing_row.couple_id <> p_couple_id
      or existing_row.requested_by_user_id <> p_user_id
      or existing_row.group_id is distinct from p_group_id
      or existing_row.draft_type <> p_draft_type
      or existing_row.payload <> p_payload
    then
      raise exception 'line_menu_draft_event_conflict';
    end if;
    return to_jsonb(existing_row);
  end if;

  if p_draft_type is null
    or p_draft_type not in ('expense', 'transfer')
    or p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or p_source_event_id is null
    or length(p_source_event_id) not between 1 and 255
    or (p_draft_type = 'transfer' and p_group_id is null)
  then
    raise exception 'line_menu_draft_invalid';
  end if;

  if p_group_id is not null then
    perform 1
    from public.groups
    where id = p_group_id
      and couple_id = p_couple_id
      and archived_at is null;
    if not found then
      raise exception 'line_menu_draft_group_invalid';
    end if;
  end if;

  update public.line_menu_amount_drafts
  set status = 'expired',
    finished_at = now(),
    updated_at = now()
  where requested_by_user_id = p_user_id
    and status = 'active'
    and expires_at <= now();

  update public.line_menu_amount_drafts
  set status = 'superseded',
    finished_at = now(),
    updated_at = now()
  where requested_by_user_id = p_user_id
    and status = 'active';

  insert into public.line_menu_amount_drafts (
    couple_id,
    group_id,
    requested_by_user_id,
    draft_type,
    payload,
    started_by_event_id
  )
  values (
    p_couple_id,
    p_group_id,
    p_user_id,
    p_draft_type,
    p_payload,
    p_source_event_id
  )
  returning * into draft_row;

  return to_jsonb(draft_row);
end;
$$;

create function public.finish_line_menu_amount_draft(
  p_couple_id smallint,
  p_user_id uuid,
  p_source_event_id text,
  p_status text,
  p_amount_twd bigint default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_row public.line_menu_amount_drafts%rowtype;
  draft_row public.line_menu_amount_drafts%rowtype;
begin
  perform 1
  from public.users
  where id = p_user_id
    and couple_id = p_couple_id
  for update;
  if not found then
    raise exception 'line_menu_draft_owner_invalid';
  end if;

  if p_status is null
    or p_status not in ('consumed', 'cancelled')
    or p_source_event_id is null
    or length(p_source_event_id) not between 1 and 255
    or (
      p_status = 'consumed'
      and (
        p_amount_twd is null
        or p_amount_twd not between 1 and 100000000
      )
    )
    or (p_status = 'cancelled' and p_amount_twd is not null)
  then
    raise exception 'line_menu_draft_finish_invalid';
  end if;

  select *
  into existing_row
  from public.line_menu_amount_drafts
  where finished_by_event_id = p_source_event_id
  for update;

  if found then
    if existing_row.couple_id <> p_couple_id
      or existing_row.requested_by_user_id <> p_user_id
      or existing_row.status <> p_status
      or existing_row.amount_twd is distinct from p_amount_twd
    then
      raise exception 'line_menu_draft_event_conflict';
    end if;
    return to_jsonb(existing_row);
  end if;

  update public.line_menu_amount_drafts
  set status = 'expired',
    finished_at = now(),
    updated_at = now()
  where requested_by_user_id = p_user_id
    and status = 'active'
    and expires_at <= now();

  select *
  into draft_row
  from public.line_menu_amount_drafts
  where requested_by_user_id = p_user_id
    and status = 'active'
  for update;

  if not found then
    return null;
  end if;

  update public.line_menu_amount_drafts
  set status = p_status,
    finished_by_event_id = p_source_event_id,
    amount_twd = p_amount_twd,
    finished_at = now(),
    updated_at = now()
  where id = draft_row.id
  returning * into draft_row;

  return to_jsonb(draft_row);
end;
$$;

revoke execute on function public.start_line_menu_amount_draft(
  smallint, uuid, uuid, text, jsonb, text
) from public, anon, authenticated;
revoke execute on function public.finish_line_menu_amount_draft(
  smallint, uuid, text, text, bigint
) from public, anon, authenticated;

grant execute on function public.start_line_menu_amount_draft(
  smallint, uuid, uuid, text, jsonb, text
) to service_role;
grant execute on function public.finish_line_menu_amount_draft(
  smallint, uuid, text, text, bigint
) to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'ledger_runtime') then
    execute 'revoke all on table public.line_menu_amount_drafts from ledger_runtime';
    execute 'revoke execute on function public.start_line_menu_amount_draft(smallint, uuid, uuid, text, jsonb, text) from ledger_runtime';
    execute 'revoke execute on function public.finish_line_menu_amount_draft(smallint, uuid, text, text, bigint) from ledger_runtime';
  end if;
end;
$$;

commit;
