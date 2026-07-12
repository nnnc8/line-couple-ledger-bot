-- P0 repair before finance-v2 migration.
-- This migration is intentionally idempotent for schema/function changes.

-- 1. Prevent private secretary messages from sharing a couple/group session.
alter table public.secretary_sessions
  add column if not exists scope text not null default 'group',
  add column if not exists user_id uuid references public.users(id);

alter table public.secretary_sessions
  drop constraint if exists secretary_sessions_scope_check;

alter table public.secretary_sessions
  add constraint secretary_sessions_scope_check
  check (
    (scope = 'group' and user_id is null)
    or (scope = 'user' and user_id is not null)
  );

-- Existing couple-level transcripts cannot be safely attributed to one user.
-- They are ephemeral context, so invalidate them instead of risking disclosure.
delete from public.secretary_sessions;

create index if not exists secretary_sessions_scope_lookup_idx
  on public.secretary_sessions (couple_id, group_id, scope, user_id, last_active_at desc);

create unique index if not exists secretary_sessions_scope_unique_idx
  on public.secretary_sessions (
    couple_id,
    group_id,
    scope,
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- 2. Make derived private mirrors follow every positive split, not only the
-- source creator and mirrors that already exist.
create or replace function public.sync_private_mirrors_for_expense(p_source_expense_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  source_row public.expenses%rowtype;
  owner_id uuid;
  share_twd bigint;
  mirror_id uuid;
begin
  select * into source_row
  from public.expenses
  where id = p_source_expense_id and ledger = 'shared';
  if not found then
    return;
  end if;

  for owner_id in
    select user_id
    from public.expense_splits
    where expense_id = source_row.id and amount_twd > 0
    union
    select created_by_user_id
    from public.expenses
    where mirror_kind = 'shared_share'
      and mirror_source_expense_id = source_row.id
  loop
    select amount_twd into share_twd
    from public.expense_splits
    where expense_id = source_row.id and user_id = owner_id;

    if coalesce(share_twd, 0) <= 0 then
      update public.expenses
      set deleted_at = coalesce(source_row.deleted_at, now()),
        deleted_by_user_id = source_row.deleted_by_user_id,
        version = version + 1,
        updated_at = now()
      where mirror_kind = 'shared_share'
        and mirror_source_expense_id = source_row.id
        and created_by_user_id = owner_id;
      continue;
    end if;

    insert into public.expenses (
      couple_id, group_id, ledger, description, merchant, notes, tag,
      amount_twd, paid_by_user_id, created_by_user_id, expense_date, split_method,
      source_action_id, mirror_kind, mirror_source_expense_id, deleted_at, deleted_by_user_id
    ) values (
      source_row.couple_id, null, 'private', source_row.description, source_row.merchant,
      source_row.notes, source_row.tag, share_twd,
      owner_id, owner_id, source_row.expense_date, 'equal', null, 'shared_share',
      source_row.id, source_row.deleted_at, source_row.deleted_by_user_id
    )
    on conflict (mirror_source_expense_id, created_by_user_id)
      where mirror_kind = 'shared_share'
    do update set
      description = excluded.description,
      merchant = excluded.merchant,
      notes = excluded.notes,
      tag = excluded.tag,
      amount_twd = excluded.amount_twd,
      paid_by_user_id = excluded.paid_by_user_id,
      expense_date = excluded.expense_date,
      split_method = excluded.split_method,
      deleted_at = excluded.deleted_at,
      deleted_by_user_id = excluded.deleted_by_user_id,
      version = public.expenses.version + 1,
      updated_at = now()
    returning id into mirror_id;

    insert into public.expense_splits (expense_id, user_id, amount_twd)
    values (mirror_id, owner_id, share_twd)
    on conflict (expense_id, user_id)
    do update set amount_twd = excluded.amount_twd;
  end loop;
end;
$$;

revoke all on function public.sync_private_mirrors_for_expense(uuid) from public, anon, authenticated;
grant execute on function public.sync_private_mirrors_for_expense(uuid) to service_role;

-- Keep the backfill in this transaction and record each newly derived mirror.
create temporary table finance_v2_missing_mirrors on commit drop as
select
  e.couple_id,
  e.group_id,
  e.created_by_user_id as actor_user_id,
  e.id as source_expense_id,
  s.user_id as mirror_owner_id
from public.expenses e
join public.expense_splits s on s.expense_id = e.id and s.amount_twd > 0
where e.ledger = 'shared'
  and e.deleted_at is null
  and not exists (
    select 1
    from public.expenses m
    where m.mirror_kind = 'shared_share'
      and m.mirror_source_expense_id = e.id
      and m.created_by_user_id = s.user_id
      and m.deleted_at is null
  );

do $$
declare
  source_id uuid;
begin
  for source_id in
    select distinct source_expense_id from finance_v2_missing_mirrors
  loop
    perform public.sync_private_mirrors_for_expense(source_id);
  end loop;
end;
$$;

insert into public.activity_events (
  couple_id, group_id, actor_user_id, entity_type, entity_id, action, before_state, after_state
)
select
  m.couple_id,
  m.group_id,
  m.actor_user_id,
  'expense',
  mirror.id::text,
  'create',
  null,
  jsonb_build_object('repair', 'finance_v2_private_mirror', 'expense', to_jsonb(mirror))
from finance_v2_missing_mirrors m
join public.expenses mirror
  on mirror.mirror_kind = 'shared_share'
 and mirror.mirror_source_expense_id = m.source_expense_id
 and mirror.created_by_user_id = m.mirror_owner_id
where mirror.deleted_at is null;

-- 3. Close stale confirmation rows without touching confirmed/cancelled data.
update public.pending_actions
set status = 'expired', processed_at = now()
where status = 'pending' and expires_at <= now();
