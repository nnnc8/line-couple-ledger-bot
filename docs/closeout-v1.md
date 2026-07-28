# Agent v1 — Production closeout

> The newest release record is first. Older sections are retained as historical
> evidence and must not be read as the current deployment or rollback target.
>
> Automated, database, production, LINE API, Rich Menu, and logged-in LIFF
> proofs are complete. The remaining operator-only row is deliberately limited
> to interaction details that require a physical LINE client.

## 2026-07-28 LINE quick-action production release

### Release identity

- **Branch**: `codex/v1-transfer-flow`.
- **Runtime source SHA**:
  `443b4726047dbfa32223f4305655beb996a263c2`
  (`feat: add LINE quick ledger flows`).
- **Verified preview artifact**:
  `dpl_7aLNZSefZUtejZDikcyUW3J7w6GX`
  (`https://line-couple-ledger-4f9dwrctd-ncnc8.vercel.app`), `READY`.
- **Promoted production copy**:
  `dpl_C9nNfzrpSZEkr2SjJHYebyYDWAFB`
  (`https://line-couple-ledger-kk3ylezqg-ncnc8.vercel.app`), `READY`.
- **Production alias**:
  `https://line-couple-ledger-bot.vercel.app`.
- **Operational branch head**:
  `e19dd473385b4154b99850ca7a592e1c38d88e98`. Its only runtime-adjacent
  difference from the promoted artifact is loading ignored `.env.local` in
  the standalone Rich Menu operator script; the app runtime remains
  `443b4726047dbfa32223f4305655beb996a263c2`.

### Product changes

- Category analytics now maps the ranked category `label` back to the public
  `tag` contract. Distinct stored categories no longer collapse to `其他` or
  share one fallback color.
- All accidental Thai prose was replaced with Traditional Chinese. The
  remaining Thai Unicode match is the intentional `฿` currency symbol in the
  THB parser.
- LINE now has a strict, versioned, stateless postback flow for quick shared or
  private expenses, both transfer directions, and full settlement.
- Quick actions collect group, payer, category, item, and amount with
  Quick Reply buttons. Custom values open a validated, prefilled LIFF form.
- Every financial result is a 10-minute pending action with confirm/cancel;
  menu postbacks never write directly. Requester identity comes from the signed
  LINE event, group ownership is rechecked, and webhook-event-derived
  idempotency keys prevent retry duplicates.
- Image messages now return an explanatory Flex card with quick-entry and LIFF
  actions instead of advertising unsupported receipt OCR.
- Two reproducible 2500×1686 Rich Menu assets and
  `render` / `validate` / `plan` / `apply` / `rollback` commands were added.
  The release aliases are `ledger-record-v1` and `ledger-manage-v1`.
- Next.js and `eslint-config-next` were patched from 16.2.9 to 16.2.11 in
  response to the July 2026 security release.

### Verification

| Gate | Result |
| :--- | :--- |
| `pnpm typecheck` | clean |
| `pnpm test` | 198 / 198 |
| real PostgreSQL transaction tests | 26 / 26 |
| `pnpm test:e2e` | 8 / 8 |
| `pnpm build` | success on Next.js 16.2.11 |
| changed production-file ESLint | clean |
| `git diff --check` | clean |
| Rich Menu render / validation | 2 / 2 assets valid, full non-overlapping coverage, both under 1 MB |
| Preview HTTP | root and signed empty webhook return 200 |
| Production HTTP | alias root and signed empty webhook return 200 |
| Logged-in LIFF | LINE OAuth login succeeds and production bootstrap renders real ledger data |
| Live classification | `維修保養`, `車貸`, `油資`, `信用卡費`; four categories, four labels/colors |
| Rich Menu API | two aliases resolve, both release menus exist, record menu is default |

### Live release evidence

- The production LINE Channel Access Token was validated with the bot-info
  endpoint. Production channel token and secret were refreshed without
  printing either value.
- The exact verified preview artifact was promoted; the production alias now
  resolves to the promoted production copy above. The prior production
  deployment remains the application rollback target.
- `ledger-record-v1` resolves to
  `richmenu-9b3a0ce7a9e69a6853662b0ca8e87969`;
  `ledger-manage-v1` resolves to
  `richmenu-713ef684d4c6b44160c9d4734665bdff`. The record menu is the default.
  Both menu names use the stable runtime release ID `443b4726`.
- `output/rich-menu-rollback.json` was written mode `600` before the menu
  switch and remains outside Git.
- A real LINE OAuth session opened the production LIFF URL and loaded the
  authenticated dashboard. The category card showed four distinct stored
  categories, the `記一筆` sheet showed separate expense/transfer/settle
  actions, and no Thai prose was present.
- Branch-scoped Preview values were removed after promotion. `vercel env ls
  preview codex/v1-transfer-flow` returns no variables, so production secrets
  are not left attached to future branch previews.
- `pnpm audit --prod` no longer reports the patched Next.js advisories, but
  still reports nine inherited transitive advisories (seven high, two
  moderate) through Sharp, Google GenAI/MCP, and the `shadcn` CLI dependency.
  They were not force-overridden because compatible upstream releases must be
  tested separately.

### Rollback

1. Application: promote or alias
   `dpl_3S23pfx2NPCR3FGKWbHVnCWuQwbn`.
2. Rich Menu: run `pnpm rich-menu:rollback`. It restores the captured prior
   default and aliases from the mode-600 manifest.
3. Database: no migration or data mutation belongs to this UI release, so no
   database rollback is required.

## 2026-07-27 first-class transfer release

### Release identity

- **Branch**: `codex/v1-transfer-flow`, pushed to
  `origin/codex/v1-transfer-flow`.
- **Runtime source SHA**:
  `bb5340c3ded5d344f39be01e1c15ee05b7abc64a`
  (`feat: add first-class transfer ledger`).
- **Verified preview**:
  `dpl_3B5KREpdeCAKr3AXURpkEJSFzwFP`
  (`https://line-couple-ledger-3y1lgi2wv-ncnc8.vercel.app`), `READY`, exact
  source SHA above.
- **Production deployment**:
  `dpl_3S23pfx2NPCR3FGKWbHVnCWuQwbn`
  (`https://line-couple-ledger-whg3r01bw-ncnc8.vercel.app`), `READY`,
  promoted at 2026-07-27 20:46 Asia/Taipei.
- **Production alias**:
  `https://line-couple-ledger-bot.vercel.app`.
- Vercel records `action=promote` and
  `originalDeploymentId=dpl_3B5KREpdeCAKr3AXURpkEJSFzwFP`; the production
  deployment has the same Git SHA. Vercel assigned the promoted production
  copy a new deployment ID, so the production copy was independently checked
  instead of assuming preview proof carried over.
- **Application rollback target**:
  `dpl_5GXuNtvS4TL2XDcUXn2Tog9sdeg9`
  (`273a6f8165a7d4d933c54c6e546e7ec0c4bbc9fe`), the previously deployed
  clean v1 baseline.
- This closeout file is committed after promotion. Its later docs-only commit
  is not the production runtime SHA; the runtime identity is the full SHA
  recorded above.

### v2 removal and recovery boundary

- Clean development base was the deployed v1 SHA `273a6f8`; the release
  branch is not descended from finance-v2 core commit `c222367`.
- Active Git refs containing `c222367` are empty. The local/remote
  `codex/personal-finance-v2` branch, its alias, `.finance-v2/`, and
  deployments whose source SHA was `c222367` or a descendant were removed.
  Historical Vercel records whose branch metadata says
  `codex/personal-finance-v2` but whose SHA is a retained v1 repair commit are
  not executable finance-v2.
- Production has no `finance` schema, abandoned public finance columns or
  indexes, or v2 finance activity-event entity types. The required
  `20260712103630_finance_v2_p0_repairs.sql` remains because it is a v1
  privacy/mirror repair despite its filename.
- Isolated backup:
  `/Users/nc8/Backups/line-couple-ledger/2026-07-22-v1-transfer-cutover`.
  The directory is mode `700`, backup files are mode `600`, and all five
  entries in `checksums.sha256` pass. It contains the public/finance schema
  and data inventory, Git bundle, v2 worktree, migration inventory, balances,
  and Vercel deployment inventory. Retain through 2026-08-21.
- The cleanup preflight proved all eight finance tables had zero rows before
  `DROP SCHEMA finance RESTRICT`. No 100/0 expense was guessed or converted;
  the eight historical candidates remain a read-only review list.

### Database migrations and live proof

The linked local/remote migration histories agree through:

1. `20260722103819_remove_abandoned_finance_schema`
2. `20260722104424_add_first_class_transfers`
3. `20260727193628_grant_group_balances_to_ledger_runtime`
4. `20260727200904_add_line_action_plans`
5. `20260727202748_restrict_line_action_plan_grants`
6. `20260727203509_lock_line_action_plan_runtime`

Post-migration production query at 2026-07-27 20:47 Asia/Taipei:

| Proof | Result |
| :--- | :--- |
| `public.expenses` | 572 |
| `public.expense_splits` | 768 |
| `public.settlements` | 4 |
| Transfer smoke residue | 0 transfer settlements, 0 transfer/void pending actions |
| `public.line_action_plans` residue | 0 |
| `finance` schema | absent |
| Abandoned public v2 columns / indexes / activity types | 0 / 0 / 0 |
| Transfer settlement columns | 7 / 7 present |
| Pending-action request fingerprint | present |
| `service_role` on `line_action_plans` | `SELECT`, `INSERT` only |
| `ledger_runtime` on `line_action_plans` | no table privileges |

The row-count increase from the 2026-07-22 backup (564 expenses / 755 splits)
is subsequent normal v1 usage, not cleanup loss. The four pre-existing
settlements remain four. Supabase security and performance advisors reported
only `INFO` notices and no `WARN` or `ERROR`; the no-policy RLS notice on
`line_action_plans` is paired with deny-by-default client grants.

### Product and accounting contract shipped

- `新增花費`, `記錄轉帳`, and `全部結清` are separate intents and UI flows.
- General transfers support zero balance, either direction, reverse direction,
  overpayment/crossing zero, and requester-recorded partner-to-me movement.
- Settle remains debt-limited and recalculates after obtaining the group lock.
- Transfer/settle/void, shared-expense writers, activity, notification queue,
  and pending-action confirmation share one database transaction and the same
  ordered group locks.
- Transfer is stored as a settlement, never an expense, split, category,
  budget item, or private mirror. Soft void keeps actor, time, source action,
  version, activity, and notification audit.
- LIFF now has the `記一筆` action sheet, balance-before/after preview,
  cross-zero warnings, transfer history filter, and soft-void entry.
- LINE direction is deterministic for `我轉給她`, `她轉給我`, `我還她`,
  `她還我`, and both settle phrases. Ambiguous direction/group asks instead of
  writing. A persisted immutable `line_action_plans` row makes webhook
  redelivery replay the first plan without rerunning the model.
- Pending financial actions notify the partner through the transactional queue
  only; the old direct second push is suppressed.

### Automated and live-system gates

| Gate | Result |
| :--- | :--- |
| `pnpm typecheck` | clean |
| `pnpm test` | 193 / 193 |
| `pnpm test:tx` | 26 / 26, including 3 real PostgreSQL tests |
| `pnpm test:e2e` | 6 / 6 |
| `pnpm build` | success |
| Changed-file ESLint | clean |
| Production-source ESLint | 0 errors; 11 inherited warnings |
| `git diff --check` | clean |
| `pnpm smoke:transfer` | all 6 phases passed; cleanup left zero residue |

The transfer smoke proved zero-balance transfers in both directions,
reverse/overpay crossing zero, partial/full partner-to-me settle, concurrent
full settle, scoped idempotency conflict handling, exactly-one audit and queued
notification, analytics isolation, and rollback cleanup.

Production verification after promotion:

- alias root returned HTTP `200` with title `共同帳本`;
- `GET /api/line/webhook` returned expected `405` with
  `x-matched-path: /api/line/webhook`, proving the POST-only route is live;
- production client bundle contains `記錄轉帳`, transfer history/search copy,
  and the void confirmation;
- bundle contains none of `FinanceHome`, `我的財務`, `淨資產`, `資產總覽`,
  `負債`, `NetWorth`, or `financialHome`;
- build error-only log, last-hour runtime error clusters, and
  deployment-scoped error/fatal logs were empty.

### Operator-only acceptance

| Surface | Cases | Expected proof | Verified by / when |
| :--- | :--- | :--- | :--- |
| Real LINE OA | outgoing, incoming, ambiguous direction, settle, same webhook redelivery | Confirm card before write; one settlement/activity/notification after confirm; ambiguous text writes nothing; retry does not duplicate | _operator_ / _date_ |
| Physical-phone LIFF | zero-balance transfer, cross-zero preview, partner-to-me, settle, history filter, void, keyboard/safe area | Correct before/after balance, transfer excluded from analytics, void restores balance once | _operator_ / _date_ |

### Rollback

- **Application**: point `line-couple-ledger-bot.vercel.app` back to
  `dpl_5GXuNtvS4TL2XDcUXn2Tog9sdeg9` in Vercel Deployments, or assign the
  alias to
  `https://line-couple-ledger-jk0j1iawv-ncnc8.vercel.app`.
- **Transfer schema**: additive and backward-compatible with clean v1. Once
  real transfer rows exist, do not drop the settlement columns, enum values,
  fingerprint, or action-plan table. Use an incident-specific forward
  migration if a schema repair is required.
- **Finance cleanup**: there is intentionally no destructive down migration.
  Restore abandoned finance data only from the isolated backup/PITR after a
  separate incident review; deleting migration files is not a production
  rollback.

---

The remaining sections are historical release records. Their deployment IDs,
test counts, database description, and rollback targets are preserved for
audit only and are superseded by the 2026-07-27 section above.

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

## 2026-07-12 v1 privacy and mirror repair

- **Repo**: repair commit `8424a17` (`fix: repair privacy and ledger mirrors`), retained in the v1 production ancestry.
- **Database migration**: `20260712103630_finance_v2_p0_repairs` applied to production. It adds user/group secretary session scope, invalidates the three unsafe old transcripts, fixes the mirror function, backfills missing mirrors in one transaction, adds 131 audit events, and expires 51 stale pending actions.
- **Database proof**: positive shared splits 257/257 have valid private mirrors; missing/stale mirrors 0; expired pending rows still marked pending 0; group balances stayed `阿提斯 -16,235/+16,235` and `吃飽喝足 +413/-413`; no notification rows were created by the repair.
- **Production**: deployment `dpl_4NAZHwhQr1Z1BFrhC9bQXk1tsgmg`, `READY` / `PROMOTED`, source SHA exactly `8424a170f1bdbc78171b0c3bd5d9b5f9e3758e03`, production alias HTTP 200, last-hour Vercel error log scan empty.
- **Local gates**: `pnpm typecheck`, `pnpm test` (189/189), `pnpm test:e2e` (4/4), changed-file ESLint, and `pnpm build` passed. The full repository lint baseline remains unresolved and is not claimed fixed here.
- **Supabase limitation**: development branch creation was attempted but blocked because the current plan does not support branching. Production was changed only after the P0 backup artifact was created.
- **Still operator-only**: real LINE two-user privacy cases and LIFF account-scope walkthrough remain required for every production release.

## 2026-07-12 Agent architecture convergence

- **Repo**: implementation commit `09fa5cefacbd238a2971f14bc87af51175f4e927`
  (`refactor: remove legacy agent paths`), retained in the v1 production ancestry.
- **Legacy removal**: deleted `src/lib/agent-loop.ts`, which had no production
  caller; removed the test-only `AgentChatService.chat()` accountant session
  path; removed the dead accountant Vercel tool builder.
- **Production path**: retained the LINE secretary `generateText` workflow and
  one secretary tool registry. The registry now emits the current AI SDK
  `inputSchema` contract instead of the obsolete `parameters` shape.
- **Provider**: `model-provider.ts` and `server-env.ts` are Gemini-only;
  unused `@ai-sdk/openai` and `@ai-sdk/anthropic` dependencies were removed.
  Audio transcription remains available through `AgentChatService`.
- **Quality gates**: `pnpm typecheck`, `pnpm test` (184/184; four obsolete
  legacy-path tests were removed), `pnpm test:e2e` (4/4), `pnpm build`, and
  production-source ESLint (`src` excluding `*.test.ts`) all passed. The test
  runner still prints existing best-effort `agent_event` mock warnings; they do
  not fail the suite and are not treated as production success evidence.
- **Production**: deployment `dpl_3MQSeQEREsdH2yGdsMH39KjR5LMK` is
  `READY` / `PROMOTED`; its Vercel API `gitSource.sha` is exactly
  `9bb68460c2896b784edf27d07de7b2ab71ddf505`, production alias HTTP 200,
  and the last-hour error-log query returned `No logs found`.
- **Database**: no migration or schema change was made in this phase. The
  closeout commit after this deployment only records these deployment facts;
  the deployed application code is the implementation in `09fa5ce` plus the
  already-pushed closeout metadata.
