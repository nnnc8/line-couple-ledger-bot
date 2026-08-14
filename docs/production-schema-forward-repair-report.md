# PRODUCTION SCHEMA FORWARD REPAIR REPORT

Repository: https://github.com/nnnc8/line-couple-ledger-bot
Incident branch: codex/couple-ledger-v2-incident-bootstrap
Production Supabase project: alzzyweydblyyvnbiwpn
Couple: 1
Evidence root:
/Users/nc8/Documents/New project/artifacts/production-recovery/20260814T065332Z/schema-forward-repair

This report covers only the authorized schema-forward-repair attempt. The
process stopped at the first migration failure as required. No retry, manual
SQL repair, migration repair, unfreeze, cutover, deployment, or LINE change was
performed after the failure.

## 1. Pre-repair hold state

### PRODUCTION READ ONLY — PASS

Immediately before apply:

~~~text
active_plane=v2
mutation_fence=false
financial_writes_enabled=false
writer_epoch=1
quarantine=0
~~~

The pre-apply guard passed for writer state, all V1/V2 row counts, every Ledger
metric, V2-only transactions, schema state, quarantine, and dry-run list.

Production counts at the hold point:

~~~text
V1: couples=1 users=2 groups=3 expenses=622 expense_splits=835 settlements=8
V2: ledgers=3 transactions=223 payments=223 shares=438 events=223
    line_inbox=17 notification_outbox=2 migration_map=633 quarantine=0
~~~

The bootstrap deployment was reported Ready by vercel ls --prod; the production
alias /api/version returned HTTP 200.

## 2. Recovery point

### PRODUCTION READ ONLY — PASS

Approved recovery point: 20260814T060504Z

~~~text
schema.sql    ed666ae3e4dd59b46a319f4a2362f8938e16110f3e38e1d8eda08c513bfd4a9b
data.sql      c1311e1d28ff03e16db8243283bcae5057e08d12259d846708b9c6df0b34b9ef
database.dump 8a3c5821375976e1d905f4846541faf7736b6e0eb52ec5e1839215095c4e12ed
financial digest 7a3e33aa352c21d58d4f689d3dfa43c6d1b6fec4691a2c5db8d26eb61d74fd9f
isolated restore PASS
~~~

## 3. Missing migration matrix

### PRODUCTION READ ONLY — PASS

| Order | Migration | Remote history before apply | Actual schema before apply | Required now |
| --- | --- | --- | --- | --- |
| 1 | 20260812050029_add_couple_ledger_v2_shadow.sql | present | present | no |
| 2 | 20260812053946_add_couple_ledger_v2_workflows.sql | present | present | no |
| 3 | 20260813031549_v2_transaction_lineage.sql | absent | lineage/retry objects absent | yes |
| 4 | 20260813041139_v2_ledger_categories.sql | absent | categories objects absent | yes |
| 5 | 20260813043813_v2_recurring_semantics.sql | absent | recurring category objects absent | yes |
| 6 | 20260814024223_v2_incident_write_freeze.sql | present once | freeze objects present | no; never rerun |

## 4. Migration SQL safety review

### PRODUCTION READ ONLY — PASS

v2_transaction_lineage was classified SAFE WITH VERIFIED PRECONDITION. It adds
replaces_transaction_id, a self-FK, a partial index, max_attempts default 8 on
inbox/outbox, and dead_letter status values. It does not backfill financial
amounts, payments, shares, or transaction status.

v2_ledger_categories was classified SAFE WITH VERIFIED PRECONDITION. It creates
Ledger-scoped categories, seeds 24 defaults (3 Ledgers x 8 labels), adds a
nullable category_id, backfills only 101 exact text matches, and adds the
category index/FK and RLS/grants. Unmatched labels remain snapshots. The freeze
function permits category-only metadata updates.

v2_recurring_semantics was classified SAFE ADDITIVE. It adds nullable recurring
category_id, a partial index, and a Ledger-scoped FK. Existing recurring rule
count was zero.

The incident-freeze SQL was excluded from the apply sequence.

## 5. Production dry-run

### PRODUCTION READ ONLY — PASS

The first dry-run without include-all stopped safely because pending timestamps
precede the recorded freeze migration. The required second dry-run was:

~~~text
supabase db push --linked --include-all --dry-run
~~~

It exited 0 and listed exactly:

~~~text
20260813031549_v2_transaction_lineage.sql
20260813041139_v2_ledger_categories.sql
20260813043813_v2_recurring_semantics.sql
~~~

Seeds and roles were empty, and the freeze migration was not listed.

## 6. Applied migration sequence

### PRODUCTION SCHEMA MUTATION — AUTHORIZED; STOPPED ON FAILURE

The confirmed command was executed exactly once:

~~~text
supabase db push --linked --include-all --yes
~~~

Observed sequence:

1. v2_transaction_lineage applied successfully.
2. v2_ledger_categories began, then failed while creating
   transactions_category_idx.
3. v2_recurring_semantics was not attempted.

Failure:

~~~text
ERROR: cannot CREATE INDEX "transactions" because it has pending trigger events
(SQLSTATE 55006)
At statement: 5
create index if not exists transactions_category_idx
  on ledger_v2.transactions (ledger_id, category_id)
  where category_id is not null
~~~

The categories migration rolled back: post-failure reads show no categories
table, no transactions.category_id, and no seeded category rows. No manual
repair or retry was attempted.

## 7. Migration-history result

### PRODUCTION READ ONLY — STOP

Post-failure history contains:

1. 20260812050029_add_couple_ledger_v2_shadow
2. 20260812053946_add_couple_ledger_v2_workflows
3. 20260813031549_v2_transaction_lineage
4. 20260814024223_v2_incident_write_freeze

The lineage migration is recorded once. Categories and recurring semantics are
not recorded. The actual state is a partial forward repair and cannot be
treated as a completed final schema.

## 8. Schema validation

### PRODUCTION READ ONLY — STOP

Post-failure catalog validation shows:

- lineage column, FK, and index: present;
- inbox/outbox max_attempts=8 and dead_letter status checks: present;
- categories table, transaction category column/index/FK: absent;
- recurring category column/index/FK: absent;
- freeze column, guard functions, and all six V2 freeze triggers: present.

The existing scripts/v2-incident-validate-schema.ts was invoked against the
runtime DATABASE_URL but could not read supabase_migrations because the runtime
role lacks that schema privilege. Linked Management API SELECT-only
catalog/history checks are the authoritative production evidence for this pass.
Final schema validation is STOP, not PASS, because two reviewed migrations
remain unapplied.

## 9. Financial reconciliation

### PRODUCTION READ ONLY — PASS FOR DATA PRESERVATION

post-failure-financial-comparison.json shows:

- V1 counts unchanged;
- V2 financial/workflow counts unchanged;
- every Ledger metric unchanged;
- V2-only semantics unchanged;
- writer state unchanged;
- quarantine remains zero;
- freeze remains held.

The schema failure did not change accounting truth. This does not waive the
schema-repair failure or authorize a retry.

## 10. Per-Ledger comparison

### PRODUCTION READ ONLY — PASS FOR DATA PRESERVATION

| Ledger | Transactions | Active | Active amount | Payments | Shares | Owner balance | Partner balance |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 共同生活 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 阿提斯 | 156 | 117 | NT$269,491 | NT$269,491 | NT$269,491 | -18,916 | 18,916 |
| 吃飽喝足 | 67 | 53 | NT$23,889 | NT$23,889 | NT$23,889 | 7 | -7 |

All three Ledgers remain one-to-one with their legacy groups. No merge,
cross-offset, payment conservation violation, share conservation violation, or
balance-sum violation was observed. Settlements remain 8 V1 rows; no
cross-Ledger movement was detected.

## 11. V2-only truth comparison

### PRODUCTION READ ONLY — PASS FOR DATA PRESERVATION

The two known V2-only transactions remain semantically identical:

- 55071845-4533-497d-b22e-1fc93f6b58b5, 吃飽喝足, 拉麵, NT$570.
- b3f6a4f4-50b7-41cf-b492-37adc5363b9b, 吃飽喝足, 火鍋, NT$250.

IDs, Ledger, type, amount, date, status, payments, shares, and accounting deltas
match the recovery point. The production digest remains
7a3e33aa352c21d58d4f689d3dfa43c6d1b6fec4691a2c5db8d26eb61d74fd9f.

## 12. Freeze verification

### PRODUCTION READ ONLY — PASS; NO NEW WRITE PROBES AFTER FAILURE

Post-failure state remains:

~~~text
active_plane=v2
financial_writes_enabled=false
mutation_fence=false
V1 financial triggers=enabled
V2 freeze triggers=enabled
~~~

No create, transfer, settle-all, replace, void, restore, recurring generation,
proposal confirmation, or LINE mutation probe was run after the migration
failure. The process stopped instead of introducing any additional production
mutation or test row.

## 13. Bootstrap runtime health

### PRODUCTION READ ONLY — PRE-APPLY PASS; NO DEPLOYMENT

Before apply, /api/version returned HTTP 200 and vercel ls --prod reported the
bootstrap deployment Ready. No application deployment or environment flag
change occurred during this task. Because the schema phase failed, no full V2
runtime health phase was started.

## 14. Storage/attachment sanity

### PRODUCTION READ ONLY — PRESERVED

The post-failure snapshot still reports attachment metadata 0 and receipts
Storage object inventory 7, matching the verified recovery point. No object was
deleted and no orphan-object cleanup was attempted. Storage bytes remain outside
the backup scope.

## 15. Evidence artifacts

All evidence is local, mode 600 where applicable, and not committed:

- pre-repair-snapshot.json, pre-apply-snapshot.json, and
  post-failure-snapshot.json;
- recovery-point.json, migration-matrix.json, and
  migration-data-preconditions.json;
- migration-dry-run-include-all.txt, migration-dry-run-comparison.json,
  and pre-apply-dry-run-comparison.json;
- migration-apply.txt, migration-apply.stderr, and migration-apply.exit;
- migration-catalog.json, post-failure-catalog.json, and
  post-failure-financial-comparison.json;
- bootstrap deployment/health and production database identity captures.

No credentials, role passwords, tokens, or signed URLs were stored.

## 16. Anomalies

1. The categories migration failed at transactions_category_idx with PostgreSQL
   SQLSTATE 55006 because pending trigger events remained in the migration
   transaction.
2. The first migration committed before the second failed, leaving a partial
   but reviewed lineage/retry schema. This is why the process must not continue
   automatically.
3. The categories transaction rolled back completely; the recurring migration
   was never attempted.
4. The runtime role cannot read supabase_migrations; linked SELECT-only checks
   were used for privileged catalog/history verification.
5. Supabase CLI initialized its managed temporary login role for linked commands;
   no manual role change was performed and no financial state changed.

## 17. Production state at hold point

Production is left frozen and must remain so:

~~~text
active_plane=v2
V1 fenced
financial_writes_enabled=false
writer_epoch=1
lineage/retry migration=installed and recorded once
categories migration=not installed/not recorded
recurring migration=not installed/not recorded
bootstrap application=still deployed
~~~

No V2 writer, product flags, Rich Menu, LINE settings, or V1 cleanup was
changed. The partial schema must be reviewed before any further action.

## 18. GO / NO-GO

~~~text
SCHEMA REPAIR FAILED — v2_ledger_categories.sql could not create transactions_category_idx because PostgreSQL reported pending trigger events (SQLSTATE 55006); repair stopped with lineage/retry applied and categories/recurring unapplied.
FORWARD REPAIR: NO-GO
FULL CUTOVER: NO-GO
~~~

Explicit confirmations:

- Production financial writes remained frozen.
- active_plane remained v2.
- V1 remained fenced.
- Financial data, Ledger balances, payments, shares, settlements, and V2-only
  truth did not change.
- Only the first reviewed migration completed; the second failed and rolled
  back; the third was not run.
- No full V2 deployment occurred.
- No LINE or Rich Menu change occurred.
- No unfreeze occurred.
- No V1 cleanup or legacy data deletion occurred.
