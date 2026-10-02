# P2-B — Ledger identity switcher & low-frequency creation

Implementation [Issue #17](https://github.com/nnnc8/line-couple-ledger-bot/issues/17), parent [Issue #8](https://github.com/nnnc8/line-couple-ledger-bot/issues/8), product [Issue #7](https://github.com/nnnc8/line-couple-ledger-bot/issues/7). Baseline `18b64b168ee1afcfc2799f112536c0efbfdea7fe`; branch `codex/p2-b-ledger-identity-switcher`. The owner explicitly requested direct Codex execution without Luna. No unmerged P2-A code is included.

## Result

Home's actual account name is one heading and one unboxed disclosure trigger. Opening it adds no URL/history entry or API request. The root's single native `LedgerSurfaceHost` displays full account names as selectable options; `aria-selected` announces the selected account and a check mark makes selection visible. “目前查看” identifies accepted read scope. When the LINE default differs, its option says “LINE 記帳預設”. Create is the bottom action; there is no adjacent add button or second normal-Home create action.

Names use the existing 40-character maximum. The header, option text and dialog title wrap; no ellipsis or horizontal scrolling is used for identity. Arrow keys/Home/End move option focus without accepting scope or issuing a write. Enter/Space accepts the focused option. Escape and visible close return focus to the name trigger. The macOS WebKit harness uses Option-Tab for all-control traversal, matching [Safari's documented keyboard behavior](https://support.apple.com/guide/safari/cpsh003/mac); Chromium uses Tab. This does not claim physical iOS keyboard or VoiceOver testing.

## P1-C reuse

The switcher is presentation only. Its callbacks still invoke `switchLedger` → `request({ kind: "navigate", … manual: true })` → existing `leaveStatus`/discard decision → `apply`. Only accepted navigation calls `v2.selectLedger`, canonical URL replacement and independently queued `v2.activateLedger`. `use-v2-ledgers.ts`, `use-v2-entry-session.ts`, the navigation helpers, P1-B operation/recovery code and backend are unchanged. There is no new active-ledger state or scope controller.

Read B becomes the accepted identity immediately and clears A data, even while B bootstrap is delayed. Preference syncing has a bounded status; failure retains B and offers the existing preference-only retry. Deep-link B never activates merely by viewing it. Request traces and browser assertions cover foreign-scope reads, generation races and request absence before guard acceptance.

| Frozen guard | Retained browser regression |
| --- | --- |
| A blank seed | P1-C case 23: no confirmation; B receives fresh defaults |
| B amount only | Cases 24–25: cancel preserves amount/focus; discard accepts B once |
| C amount and purpose | Case 47 and P1-B switching tests: guarded close; no silent loss |
| D advanced fields | Case 27 and settings/advanced regressions: semantic dirtiness, preserved value/focus |
| E SUBMITTING | Case 28: no B read/activation; original POST remains alive |
| F COMMITTED + refresh pending/failed | Cases 29–30: immediate switch; A proof survives and cannot contaminate B |
| G UNKNOWN | Cases 31–32/48: no scope transfer; same Ledger/body/key replay; latest destination retained |

The same single native dialog replaces switcher content with existing guard content. No second confirmation implementation or financial POST is introduced by the switcher.

## Create

`openCreate` submits the existing create leave intent. Dirty/submitting/unknown handling occurs before the form is opened. Form fields remain one name, with a visible label, 40-character limit and empty-value prevention. Create content replaces switcher content inside the same host. Before submission, Cancel/Escape/close clear the name and return to the switcher without changing scope or history. The legitimate empty/archived-only list instead has one clear create action and no name trigger; cancelling returns focus to that exact button, including WebKit where mouse clicks do not necessarily focus buttons.

Submission uses existing `v2.createLedger` (POST + deferred list refresh). A synchronous single-flight latch prevents double submission. While that request is pending the dialog stays open and its cancel actions are disabled. Successful completion still rechecks the existing root leave contract and navigation generation before accepting the new Ledger, updating the header and queuing the normal LINE preference activation. Rejection keeps the entered name and original scope. Existing backend behavior is retained, including its existing network/list-refresh failure semantics; no new create idempotency/recovery protocol is claimed.

## Validation and boundaries

[Evidence and performance](evidence/p2-b/README.md) contain four mobile matrix sets, before/after production-build captures, request traces, recordings, local check logs and lint baseline comparison. The default E2E configuration and existing hosted gates include the P2-B tests on Chromium/WebKit at 390×844 and 393×852; existing 430px legacy coverage remains. CI also preserves P2-B artifacts for 14 days without removing any existing checks.

No runtime dependency, extra bootstrap, financial API/write semantics, schema, member/currency/settings redesign, P2-C/D/E, V3-1, P1-C routing contract or Statistics-defect fix. No merge or deployment command. Browser mocks establish client behavior; hosted PostgreSQL gates remain separate. Physical LINE lifecycle/termination and VoiceOver speech have not been newly verified. Browser-first policy in Issue #8 applies.
