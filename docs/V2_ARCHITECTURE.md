# Couple Ledger V2 architecture and legacy boundary

Status: current-state documentation for `codex/v2-legacy-cleanup`.

This document records the repository state after the existing V1 frontend
cleanup. It is an evidence map, not a migration plan and not authorization for
production deployment or database writes.

## 1. Product ownership and invariants

- `src/app/page.tsx` renders `V2LiffHome` directly. There is no reachable V1
  homepage branch and no `NEXT_PUBLIC_V2_LEDGER_UI` runtime/build flag.
- `V2_LEDGER_ENABLED=1` enables the V2 API and writer gate. A fresh template
  keeps it at `0` until migration and cutover checks pass.
- V2 is the canonical TWD-only, two-member Couple Ledger. Each Ledger keeps
  its own transactions, payments, shares, balance, settlement transfer,
  recurring rules, categories, statistics, and attachments.
- The accounting kernel is deterministic: payment totals and share totals
  equal the transaction amount; each two-member Ledger balance is zero-sum;
  idempotency and immutable/void-and-replace lineage remain database-backed.
- This cleanup changed no SQL migration, schema, accounting formula, writer
  state, production row, authentication, AI contract, or Rich Menu design.

## 2. A-F dependency map

The map covers the baseline TypeScript universe, current runtime paths, tests,
scripts, routes, direct dependencies, and checked-in assets. References were
searched from the current worktree after the pre-existing deletion set was
inspected; filename-only deletion was not used.

### A. `src/` runtime and retained compatibility

| Path set | Classification | Inbound/dependent surface | Disposition |
| --- | --- | --- | --- |
| `src/app/page.tsx`, `src/components/ledger/**`, `src/hooks/use-v2-ledgers.ts` | `ACTIVE_V2_PRODUCTION` | Root LIFF entry, V2 browser API calls, V2 E2E | Retain as the only active UI |
| `src/app/api/app/[...path]/route.ts` | `ACTIVE_V2_PRODUCTION` plus legacy read/guard boundary | All LIFF API calls; V2 route services; compatibility GETs | Retain; document every route below |
| `src/app/api/line/webhook/route.ts`, `src/lib/v2-line-inbox-dispatch.ts`, `src/lib/v2-inbox-worker.ts` | `ACTIVE_V2_PRODUCTION` | Signed webhook, durable inbox, retry/dead-letter worker | Retain |
| `src/app/api/cron/{daily,v2-workers}/route.ts`, `src/lib/daily-jobs.ts` | `ACTIVE_V2_PRODUCTION` plus compatibility gate | Daily safety sweep, V2 recurring/outbox/inbox | Retain; V1 jobs are explicitly skipped when V2 owns the plane |
| `src/lib/v2-ledger.ts`, `src/lib/v2-ledger-service.ts`, `src/lib/v2-attachment-service.ts` | `ACTIVE_V2_PRODUCTION` | LIFF, LINE proposals, workers, V2 tests | Retain as canonical writer/read service |
| `src/lib/v2-line-proposal.ts`, `src/lib/v2-navigation.ts`, `src/lib/v2-notification-drain.ts`, `src/lib/v2-outbox-{dispatch,worker}.ts` | `ACTIVE_V2_PRODUCTION` | LINE direct/proposal flow, LIFF deep links, notification delivery | Retain |
| `src/lib/v2-migration*.ts`, `src/lib/ledger-core.ts`, `src/lib/ledger-query*.ts` | `LEGACY_MIGRATION_AUDIT` | Migration plan/apply, compatibility reads, historical tests | Retain; no production V1 deletion |
| `src/lib/accountant*.ts` | `LEGACY_MIGRATION_AUDIT` | API analytics/category paths, daily report path, secretary tool registry, tests | Retain; V2 daily jobs do not run legacy reports |
| `src/lib/secretary*.ts`, `src/lib/agent-*.ts`, `src/lib/vercel-agent.ts` | `LEGACY_MIGRATION_AUDIT` | LINE compatibility handler, task/memory/event reads, tool registry, tests | Retain; V2 text handling does not fall through to this writer |
| `src/lib/pending-action*.ts`, `src/lib/line-menu*.ts`, `src/lib/recurring*.ts`, `src/lib/group-service.ts`, `src/lib/bank-import-service.ts` | `LEGACY_MIGRATION_AUDIT` | V1 compatibility POSTs, migration/audit, transaction/PG tests, local smoke scripts | Retain behind the V2 route/handler/database fences |
| `src/lib/types.ts` | `ACTIVE_SHARED_INFRA` plus legacy types | V2 browser types and legacy compatibility query types | Retain; no V1 type is imported by the V2 Ledger components |
| `src/lib/server-runtime.ts`, `src/lib/db/**`, `src/lib/security.ts`, `src/lib/http-error.ts`, `src/lib/format.ts`, `src/lib/utils.ts` | `ACTIVE_SHARED_INFRA` | V2 and retained server paths | Retain; `format.ts` now contains only the used `money()` helper |

### B. `scripts/`

| Path set | Role | Disposition |
| --- | --- | --- |
| `scripts/v2-migration-plan.ts`, `scripts/v2-migration-apply.ts`, `scripts/v2-cutover.ts` | Read/guarded migration and writer-plane cutover | Retain; explicit apply gates remain required |
| `scripts/v2-incident-freeze.ts` | Incident writer freeze/status CLI | Retain as incident recovery tooling |
| `scripts/live-smoke/**` | Isolated/live smoke and cleanup probes | Retain as `TEST_ONLY`; never run against production for this issue |
| `scripts/line-rich-menu.ts` | Active Rich Menu render/validate/plan/apply/rollback source | Retain; source fingerprint now names current V2 files, external `-v1` aliases remain compatibility identifiers |

### C. `tests/`

- `tests/v2-liff.spec.ts` is the default Playwright target after the existing
  cleanup; `playwright.v2.config.ts` remains the dedicated V2 config.
- `src/lib/v2-ledger.test.ts`, `v2-history.test.ts`, `v2-workflow.test.ts`,
  `v2-migration*.test.ts`, `v2-outbox-dispatch.test.ts`,
  `v2-navigation.test.ts`, and `onboarding-route.test.ts` cover V2 kernel,
  workflow, migration, outbox, navigation, and route behavior.
- `src/lib/pending-action*.test.ts`, `ledger.test.ts`, and the remaining
  compatibility tests are retained because accountant/secretary, settlement,
  migration, incident, and historical invariants still have inbound callers.
- PostgreSQL suites are opt-in and refuse non-local test URLs. A skip is a
  truthful result when an isolated database is not supplied.

### D. App route map

All paths below are relative to `/api/app`.

| Method/path | Classification and writer behavior |
| --- | --- |
| `POST /session` | Authentication/session setup; not a financial writer and intentionally precedes the V2 POST guard |
| `GET /v2/context`, `/v2/ledgers`, `/v2/ledgers/:id/bootstrap` | V2 reads; require `V2_LEDGER_ENABLED=1` |
| `GET /v2/ledgers/:id/transactions`, `/export`, `/statistics`, `/recurring`, `/categories` | V2 history, CSV, statistics, recurring, and category reads; require V2 gate |
| `GET /v2/transactions/:id/attachments`, `GET /v2/proposals/:id` | V2 attachment/proposal reads; require V2 gate |
| `POST /v2/ledgers`, `/v2/ledgers/:id/transactions`, `/settle-all`, `/activate`, `/default-shares` | Canonical ledger, transaction, transfer-settlement, activation, and default-share writes; require V2 gate and service writer check |
| `POST /v2/transactions/:id/mutate` | Canonical void/restore/replace path; require V2 gate, version, idempotency, and service writer check |
| `POST /v2/attachments`, `/v2/attachments/:id/complete` and `DELETE /v2/attachments/:id` | V2 receipt metadata lifecycle; require V2 gate |
| `POST /v2/proposals`, `/v2/proposals/:id/confirm`, `/cancel` | Bounded V2 proposal creation and explicit confirmation/cancel; require V2 gate |
| `POST /v2/ledgers/:id/recurring`, `/v2/ledgers/:id/categories`, `/v2/categories/:id`, `/v2/recurring/:id/toggle` | V2 recurring/category metadata writers; require V2 gate and service validation |
| `GET /bootstrap`, `/export`, `/analytics/**`, `/expenses/**`, `/secretary/tasks`, `/agent/**` | Retained V1 compatibility/read surface; no V1 UI entry remains |
| `POST /actions`, `/groups`, `/recurring`, `/categories/**`, `/bank/import`, `/agent/tasks`, `/onboarding` | Retained V1 compatibility writers; when `V2_LEDGER_ENABLED=1`, the route rejects every non-session POST with `409 V2 Ledger writer 已啟用；請使用 V2 Ledger API` before dispatch |

The route-level guard is in `src/app/api/app/[...path]/route.ts` after
authentication and before any non-V2 POST service call. `GET` compatibility
reads remain available for migration/audit; they are not a second financial
writer.

### E. Direct dependencies

The six removed direct dependencies have no remaining source import, package
script use, or lockfile reference after the current cleanup:

`@base-ui/react`, `@hookform/resolvers`, `cmdk`, `react-hook-form`,
`recharts`, and `shadcn`.

The retained direct dependency set is used by the V2 UI, Next.js runtime,
LINE/Gemini/Supabase integrations, PostgreSQL transaction path, validation,
styling, and test/build tooling. `components.json` is retained as a UI
generator configuration file; removing the CLI dependency does not make the
checked-in UI components dead.

### F. Assets and generated output

| Path | Classification | Evidence/disposition |
| --- | --- | --- |
| `assets/line-rich-menu/record.png`, `manage.png` | `ACTIVE_SHARED_INFRA` / ops asset | Loaded by `scripts/line-rich-menu.ts`; retain unchanged |
| `scripts/line-rich-menu.ts` | Active ops source | Render/validate/plan/apply/rollback remain available; no external alias redesign |
| `setup.html` | Setup helper | Referenced by `SECURITY.md`; browser-only secret generation is intentionally retained |
| `components.json` | Tooling config | Retained for component maintenance; not a runtime dependency |
| `output/`, `.next/`, `.pnpm-store/` | Generated/local artifacts | Not commit inputs. The untracked `.pnpm-store/` SQLite artifact was moved to `/Users/nc8/.codex/archives/line-couple-ledger-pnpm-store-20260913/` and verified absent from the worktree |

## 3. Classification counts

The baseline at `20c81119c2177b15aa8a6ff5cea1ea7826afab7f` contained 190
tracked TypeScript/TSX paths across `src/`, `scripts/`, and `tests/`. The
current tree contains 167. The mutually exclusive cleanup classification is:

| Classification | Count | Meaning |
| --- | ---: | --- |
| `ACTIVE_V2_PRODUCTION` | 20 | Current V2 UI, API, ledger services, inbox/outbox, and worker paths |
| `ACTIVE_SHARED_INFRA` | 65 | Shared runtime, types, security, UI primitives, and non-V1-specific infrastructure |
| `LEGACY_MIGRATION_AUDIT` | 53 | Retained V1 compatibility, accountant/secretary/pending-action, query, migration, and audit paths with inbound references |
| `INCIDENT_RECOVERY` | 2 | `v2-incident-freeze.ts` and its guarded CLI |
| `TEST_ONLY` | 27 | Unit/PG tests and smoke probes |
| `DEAD` | 23 | Verified-unreachable V1 UI/helpers/tests removed by the pre-existing cleanup |

The category totals equal the baseline 190 paths. This count is a cleanup
inventory, not a claim that every retained compatibility path is part of the
active V2 product.

## 4. Removed V1 set and inbound-reference result

Removed files (23):

- `src/components/legacy-home.tsx`
- `src/components/analysis/analysis-section.tsx`
- `src/components/dashboard/{agent-task-bar,category-pie-chart,dashboard,recent-decisions,secretary-task-card,spending-trend,tag-bar-chart}.tsx`
- `src/components/expense/expense-form.tsx`
- `src/components/history/history-section.tsx`
- `src/components/layout/nav-bar.tsx`
- `src/components/onboarding/onboarding-flow.tsx`
- `src/components/private/private-ledger.tsx`
- `src/components/settings/settings-section.tsx`
- `src/components/transfer/{transfer-sheet,transfer-sheet.test}.tsx`
- `src/hooks/{use-analytics,use-bootstrap}.ts`
- `src/lib/categories.ts`
- `src/lib/{optimistic,optimistic.test}.ts`
- `tests/liff.spec.ts`

The current source tree has no imports or runtime references to those paths or
to the removed helper exports (`tagColor`, V1 chart/date/optimistic helpers).
Historical `docs/closeout-v1.md` text may mention old paths as audit evidence;
that is not an inbound runtime reference.

## 5. Accountant/agent disposition

The accountant/agent surface is retained, not dead:

1. `src/app/api/app/[...path]/route.ts` reads accountant analytics and agent
   tasks/memories/events and accepts retained category cleanup/suggest/task
   routes.
2. `src/app/api/cron/daily/route.ts` imports the legacy secretary briefing;
   `src/lib/daily-jobs.ts` runs legacy recurring/accountant/insight jobs only
   while V2 is not the active plane.
3. `src/lib/line-webhook-service.ts` and `src/lib/line-secretary-service.ts`
   remain the compatibility LINE path when V2 is disabled; the V2 text branch
   in `line-text-service.ts` returns V2 balance/proposal responses and never
   falls through to `runLineSecretaryTurn`.
4. `services.ts`, `secretary-tool-registry.ts`, `accountant-tool-registry.ts`,
   migration code, and `ledger.test.ts` have direct references.

Disposition: `LEGACY_MIGRATION_AUDIT` / compatibility. These modules are not a
second V2 product and are not deleted without a separate migration/audit
decision.

## 6. Settlement and settle-all compatibility

| Surface | Current behavior |
| --- | --- |
| V2 `POST /v2/ledgers/:id/settle-all` | Reads one Ledger balance and writes one first-class V2 `transfer` for only the debtor amount; idempotency receipt and zero-sum checks remain in the same transaction |
| V2 LINE `結清` | Builds the same `buildSettleAllTransfer` shape, then creates a bounded proposal for LIFF confirmation |
| V2 migration | Converts each legacy `public.settlements` row into a transfer in its source Ledger; no cross-Ledger netting |
| Retained V1 settlement | `pending-action-*`, `line-menu-service.ts`, and secretary tools still read/write legacy settlement structures only as compatibility code; the V2 route guard and database writer trigger fence them after cutover |

Evidence: `src/lib/v2-ledger-service.ts`, `src/lib/v2-ledger.ts`,
`src/lib/v2-line-proposal.ts`, `src/lib/v2-migration.ts`,
`src/lib/v2-ledger.test.ts`, `src/lib/v2-migration.test.ts`, and the guarded
PostgreSQL precutover suite.

## 7. Shared-type audit

- V2 browser contracts are the `V2*` types in `src/lib/types.ts` and the
  service schemas in `src/lib/v2-ledger-service.ts`.
- The legacy `Expense`, `Bootstrap`, `SettlementView`, and category/query
  types remain consumed by `ledger-query*`, accountant loaders, secretary
  tools, retained API reads, migration tests, and historical compatibility
  tests.
- V2 components import the V2 contracts and `money()`; no deleted V1 helper or
  legacy optimistic field is needed by the V2 entry.
- No formula, amount representation, payment/share semantics, or database
  schema was changed by the cleanup.

## 8. Flags and operational boundaries

| Flag | Scope | Current meaning |
| --- | --- | --- |
| `V2_LEDGER_ENABLED` | Runtime | V2 API/writer gate; when `1`, non-session non-V2 POSTs are rejected and V2 daily ownership is selected |
| `V2_LINE_INBOX_ENABLED` | Runtime | Durable signed webhook inbox and worker dispatch; daily safety sweep drains it when enabled |
| `V2_INCIDENT_BOOTSTRAP_ONLY` | Runtime incident mode | Holds unsupported V2 schema paths and workers; reads remain limited by explicit allowlists |
| `V2_MIGRATION_APPLY`, `V2_CUTOVER_APPLY` | One-shot CLI | Guarded migration and writer-plane mutations; not persistent deployment flags |
| `V2_TEST_DATABASE_URL` | Local test only | Opt-in isolated localhost PostgreSQL target; missing value produces explicit SKIP |

Historical incident docs may retain `NEXT_PUBLIC_V2_LEDGER_UI` references to
explain an old build. It is absent from `.env.example`, current Playwright
configs, application code, and current environment documentation.

## 9. Single-writer proof

The proof is layered and current-tree based:

1. **Route:** V2 API routes call `requireV2Ledger`; with V2 enabled, every
   non-session POST is rejected before a legacy service is called.
2. **LINE:** V2 text handling uses deterministic V2 writes or bounded V2
   proposals; V1 postback confirmation/menu writes are rejected while V2 is
   enabled. Durable inbox dispatch uses the same handler and idempotent V2
   services.
3. **Cron:** when V2 owns the plane, daily jobs run V2 recurring,
   notification, inbox, and attachment maintenance; legacy recurring,
   accountant report, insight, and notification flush paths are skipped.
4. **Database:** the workflow migration installs `prevent_v1_financial_write`
   on legacy financial/group tables after a couple is V2-active. The incident
   freeze migration adds `financial_writes_enabled` and V2 triggers; the
   cutover CLI changes `active_plane` only after a verified zero-quarantine
   digest and writer fence transaction.

This is static/current-tree and local-test evidence. This issue performs no
production writer-state read or write and does not claim current production
flag/schema state beyond the retained historical records.

## 10. User-visible coverage retained

| Requirement | Code/test evidence |
| --- | --- |
| Expense, partner payer, multi-payer/split | `v2-transaction-editor.tsx`, `v2-ledger-service.ts`, `tests/v2-liff.spec.ts`, `v2-ledger.test.ts` |
| Equal, weight, percentage, exact, 100/0 split | `v2-ledger.ts`, service schemas, LIFF E2E and kernel tests |
| Income/refund and transfer | V2 transaction schema, LINE proposal parser, LIFF E2E, kernel tests |
| History, filter, statistics, categories, CSV | V2 route/service/UI plus `v2-history.test.ts` and V2 E2E |
| Recurring rules | V2 service/UI, daily runner, precutover PG suite |
| Void/replace and lineage | V2 mutate route/service, migration/lineage tests, V2 E2E void coverage |
| LINE direct expense and proposal confirmation | `line-text-service.ts`, `v2-line-proposal.ts`, inbox/webhook services, V2 workflow/precutover tests |
| Notification enqueue/drain | `v2-ledger-service.ts`, outbox worker/dispatch/drain, outbox and retry tests |

## 11. Current documentation boundary

- Current: `README.md`, `docs/README.zh-TW.md`, `docs/env-vars.md`,
  `docs/deploy-vercel.md`, `docs/v2-cutover-runbook.md`, and this document.
- Compatibility reference: `docs/commands.md`.
- Historical evidence: `docs/closeout-v1.md`,
  `docs/environment-cleanup-2026-08-11.md`, incident/bootstrap reports,
  production incident/backup reports, and dated repair reviews. They remain
  checked in; their old deployment IDs, flags, and production observations are
  not current release instructions.

## 12. Metrics and verification record

The source/dependency metrics use the same path universe before and after:

| Metric | Baseline `20c8111` | Current cleanup tree |
| --- | ---: | ---: |
| TypeScript/TSX paths in `src/`, `scripts/`, `tests/` | 190 | 167 |
| `src/` TypeScript/TSX files | 176 | 154 |
| `src/` TypeScript/TSX LOC | 45,183 | 40,645 |
| Direct dependencies (`dependencies` + `devDependencies`) | 35 | 29 |

Build artifact metrics, validation commands, PostgreSQL skip details, commit
SHAs, and remote SHA are recorded in the final Issue #1 report after the final
current-tree build and push.

## 13. Scope and deployment decision

- No production deployment occurred.
- No production database connection, migration, writer-plane mutation, Rich
  Menu mutation, or smoke write occurred.
- The branch is eligible for review only after the required test suite,
  production build, logical commits, push, and `git ls-remote` proof pass.
