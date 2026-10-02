# P1-C evidence

[PR #14](https://github.com/nnnc8/line-couple-ledger-bot/pull/14) · [30-item final report in Issue #13](https://github.com/nnnc8/line-couple-ledger-bot/issues/13) · [implementation contract](../../p1-c-surface-scope-navigation.md)

Baseline: `c8c21e495ce5d52a13c1f7d9e673f23955da6769`. Final local test revision: `e698378e6102d723faa13a4ab130b8ec752c370f`. Production code, build inputs, visual evidence and performance samples are unchanged from `22b7f66a55954287c5543b2ff7358fa88dca67d9`; the later code commit only synchronizes the LIFF-init test with hydration. The following commit updates only this evidence package. The final issue comment records the final remote SHA and its exact hosted CI/PG results, avoiding a self-referential commit hash in this document.

## Final local checks

- Typecheck and production build: PASS. Unit tests: 272 passed, zero skipped.
- Full E2E: 512 passed, zero failures/skips, with `P1B_MEASURE_STAGE=after` (the same three additional P1-B evidence cases enabled in CI). Per project: {"chromium-iphone": 134, "webkit-iphone": 134, "chromium-393": 110, "webkit-393": 110, "chromium-wide": 24}.
- LIFF-init regression: 20/20 repeated runs across all four mobile projects. [An earlier hosted run](https://github.com/nnnc8/line-couple-ledger-bot/actions/runs/36839032619) failed two instances because SSR loading text appeared before the held init callback existed. The fixture now installs the stub/hold together and waits for actual init entry before asserting untouched URL and zero requests; no product behavior or assertion was weakened.
- Raw lint: 280 errors, 37 warnings; baseline: 282 errors, 37 warnings. Baseline-delta check: no new findings. Raw lint is not clean.
- [Raw check logs](checks/) are retained; hosted DB results must be read from the exact final-head CI linked in Issue #13. Browser mocks are not DB evidence.

## Production-build comparison

Same Node 22.23.1 / Next 16.2.11, frozen dependency lock, LIFF stub, separate `next start` processes, same API fixtures, mobile Chromium 390×844, three fresh contexts per stage, no network throttling. No E2E/build workload ran during the final paired measurements. First sample can include process/browser cold-start costs; medians are local automation observations, not an SLO or evidence of physical LINE performance.

Initial-route gzip JS: **187,468 → 191,749 bytes; +4,281 bytes (4.18 KiB)**, within the ≤10 KB target. Gzip is computed from the actual loaded JS response bodies, not package size. No new runtime dependency.

| Action | Before median ms | After median ms | API requests before → after |
| --- | ---: | ---: | ---: |
| startup | 159.3 | 149.3 | 5 → 5 |
| switch-A-B | 59.1 | 64.8 | 3 → 3 |
| deep-link-B | 147.5 | 146.2 | 5 → 5 |
| stats | 61.5 | 48.0 | 1 → 1 |
| settings | 52.3 | 61.7 | 1 → 1 |
| dialog-open | N/A | 79.8 | N/A → 0 |
| scroll-restore-B | N/A | 81.8 | N/A → 3 |

Timing starts at automation action dispatch and ends after the readiness assertion and two animation frames. It includes automation/selector time; it is not isolated rendering or compositor time. The scroll scenario uses a long B Home, opens its offscreen Switcher programmatically to avoid the automation scrolling away from the origin, then returns to B. `scrollCalls` records synchronous native-scroll duration and actual restored y; sub-millisecond resolution is not a reliable isolated scroll-cost claim. Functional restoration is separately asserted in browser tests.

[Before raw samples](metrics/before/metrics.json) · [After raw samples](metrics/after/metrics.json) · [Summary](metrics/summary.json). Each sample includes request method/path/start/finish, ready-to-two-frame proxy and scroll calls. Startup/deep link remains session → context → Ledger list → only the accepted Ledger bootstrap → categories (5). Manual switch remains activation + accepted Ledger bootstrap + categories (3), without waiting for activation success. Stats and Settings add one read each; native dialog adds zero requests. Deep-link B never activates.

## Visual and request evidence

Every screenshot uses fixture data. Four folders cover the required matrix: [Chromium 390](screenshots/chromium-iphone/), [WebKit 390](screenshots/webkit-iphone/), [Chromium 393](screenshots/chromium-393/), [WebKit 393](screenshots/webkit-393/). They include explicit B, detail, statistics/settings, native Switcher, dirty/UNKNOWN guards and 200% text. Representative images across both engines and widths were visually inspected. Native select text can truncate at 200%; its options remain reachable and the page heading names the accepted Ledger.

[Request traces](requests/) capture NOT-SENT activation/foreign-scope requests for guard and invalid-link cases. [Recordings](recordings/) preserve detail/Back and UNKNOWN blocking on both engines from the complete local suite; provenance is recorded alongside them. Final hosted CI preserves the complete `p1-c-browser-evidence` plus P1-B artifacts for 14 days; these repository copies are durable.

## Scope and limitations

No DB migration, accounting/API/idempotency/recovery-format changes, P2 or V3-1. The unrelated Statistics loading defect is not addressed. Browser-first policy applies. No new physical iOS/Android/LINE host run is claimed; native host termination and cross-document close cannot be guaranteed intercepted. `beforeunload` is best effort; dispatched-write safety still uses P1-B recovery. G5 is NOT COMPLETE / NOT PASS. No merge or deployment command was executed; existing GitHub integrations may automatically create Preview checks.

`sha256.json` hashes every evidence file except itself. `changed-files.txt` lists all final paths relative to the baseline.
