# INCIDENT BOOTSTRAP REVIEW

Repository: `https://github.com/nnnc8/line-couple-ledger-bot`
Baseline branch: `codex/couple-ledger-v2` at `50f5ddc3cc7fc27fdc766d2982a8a2cf38bf078`
Bootstrap branch: `codex/couple-ledger-v2-incident-bootstrap`
Bootstrap commit: `f21acb9` (`fix: add production-safe v2 incident bootstrap`)
Scope: minimal incident containment and compatibility only. No production
deployment, writer change, feature-flag change, LINE setting change, Rich Menu
change, or production Supabase mutation was performed.

## 1. Current production schema contract

The read-only production snapshot showed the two V2 migrations already recorded
in Supabase:

- `20260812050029_add_couple_ledger_v2_shadow`
- `20260812053946_add_couple_ledger_v2_workflows`

The snapshot also showed `writer_control.active_plane = 'v2'`,
`mutation_fence = false`, `writer_epoch = 1`, three Ledgers, 223 V2
transactions, and zero quarantine. Two post-migration V2 financial
transactions must be treated as production truth. The following later objects
were absent from the observed production schema and migration history:

| Later contract | Status | Bootstrap treatment |
|---|---|---|
| `transactions.replaces_transaction_id` plus index/FK | absent | typed `NULL` projection; replacement is held |
| `ledger_v2.categories`, transaction `category_id` plus index/FK | absent | category routes/filters are held |
| recurring `category_id` plus index/FK | absent | old recurring shape only; runner held |
| inbox/outbox `max_attempts` and dead-letter checks | absent | workers do not claim/dispatch |
| `writer_control.financial_writes_enabled` | absent before bootstrap SQL | standalone migration adds it, default `true` |

The bootstrap target therefore depends only on the shadow/workflow tables and
the pre-lineage/pre-category columns. It does not claim that the later V2
schema is present.

## 2. Bootstrap scope

`V2_INCIDENT_BOOTSTRAP_ONLY=1` is a deployment boundary, not a product flag.
It keeps safe reads available and prevents code from reaching missing-column
queries:

- V2 context, Ledger list/bootstrap, transaction history/export, proposal
  reads, and existing attachment metadata reads remain available.
- Current-schema Ledger/transaction/recurring creation paths use old-schema
  projections; category identity and replacement lineage are rejected.
- Statistics, category management, replacement editing, and other later-schema
  routes return the stable 503 maintenance error before SQL is attempted.
- V2 recurring, inbox, and notification workers are held before claim SQL.
- With `V2_LINE_INBOX_ENABLED=1`, the webhook durably inserts each event into
  the existing inbox shape and returns `{ ok: true, maintenance: true }`;
  it does not dispatch or direct-post financial commands.
- With the bootstrap flag and inbox disabled, the webhook returns 503 rather
  than falling back to the old direct financial handler.

The allowlists live in `src/lib/v2-incident-freeze.ts`; route enforcement is in
`src/app/api/app/[...path]/route.ts`.

## 3. `V2_INCIDENT_BOOTSTRAP_ONLY` behavior

The code flag and the persistent database freeze are intentionally separate.
The code flag prevents unsupported schema access; it does **not** by itself
freeze valid pre-lineage V2 writes. The persistent freeze is
`writer_control.financial_writes_enabled = false`, enforced both by
`assertV2Writer` and database triggers.

Expected state during repair:

```text
V2_INCIDENT_BOOTSTRAP_ONLY=1
V2_LEDGER_ENABLED=1
NEXT_PUBLIC_V2_LEDGER_UI=0
V2_LINE_INBOX_ENABLED=1
active_plane=v2
mutation_fence=false
financial_writes_enabled=false
```

Reads continue while the flag is false. Create, replace, proposal confirm,
recurring toggle/run, V1 financial writes, and direct LINE deterministic entry
are rejected with the stable HTTP 503 maintenance response. Inbox rows remain
`received` and are not claimed, so the event is retained for later replay.

## 4. Standalone freeze migration analysis

Migration `supabase/migrations/20260814024223_v2_incident_write_freeze.sql` is
the only migration in the bootstrap commit. It:

1. adds `writer_control.financial_writes_enabled boolean not null default true`;
2. replaces the existing V1 guard so the new flag also fences V1 writes;
3. adds V2 triggers to transactions, payments, shares, events, proposals, and
   recurring runs;
4. leaves `active_plane`, `mutation_fence`, and `writer_epoch` unchanged;
5. permits only accounting-neutral category metadata updates while frozen,
   so a later categories migration can be applied without changing money.

The function uses `to_jsonb(old/new)` for the optional lineage field. It does
not select or reference a missing physical column, category table, recurring
category column, retry column, or dead-letter enum. The migration is therefore
independent of all later V2 migrations. Its default-true branch preserves old
code behavior until the operator explicitly activates the freeze.

The SQL must be executed as one explicit, single migration in a disposable
recovery checkout. Do not run unrestricted `supabase db push` because that
would apply every pending migration. Migration history may be repaired for
`20260814024223` only after the exact SQL completed and catalog checks passed;
missing historical migrations must never be marked applied without execution.

## 5. Old-code compatibility

The old V1/V2 bundle can start against the pre-lineage schema because no new
query runs at module import. The standalone migration is additive and the new
column defaults to `true`; old code ignores it. Existing V1 triggers still
reject V1 financial writes when `active_plane = 'v2'`.

The bootstrap bundle is required before exposing V2 routes because the normal
full bundle still selects `category_id`, `replaces_transaction_id`, recurring
category data, and worker `max_attempts`. The compatibility implementation
uses explicit old-schema projections rather than relying on a query failure.

No V1 table, V1 row, full migration, Rich Menu asset, or production
configuration is removed or changed by this commit.

## 6. Current-schema bootstrap test

`src/lib/v2-bootstrap-compatibility.pg.test.ts` is an opt-in PostgreSQL
integration test. It rejects any non-local database URL. The isolated target
was created from the current V2 shadow/workflow shape, pruned of the later
columns/tables/constraints, and then given only the standalone freeze
migration. It verifies:

- the later objects are actually absent;
- `active_plane=v2`, `mutation_fence=false`, and the additive flag defaults
  to `true`;
- Ledger creation, list, bootstrap, balance, history, and a current-schema
  transaction write work before the freeze;
- create, replacement, proposal confirmation, recurring toggle/runner, and
  inbox dispatch are held after the freeze;
- a real `handleLineEvent` deterministic text event (`晚餐 1 我付`) rejects at
  the freeze boundary and the PostgreSQL transaction count is unchanged;
- an inbox row remains `received` with `attempt_count=0`;
- `/api/version` exposes the build boundary.

Run sequentially against an isolated database only:

```bash
V2_BOOTSTRAP_TEST_DATABASE_URL=postgresql://nc8@localhost/<isolated-db> \
pnpm test:bootstrap
```

The same fixture must not be run concurrently for the same `couple_id`,
because the test intentionally toggles the shared writer-control freeze.

## 7. Bootstrap race windows

The deployment order is:

```text
standalone SQL (default true)
  -> bootstrap bundle with UI off
  -> /api/version/read-only verification
  -> guarded persistent freeze
  -> later additive schema repair
```

The real windows are:

- **A — before the standalone SQL:** the pre-existing partial-cutover risk
  remains; this patch adds no new state.
- **B — after SQL, before bootstrap bundle:** the new column is default true,
  so old code remains compatible. Keep the interval short and do not expose
  the V2 UI or LINE direct handler.
- **C — after bootstrap bundle, before persistent freeze:** safe old-schema
  V2 writes are still technically enabled. The operator must activate the
  freeze immediately after deployment verification; this interval has no
  automatic timeout and is an explicit human risk.
- **D — after persistent freeze:** financial writes are rejected at both code
  and database layers. Events can be retained in inbox but cannot be claimed.

If any deployment, lock, or state verification fails, keep the freeze active,
do not unfreeze, and stop. There is no hidden retry or timer that silently
reopens writes.

## 8. Operator commands

Every command below is a template. None was run against production.

### READ ONLY

```bash
export V2_INCIDENT_DATABASE_URL='postgresql://<operator>@<approved-host>/<db>'
export V2_INCIDENT_COUPLE_ID='<couple-id>'
pnpm incident:v2:status
curl -fsS https://<production-domain>/api/version
supabase migration list --db-url "$V2_INCIDENT_DATABASE_URL"
```

### PRODUCTION MUTATION — DO NOT EXECUTE DURING REVIEW

```bash
test "${PRODUCTION_MUTATION_CONFIRM:-}" = "APPLY_INCIDENT_FREEZE_SQL" || exit 1
psql --single-transaction --set ON_ERROR_STOP=1 "$V2_INCIDENT_DATABASE_URL" \
  --file supabase/migrations/20260814024223_v2_incident_write_freeze.sql
```

After SQL/catalog verification and a human checkpoint only:

```bash
test "${PRODUCTION_MUTATION_CONFIRM:-}" = "RECORD_EXECUTED_INCIDENT_MIGRATION" || exit 1
supabase migration repair --status applied \
  --db-url "$V2_INCIDENT_DATABASE_URL" 20260814024223

V2_INCIDENT_FREEZE_APPLY=1 V2_INCIDENT_ALLOW_REMOTE=1 \
V2_INCIDENT_DATABASE_URL="$V2_INCIDENT_DATABASE_URL" \
V2_INCIDENT_COUPLE_ID="$V2_INCIDENT_COUPLE_ID" \
pnpm incident:v2:freeze -- --apply
```

The CLI refuses a remote mutation without the explicit
`V2_INCIDENT_ALLOW_REMOTE=1` acknowledgement, requires the exact database URL
and couple ID, locks the control row, checks `active_plane=v2` and
`mutation_fence=false`, updates only `financial_writes_enabled`, verifies, and
commits. `status` is read-only and never accepts `--apply`.

## 9. Single-migration deployment strategy

The bootstrap deployment contains exactly one new migration:
`20260814024223_v2_incident_write_freeze.sql`. Use a recovery checkout with
only this migration when applying it to an environment whose migration head
stops at workflows. Record the exact SQL checksum, operator, UTC timestamp,
target project, and catalog verification output.

Do not run the later lineage/categories/recurring/retry migrations as part of
the bootstrap deployment. They require the persistent freeze, a separate
reviewed order, and their own rehearsal. Do not use migration repair as a
substitute for applying SQL.

## 10. Freeze verification

Success requires all of the following, captured as an operator artifact:

```sql
select couple_id, active_plane, mutation_fence,
       financial_writes_enabled, writer_epoch, updated_at
  from ledger_v2.writer_control
 where couple_id = <couple-id>;

select c.relname, t.tgenabled
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'ledger_v2'
   and t.tgname in (
     'prevent_v2_transaction_write', 'prevent_v2_payment_write',
     'prevent_v2_share_write', 'prevent_v2_event_write',
     'prevent_v2_proposal_write', 'prevent_v2_recurring_run_write'
   );
```

Expected writer row is `v2 / false / false`; every listed trigger is enabled.
The supported V2 create/replace/proposal/recurring harness and the old V1
financial path must each return `REJECTED`/503. A read of an existing Ledger
must still succeed. Any write, trigger, or state mismatch is a stop condition.

## 11. Version boundary

`GET /api/version` is a no-store, unauthenticated deployment identity endpoint.
The bootstrap build returns `commitSha`, `environment`, and `buildTimestamp`;
it does not expose secrets or feature-flag values. The compatibility test
asserts these fields using a synthetic production build environment.

Before any controlled deployment, the operator must compare the endpoint's
`commitSha` with the approved bootstrap commit (`f21acb9` or its full SHA) and
record the Vercel deployment ID. A successful HTTP response without a matching
SHA is not deployment proof.

## 12. Bootstrap flag state

The intended bootstrap deployment state is:

| Flag/state | Required value | Why |
|---|---:|---|
| `V2_INCIDENT_BOOTSTRAP_ONLY` | `1` | hold unsupported schema paths |
| `V2_LEDGER_ENABLED` | `1` | allow only the explicitly compatible V2 surface |
| `NEXT_PUBLIC_V2_LEDGER_UI` | `0` | no public V2 UI during repair |
| `V2_LINE_INBOX_ENABLED` | `1` | durable inbox retention without dispatch |
| `financial_writes_enabled` | `false` after freeze checkpoint | reject all financial mutation |

`NEXT_PUBLIC_V2_LEDGER_UI` is build-time. The other application values are
runtime values for a new deployment. Existing production values are encrypted
and were not read; they remain unknown until a human checks them. This review
did not enable or change any flag.

## 13. Commit diff review

Commit `f21acb9` contains 19 files: the standalone migration, guarded freeze
CLI, bootstrap route/service/worker/webhook compatibility, `/api/version`, the
opt-in PostgreSQL test, two unit/version tests, package scripts, and the
contract document. Diff summary: 1,081 insertions and 74 deletions.

The diff contains no product UI, no Rich Menu asset/API call, no migration
backfill, no V1 deletion, no production credential, and no deployment action.
The package additions are limited to `test:bootstrap` and the three incident
status/freeze commands. A follow-up test/report commit adds only the direct
LINE assertion and this review document; it does not change runtime behavior.

## 14. Test results

On the parent working tree after the compatibility changes:

| Check | Result |
|---|---:|
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS — 243 tests, 0 fail, 0 skipped |
| `pnpm exec tsx --test src/lib/v2-incident-freeze.test.ts` | PASS — 4 |
| `V2_BOOTSTRAP_TEST_DATABASE_URL=... pnpm test:bootstrap` | PASS — 1 PostgreSQL test |
| `pnpm test:tx` | PASS — 39, 3 credential-gated skips |
| `pnpm test:precutover` | PASS — 16 |
| `pnpm test:incident` | PASS — 16 tests (including the 10 incident-freeze subtests) |
| dedicated worktree `pnpm typecheck` | PASS |
| dedicated worktree `pnpm test` | PASS — 233 |
| dedicated worktree `pnpm build` | PASS |
| dedicated worktree bootstrap PostgreSQL test | PASS — 1 (sequential run) |
| parent `pnpm build` | PASS — Next.js production build includes `/api/version` and `/api/cron/v2-workers` |
| parent `pnpm test:e2e` | PASS — 36 Chromium/WebKit tests |

The fixture test was deliberately run sequentially after an initial parallel
attempt exposed only a shared local writer-control race between two test
processes; no application defect was inferred. Parent build and
Chromium/WebKit E2E were rerun after the direct LINE test addition and passed.
Repository-wide lint remains a known baseline failure in unrelated legacy test
code and is not a bootstrap acceptance gate.

## 15. Remaining blockers

The bootstrap commit is not permission to repair or cut over production. Before
controlled deployment, a human still must:

1. verify the exact promoted Vercel deployment SHA and encrypted flag state;
2. take and restore-test the complete production backup;
3. confirm the standalone migration checksum and apply it through the approved
   single-migration path;
4. deploy the bootstrap bundle with UI disabled and verify `/api/version`;
5. activate and verify the persistent freeze;
6. separately rehearse/apply the missing lineage, categories, recurring, and
   retry/dead-letter migrations;
7. regenerate and reconcile the per-Ledger migration plan without merging
   balances or discarding the two V2-only financial rows;
8. decide the forward repair for the partial-cutover state before any full
   writer/cutover work;
9. audit both users' V1 per-user Rich Menu bindings and replace unsafe menus
   only in a separate approved cutover task.

No production backup, schema repair, flag change, deployment, writer freeze,
Rich Menu mutation, or V1 data mutation occurred in this review.

## 16. GO / NO-GO

The code-level bootstrap boundary is suitable for a controlled deployment
review because the dedicated branch is isolated, pushed, typechecks, builds,
and passes the current-schema PostgreSQL proof. This is not a production
execution approval: all human preflight, backup, migration, and freeze gates
remain mandatory.

Production Supabase was untouched. The V2 production writer was not enabled by
this task. V2 production flags were not enabled or changed. Production LINE
settings and Rich Menu were untouched. V1 production data was not modified.

BOOTSTRAP COMMIT APPROVED FOR CONTROLLED PRODUCTION DEPLOYMENT

FORWARD REPAIR: NO-GO

FULL CUTOVER: NO-GO
