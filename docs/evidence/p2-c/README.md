# P2-C review evidence

Implementation: [Issue #19](https://github.com/nnnc8/line-couple-ledger-bot/issues/19). Frozen baseline: `aa9799cdb78fab7bc91d0648113e77a76b58f70d`. Final candidate SHA and the hosted CI run are recorded in the Issue report and PR, so this evidence does not embed a self-referential commit SHA.

## Evidence map

| Requirement | Implementation / verification |
| --- | --- |
| Full bootstrap; effective posted Home rows; deterministic sort; Taipei date labels | `src/lib/v2-timeline.ts`, 31 focused helper tests; browser cases 01–06 |
| Initial 20; +20; stable existing positions/IDs; one heading across 20/21 and 40/41; final control removed | Browser cases 01–05; `normal-timeline-20`, `load-older-40`, `all-effective-rows`; performance request traces |
| Purpose clamp; complete BigInt amount; payer/receiver/direction/category; one accessible button | Browser cases 07–12 and 36–37; all screenshot captures check no body overflow, ≥44px rows, complete tabular amounts, unique IDs and semantic date headings |
| Category snapshot/scoped archived name; assigned reference with failed name read | Case 09 extended without adding test definitions; `category-unavailable`, `archived-category-detail`; income case 10 verifies truly unclassified data |
| Sole Detail; exact scoped bootstrap lookup; skeleton/error/retry; old/void/new lineage | Browser cases 13–24 plus initial read500/retry; `legacy-removal.txt`, frozen ownership hashes |
| Back, focus, offset; direct/reload replace; ≥40-row origin preserved | Cases 13–19; extra filtered Search page-2 return, missing-origin nearest row, and insertion pushing origin from row 20 to row 21 |
| Existing shared correction editor/P1-B owner; dirty leave guard; committed + read500 truth | Cases 25–28 and 42; unchanged ownership hashes; existing P1-B/P1-C/P2-A suite |
| Existing void/restore adapter; captured version/key; canonical status proof before refresh | Cases 29–31 plus ambiguous response/same-key retry; three status-proof unit tests; hosted existing mutation/lineage PG gates |
| Receipts in More; existing list/upload/complete/delete; separate attachment state | Cases 32–35; receipt screenshots and representative recordings; no native picker/HEIC claim |
| Search secondary filters/include-void; known rows after read500; aborted append can retry | Cases 38–39 plus Search page/window/read500/abort regressions |
| Existing P2-B Ledger scope/identity and P2-A create/upsert behavior | Cases 40–41; existing editor, switcher, navigation and race suites |
| CSS 160ms open, 140ms close, 120ms appended-ID fade; reduced motion | Native view-transition support/duration case and reduced-motion 200% case; no runtime dependency |
| Requested commands and hosted PG critical/precutover/incident | `checks/`; exact-candidate hosted run linked in Issue/PR |
| Baseline vs candidate gzip/bootstrap/DOM/timing/requests | `metrics/before/`, `metrics/after/`, `metrics/summary.json` |

The 42 owner-required browser cases are grouped into named tests, with additional regressions. Existing test definitions remain; selectors changed where the old row action surface was removed. The configuration runs Chromium and WebKit at both required sizes and retains the existing 430px legacy project.

## Mobile artifacts

Each engine/size folder retains 19 selected screenshots and all 57 measured JSON captures (76 PNG and 228 JSON total). Required views: normal 20-row timeline, load older to 40, long purpose, large amount, expense/income/transfer Detail, voided/replaced-old Detail, More, correction, receipts, and 200% text. Additional JSON captures record confirmed-mutation read500, wrong scope, direct/reload, origin focus/scroll, loading/empty states, Search and native close motion; their screenshots are also retained in the hosted CI artifact.

| Folder | Engine | Viewport |
| --- | --- | --- |
| `chromium-iphone/` | Chromium | 390×844 |
| `webkit-iphone/` | WebKit | 390×844 |
| `chromium-393/` | Chromium | 393×852 |
| `webkit-393/` | WebKit | 393×852 |

`recordings/` preserves 16 representative videos in total, four for each required project. The hosted CI also uploads the complete P2-C screenshots/JSON/test-results as an artifact with 14-day retention. Repository evidence remains available after that retention expires. `SHA256SUMS` verifies the permanent package's files; its own hash is not included.

## Measurement and limits

| Production measurement | Baseline | Candidate |
| --- | ---: | ---: |
| Initial loaded route gzip JS | 195,679 bytes | 200,048 bytes (+4,369) |
| Full bootstrap | 68 records / 47,312 bytes | 68 records / 47,312 bytes |
| Initial Home DOM rows | 68 | 20 |
| Bootstrap response → two-rAF paint, median | 34.5ms | 28.3ms |
| 20→40 input → two-rAF paint, median | Not available | 49.8ms |
| Detail open, median | 48.7ms | 29.5ms |
| Detail Back restoration, median | 32.0ms | 45.6ms |
| Startup API requests, each sample | 5 | 5 |
| 20→40 API requests, each sample | Not available | 0 |
| Detail open API requests, each sample | 1 attachment list | 0 |
| Detail Back API requests, each sample | 0 | 0 |
| Exact origin focus / maximum row-offset difference | 3/3 / 0px | 3/3 / 0px |

Performance uses the same complete synthetic 68-transaction bootstrap in baseline and candidate: 65 effective posted records and three historical records. The huge sample uses the existing kernel limit of NT$100,000,000,000; unit formatting tests separately exercise integer strings beyond Number precision. Measurements use production builds, three fresh Chromium 390×844 contexts, gzip level 6 on actual initial-route JavaScript responses, actual mock bootstrap bytes and input/DOM-to-two-rAF browser clock proxies. No concurrent build/test load is used during measurement. This is not a live account size or physical LINE latency claim.

Home never owns Search pagination. Its 20→40 action must issue zero requests, and Detail open must issue zero transaction GETs. Balance/next payer always use the full canonical bootstrap. Restoring a voided predecessor retains the existing service/kernel behavior: a posted replaced predecessor can contribute to canonical balance while remaining secondary history; P2-C adds no restore policy or balance calculation.

Browser checks establish DOM labels, logical sections, heading/row focus, position restoration and 200% layout. They do not establish physical LINE lifecycle, native file picker, HEIC processing or actual VoiceOver speech. **G5 remains NOT COMPLETE / NOT PASS.** Issue #8's browser-first policy applies.

No DB migration, accounting change, server pagination, transaction GET, P2-D/P2-E or V3-1. Statistics loading defect remains outside scope. No merge or production deployment.

## Final local run and diagnostics

Final `CI=1 pnpm test:e2e`: **793/793 passed**, zero failed/skipped/cancelled/retried, with 208 source files unchanged throughout. Typecheck and 313 unit cases pass; build and production request measurements pass. Raw lint remains the exact baseline debt (280 errors / 37 warnings); delta and changed-file lint pass with zero new findings.

The resumed concurrent-checks run recorded 791 passes and two 30-second startup timeouts; its HTML/HMR trace timings and concurrent lint command timings are retained in `diagnostics/concurrent-checks/`. The identical source then passed 21 targeted repeats and the final isolated full suite. No product change, increased timeout, removed test or automatic retry resolved those two timeouts. Earlier development failures and the pre-category 793-pass run are explicitly superseded diagnostic evidence. The exact final PR-head hosted CI/PG/lint results remain linked from Issue #19 and the PR.
