-- Recurring rules use the same canonical V2 allocation model as ordinary
-- transactions. Keep category_id optional and ledger-scoped; existing rules
-- retain their text-free shape until an editor supplies a category.
alter table ledger_v2.recurring_rules
  add column if not exists category_id uuid;

create index if not exists recurring_rules_category_idx
  on ledger_v2.recurring_rules (ledger_id, category_id)
  where category_id is not null;

alter table ledger_v2.recurring_rules
  drop constraint if exists recurring_rules_category_fk;

alter table ledger_v2.recurring_rules
  add constraint recurring_rules_category_fk
  foreign key (category_id, ledger_id, couple_id)
  references ledger_v2.categories(id, ledger_id, couple_id)
  on delete restrict;
