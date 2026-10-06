# P2-C full-suite timeout diagnosis

Read-only diagnosis on 2026-10-06 of two Chromium iPhone failures from the final-source full-suite attempt. The conclusion is **shared runtime delay exhausted the test budget; neither trace demonstrates a failed product invariant**. The failed attempt is diagnostic evidence, not a passing gate. The implementation owner will preserve it and rerun the affected cases and full suite after other heavy checks stop. No product change or timeout increase is justified by these traces alone.

## Source and execution identity

- Command: `CI=1 pnpm test:e2e`, 4 workers, default test timeout 30,000 ms.
- Baseline: `aa9799cdb78fab7bc91d0648113e77a76b58f70d`.
- Local HEAD at run start: `c665705eaec18328d8359d55deda85bb64d1c426`, with the final category correction and browser assertions in the working tree.
- Source snapshot observed at `2026-10-06T03:08:30.194500+00:00`: `output/p2-c/checks/e2e-final-source-snapshot.json` in this attempt, 208 entries.
- Source aggregate SHA-256: `14388027d50c7780b96b98f7c142329ee25c1ae660d9a4045af869980f043c65`.
- Snapshot-file SHA-256: `2254b97d08f2337fffd0a5ed84fa016909d5072d5582dee140d23cc3f29be89b`.
- Node: `v22.23.1`; Playwright trace version: `1.61.0`; target: local Next development server on port 3108.

The paths above identify the attempt before archival. The aggregate and trace hashes below continue to identify this evidence when the implementation owner moves the diagnostic files aside for the subsequent run.

## Detail loading/read-failure case

Test: `tests/p2-c-timeline.spec.ts:306`, “Detail pending read and read500 never guess a transaction or reveal foreign scope”, project `chromium-iphone`.

Original result directory: `output/playwright/results/p2-c-timeline-Detail-pendi-a938f-ion-or-reveal-foreign-scope-chromium-iphone/`.

Trace SHA-256: `a60462b75c2e7a57832e268f41d5cbcb45b4f7b550a957651a4464e49ad267eb`.

Observed from `test.trace` and `0-trace.network`:

| Observation | Duration |
| --- | ---: |
| First Detail navigation | 15,239 ms |
| First HTML response | 2,545 ms, including 2,351 ms server wait |
| Development HMR chunks | 8,425 / 8,463 ms, including 8,084 / 8,262 ms server wait |
| Reload after configuring bootstrap 500 | 12,518 ms |
| Reload HTML response | 10,651 ms, including 10,384 ms server wait |
| Final visibility assertion before global timeout | approximately 591 ms of its nominal 5,000 ms allowance |

The first bootstrap is deliberately held by the fixture; its roughly 9,971 ms duration is not independently evidence of a product fault. The skeleton assertions passed, the hold was released, and Detail became visible. After reload, the remaining budget expired while startup was still progressing. The recorded network contains session/context/Ledger-list startup responses but no completed 500 bootstrap response for the reload. The final DOM is the correctly scoped Detail skeleton, not an error state that contradicted a received failure. The test therefore did not finish its second scenario. Absence of the expected error at that deadline does not establish that a completed 500 response was mishandled.

## Reversed recurring-response case

Test: `tests/v2-liff.spec.ts:691`, “V3-0 ignores reversed recurring responses across Ledgers”, project `chromium-iphone`; timeout surfaced in helper `openSecondary` at line 302.

Original result directory: `output/playwright/results/v2-liff-V3-0-ignores-rever-87a3e-ng-responses-across-Ledgers-chromium-iphone/`.

Trace SHA-256: `9aba8880f9417f6f2ba3499d5ebd377e25ac2afe8565d556cd2a07e686d07fb4`.

| Observation | Duration |
| --- | ---: |
| Initial HTML response | 22,896 ms, including 22,742 ms server wait |
| Initial page navigation | 24,893 ms |
| `beforeEach` | 29,628 ms |
| Attempted “固定記帳” click before global timeout | approximately 32 ms |

The setup consumed almost the entire 30-second test budget. The final DOM contains the “固定記帳” button on scoped Settings and the recurring section; there is no evidence of an absent control. The test timed out while opening that initial surface, before it reached the held-response / Ledger-switch / stale-response assertions. Thus this failure did not exercise the invariant named by the test.

## Interpretation and next verification

Both failures overlap approximately `03:11:44–03:12:07 UTC`. Their large waits concern unmocked HTML/development assets, while mocked application responses complete quickly once startup resumes. This supports shared development-server or host-resource delay. Other checks, including lint, ran concurrently; contention is a plausible explanation, **not a proven causal finding**. The traces contain no measurement that attributes the delay specifically to lint.

Rerun the two unchanged scenarios serially after the current full run and other heavy checks finish, then collect a clean full-suite result for the unchanged source aggregate. Preserve the failed attempt and report its status separately. This diagnosis ran no browser, test, build, or performance workload and changed only this diagnostic document.
