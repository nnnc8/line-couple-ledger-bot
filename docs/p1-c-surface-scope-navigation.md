# P1-C: returnable surfaces and explicit scope

Source of truth: [Issue #13](https://github.com/nnnc8/line-couple-ledger-bot/issues/13), under [frozen plan #8](https://github.com/nnnc8/line-couple-ledger-bot/issues/8) and [experience source #7](https://github.com/nnnc8/line-couple-ledger-bot/issues/7). Baseline is deployed P1-B [PR #12](https://github.com/nnnc8/line-couple-ledger-bot/pull/12), commit `c8c21e495ce5d52a13c1f7d9e673f23955da6769`.

## Navigation boundary

`v2-navigation.ts` maps a finite union to existing URL parameters. There is no router package, routing DSL, global state library or motion runtime.

| Surface | URL beyond `v2Ledger=L` | Entry / visible return |
| --- | --- | --- |
| HOME | none | Startup and manual switch replace |
| TRANSACTION_DETAIL | `v2Transaction=T` | Home row pushes; Back replaces Home L |
| STATS | `tab=stats` (`analysis` remains an input alias) | Push; Back replaces Home L |
| SETTINGS | `tab=settings` | Push; Back replaces Home L |
| RECURRING | `tab=recurring` | Push; Back replaces Home L |
| SEARCH | `view=search`, existing q/type/payerUserId/categoryId/from/to | Push; filter changes replace; Back replaces Home L |
| PROPOSAL_COMPAT_ENTRY | `v2Proposal=P` | Existing ID-based proposal path; no claim of ownership from active Ledger |

Quick Entry remains the existing inline editor for this phase. It has no URL or history entry. Switcher and confirmation use one native `<dialog>` without URL changes. Payer/split controls remain existing inline controls; no modal stack was introduced.

Initialization waits for `liff.init()`, authenticated context and the active Ledger list before accepting a URL. LIFF redirect parameters remain untouched while init is pending. Startup replaces the current entry with explicit scope. Subsequent native push, replace and popstate are observed without a remount-based URL reader. The bridge preserves unrelated history state and Next's internal tree. The public Next 16 history bridge must receive a copy without its internal-write flags (`__NA`, `_N`); Next copies those flags back while syncing query state. Browser tests verify retained Next state and absence of insertion-effect update warnings.

An explicit target is validated against active membership. Invalid, missing and unauthorized targets never fall back to another Ledger. Only an absent target may use LINE preference / the first active Ledger. T requires L, and detail is reconstructed only from L's bootstrap; a missing/wrong T produces a bounded error rather than scanning other Ledgers.

A small origin marker contains only version, document token, Ledger ID and optional row ID. No draft, command, API response or recovery record is serialized into URL/history. The document token invalidates stale origin on reload. Visible Back always replaces with Home L, including app-origin entries; browser Back/Forward retains normal same-document semantics. No arbitrary `history.back()` is used by visible Back.

## Scope, preference and recovery

`selectLedger` accepts read scope immediately and clears previous data/errors. `activateLedger` is a separate ordered LINE-preference write. Deep links never activate. A manual accepted switch replaces with Home B and starts B's read independently of activation completion. Failure keeps B readable, reports preference failure separately, and retries only activation. Scope identity plus request/preference generations fence A→B→A and late successes/failures.

The P1-B root remains the only transaction draft/operation owner. Dirty compares every editable field to its opening seed, including a correction's historical values; editing and restoring a value becomes clean. Draft seed is memory-only and does not change command or recovery serialization.

| Case | Leave behavior | Evidence |
| --- | --- | --- |
| A Initial/empty | Immediate; fresh B defaults | Navigation 23 |
| B Amount only | Native confirmation; cancel retains amount/focus | Navigation 24–25 |
| C Amount + purpose | Same guard, including editor cancel | Navigation 47; existing P1-B draft tests |
| D Advanced only | Guard even with empty amount | Navigation 27; all-field seed unit test |
| E SUBMITTING | No scope move, abort or key clearing; show processing status | Navigation 28; popstate race test; P1-B timeout |
| F COMMITTED + pending/failed refresh | Immediate switch; late A read cannot replace B | Navigation 29–30, 49 |
| G UNKNOWN | Keep original Ledger, endpoint, bytes and key; explicit replay only | Navigation 31–32, 48; P1-B recovery suite |

One root pending destination is replaced by the latest intent. Discard is required before activation. Looking at processing status or explicitly replaying retains that destination; cancelling the leave decision clears it. Recovery first displays the operation's original Ledger with an explicit banner and canonical original-scope URL; the requested destination remains pending, never mislabeled as accepted. A committed recovery marker can survive a switch in storage without being hydrated against B.

Unsaved category/default-share/recurring settings also report a bounded dirty/discard adapter to the same host. They retain their existing local fields; there is no second financial draft owner. Cancel restores the original input focus, and accepted discard resets the settings fields.

On guarded popstate the target URL has already changed. The host replaces it with the last accepted URL while presenting the same leave decision. Acceptance applies the latest destination once. There is no push/forward trap. E2E assertions check that activation and destination bootstrap requests were NOT SENT while blocked, not merely that warning text appeared.

## Interaction and errors

The single native dialog owns label, heading focus, close/cancel, body scroll lock and focus return. Switching dialog content never nests a second modal. Native modal inert behavior is tested by trying to focus a background control. Switcher cancel returns to the Ledger trigger; dirty cancel returns to the editing field. Accepted navigation focuses the surface heading; detail return focuses the original row or a surviving row/heading fallback.

Home scroll memory is a per-Ledger in-memory map of first visible transaction ID, offset and scrollY fallback. Secondary entry preserves Home position, A→B→A restores it, and reload starts at top. No scroll data is written to storage or the database. Focus requests are consumed once, so background resume/read refresh/late responses do not steal focus.

Auth, explicit target, read, preference and write errors remain distinct. Bootstrap 401 offers re-login; 403/404 provide bounded target recovery; a 500 read offers reload. Stats, Recurring and Search retain HTTP status, offer re-login for 401, and retry only their failed read for other errors without discarding unsaved settings. Preference errors do not alter read state. Secondary errors carry their surface/query identity, and old Ledger components cannot publish into a new scope. Proposal reads are fenced by proposal ID/generation; detail attachment state is keyed by transaction ID/version.

Statistics retain their existing all-history model and show “收支概況 / 全部有效紀錄”. The unrelated Statistics loading defect is not addressed. The statistics effect schedules its existing request after the navigation effect and cancels an unstarted request on exit; no endpoint, analytic calculation or loading-model redesign is included. A recurring loaded flag prevents the newly separated Settings→Recurring surfaces from duplicating an empty-list request.

## Validation and limits

The browser suite covers Chromium and WebKit at 390×844 and 393×852, plus the existing 430×932 wide smoke. P1-B assertions still cover canonical commit, identical replay bytes/key/endpoint, one financial effect, correction versions, stale receipts, authorization loss and storage failures. Selectors/copy were adapted to the new surfaces, without removing these financial assertions.

Reproduction:

```sh
pnpm typecheck
pnpm test
pnpm test:e2e --workers=4
NEXT_PUBLIC_LIFF_ID=test-liff-id V2_LEDGER_ENABLED=1 pnpm build
pnpm lint
```

The repository has pre-existing lint debt. The existing hosted baseline-delta gate rejects newly introduced findings; raw lint failure is not reported as a clean lint pass. Existing critical PostgreSQL, precutover and incident commands are unchanged. They must pass against the hosted disposable PostgreSQL service, without skips; mocked browser APIs do not prove database behavior.

Production-build measurements use `tests/p1-c-metrics.ts` against separate baseline/current `next start` servers, the same fixture and mobile Chromium, three fresh contexts, gzip of initial JS response bodies, request timestamps, and automation action-to-ready-plus-two-frame timing. This is a local automation proxy, not physical-device latency. Scroll-call timing measures synchronous browser work, not isolated compositor cost. See [evidence](evidence/p1-c/README.md).

**Host limitation:** browser evidence proves native dialog cancel and same-document history handling. `beforeunload` is best effort. LINE native close, cross-document navigation, host termination, real authorization return, keyboard and actual iOS/Android WebViews are not proved by these mocks. The app cannot guarantee interception of host termination; the unchanged P1-B recovery record protects dispatched writes. No new physical-device evidence is claimed. The authoritative browser-first policy applies; missing hardware alone is not a default blocker. G5 remains NOT COMPLETE / NOT PASS.

There is no DB migration, accounting/API/idempotency change, P2 implementation or V3-1 work. This branch is for review only: do not merge or deploy as part of P1-C implementation closeout.
