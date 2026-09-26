# P1-B — Write outcome truth, single draft owner & safe replay

Implementation source of truth: [Issue #11](https://github.com/nnnc8/line-couple-ledger-bot/issues/11). Frozen plan: [Issue #8](https://github.com/nnnc8/line-couple-ledger-bot/issues/8); product source: [Issue #7](https://github.com/nnnc8/line-couple-ledger-bot/issues/7). P1-A: [Issue #9](https://github.com/nnnc8/line-couple-ledger-bot/issues/9) / [PR #10](https://github.com/nnnc8/line-couple-ledger-bot/pull/10).

This change preserves the distinction between an unsent draft, an uncertain write, a confirmed write, and the freshness of subsequent reads. A dropped response cannot create a second operation on retry. A later failed read cannot turn a confirmed write into “not saved.”

1. **Baseline:** `e332ff2d28216daf1cf862d16163dc1cf2d313f8`, verified against remote `main` before implementation and again before publishing.
2. **Branch:** `codex/p1-b-write-outcome-truth` in an isolated worktree. The original checkout was preserved.
3. **Final remote SHA:** recorded with immutable CI links in the final Issue #11 report. This document travels with that commit; no self-referential commit SHA is embedded here.
4. **Changed files:** entry owner (`use-v2-entry-session.ts`), draft/operation models (`v2-transaction-draft.ts`, `v2-entry-operation.ts`), root/ledger/editor components, bootstrap owner, and typed API errors. Tests cover these boundaries, plus three additional real PostgreSQL cases. CI retains mobile evidence. The lint comparator only normalizes embedded source-location numbers so moved, unchanged diagnostics retain their identity; five tests preserve rejection of new findings. No dependency or lockfile change.
5. **Independent state facts:** draft `empty | dirty`, write `idle | submitting | unknown | committed | rejected`, read `initialLoading | ready | refreshing | failed`. A root entry owner survives Ledger-home remounts. Only one create/correction draft exists. The editor owns disclosure UI only; requests, keys, reset, and completion belong to the owner. Locked editing and an in-flight request are separate, so UNKNOWN does not keep a “saving” spinner running.
6. **Recovery record:** `sessionStorage["v2.entry-operation.v1"]` contains `schemaVersion`, actor/couple/Ledger IDs, create/replace type, endpoint, key, normalized body, submitted time, phase, and `hadUnknown`; confirmed writes add a validated `CommitProof`. No ordinary draft, token, cookie, receipt image, file bytes, or secrets are serialized. Before POST, writing and exact read-back must both succeed. Unreadable/malformed records block new financial work. Reload converts an in-flight marker to UNKNOWN; it never automatically POSTs.
7. **Rejected versus unknown:** local validation does not dispatch. On the first attempt, recognized JSON-error responses with 400/401/403/404/422 are REJECTED according to the existing endpoints' validation/authentication and rollback contract. Network errors, the 30-second post-dispatch timeout, malformed or wrong-scope 2xx, 5xx, 408/429, and ambiguous 409 remain UNKNOWN. Any previous UNKNOWN stays UNKNOWN after later authorization/version errors. Classification never searches message text.
8. **Exact replay:** 「確認並完成這筆」 rechecks the authenticated actor, then sends the original endpoint/body/key. The copy explicitly says it can complete the operation if it did not previously commit. Browser tests compare original/replay bytes and headers, assert no automatic POST after reload, and verify one financial effect. The real PostgreSQL suite proves immutable receipt replay, changed-body conflict, scope authorization, and rollback. The same raw key is scoped by actor/endpoint/Ledger; it is not a globally unique key across independent Ledgers.
9. **Commit proof versus snapshot:** a matching posted transaction proves commit after scope, command fields, payments and shares are validated. Replacement additionally binds the original transaction, lineage and expected version. A complete create result atomically updates row, balance and next payer from one result/version. A compatible partial result remains COMMITTED and triggers a read. No substitute client balance is calculated.
10. **Commit plus failed read:** create and correction scenarios preserve COMMITTED after a refresh 500 and show 「其他紀錄暫時無法更新」. Read retry does not issue a financial POST. Recovery persists the known commit across reload. If a fresh read revokes access, cached financial content is hidden while the commit proof remains stored for the original identity.
11. **Version monotonicity:** accepted Ledger/transaction versions cannot move backward. An older receipt still proves the historical operation, but cannot downgrade balance/next payer, overwrite a newer row, or resurrect a voided/replaced row. Late reads from a previous Ledger/request generation cannot apply. Partial replacement proof marks the known original voided and identifies its replacement while the aggregate snapshot remains explicitly awaiting refresh.
12. **Defaults and member order:** opening a draft copies verified default weights and stable Ledger member order. Preview and normalization use the unchanged deterministic kernel. Explicit shares are frozen before dispatch. Nine unit cases cover amount 681, weights 1:1/2:1/0:1, signed-in second member and self/partner/both payment modes. Browser and PostgreSQL cases change defaults after draft creation and prove the frozen command is unchanged. A fresh draft resets payer, note/category/split and uses the current Taipei date; a midnight regression preserves the old draft's date while resetting the next draft correctly.
13. **Correction:** the same owner hydrates actual historical payments/exact shares, ID and expected version. The UI says 「沿用這筆分攤」; it does not invent a historical percentage. Opening correction over a dirty create draft requires explicit keep/discard. Correction replay preserves the original expected version and key. A delayed create-Ledger regression verifies the next editor belongs to the new Ledger. Authorized recovery A wins over URL B, including an unavailable B. Receipt attachment state remains separate.
14. **Typecheck:** see final validation results below and CI linked from Issue #11.
15. **Unit tests:** 259 passed, zero skips, including 19 entry contract tests and five lint-comparator tests.
16. **Browser tests:** final count is recorded below. Existing 69 cases remain. P1-B exercises 26 scenarios across Chromium/WebKit at 390 × 844 and 393 × 852, plus three request/timing samples when `P1B_MEASURE_STAGE=after`. Browser API responses are fixtures; they are not evidence of a real database or physical LINE WebView.
17. **Real PostgreSQL:** isolated PostgreSQL 17, disposable per-suite databases: critical gate 42/42, pre-cutover 6/6, incident 5/5, all zero skips. Added cases cover frozen 681 allocations after defaults change, idempotent replacement before stale-version checking, and replacement rollback retaining the original posted row with no receipt. Existing cross-Ledger, membership, concurrency, rollback and writer-fence gates remain intact. No production database was used.
18. **Build:** final result is recorded below. Uses CI stub environment values; no production configuration changes.
19. **Lint:** raw lint retains 282 errors / 37 warnings from baseline and therefore exits 1. Baseline-delta gate passes with no new findings. No lint suppressions or Statistics fixes were added.
20. **Requests/performance:** see the measured table below and raw JSON under `docs/evidence/p1-b/metrics/`. Normal complete create still has one financial POST and the existing categories GET; zero new bootstrap GETs. Partial/stale/recovered results may require bootstrap; explicit unknown replay adds an actor-context GET. No runtime libraries were added. Timing samples include browser-driver polling and are upper-bound observations, not a statistically reliable performance benchmark.
21. **Mobile evidence:** [gallery](evidence/p1-b/README.md) contains baseline images, ten P1-B states at both requested widths, and normal/drop-response-recovery videos. CI also captures all four engine/width combinations and preserves full recordings in `p1-b-browser-evidence` for 14 days. Checked representative images for readability, truthful status, frozen-operation summary and width overflow. Dev captures contain the Next.js development indicator; this is not product UI.
22. **Physical devices:** P1-B physical iPhone/LINE and Android/LINE background/resume/reopen behavior is UNVERIFIED. P1-A's earlier iPhone result and one-time Android exception are not P1-B evidence. Android validation debt remains open. G5 is NOT PASS.
23. **Known limitations:** sessionStorage only survives the browser session; closing/evicting the WebView or clearing storage can lose recovery. There is no cross-device recovery or server receipt-query API. When identity/scope is unavailable, original-account recovery is required. First-attempt 409 intentionally stays UNKNOWN because the current API lacks a machine-readable distinction between receipt conflict and stale version; it is not relabeled rejected. Existing native confirmation is retained for keep/discard; P1-C dialog/back/navigation behavior is not implemented. Financial timing and mobile tests use controlled fixtures; production smoke is reserved for a separately authorized deployment review.
24. **Recommendation:** proceed to deployment review after the final PR checks pass. This implementation does not authorize merge or deployment. Physical-device and G5 decisions remain explicit review gates. No DB migration, accounting formula change, P1-C, or V3-1. The unrelated Statistics loading defect is not addressed.

## Final local validation

| Check | Result |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm test` | 259/259, zero skips |
| `P1B_MEASURE_STAGE=after pnpm test:e2e --workers=4` | 176/176: existing 69 + P1-B 104 + 3 timing samples |
| `pnpm test:v3:pg` | 42/42, zero skips, isolated PostgreSQL 17 |
| Isolated pre-cutover wrapper | 6/6, zero skips |
| Isolated incident wrapper | 5/5, zero skips |
| `pnpm build` | PASS, stub CI configuration |
| `pnpm lint` | Baseline debt retained: 282 errors / 37 warnings, exits 1 |
| Lint baseline-delta comparator | PASS, no new findings |

CI repeats the required checks using its own disposable PostgreSQL service. The final Issue #11 report records results for the pushed SHA.

## Changed source and verification files

```text
src/hooks/use-v2-entry-session.ts
src/hooks/use-v2-ledgers.ts
src/lib/v2-transaction-draft.ts
src/lib/v2-entry-operation.ts
src/lib/api.ts
src/components/ledger/v2-liff-home.tsx
src/components/ledger/v2-ledger-home.tsx
src/components/ledger/v2-transaction-editor.tsx
src/lib/v2-entry.test.ts
src/lib/v3-0-correctness.pg.test.ts
tests/fixtures/p1-b-browser.ts
tests/p1-b-entry.spec.ts
tests/v2-liff.spec.ts
playwright.config.ts
package.json
.github/scripts/check-lint-baseline.mjs
.github/scripts/check-lint-baseline.test.mjs
.github/workflows/ci.yml
```

Documentation and original fixture capture files live in this report and `docs/evidence/p1-b/`.

## Measured performance

| Measurement | e332ff2 baseline | P1-B | Delta |
| --- | ---: | ---: | ---: |
| Normal create request count | 2 | 2 | 0 |
| Bootstrap GETs after a complete create | 0 | 0 | 0 |
| Response to visible result, Chromium 390 sample | 71.52 ms | 49.57 ms | -21.95 ms, not a benchmark claim |
| Initial route JavaScript, raw | 749,153 bytes | 768,364 bytes | +19,211 bytes (+2.56%) |
| Initial route JavaScript, gzip per chunk | 220,341 bytes | 226,326 bytes | +5,985 bytes (+2.72%) |
| Recovery record storage | none | 827 bytes submitting; 2,240 bytes with full proof | 2 synchronous writes |
| Observed storage write duration | none | 0–0.10 ms per write | browser timer resolution applies |

The JavaScript comparison uses production builds on the same local Node 22/pnpm setup, summing every same-origin script source in the root HTML (unique chunks, gzip per file). The unchanged external LINE SDK is excluded. Request/timing comparisons use the same Chromium fixture scenario. Other after-only samples were 42.96 ms (WebKit 390) and 43.75 ms (Chromium 430); they have no before baseline. Storage figures include all four mobile engine/width combinations. These small local samples do not predict physical LINE scheduling or network latency.

## Review

Independent read-only correctness review found three bounded draft/recovery reset issues; all were fixed with focused browser regressions. Final read-back found no remaining actionable financial truth, replay, scope, or version findings. Runtime verification is reported separately above.
