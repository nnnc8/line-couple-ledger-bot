# PRODUCTION BACKUP AND RESTORE VERIFICATION REPORT

Repository: `https://github.com/nnnc8/line-couple-ledger-bot`
Incident branch: `codex/couple-ledger-v2-incident-bootstrap`
Production Supabase project: `alzzyweydblyyvnbiwpn`
Couple: `1`
Evidence root (local, gitignored, mode 700):
`/Users/nc8/Documents/New project/artifacts/production-recovery/20260814T060504Z/backup`

This report covers only the authorized production backup and isolated restore
verification pass. It does not authorize schema repair, unfreeze, writer
selection, cutover, deployment, or LINE changes.

## 1. Production freeze status

### PRODUCTION READ ONLY — COMPLETED

Fresh checks were taken before the backup and again after the isolated restore:

| Field | Value |
| --- | --- |
| `active_plane` | `v2` |
| `mutation_fence` | `false` |
| `financial_writes_enabled` | `false` |
| `writer_epoch` | `1` |
| V1 financial triggers | enabled |
| V2 incident-freeze triggers | enabled |
| migration quarantine | `0` |
| V2-only posted rows | `2` |
| V2-only digest | `7a3e33aa352c21d58d4f689d3dfa43c6d1b6fec4691a2c5db8d26eb61d74fd9f` |

The production writer remained frozen for this entire task. No production
financial row was inserted, edited, deleted, or voided.

## 2. Backup timestamp

Backup identifier: `20260814T060504Z`
Backup start timestamp: `2026-08-14T06:05:04Z`
Backup artifact completion timestamp: `2026-08-14T06:31:04Z`
Timezone: UTC (Taipei local time is UTC+08:00).

## 3. Backup artifact inventory

### PRODUCTION READ / BACKUP — AUTHORIZED

The local backup contains:

- `schema.sql`, `data.sql`, `database.dump`, and `database.dump.list`.
- `roles.sql`, generated with `pg_dumpall --roles-only --no-role-passwords`; no
  role passwords are stored.
- `migration-history.json`, `migration-metadata.json`, `writer-state.json`,
  `reconciliation-before.json`, `reconciliation-before-admin.json`, and
  `v2-only-truth-before.json`.
- `storage-manifest.json` and `missing-runtime-tables.json`.
- Deployment inspection evidence (`deployment.json` and
  `deployment-list.json`); no deployment mutation was performed in this task.
- Restore evidence, structural comparisons, accounting comparisons, trigger
  comparison, post-restore drift comparison, and `restore-verification.json`.
- `backup-metadata.json` and `backup-checksums.sha256`.

The direct runtime-role dumps intentionally excluded:

- `public.line_action_plans`
- `public.line_menu_amount_drafts`

`ledger_runtime` had no `SELECT` on those two operational tables. They were
captured separately through a linked read-only JSON query; the export contains
0 and 9 rows respectively. No financial table was excluded.

The Supabase CLI linked dump path was attempted first but could not run because
the local machine has no Docker Desktop. Direct `pg_dump`/`pg_dumpall` fallback
completed successfully, and the fallback is recorded in the artifacts and this
report.

## 4. Backup checksums

All 32 listed artifacts passed:

```bash
# READ ONLY — LOCAL INTEGRITY CHECK
cd /Users/nc8/Documents/New\ project/artifacts/production-recovery/20260814T060504Z/backup
shasum -a 256 -c backup-checksums.sha256
```

Result: every entry `OK`. The custom dump has 417 `pg_restore --list` entries;
schema and data dumps are non-empty and contain all expected V1/V2 table
markers.

## 5. Migration-history snapshot

### PRODUCTION READ ONLY — COMPLETED

The production history captured at backup time contains exactly:

1. `20260812050029_add_couple_ledger_v2_shadow`
2. `20260812053946_add_couple_ledger_v2_workflows`
3. `20260814024223_v2_incident_write_freeze`

No lineage, categories, recurring-semantics, retry/dead-letter, or other
forward-repair migration was applied or marked applied during this task.

## 6. Writer-state snapshot

### PRODUCTION READ ONLY — COMPLETED

`writer-state.json` and the post-restore read both show:

```text
couple_id=1
active_plane=v2
mutation_fence=false
financial_writes_enabled=false
writer_epoch=1
```

The restored target has the same writer state. This is an isolated verification
of the frozen state, not a request to unfreeze it.

## 7. Storage inventory

### PRODUCTION READ ONLY — COMPLETED

`storage-manifest.json` reports:

- attachment metadata rows: `0`
- `receipts` Storage objects: `7`
- referenced paths: `0`
- missing referenced objects: `0`
- unreferenced/orphan objects: `7`
- object bytes downloaded: `NO`
- signed URLs stored: `NO`

The 7 object metadata rows were preserved and restored into the local
verification target. The seven orphan paths are recorded verbatim in the
manifest; they are not silently deleted or treated as financial rows.

## 8. Isolated restore target

### LOCAL ISOLATED MUTATION — COMPLETED; NOT PRODUCTION

Target database:

```text
database=couple_ledger_prod_restore_20260814T060504Z
host=127.0.0.1
port=5432
server=PostgreSQL 17.10 (Homebrew)
user=nc8
```

`isolation-proof.json` records the exact local target name and separately records
the production project/host. The target was created locally and was never
connected to Supabase production application traffic.

The final restore used the custom dump:

```bash
# LOCAL ISOLATED MUTATION — SAFE TARGET ONLY
pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname "postgresql://nc8@127.0.0.1/couple_ledger_prod_restore_20260814T060504Z" \
  database.dump
```

The internal compatibility shell (`supabase_migrations.schema_migrations`,
`storage.objects`, the two runtime-table exports, and an isolation marker) was
added only to this local target so the verification queries could exercise the
same catalog shape. It is explicitly not a production schema repair.

## 9. Restore result

`pg_restore` custom-format exit status: `0`. The restored database passed the
incident reconciliation tool with `pass=true`.

The first plain SQL schema attempt stopped at the pre-existing local `public`
schema (`schema "public" already exists`). That target was recreated locally;
the custom-format restore then completed cleanly. The failed plain attempt did
not touch production and is retained as an artifact for auditability.

## 10. Structural comparison

`structural-row-count-comparison.json`: **PASS**. Production and restore counts
match for all checked V1/V2 relations, including:

```text
couples=1 users=2 groups=3 expenses=622 expense_splits=835 settlements=8
ledgers=3 ledger_members=6 transactions=223 payments=223 shares=438
events=223 line_inbox=17 notification_outbox=2 migration_batches=1
migration_map=633 migration_quarantine=0 writer_control=1
```

`structural-catalog-comparison-normalized.json`: **PASS**. Live columns and
constraints match (282 columns and 314 constraints after normalizing dropped
historical column ordinal gaps). Both sides lack `ledger_v2.categories`, as
expected from the captured migration history. The two historical dropped
`public.expenses` columns are documented and were not recreated.

## 11. Per-Ledger reconciliation

Every legacy group mapped one-to-one to a V2 Ledger. No Ledgers were merged and
no balances were cross-offset. Each row below is independently reconciled;
payments and shares each equal the active amount and the member balances sum
to zero.

| Legacy group → Ledger | Transactions | Active | Active amount TWD | Payments | Shares | Owner signed balance | Partner signed balance | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 共同生活 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | PASS |
| 阿提斯 | 156 | 117 | 269,491 | 269,491 | 269,491 | -18,916 | 18,916 | PASS |
| 吃飽喝足 | 67 | 53 | 23,889 | 23,889 | 23,889 | 7 | -7 | PASS |

The last balance includes the two pre-existing V2-only transactions: the
migration baseline was `542/-542`, and the V2-only delta was `-535/+535`, giving
the verified post-containment balance `7/-7`.

Additional gates:

- Couple members: exactly 2.
- Unknown participants: none.
- Payment conservation violations: 0.
- Share conservation violations: 0.
- Balance-sum violations: 0.
- Migration batch: `verified`.
- Migration map: 3 Ledger rows, 221 transaction rows, 366 excluded mirrors,
  43 excluded private rows.
- Quarantine: 0.
- V1 settlement rows preserved in the dump: 8; no cross-Ledger settlement
  violation was found in the restored reconciliation.

## 12. V2-only truth comparison

The production backup contains exactly two V2-only posted transactions:

- `55071845-4533-497d-b22e-1fc93f6b58b5` — 拉麵, NT$570
- `b3f6a4f4-50b7-41cf-b492-37adc5363b9b` — 火鍋, NT$250

The isolated restore contains the same two IDs, same Ledger, type, amount,
payments, shares, date, description, and signed deltas. Semantic comparison:

```text
count before=2, count restored=2
canonical semantic digest before=52dfa50ef01e5c345046a750db6cfffe5c7696086a7df2026dfb5241e4434c0f
canonical semantic digest restored=52dfa50ef01e5c345046a750db6cfffe5c7696086a7df2026dfb5241e4434c0f
source production digest=7a3e33aa352c21d58d4f689d3dfa43c6d1b6fec4691a2c5db8d26eb61d74fd9f
result=PASS
```

The two digest strings use different canonicalization routines; the semantic
transaction comparison is the authoritative restore check.

## 13. Migration-history comparison

`migration-history-comparison.json`: **PASS**.

- All three captured migration versions and names match exactly.
- Writer state matches exactly.
- Missing forward migrations remain absent on the restore target:
  lineage, categories, recurring category semantics, and retry max-attempts.
- No missing migration was applied during this task.

## 14. Storage restore limitations

`storage-restore-verification.json`: **PASS** for object inventory and metadata:
7 manifest objects restored, 0 missing, 0 unexpected, and metadata equal.

This is not a byte-level Storage backup. Object bytes were not downloaded and
signed URLs were not retained. The seven unreferenced receipt objects remain an
explicit review item; there are no missing objects for any attachment metadata
row because the attachment metadata count is zero.

## 15. Production post-process reconciliation

### PRODUCTION READ ONLY — COMPLETED

After the local restore, production was read again through both the runtime
connection and the linked read-only administrative query. The result in
`production-post-restore-drift.json` is **PASS** for all checks:

- writer state unchanged;
- V1 counts unchanged;
- all V2 financial/workflow counts unchanged;
- per-Ledger transaction counts, active amounts, payments, shares, and statuses
  unchanged;
- V2-only digest unchanged;
- migration history, batch, map/quarantine, Storage inventory, and the
  containment inbox row unchanged.

## 16. Anomalies and handling

1. Supabase CLI linked `db dump` could not run without local Docker; direct
   `pg_dump` fallback succeeded.
2. The runtime role could not read two operational tables; those tables were
   exported separately through a linked read-only query. No financial relation
   was omitted.
3. Two historical dropped column positions in `public.expenses` are absent
   from the dump; live catalog comparison was normalized and passed.
4. Seven orphan receipt Storage objects are present; no attachment-referenced
   object is missing.
5. Storage bytes were not backed up in this pass.
6. The linked CLI initialized its managed temporary login role for the query
   path. No manual role mutation was performed; no financial or writer state
   changed. The role metadata is retained in the role dump for audit.
7. The initial plain SQL local restore was non-idempotent against an existing
   `public` schema; the isolated target was recreated and the custom restore
   succeeded.

None of these anomalies is a production financial-data drift. Storage byte
preservation and orphan-object disposition require a separate, explicitly
approved operation.

## 17. Recovery-point assessment

Human checkpoints:

```text
BACKUP VERIFIED — YES
ISOLATED RESTORE VERIFIED — YES
STORAGE INVENTORY VERIFIED — YES
STORAGE BYTES BACKED UP — NO (explicit limitation)
PRODUCTION POST-RESTORE DRIFT — PASS
```

The database recovery point is established and reproducible in the isolated
PostgreSQL target. The verified point is suitable for a separately reviewed
schema forward-repair discussion. It is not a cutover approval and does not
make Storage bytes recoverable.

## 18. GO / NO-GO

```text
VERIFIED RECOVERY POINT ESTABLISHED — READY FOR SCHEMA FORWARD REPAIR REVIEW
FORWARD REPAIR: NO-GO
FULL CUTOVER: NO-GO
```

Explicit confirmations for this task:

- Production Supabase remained frozen and was not restored, dropped, or
  structurally repaired.
- Production financial data remained unchanged.
- The production writer plane and writer epoch were unchanged.
- No missing forward migration was applied or marked applied.
- No production deployment was performed during this backup/restore task; the
  pre-existing containment bootstrap deployment was only inspected.
- Vercel environment variables were not changed.
- Production LINE settings, webhook configuration, and Rich Menu were not
  changed.
- V1 production data was not modified.
- The isolated restore database remains local for review and is not production.
