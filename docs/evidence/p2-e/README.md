# P2-E evidence

Baseline: `1d52fd6371440833118dae0ac072256e00fd2764`. Product source captured and measured: `0d08bc2e9fe49ca172e7f6bbee7d7735b3a5d918`; `src` tree `e3a232652b67693cb42c089d7c49716ea72b2fac`. Later evidence/tooling commits preserve that product tree. The final candidate SHA and hosted checks are pinned in [Issue #23's final report](https://github.com/nnnc8/line-couple-ledger-bot/issues/23), with [PR #24](https://github.com/nnnc8/line-couple-ledger-bot/pull/24).

## Visual matrix

Each directory has uncropped viewport `.png`, full-page `-full.png` and `.json` containing dimensions, colors, text, target geometry, first-fold row count and request audit. These are local production builds with mocked LIFF/auth/canonical APIs, not production data or physical device screenshots.

| Engine / viewport | Baseline | Candidate |
| --- | --- | --- |
| Chromium 390×844 | [before](before/chromium-390/) | [after](after/chromium-390/) |
| Chromium 393×852 | [before](before/chromium-393/) | [after](after/chromium-393/) |
| WebKit 390×844 | [before](before/webkit-390/) | [after](after/webkit-390/) |
| WebKit 393×852 | [before](before/webkit-393/) | [after](after/webkit-393/) |

All four include self-positive, partner-positive, balanced, zero-records, initial-loading, initial-read-failure, stale-known-data, long-name, large-balance, text-200 and no-ledger before/after. Candidate also has home-more and text-200-scrolled. See [visual QA](checks/visual-qa.json) and [first-fold checks](checks/first-fold.json). Full-page captures preserve vertical scrolling requirements; supplemental scrolled captures show the complete very large amount at 200% without altering or cropping the initial viewport.

## Recordings and measurements

The [Chromium](recordings/chromium-390-home-flow.webm) and [WebKit](recordings/webkit-390-home-flow.webm) recordings cover More initial/return focus, Settings/Back, Refresh, one fixture create, contextual success, row focus and fresh next draft. Adjacent JSON audits record the synthetic POST and existing scoped reads. No production financial write occurred.

Performance: [before raw 60 samples](metrics/before/performance.json), [after raw 60 samples](metrics/after/performance.json), [comparison](metrics/comparison.json), [baseline JS](metrics/initial-js-before.json), [candidate JS](metrics/initial-js-after.json). These use native browser clocks, production builds and the same simulated 30ms per-API latency. Encoded payload/real network throughput and physical LINE startup are unmeasured. No payload reduction is claimed.

Source boundaries: [ownership](checks/ownership.json), [contrast](checks/contrast.json), [changed files](changed-files.txt). Local [typecheck](checks/typecheck.log), [unit](checks/unit.log), [critical PG](checks/pg-critical.log), [precutover PG](checks/pg-precutover.log), [incident PG](checks/pg-incident.log), [build](checks/build-after.log), [raw lint](checks/lint.log), [lint delta](checks/lint-delta.log), [full E2E diagnostic](checks/e2e.log), [scope recheck](checks/e2e-scope-recheck.log), [Home/identity recheck](checks/e2e-home-recheck.log). The full diagnostic run's one fixture timing failure is retained and explained in [implementation notes](../../p2-e-ledger-home.md); exact final-candidate full hosted results belong to the final Issue report.

[Initial focused diagnostics](diagnostics/initial-home-focused.log) retain development-time selector failures before the final accessible amount and secondary-error contracts were corrected. They are not passing candidate gates. Captured text logs normalize line endings and trailing whitespace without changing diagnostic content.

`SHA256SUMS` covers the evidence files except itself. Hashes establish artifact integrity, not physical-host behavior.

## Reproduction

Build each commit with the frozen lockfile, Node 22 and the same stub environment, then start its production server. From the candidate checkout:

```sh
pnpm exec tsx tests/p2-e-evidence.ts before http://localhost:3118
pnpm exec tsx tests/p2-e-evidence.ts after http://localhost:3119
pnpm exec tsx tests/p2-e-performance.ts before http://localhost:3118
pnpm exec tsx tests/p2-e-performance.ts after http://localhost:3119
pnpm exec tsx tests/p2-e-recordings.ts http://localhost:3119
node scripts/measure-entry-route.mjs docs/evidence/p2-e/metrics/initial-js-after.json
```

Collect before/after performance sequentially without concurrent builds or test suites. Browser E2E uses `pnpm test:e2e`; CI retains P1-B/C, P2-A/B/C/D/E evidence and complete per-shard results. The final report links the exact run and confirms whether required steps were skipped or cancelled.

Browser-first policy applied. G5 remains NOT COMPLETE / NOT PASS; physical VoiceOver, LINE lifecycle and OS keyboard are not proved here. Statistics remains out of scope. No DB migration, accounting/writer/state-ownership change or V3-1; no merge or deployment authorization.
