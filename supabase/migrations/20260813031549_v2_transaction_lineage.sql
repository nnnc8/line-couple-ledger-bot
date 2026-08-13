-- Additive V2 lineage metadata. This pass intentionally does not apply or
-- enable any production migration/cutover.
alter table ledger_v2.transactions
  add column if not exists replaces_transaction_id uuid;

alter table ledger_v2.transactions
  drop constraint if exists transactions_replaces_transaction_fk;

alter table ledger_v2.transactions
  add constraint transactions_replaces_transaction_fk
  foreign key (replaces_transaction_id)
  references ledger_v2.transactions(id)
  on delete restrict;

create index if not exists transactions_replacement_idx
  on ledger_v2.transactions (replaces_transaction_id)
  where replaces_transaction_id is not null;

alter table ledger_v2.line_inbox
  add column if not exists max_attempts integer not null default 8;

alter table ledger_v2.line_inbox
  drop constraint if exists line_inbox_status_check;

alter table ledger_v2.line_inbox
  add constraint line_inbox_status_check
  check (status in ('received', 'processing', 'processed', 'failed', 'ignored', 'dead_letter'));

alter table ledger_v2.notification_outbox
  add column if not exists max_attempts integer not null default 8;

alter table ledger_v2.notification_outbox
  drop constraint if exists notification_outbox_status_check;

alter table ledger_v2.notification_outbox
  add constraint notification_outbox_status_check
  check (status in ('pending', 'sending', 'sent', 'failed', 'skipped', 'dead_letter'));
