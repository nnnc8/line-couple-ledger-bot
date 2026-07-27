-- First-class v1 transfers continue to use settlements so there is one source
-- of truth for shared balances. Transfers are not expenses and never create
-- expense splits or private mirrors.

alter type public.pending_action_type add value if not exists 'transfer';
alter type public.pending_action_type add value if not exists 'void_settlement';

alter table public.settlements
  add column intent text not null default 'settle',
  add column occurred_on date,
  add column notes text,
  add column voided_at timestamptz,
  add column voided_by_user_id uuid references public.users(id),
  add column void_source_action_id uuid unique references public.pending_actions(id),
  add column version integer not null default 1;

update public.settlements
set occurred_on = (created_at at time zone 'Asia/Taipei')::date
where occurred_on is null;

alter table public.settlements
  alter column occurred_on set not null,
  add constraint settlements_intent_check
    check (intent in ('settle', 'transfer')),
  add constraint settlements_notes_check
    check (notes is null or length(notes) <= 200),
  add constraint settlements_version_check
    check (version > 0),
  add constraint settlements_void_fields_check
    check (
      (voided_at is null and voided_by_user_id is null and void_source_action_id is null)
      or
      (voided_at is not null and voided_by_user_id is not null and void_source_action_id is not null)
    );

alter table public.settlements
  drop constraint settlements_amount_twd_check;
alter table public.settlements
  add constraint settlements_amount_twd_check
    check (amount_twd between 1 and 100000000);

create index settlements_couple_occurred_idx
  on public.settlements (couple_id, occurred_on desc, created_at desc);

alter table public.pending_actions
  add column request_fingerprint text;

alter table public.pending_actions
  add constraint pending_actions_request_fingerprint_check
    check (
      request_fingerprint is null
      or request_fingerprint ~ '^[0-9a-f]{64}$'
    );

drop index public.pending_actions_idempotency_idx;
create unique index pending_actions_idempotency_idx
  on public.pending_actions (
    requested_by_user_id,
    action_type,
    idempotency_key
  )
  where idempotency_key is not null;

create or replace function public.group_balances(p_group_id uuid)
returns table (user_id uuid, balance_twd bigint)
language sql security definer set search_path = public stable as $$
  select u.id,
    coalesce((select sum(e.amount_twd) from public.expenses e
      where e.group_id = p_group_id and e.ledger = 'shared' and e.deleted_at is null and e.paid_by_user_id = u.id), 0)
    - coalesce((select sum(es.amount_twd) from public.expense_splits es
      join public.expenses e on e.id = es.expense_id
      where e.group_id = p_group_id and e.ledger = 'shared' and e.deleted_at is null and es.user_id = u.id), 0)
    + coalesce((select sum(s.amount_twd) from public.settlements s
      where s.group_id = p_group_id and s.from_user_id = u.id and s.voided_at is null), 0)
    - coalesce((select sum(s.amount_twd) from public.settlements s
      where s.group_id = p_group_id and s.to_user_id = u.id and s.voided_at is null), 0) as balance_twd
  from public.users u
  join public.groups g on g.couple_id = u.couple_id
  where g.id = p_group_id;
$$;

revoke all on function public.group_balances(uuid) from public, anon, authenticated;
grant execute on function public.group_balances(uuid) to service_role;
