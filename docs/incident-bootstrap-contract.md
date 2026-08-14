# Incident Bootstrap Contract

This document defines the only production contract for the dedicated incident
bootstrap build. It is additive and review-only; no command below was run
against production.

## Current production schema proven by read-only reconciliation

The bootstrap build may rely on these objects from the two V2 migrations
already recorded in production:

| Object | Required by bootstrap | Proven present | Fallback / hold |
|---|---:|---:|---|
| `ledger_v2.writer_control(couple_id, active_plane, mutation_fence, writer_epoch, updated_at)` | yes | yes | Missing row rejects V2 writes |
| `ledger_v2.ledgers` | yes | yes | Read returns not found |
| `ledger_v2.ledger_members` | yes | yes | Couple/ledger shape error |
| `ledger_v2.ledger_default_shares` | yes | yes | Shape error |
| `ledger_v2.user_preferences` | yes | yes | Active-ledger preference is unavailable |
| `ledger_v2.transactions` (pre-lineage columns only) | yes | yes | Bootstrap selects `category_id`/lineage as typed `NULL` |
| `ledger_v2.transaction_payments` | yes | yes | Read/write fails closed |
| `ledger_v2.transaction_shares` | yes | yes | Read/write fails closed |
| `ledger_v2.transaction_events` | yes | yes | Write fails closed |
| `ledger_v2.command_receipts` | yes | yes | Idempotent write fails closed |
| `ledger_v2.proposals` | yes | yes | Confirmation is gated before query when frozen |
| `ledger_v2.recurring_rules` (pre-category column) | yes | yes | Runner is held in bootstrap mode |
| `ledger_v2.recurring_runs` | yes | yes | Runner is held in bootstrap mode |
| `ledger_v2.line_inbox` (pre-`max_attempts`) | yes | yes | Inbox is retained; worker never claims |
| `ledger_v2.notification_outbox` (pre-`max_attempts`) | yes | yes | Outbox worker is held |
| `ledger_v2.attachments` | no | yes | Attachment reads remain outside the bootstrap read allow-list |
| `public.couples`, `public.users` | yes | yes | Couple must still have exactly two members |

The following are deliberately **not** bootstrap dependencies: `ledger_v2.categories`,
`transactions.category_id`, `transactions.replaces_transaction_id`, the
replacement index/FK, recurring `category_id`, inbox/outbox `max_attempts`, and
dead-letter status constraints. The bootstrap target fixture proves those
objects are absent.

## Bootstrap behavior

`V2_INCIDENT_BOOTSTRAP_ONLY=1` permits context, Ledger list/bootstrap,
transaction history/export, attachment metadata, proposal reads, and the
existing pre-lineage V2 write paths. Those paths use the pre-lineage/pre-category
projections. V2 statistics, category paths, and replacement lineage are held by
the route/service gate. Transaction creation and recurring creation use
old-schema insert projections; category identity and replacement lineage are
rejected until the later migrations exist. The runner, inbox worker, and
outbox worker do not query newer columns in bootstrap mode.

When `financial_writes_enabled=false`, the database trigger and writer check
reject canonical V2 writes with HTTP 503; reads continue to work. LINE webhook
events are inserted into the existing inbox shape and left `received` without
claiming or dispatching. If the inbox flag is off, the webhook returns the same
maintenance response without direct handling.

## Freeze migration independence and old-code behavior

`20260814024223_v2_incident_write_freeze.sql` only alters the existing
`writer_control`, replaces the existing V1 guard, and adds V2 triggers to the
existing accounting/workflow tables. It does not reference category, lineage,
recurring-semantics, retry, or dead-letter columns. `financial_writes_enabled`
defaults to `true`; applying the migration alone does not freeze or change
`active_plane`/`mutation_fence`. Old code ignores the additive column and keeps
writing while the flag is true. The new trigger exists immediately, but its
default-true branch preserves the old behavior.

## Safe deployment sequence and race windows

1. Apply only the standalone freeze SQL, defaulting the new flag to `true`.
2. Deploy the reviewed bootstrap commit with `V2_INCIDENT_BOOTSTRAP_ONLY=1`.
3. Verify `/api/version` and read-only health.
4. Activate the guarded freeze CLI; verify `active_plane=v2`,
   `mutation_fence=false`, `financial_writes_enabled=false`.
5. Only then apply the remaining additive migrations with a reviewed dry-run.

- **WINDOW A — before freeze SQL:** current partial-cutover risk remains; no
  new risk is introduced.
- **WINDOW B — after freeze SQL, before bootstrap deploy:** flag is still true;
  old code remains functional. A human may set the flag false immediately if
  the deployment is delayed.
- **WINDOW C — after bootstrap deploy, before activation:** bootstrap blocks
  unsupported schema paths, but financial writes remain enabled by design;
  the operator must activate the persistent freeze before repair.

## Operator commands

All commands below are templates and were **not executed**.

### READ ONLY — explicit target

```bash
export V2_INCIDENT_DATABASE_URL='postgresql://<operator>@<production-host>/<db>'
export V2_INCIDENT_COUPLE_ID='<couple-id>'
pnpm incident:v2:status
curl -fsS https://<production-domain>/api/version
supabase migration list --db-url "$V2_INCIDENT_DATABASE_URL"
```

### PRODUCTION MUTATION — DO NOT EXECUTE during review

Do not run unrestricted `supabase db push`: it would apply every pending
migration. Use a disposable recovery checkout containing only the reviewed
freeze migration and run the explicit SQL file through the approved Postgres
change path:

```bash
test "${PRODUCTION_MUTATION_CONFIRM:-}" = "APPLY_INCIDENT_FREEZE_SQL" || \
  { echo "set PRODUCTION_MUTATION_CONFIRM=APPLY_INCIDENT_FREEZE_SQL" >&2; exit 1; }
psql --set ON_ERROR_STOP=1 "$V2_INCIDENT_DATABASE_URL" \
  --file supabase/migrations/20260814024223_v2_incident_write_freeze.sql
```

After the SQL succeeds and its catalog checks pass, recording **only this
executed** migration is allowed:

```bash
test "${PRODUCTION_MUTATION_CONFIRM:-}" = "RECORD_EXECUTED_INCIDENT_MIGRATION" || \
  { echo "set PRODUCTION_MUTATION_CONFIRM=RECORD_EXECUTED_INCIDENT_MIGRATION" >&2; exit 1; }
supabase migration repair --status applied \
  --db-url "$V2_INCIDENT_DATABASE_URL" 20260814024223
```

Do not mark missing historical migrations applied with `supabase migration
repair`; they must be executed later. After the bootstrap deploy and a human
checkpoint, the guarded freeze command is:

```bash
V2_INCIDENT_FREEZE_APPLY=1 \
V2_INCIDENT_ALLOW_REMOTE=1 \
V2_INCIDENT_DATABASE_URL="$V2_INCIDENT_DATABASE_URL" \
V2_INCIDENT_COUPLE_ID="$V2_INCIDENT_COUPLE_ID" \
pnpm incident:v2:freeze -- --apply
```

The production flag state for this deployment is:

```text
V2_INCIDENT_BOOTSTRAP_ONLY=1
V2_LEDGER_ENABLED=1
NEXT_PUBLIC_V2_LEDGER_UI=0
V2_LINE_INBOX_ENABLED=1
```

`NEXT_PUBLIC_V2_LEDGER_UI` is build-time; the other values are runtime for a
new deployment. No Rich Menu or LINE setting changes belong to this commit.

## Dedicated local proof

`src/lib/v2-bootstrap-compatibility.pg.test.ts` runs against a local database
created from the current production shape plus only the standalone freeze
migration. It proves Ledger list/bootstrap/history reads, a V2 write while
unfrozen, freeze rejection of create/replace/proposal/recurring writes, inbox
retention, and `/api/version` identity without querying the missing later
columns. Run it with:

```bash
V2_BOOTSTRAP_TEST_DATABASE_URL=postgresql://nc8@localhost/<isolated-db> \
pnpm test:bootstrap
```

This is an isolated test target; production is never an accepted URL.
