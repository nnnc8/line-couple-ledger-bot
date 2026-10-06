# P2-D — Quick Entry and return to the created transaction

Implementation issue: [#21](https://github.com/nnnc8/line-couple-ledger-bot/issues/21). Contracts: [#8](https://github.com/nnnc8/line-couple-ledger-bot/issues/8), [#7](https://github.com/nnnc8/line-couple-ledger-bot/issues/7), P2-A [#15](https://github.com/nnnc8/line-couple-ledger-bot/issues/15), P2-B [#17](https://github.com/nnnc8/line-couple-ledger-bot/issues/17), P2-C [#19](https://github.com/nnnc8/line-couple-ledger-bot/issues/19).

The verified remote-main baseline before implementation was `bc4d966ded4650d79667b19d12902ac49e4eff78`. Work is isolated on `codex/p2-d-quick-entry`. The final candidate SHA and exact hosted check results are recorded in Issue #21; this change does not authorize merging or deployment.

## Product behavior

Home has one bottom 52px 「記一筆」 action and no permanent transaction form. The transparent action wrapper and reserved bottom space respect the safe area. The existing gradient balance card and secondary navigation remain.

The action opens a full-height presentation of the existing native dialog and attempts amount focus synchronously in the opening gesture. The actual Ledger name precedes amount, purpose, payer, split, More and Add. The name is informational; pointer and keyboard users close/discard the entry before switching Ledgers on Home.

Amount Enter moves to purpose. Purpose Enter moves to Add when valid or blurs when incomplete; neither input submits. Note Enter remains a newline. Composition state, native `isComposing`, 229 compatibility and the composition-ending frame all suppress Enter. Empty drafts show 「填金額與用途後即可加入」, associated with the disabled Add button. Empty autofocus fields do not insert an error during the first tap on payer/More and shift that tap's target. Existing validation of entered values remains authoritative.

Payer/split replace the one host's content. Quick Entry stays mounted but hidden during these surfaces and the leave guard, preserving its More disclosure, scroll and draft. Returning restores the appropriate field or summary without fetching. The host is the sole scroll container; body scrolling is locked. A single host-level VisualViewport listener adjusts height/top without refocusing. The button is in normal content flow and stays reachable in a reduced viewport.

## Ownership and bounded additions

| Existing owner | P2-D interface and preserved boundary |
| --- | --- |
| P1-B root session | `openCreateDraft()` exposes explicit opening with a current verified default snapshot. Dirty unsent create drafts retain their identity. It does not dispatch; `dispatch`, command freezing, storage read-back, idempotency, replay and commit proof remain unchanged. |
| P2-A editor | Quick Entry composes the existing controlled editor and its validation/payer/split controls. The pending label is 「正在加入…」 with unchanged geometry and `aria-busy`. |
| P1-C root/host | Opening, close, dirty discard and locked leave use the existing intent/leave contract and `LedgerSurfaceHost`. There is one native `dialog`, no nested modal or additional navigation owner. |
| P2-C canonical collection | `entryCompletionTarget()` reuses `effectiveTimelineTransactions()` and its page size. It returns a row/window or Detail target; it never stores, sorts independently, fetches or changes transactions. Row identity, canonical Detail and origin restoration remain P2-C's. |

The root's extra state is presentation state: whether Quick Entry is shown, category options copied from the existing read surface, a focus/scroll origin, and a completion target. The existing Home statistics cache is invalidated once per committed operation, matching the former editor completion callback; this does not fix the known Statistics defect.

The [byte comparison](evidence/p2-d/ownership-proof.json) records unchanged financial files and the unchanged dispatch body. The hook's opening method is the only addition to the P1-B owner. Financial command/service/math, commit application, recovery parsing and the lockfile are unchanged. There is no DB migration, accounting change, command ownership change, idempotency change, persistent generic/offline draft, new runtime dependency, P2-E or V3-1.

## T0–T6 and completion

| Stage | Behavior and evidence |
| --- | --- |
| T0 | P1-B's synchronous in-flight guard is effective before a second activation. Same-frame double activation produces one POST, key, recovery record and financial effect. |
| T1 | Pending remains inside Quick Entry. Amount/purpose and payer/split stay visible; there is no speculative balance, clearing or success toast. |
| T2 | A bounded 2s timer adds 「連線比平常慢」. The existing 30s/ambiguous UNKNOWN contract preserves the original immutable operation. Closing/switching cannot cancel it. Explicit replay uses identical bytes/key. |
| T3 | Existing proof validation accepts only a canonical committed result. Full results update the canonical collection, balance, next payer and version through the existing owner. |
| T4/T5 | The modal closes on known commit. Home's row/balance cards expose the same canonical version for the atomic DOM assertion. Today targets the actual row, expands the P2-C window if needed, focuses with `preventScroll`, and performs at most one necessary scroll adjustment. |
| T6 | Complete canonical create does not require bootstrap. Partial proof still uses the existing read recovery. Read500 leaves the committed message intact; retry is GET-only. |

Completion and timeline date labels use the existing Asia/Taipei current-date helper, including crossing midnight. The editor compares date hints with the owner's opening seed so a blur at midnight does not move Add during a tap. Backdated/future dates preserve chronological order and expose 「查看」. A moved reading position, changed surface or background completion avoids automatic row scrolling. Search keeps its filters and excludes a nonmatching transaction. View opens the exact canonical P2-C Detail.

There is one contextual status surface at a time. Home uses its stable sticky status slot; while entry is active only Quick Entry shows that operation's status. There is no success card/toast. The success text stays stable through read refresh/failure, with the read suffix outside live announcements. Timeline count is readable but does not issue a competing live announcement. Row highlight is visual only: 140ms opacity plus 1.2s background; completion expansion does not animate the other revealed rows. Reduced motion removes motion and retains a static subtle highlight.

Opening uses 200ms ease-out opacity/8px translation; closing uses 160ms ease-in. Focus does not wait for motion. On cancellation the Home CTA receives focus. A recovered dispatched operation remains UNKNOWN on reload without automatic POST or a clean editor. Ordinary unsent drafts remain in memory only. Simulated background/resume retains a surviving draft and focus without auto POST/keyboard opening.

## Verification and evidence

`tests/p2-d-quick-entry.spec.ts` covers all 45 requested E2E behaviors through 18 focused scenarios plus the retained P1-B/P1-C/P2-A/P2-B/P2-C regressions. Existing financial assertions remain: same-key replay, recovery record/read-back, storage failure blocking dispatch, commit+read failure, stale receipts, immutable operation, correction and effect counts.

Legacy tests now explicitly open Quick Entry instead of assuming a permanent form. Their outer-intent helper deliberately invokes the existing handler to exercise P1-C guards while native-modal background UI is inert; this is not evidence that a user can click the background or switch inside Quick Entry. Separate P2-D tests use actual close/discard-before-switch pointer flows.

The browser matrix remains Chromium and WebKit at 390×844 and 393×852, plus the existing Chromium 430×932 regression. Screenshots/target dimensions/request logs are written to `output/playwright/p2-d/<project>/`. Each engine/required width records Home, fresh/valid Quick Entry, payer, split, submitting, slow, UNKNOWN, created row, backdated/future View, read500, 200% text and reduced viewport. P2-D recordings are in `output/playwright/results/p2-d-quick-entry-*/video.webm`. CI uploads these as `p2-d-browser-evidence-shard-1/2` with 14-day retention. The exact final CI run and its artifact links are in Issue #21.

Accessible browser checks cover names/title/Ledger description, numeric amount and purpose labels, disabled reason, pending `aria-busy`, one success node, row/View focus, cancel focus, native modal background inertness, target sizes (44px; primary 52px), 200% text and horizontal overflow. The atomic observer checks the actual balance card, next-payer text and both canonical versions when the new row first exists. Physical VoiceOver speech, real Chinese keyboard candidate selection, LINE keyboard availability and native lifecycle are not established by these checks.

Hosted critical PostgreSQL, precutover and incident suites remain required and unchanged. They run against the workflow's isolated PostgreSQL 17 service; browser financial responses use the existing kernel-backed fixtures. No production financial write or production data was used for implementation verification.

## Production-build performance

Raw samples: [before](evidence/p2-d/metrics-before.json), [after](evidence/p2-d/metrics-after.json). Initial-JS manifests: [before](evidence/p2-d/gzip-before.json), [after](evidence/p2-d/gzip-after.json).

Baseline was built from an exact archive of `bc4d966…`; candidate used the same frozen lockfile, Node 22.23.1 and pnpm 11.1.2. Both production servers used stub LIFF and mocked canonical APIs. Twenty fresh Chromium 390×844 contexts per stage ran without concurrent builds/test suites or throttling. MutationObserver plus two animation frames measures a painted-frame proxy; response timing starts after full canonical JSON parsing and excludes network. This is a controlled local comparison, not physical LINE latency or a population SLA.

| Measurement | Baseline median / p95 / max | Candidate median / p95 / max |
| --- | --- | --- |
| Initial gzip JS (deduplicated manifest, level 9) | 199,527 bytes | 201,914 bytes: **+2,387 bytes**, below 10KB |
| Quick Entry tap → focus | N/A: permanent inline form | 21 / 24 / 33ms |
| Quick Entry tap → painted-frame proxy | N/A: permanent inline form | 70 / 89 / 90ms |
| Add → pending painted-frame proxy | 65 / 80 / 80ms | 26 / 35 / 38ms |
| Canonical JSON → Home painted-frame proxy | 30 / 36 / 36ms | 38 / 42 / 43ms |
| Canonical JSON → logical dialog close | N/A | 8 / 13 / 14ms |
| Close CSS duration | N/A | 160ms |
| Recovery sessionStorage write (40 per stage) | 0 / 0 / 1ms | 0 / 0 / 1ms |

Every measured candidate feedback frame was below 100ms. Timer resolution limits storage precision. CSS duration is recorded separately from logical close/first Home paint; it is not added to response latency.

Each stage's normal create had two API requests: one transaction POST and the existing categories GET caused by the canonical version change. Both stages had **zero blocking/bootstrap GETs** during complete create. Candidate opening and payer/split each add zero network requests. These are observed request assertions, not assumptions about caches.

Reproduce with the corresponding production build running: `pnpm exec tsx tests/p2-d-metrics.mts before <baseline-url> <output-dir>` and `after <candidate-url> <output-dir>`. Do not run a dev/build/test workload concurrently with the sample collection.

## Release boundary

Browser-first review can proceed when exact-candidate checks are all successful. **G5 remains NOT COMPLETE / NOT PASS.** Physical iOS/Android LINE, actual OS keyboard/IME, VoiceOver announcement count, termination and cross-document close remain compatibility evidence to collect. CSS viewport reduction and synthetic visibility/composition events are not physical-device proof. The known Statistics defect is not addressed. Merge/deploy and P2-E/V3-1 remain outside this task's authorization.
