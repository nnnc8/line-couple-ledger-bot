# PRODUCTION INCIDENT CONTAINMENT REPORT

Repository: `https://github.com/nnnc8/line-couple-ledger-bot`

Incident branch: `codex/couple-ledger-v2-incident-bootstrap`

Baseline code: `codex/couple-ledger-v2` at `50f5ddc3cc7fc27fdcc766d2982a8a2cf38bf078`

Bootstrap runtime commit: `f21acb984c97d7a9affaa8eb4f4d45f30d68c6a0`

Production project: Supabase `alzzyweydblyyvnbiwpn`, Vercel project
`line-couple-ledger-bot`, couple `1`.

This report records only the authorized incident-containment work. Forward
repair, full cutover, later V2 migrations, Rich Menu changes, and V2 financial
writes remain on hold.

## 1. Scope and operator checkpoint

The operator checkpoint required before deployment was received through the
goal continuation. The allowed sequence was followed: baseline, one reviewed
freeze migration, migration-history repair for that migration only, guarded
freeze activation, bootstrap deployment, and containment verification.

No unrestricted `supabase db push`, `migration:v2:apply`, or
`migration:v2:cutover` was run. The freeze was not removed after verification.

## 2. Baseline captured before mutation

Evidence root (local operator artifacts, mode 700):
`/Users/nc8/Documents/New project/artifacts/production-recovery/20260814T052942Z/containment`

The baseline showed:

- `active_plane=v2`, `mutation_fence=false`, `writer_epoch=1`.
- Three Ledgers and exactly two Couple members.
- V1 rows: groups `3`, expenses `622`, expense splits `835`, settlements `8`.
- V2 rows: transactions `223`, payments `223`, shares `438`, transaction
  events `223`, command receipts `2`, notifications `2`, proposals `0`, and
  inbox rows `16`.
- Two pre-existing V2-only posted transactions. Count `2` and digest:
  `7a3e33aa352c21d58d4f689d3dfa43c6d1b6fec4691a2c5db8d26eb61d74fd9f`.
- Per-Ledger balances were zero-sum and were not combined across Ledgers.

## 3. Standalone freeze migration

### PRODUCTION MUTATION — EXECUTED WITH CHECKPOINT

Only this reviewed migration was executed:

`supabase/migrations/20260814024223_v2_incident_write_freeze.sql`

SHA-256:

`b16fb5030718c75ab4205d961291e58c20179b1ed4e3599306c81c3dcae83c01`

The runtime database role (`ledger_runtime`) did not own the V2 schema and
could not perform DDL. Therefore the exact file was submitted through the
linked Supabase Management API with:

```bash
supabase db query --linked --output-format json \
  --file supabase/migrations/20260814024223_v2_incident_write_freeze.sql
```

This was constrained to the exact file; it was not a general migration push.
Catalog verification passed: `financial_writes_enabled` exists, both guard
functions exist, all six V2 freeze triggers are enabled, and the original V1
financial triggers remain enabled.

The migration is additive only. It did not alter `active_plane`,
`mutation_fence`, `writer_epoch`, or financial rows.

## 4. Migration history repair

### PRODUCTION MUTATION — EXECUTED WITH CHECKPOINT

After catalog and row-count verification, only the executed migration was
recorded:

```bash
supabase migration repair --linked --status applied 20260814024223
```

The post-repair V2 history contains the two existing shadow/workflow
migrations and `20260814024223_v2_incident_write_freeze`. The later lineage,
categories, recurring-semantics, and retry/dead-letter migrations remain
absent and were not marked applied.

## 5. Guarded freeze activation

### PRODUCTION MUTATION — EXECUTED WITH CHECKPOINT

The guarded command was run for couple `1`:

```bash
V2_INCIDENT_DATABASE_URL="$DATABASE_URL" \
V2_INCIDENT_COUPLE_ID=1 \
V2_INCIDENT_FREEZE_APPLY=1 \
V2_INCIDENT_ALLOW_REMOTE=1 \
pnpm incident:v2:freeze -- --apply
```

Result:

```text
prior_financial_writes_enabled=true
result_financial_writes_enabled=false
active_plane=v2
mutation_fence=false
writer_epoch=1
```

The freeze is ON and must remain ON. No unfreeze command was run.

## 6. Bootstrap deployment

### PRODUCTION MUTATION — EXECUTED WITH CHECKPOINT

The source worktree was detached and clean at exactly
`f21acb984c97d7a9affaa8eb4f4d45f30d68c6a0`. The final READY production
deployment is:

- Deployment: `dpl_8Vi44CkdeCpkktj9PGX2gzRTXfma`
- URL: `line-couple-ledger-2xszsh3gt-ncnc8.vercel.app`
- Aliases: `line-couple-ledger-bot.vercel.app`,
  `line-couple-ledger-bot-ncnc8.vercel.app`
- Target: `production`
- State: `READY`
- Vercel deployment metadata Git SHA:
  `f21acb984c97d7a9affaa8eb4f4d45f30d68c6a0`

Deployment-scoped values only were supplied:

```text
V2_INCIDENT_BOOTSTRAP_ONLY=1
V2_LEDGER_ENABLED=1
V2_LINE_INBOX_ENABLED=1
NEXT_PUBLIC_V2_LEDGER_UI=0  (build-time)
```

Project-level environment variables were not changed. The final deployment
was made from the exact runtime commit and passed a dry run before mutation.

## 7. Deployment/runtime verification

### READ ONLY

- The immutable deployment and both production aliases returned HTTP `200` on
  `/api/version`.
- Vercel deployment metadata, rather than the endpoint, is the authoritative
  commit proof: it reports the exact `f21acb9…` SHA and the exact bootstrap
  commit message.
- `/api/version` returned `commitSha:""` because Vercel CLI deployment does
  not populate the runtime `VERCEL_GIT_COMMIT_SHA` value in this deployment;
  this is recorded as an observability limitation, not treated as a source
  mismatch. No code or project environment change was made to hide it.
- The unauthenticated root shell returned HTTP `200`; the build-time V2 UI
  marker was absent, consistent with `NEXT_PUBLIC_V2_LEDGER_UI=0`.
- The authenticated worker endpoint, using the existing cron secret, returned
  HTTP `503` with the stable maintenance response. No worker drain occurred.

## 8. Database-level containment proof

### READ ONLY verification of a safe rollback transaction

Inside one rollback transaction, the following application-shaped attempts
were made and all were rejected before commit:

| Attempt | Result | SQLSTATE | Message |
|---|---|---|---|
| V1 group financial update | rejected | `55000` | `V1 financial writer is fenced for couple 1` |
| V2 transaction insert | rejected | `55000` | `V2 financial writer is frozen for couple 1` |
| V2 payment insert | rejected | `55000` | `V2 financial writer is frozen for couple 1` |

The rollback transaction committed no row. No transaction, payment, share,
event, proposal, or notification row was created by this proof.

## 9. Application read and mutation containment

### READ ONLY

Direct application-service verification against the production database
confirmed:

```json
{
  "ledgerCount": 2,
  "activeLedger": "bfd8e2a2-060d-4adb-82af-8d2b8a7f2ba8",
  "memberCount": 2,
  "historyCount": 5,
  "balance": {
    "00ae8420-fdae-4b54-b842-ce82729d6f26": "-18916",
    "ed4a1d5f-7727-4efc-a26b-cedc2e2df91c": "18916"
  },
  "hasMissingSchemaErrors": false
}
```

The following application mutation paths all returned the stable `503`
maintenance boundary: expense, income, transfer, settle-all, void, restore,
replace, proposal confirmation, recurring creation, and recurring toggle.
Recurring posting reported `posted=0`.

An authenticated LIFF write was not attempted: there is no disposable LINE
ID token in the operator environment, and containment explicitly forbids
creating a financial test row. The deployed read shell and the direct service
read proof are complete; authenticated LIFF smoke belongs to forward repair /
cutover review.

## 10. LINE webhook containment

### PRODUCTION MUTATION — NON-FINANCIAL INBOX INSERT ONLY

A signed, synthetic LINE event with event ID
`containment-20260814T052942Z-01` and text `晚餐 1 我付` was sent to the
immutable deployment URL. The response was:

```json
{"ok":true,"maintenance":true}
```

The database row is:

```text
provider=line
channel=production
status=received
attempt_count=0
processed_at=NULL
last_error=NULL
```

The exact event was replayed. It returned the same `200` maintenance response;
the event still has exactly one inbox row, `attempt_count=0`, and no
processing. No direct financial handler and no partner notification ran.

This intentionally adds one durable inbox row (`16 -> 17`); it does not add
financial truth. The row is retained for later controlled replay/repair.

## 11. Worker and recurring containment

### READ ONLY

The deployed `/api/cron/v2-workers` endpoint returned `503` maintenance with
the valid cron credential. This proves the bootstrap flag holds the inbox and
outbox workers before claim/dispatch. Existing recurring posting verification
also reports `posted=0` under the persistent freeze.

No retry lease was consumed, no notification was sent, and no outbox row was
changed by the containment probes.

## 12. Post-containment migration reconciliation

### READ ONLY

The privileged, read-only reconciliation query reported migration batch status
`verified`, quarantine `0`, and mapping counts of `3` Ledgers and `221`
migrated transactions. Each legacy group maps one-to-one to its Ledger; no
Ledger was merged or cross-offset.

| Ledger | Migrated transaction count | V1 active amount | V2 active amount | Owner balance | Partner balance | Result |
|---|---:|---:|---:|---:|---:|---|
| 共同生活 (`6099ee82…`) | 0 | NT$0 | NT$0 | 0 | 0 | PASS |
| 阿提斯 (`bfd8e2a2…`) | 156 | NT$269,491 | NT$269,491 | -18,916 | +18,916 | PASS |
| 吃飽喝足 (`5db07bec…`) | 65 | NT$23,069 | NT$23,069 | +542 | -542 | PASS |

The two pre-existing V2-only transactions remain in `吃飽喝足`; therefore the
current post-containment aggregate for that Ledger is `67` transactions,
NT$23,889 active amount, and balance `+7/-7`. This is the expected
pre-existing V2 truth, not a containment write.

Additional post-containment gates:

- exactly two Couple members;
- no unknown participants;
- no cross-Ledger allocation rows;
- `170` active transactions have zero payment-conservation violations and
  zero share-conservation violations;
- each Ledger balance sums to zero;
- quarantine remains zero;
- attachment metadata count is `0` and receipt Storage object count is `7`;
- V1 writer triggers remain enabled.

## 13. Before/after financial invariants

### READ ONLY

| Plane | Baseline | After containment | Interpretation |
|---|---:|---:|---|
| V1 groups | 3 | 3 | unchanged |
| V1 expenses | 622 | 622 | unchanged |
| V1 expense splits | 835 | 835 | unchanged |
| V1 settlements | 8 | 8 | unchanged |
| V2 transactions | 223 | 223 | unchanged |
| V2 payments | 223 | 223 | unchanged |
| V2 shares | 438 | 438 | unchanged |
| V2 transaction events | 223 | 223 | unchanged |
| V2 notifications | 2 | 2 | unchanged |
| V2 proposals | 0 | 0 | unchanged |
| V2-only count/digest | 2 / `7a3e33aa…` | 2 / `7a3e33aa…` | unchanged |
| LINE inbox | 16 | 17 | one retained containment event only |

The signed-balance vectors and all payment/share conservation checks are
unchanged. No financial data was inserted, updated, voided, deleted, or
cross-offset.

## 14. Explicit production change ledger

| Item | Result |
|---|---|
| Database schema | **Changed intentionally:** one additive freeze migration only |
| Financial data | **Unchanged** |
| Writer plane (`active_plane`) | **Unchanged:** remains `v2` |
| V1 mutation fence | **ON / enforced** |
| V2 financial freeze | **ON:** `financial_writes_enabled=false` |
| Production deployment | **Changed intentionally:** bootstrap runtime is READY |
| Project-level Vercel env | **Unchanged**; deployment-scoped overrides only |
| LINE webhook/Rich Menu settings | **Unchanged** |
| Production Rich Menu | **Unchanged** |
| V1 tables/code/data | **Unchanged** |

## 15. Evidence, deviations, and remaining hold

Evidence files are under the local evidence root listed in Section 2. The
repository report is accompanied by the existing bootstrap contract and review
docs. The only execution deviation was the migration transport: the reviewed
SQL was executed through linked Supabase Management API because the runtime
role was deliberately not a DDL owner. The exact file checksum, catalog state,
migration history, writer state, row counts, and reconciliation were verified
afterward.

The following work is explicitly deferred and must not start during this hold:

- lineage, categories, recurring-semantics, retry/dead-letter migrations;
- deterministic forward repair/backfill;
- V2 writer selection or active-plane changes;
- V2 feature flags, Rich Menu, or LINE configuration changes;
- authenticated LIFF/LINE financial smoke writes;
- handling or replaying the retained inbox event;
- modifying or deleting the two V2-only transactions.

## 16. Decision

Containment verification passed. Production is deliberately held in a safe
read-only/bootstrap state with both financial writer paths fenced. The
bootstrap deployment is healthy, LINE events are durably retained without
dispatch, and the financial reconciliation remains unchanged per Ledger.

CONTAINMENT SUCCESSFUL — PRODUCTION FROZEN FOR FORWARD REPAIR

FORWARD REPAIR: NO-GO

FULL CUTOVER: NO-GO

Production Supabase was intentionally changed only by the standalone additive
freeze migration, migration-history record, and guarded
`financial_writes_enabled=false` control update. Production financial data was
not changed. The V2 writer was not enabled; it was frozen. The normal V2 UI and
financial cutover flags were not enabled; the deployment-scoped bootstrap
values `V2_LEDGER_ENABLED=1` and `V2_LINE_INBOX_ENABLED=1` were used only for
safe reads and durable inbox retention, while `NEXT_PUBLIC_V2_LEDGER_UI=0`
kept the V2 UI off. LINE webhook and Rich Menu settings were untouched. V1
production data was not modified.
