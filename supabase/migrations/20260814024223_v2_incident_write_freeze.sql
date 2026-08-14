-- Persistent incident freeze for the canonical V2 accounting plane.
-- This is additive: the default keeps existing production behavior enabled.
-- It intentionally does not change active_plane or the V1 mutation fence.

alter table ledger_v2.writer_control
  add column if not exists financial_writes_enabled boolean not null default true;

comment on column ledger_v2.writer_control.financial_writes_enabled is
  'When false, canonical V2 financial mutations are rejected without changing active_plane.';

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

  if control.active_plane = 'v2'
     or control.mutation_fence
     or not coalesce(control.financial_writes_enabled, true) then
    raise exception 'V1 financial writer is fenced for couple %', target_couple
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function ledger_v2.prevent_v2_financial_write()
returns trigger
language plpgsql
security definer
set search_path = ledger_v2, public
as $$
declare
  target_couple smallint;
  control ledger_v2.writer_control%rowtype;
  old_row jsonb;
  new_row jsonb;
begin
  old_row := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  new_row := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;

  if tg_table_name = 'recurring_runs' then
    select r.couple_id into target_couple
    from ledger_v2.recurring_rules r
    where r.id = coalesce(new_row->>'rule_id', old_row->>'rule_id')::uuid;
  else
    target_couple := coalesce(new_row->>'couple_id', old_row->>'couple_id')::smallint;
  end if;

  select * into control
  from ledger_v2.writer_control
  where couple_id = target_couple;

  if not coalesce(control.financial_writes_enabled, true) then
    -- Category-only metadata backfill is intentionally allowed while the
    -- incident freeze is active so the controlled categories migration does
    -- not become impossible. All accounting fields remain immutable here.
    if tg_table_name = 'transactions' and tg_op = 'UPDATE'
       and new_row->>'type' is not distinct from old_row->>'type'
       and new_row->>'amount_twd' is not distinct from old_row->>'amount_twd'
       and new_row->>'occurred_on' is not distinct from old_row->>'occurred_on'
       and new_row->>'description' is not distinct from old_row->>'description'
       and new_row->>'category' is not distinct from old_row->>'category'
       and new_row->>'note' is not distinct from old_row->>'note'
       and new_row->>'split_method' is not distinct from old_row->>'split_method'
       and new_row->>'status' is not distinct from old_row->>'status'
       and new_row->>'version' is not distinct from old_row->>'version'
       and new_row->>'created_by_user_id' is not distinct from old_row->>'created_by_user_id'
       and new_row->>'idempotency_key' is not distinct from old_row->>'idempotency_key'
       and new_row->>'legacy_group_id' is not distinct from old_row->>'legacy_group_id'
       and new_row->>'source_table' is not distinct from old_row->>'source_table'
       and new_row->>'source_id' is not distinct from old_row->>'source_id'
       and new_row->>'voided_at' is not distinct from old_row->>'voided_at'
       and new_row->>'created_at' is not distinct from old_row->>'created_at'
       and new_row->>'replaces_transaction_id' is not distinct from old_row->>'replaces_transaction_id' then
      return new;
    end if;
    raise exception 'V2 financial writer is frozen for couple %', target_couple
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function ledger_v2.prevent_v1_financial_write() from public, anon, authenticated;
revoke all on function ledger_v2.prevent_v2_financial_write() from public, anon, authenticated;
grant execute on function ledger_v2.prevent_v1_financial_write() to service_role;
grant execute on function ledger_v2.prevent_v2_financial_write() to service_role;

drop trigger if exists prevent_v2_transaction_write on ledger_v2.transactions;
create trigger prevent_v2_transaction_write
before insert or update or delete on ledger_v2.transactions
for each row execute function ledger_v2.prevent_v2_financial_write();

drop trigger if exists prevent_v2_payment_write on ledger_v2.transaction_payments;
create trigger prevent_v2_payment_write
before insert or update or delete on ledger_v2.transaction_payments
for each row execute function ledger_v2.prevent_v2_financial_write();

drop trigger if exists prevent_v2_share_write on ledger_v2.transaction_shares;
create trigger prevent_v2_share_write
before insert or update or delete on ledger_v2.transaction_shares
for each row execute function ledger_v2.prevent_v2_financial_write();

drop trigger if exists prevent_v2_event_write on ledger_v2.transaction_events;
create trigger prevent_v2_event_write
before insert or update or delete on ledger_v2.transaction_events
for each row execute function ledger_v2.prevent_v2_financial_write();

drop trigger if exists prevent_v2_proposal_write on ledger_v2.proposals;
create trigger prevent_v2_proposal_write
before insert or update or delete on ledger_v2.proposals
for each row execute function ledger_v2.prevent_v2_financial_write();

drop trigger if exists prevent_v2_recurring_run_write on ledger_v2.recurring_runs;
create trigger prevent_v2_recurring_run_write
before insert or update or delete on ledger_v2.recurring_runs
for each row execute function ledger_v2.prevent_v2_financial_write();
