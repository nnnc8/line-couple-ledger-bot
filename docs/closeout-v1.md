# Agent v1 — Production closeout

> Snapshot of the v1 closeout run. Update the "Verified by" rows after each
> redeploy and re-run of the live proof checklist.
>
> **Operator action required after redeploy**: open the production LINE OA
> and run the 4 cases in "Live LINE proof" below, then come back and fill in
> the `Verified by / when` column plus the actual reply and side-effect.

## 2026-07-12 transfer / LIFF repair continuation

- **Repo**: branch `codex/line-couple-bot-mvp`, repair commit `5780540a5900db03adc91de6a892f9a901633867` pushed to `origin`.
- **Duplicate transfer notification hotfix**: code commit `fd0c477` removes the second out-of-band LINE push from `handleSettlementTurn`; the transactional notification queue is now the only partner delivery path. `pnpm typecheck`, `pnpm test` (184/184), and `pnpm build` passed.
- **Hotfix production deployment**: `dpl_GfW7NfiHQ9AkLjhNkAUCn1WHiw2p` (`https://line-couple-ledger-fl6j0lggf-ncnc8.vercel.app`) is Ready, aliased to `https://line-couple-ledger-bot.vercel.app`, and returned HTTP 200.
- **Local gates**: `pnpm typecheck`, `pnpm test` (184/184), `pnpm test:e2e` (4/4), `pnpm build`, and `pnpm smoke:local` all passed. The live smoke covered private expense, shared expense, settlement, and cleanup.
- **Database**: no schema or migration changed. Settlement writes still use `pending_actions` → `settlements` / `activity_events` / `notifications` in the existing transaction; local smoke cleanup completed.
- **Production observation**: the HEAD push triggered a Vercel production deployment; the production alias is Ready and returns HTTP 200. The current CLI does not expose the deployment source SHA, so branch-push linkage is recorded but SHA parity is not independently exposed.
- **LINE / LIFF**: deterministic transfer and delayed-SDK coverage are local tests only. Real LINE account, LINE Console settings, production LIFF cold starts, and production DB side-effects remain operator-only after deployment.

## 2026-07-12 classification repair continuation

- **Repo**: branch `codex/line-couple-bot-mvp`, code commit `4bcd186ff3f19baaf552a4aeb4f043ae5e5222c4` pushed to `origin`.
- **Local gates**: `pnpm typecheck`, `pnpm test` (188/188), `pnpm test:e2e` (4/4), `pnpm build`, and `pnpm smoke:local` all passed.
- **Production**: Vercel deployment `dpl_27ns5ChL2pFU2DUCEGrkDVgLxTmx` is `READY` / `PROMOTED`, production alias returns HTTP 200, and Vercel API `gitSource.sha` exactly matches `4bcd186ff3f19baaf552a4aeb4f043ae5e5222c4`.
- **Classification**: `record_expense` now preserves valid Chinese tags, excludes `other` / `其他` history, applies deterministic rules first, and falls back safely on low confidence, errors, or timeout. Local model smoke was attempted but `.env.local` Gemini returned `API key not valid`; no successful live-model result is claimed.
- **Backfill**: exact target predicate (`source_event_id ~ '^01K'`, shared, 15 mapped descriptions, original tag `other` / `其他`) matched 15 rows. One atomic version-guarded update produced 15/15 expected tags, 15/15 version increments, 15/15 activity audits, and 0 notifications. Each audit `before_state` contains the rollback snapshot.
- **Database**: no schema or migration changed; raw pending-action command payloads were not rewritten, so the original command tag remains available for audit.

## Deployment

- **Production alias**: `https://line-couple-ledger-bot.vercel.app` (the cron
  smoke at `scripts/live-smoke/cron.ts` confirms this endpoint is live and
  reachable).
- **Repo SHA at closeout**: `97be21d` (`chore: close out agent v1 rollout`,
  pushed to `origin/codex/line-couple-bot-mvp`).
- **Vercel deployment record**:
  - deployment id: `dpl_64Ew3c2RByund15wFfqThvvzurgS`
  - canonical URL: `https://line-couple-ledger-nf4bsay78-ncnc8.vercel.app`
  - target: `production`, status: `Ready`
  - created: `2026-07-08 17:17:52 CST`
  - aliases: `line-couple-ledger-bot.vercel.app`,
    `line-couple-ledger-bot-ncnc8.vercel.app`,
    `line-couple-ledger-bot-nnnc8-ncnc8.vercel.app`
  - Previous production (kept for rollback reference): `dpl_2B8dQFYsgQUiuh3nJfTVhZpnyyEq`
    (SHA `09b8d94`).
- **Post-deploy sanity** (run after every redeploy):
  - `curl -sS -o /dev/null -w "%{http_code}\n" https://line-couple-ledger-bot.vercel.app/`
    → `200`.
  - `pnpm smoke:cron` → `200` from the same alias (so the cron route
    is wired and the new deployment is what the alias resolves to).
  - `vercel ls --prod` shows the new deployment at the top.
- **Working-tree changes shipped in `09b8d94`**:
  - `README.md` — v1 copy refresh, 174 / 2 test counts, "v1 limits" section.
  - `docs/README.zh-TW.md` — 架構圖不再寫「圖片」、`刪除剛剛那筆` 改寫為 LIFF confirm 流程。
  - `docs/commands.md` — replace 5-min confirm copy with the LIFF confirm
    flow; add Voice / Images rows.
  - `docs/deploy-vercel.md` — note that smoke scripts need
    `agent_events` migration applied.
  - `src/lib/line-secretary-service.ts` — drop implicit group fallback,
    intent-aware gate, image rejection, no `dependencies.context` writeback.
  - `src/lib/secretary-service.ts` — `pendingActions: unknown[]` →
    `didExecuteAction: boolean`.
  - `src/lib/agent-event-service.ts` — delete unused `runWithAudit`.
  - `src/lib/ledger-query-bootstrap.ts` + `src/lib/types.ts` — drop
    `memories` from bootstrap payload and `Bootstrap` type.
  - `src/components/settings/settings-section.tsx` — add
    `AgentRulesCard` (on-demand `fetch("/api/app/agent/memories")`).
  - `src/lib/ledger.test.ts` — 7 stub updates + 4 new tests + image
    test rewrite.
  - `tests/liff.spec.ts` — fixture gets `openTasks` / `recentEvents`;
    new `**/api/app/agent/memories` route mock.
  - `docs/closeout-v1.md` — this file.
  - `scripts/live-smoke/apply-migration.ts`,
    `scripts/live-smoke/probe-agent-events.ts`,
    `scripts/live-smoke/probe-roles.ts` — verification helpers.

## Database

- **Migration**: `supabase/migrations/202607080001_agent_events.sql` —
  already applied to the production database that `.env.local` points at
  (DB host `aws-1-ap-southeast-1.pooler.supabase.com`, role
  `ledger_runtime`).
- **Verification** (run via `pnpm exec tsx scripts/live-smoke/apply-migration.ts`):
  - `to_regclass('public.agent_events')` → `agent_events` ✓
  - Indexes: `agent_events_pkey`, `agent_events_couple_recent_idx`,
    `agent_events_user_recent_idx`, `agent_events_source_event_uniq` ✓
  - Unique partial index definition matches the migration SQL ✓
  - `service_role` privileges: INSERT ✓, SELECT ✓, UPDATE ✓
    (verified via `has_table_privilege`).
  - `ledger_runtime` privileges: SELECT, INSERT, UPDATE, DELETE
    (RLS on, role has `bypassrls`).
  - `agent_events` RLS enabled (`rowsecurity=true`).
  - service_role insert probe wrote a probe row, read it back, and
    deleted it cleanly.

## Verification

### Automated gates (all green)

| Gate | Result |
| :--- | :--- |
| `pnpm typecheck` | clean |
| `pnpm test` | 174 / 174 passing |
| `pnpm test:e2e` | 2 / 2 passing |
| `pnpm build` | success |

### Smoke (live DB, with cleanup)

| Smoke | Result |
| :--- | :--- |
| `pnpm smoke:local` | Cases 1 (private) / 2 (shared) / 3 (settle) all passed, cleanup ran. |
| `pnpm smoke:recurring` | Seeded recurring expense → generated `pending_action` (`status=confirmed`) → generated expense. Cleanup ran. |
| `pnpm smoke:cron` (pre-deploy) | `GET /api/cron/daily` returned 200 with empty drafts/reports (today is 2026-07-08; nothing due). |
| `pnpm smoke:cron` (post-deploy, against alias) | `GET https://line-couple-ledger-bot.vercel.app/api/cron/daily` returned 200 with the same empty payload — confirms the alias is now pointing at the new deployment. |

### Live LINE proof (4 cases — to be filled in by the operator)

> These four cases need a real LINE OA. The bot is reached on the same
> Production URL above; the test pairs are the production LINE users
> (smoke fixtures aside).

| # | Message | Expected reply | Expected side-effect | Verified by / when |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Shared text, no group name (e.g. `晚餐 500 我付`, account has ≥ 2 groups) | `要記到哪個群組？你的群組有：…` (`kind=needs_group`) | No `expenses` row. | _operator_ / _date_ |
| 2 | Shared text, with group name (e.g. `<group> 拉麵 200 我付`) | Secretary success reply that **includes the group name** | New `expenses` row + `agent_events.kind=action_executed`. | _operator_ / _date_ |
| 3 | Private text (e.g. `私人 咖啡 120`) | Direct success reply; no group prompt | New `expenses` row (ledger=`private`). | _operator_ / _date_ |
| 4 | Image (any photo) | `目前請直接用文字記帳，圖片暫不自動入帳 📝` | `agent_events.kind=image_rejected`; no `expenses` row. | _operator_ / _date_ |

### LIFF verification checklist (operator)

- [ ] Dashboard shows `openTasks` and `recentEvents` populated.
- [ ] Settings page shows the `學習紀錄` card (empty state until memories
  are written, or list of green/amber dot entries if there are any).
- [ ] After each LIVE LINE case above, the matching `agent_events` row
  appears in `recentEvents` (or in the DB for the operator to inspect).

## Rollback

This round is additive on the schema side: the only new DB object is
`public.agent_events`, which is a write-behind audit log that the
primary write path never depends on. The app code that writes to it is
in `agent-event-service.logAgentEvent`, which is best-effort and
swallows errors.

### Application rollback

1. In Vercel → Deployments, promote the previous deployment to
   production (or `vercel rollback`).
   - Current production: `dpl_64Ew3c2RByund15wFfqThvvzurgS` (SHA
     `97be21d`).
   - Previous production (one step back): `dpl_2B8dQFYsgQUiuh3nJfTVhZpnyyEq`
     (SHA `09b8d94`).
   - Earlier still: the SHA `9858162` deployment (visible in
     `vercel ls --prod`).
2. No data migration is required; the older build simply doesn't read
   from `agent_events` if you roll back further than the v1 closeout.

### Schema rollback (only if absolutely needed)

`agent_events` is purely an audit / observability layer. If a future
incident requires removing it:

```sql
-- Drop the table. The agent_events payload is not referenced by any
-- other table, no RLS policies outside the table itself, and no grants
-- beyond service_role + ledger_runtime.
drop table if exists public.agent_events cascade;
```

Equivalent DDL: deleting the migration file
`supabase/migrations/202607080001_agent_events.sql` and re-running
`supabase db push` against an empty / rolled-back DB. There is no
data-loss risk in the primary tables (expenses / pending_actions /
recurring_expenses / etc.) because none of them reference
`agent_events` (the FKs in the migration are the reverse direction).

### Smoke rollback

Smoke scripts auto-clean when `SMOKE_CLEANUP_MODE` is enabled. If a
smoke is interrupted, the seeded `codex-smoke` group and its rows can
be reaped by re-running the same script — it is idempotent against the
existing `codex-smoke` tenant.

## 2026-07-12 finance-v2 P0 repair

- **Repo**: branch `codex/personal-finance-v2`, commit `8424a17` (`fix: repair finance v2 privacy and ledger mirrors`), pushed to `origin`.
- **Baseline**: [finance-v2-baseline-20260712.md](./finance-v2-baseline-20260712.md). The P0 rollback SQL is kept outside Git at `.finance-v2/backups/production-p0-20260712.sql`.
- **Database migration**: `20260712103630_finance_v2_p0_repairs` applied to production. It adds user/group secretary session scope, invalidates the three unsafe old transcripts, fixes the mirror function, backfills missing mirrors in one transaction, adds 131 audit events, and expires 51 stale pending actions.
- **Database proof**: positive shared splits 257/257 have valid private mirrors; missing/stale mirrors 0; expired pending rows still marked pending 0; group balances stayed `阿提斯 -16,235/+16,235` and `吃飽喝足 +413/-413`; no notification rows were created by the repair.
- **Production**: deployment `dpl_4NAZHwhQr1Z1BFrhC9bQXk1tsgmg`, `READY` / `PROMOTED`, source SHA exactly `8424a170f1bdbc78171b0c3bd5d9b5f9e3758e03`, production alias HTTP 200, last-hour Vercel error log scan empty.
- **Local gates**: `pnpm typecheck`, `pnpm test` (189/189), `pnpm test:e2e` (4/4), changed-file ESLint, and `pnpm build` passed. The full repository lint baseline remains unresolved and is not claimed fixed here.
- **Supabase limitation**: development branch creation was attempted but blocked because the current plan does not support branching. Production was changed only after the P0 backup artifact was created.
- **Still operator-only**: real LINE two-user privacy cases and LIFF account-scope walkthrough remain required before starting the finance schema v2 work. No account/journal schema has been added yet.
