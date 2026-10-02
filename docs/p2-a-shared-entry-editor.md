# P2-A shared entry editor

Implementation source: [Issue #15](https://github.com/nnnc8/line-couple-ledger-bot/issues/15), under [plan #8](https://github.com/nnnc8/line-couple-ledger-bot/issues/8) and [product source #7](https://github.com/nnnc8/line-couple-ledger-bot/issues/7). Baseline: `18b64b168ee1afcfc2799f112536c0efbfdea7fe`. Branch: `codex/p2-a-shared-entry-editor`.

## Ownership

The same controlled `V2TransactionEditor` renders create and correction. Its props are the P1-B draft, an `onChange` patch callback and the owner's submit callback. Local state holds only More visibility, touched fields and IME activity. `V2EntryControls` holds a temporary partial selection patch while the existing native dialog is open. Cancel drops that patch; Apply calls `entry.updateDraft`. It is not a second transaction draft or write owner.

`useV2EntrySession` still creates/hydrates the draft, dispatches the command, creates the key, freezes the operation, persists recovery, replays the original operation and accepts the canonical result. The following files are byte-identical to baseline:

- `src/hooks/use-v2-entry-session.ts`
- `src/lib/v2-transaction-draft.ts`
- `src/lib/v2-entry-operation.ts`
- `src/lib/v2-entry-state.ts`
- `src/lib/v2-ledger.ts`
- `src/lib/v2-direct-command.ts`
- `src/lib/v2-ledger-service.ts`
- `pnpm-lock.yaml`

The editor and selection controls contain no fetch, API dispatch, idempotency generation or recovery storage. No command adapter, accounting formula, database migration or PostgreSQL test changed. `entryPresentation` calls the existing normalizer/kernel for validation and previews. Its temporary probes isolate payer/split feedback from unfinished purpose/date fields and are never stored or submitted. Extra lexical guards reject blank percentages and unsupported precision, and associate amount failures with the amount field. Difference arithmetic is feedback only and never reallocates money.

## Visible behavior

The default editor orders 金額 (NT$), 用途, payer, split, 更多 and 加入. More holds type, date, category and note. When collapsed, a non-expense type, historical date, selected category and a note preview remain visible. A stored category absent from current active options remains selectable. Long note previews are capped at 40 characters, with the full value retained under More.

| Control | Behavior |
| --- | --- |
| Self / partner payer | Actual member label and 付款; income uses 收款 |
| Both payers | Both explicit member amounts, in Ledger member order; invalid totals remain visible |
| Default | Draft's frozen opening weights; 平均分 only for a valid true 1:1 split |
| Equal | Existing kernel allocation, including the first Ledger member's odd-dollar remainder |
| Percentage | Actual percentages; supported fractional precision is at most two decimal places |
| Exact | Actual member amounts; no redistribution after changing the total |
| Income | Receiver and 款項分配 / 分配 language |
| Transfer | Explicit sender → receiver; split trigger is absent |

All member rendering and allocation use `draft.memberIds`; actor-relative fields are mapped by ID. Logging in as the second member does not reorder the Ledger. Both-payer amounts and exact shares are never recalculated automatically. Changing a both-payer draft into a transfer leaves an incomplete sender until the user explicitly selects one.

The current draft continues to show 本筆依開啟時的預設 after a Ledger refresh changes defaults. There is no implicit apply-latest action. P1-B's retry keeps the original explicit shares, bytes, endpoint and key.

Correction uses the existing stored-data hydrator. Actual payments, shares, type, amount, date, category and note are retained. Historical exact allocations show 沿用這筆分攤 (or 分配 for income), even if a stored method says percentage without the original percentage inputs. That prefix disappears when the exact amounts are edited. The primary correction action remains 儲存修改.

## Dialog, keyboard and validation

Payer/split content uses the P1-C root's existing `LedgerSurfaceHost`; there is exactly one native `<dialog>`, without a nested modal. Opening, selecting and applying the controls send no request. Cancel/Escape preserve the owner draft, and Apply/Cancel restore focus to the summary trigger. The host retains its existing inert background, scroll lock and bounded scrolling.

Inputs have accessible labels. 金額 exposes 金額，新臺幣; 用途 has placeholder 晚餐. Raw purpose input is preserved during typing and normalized by P1-B only when constructing the command. The existing trimmed 1–120 character contract and integer-only TWD remain intact.

Composition start/end, `event.isComposing` and key code 229 prevent accidental Enter activation. Amount Enter moves to purpose. Purpose Enter focuses the primary action (or dismisses focus while invalid) without submitting. Only explicit primary-button activation calls the owner. The selection surface also blocks Enter submission during IME.

The primary action requires the normalizer's structural validity, an active Ledger/actor/member scope, no pending write/recovery conflict and completed IME input. A nearby status explains every disabled state. Inline errors use associated labels and `aria-describedby`; a rejected submit focuses the first invalid field and opens More when needed. Server validation remains authoritative.

## Reproducible evidence

```sh
pnpm typecheck
pnpm test
P1B_MEASURE_STAGE=after pnpm test:e2e --workers=4
# With the existing CI build stub environment:
pnpm build
node scripts/measure-entry-route.mjs /tmp/entry-gzip.json
pnpm lint
```

`tests/p2-a-entry.spec.ts` runs 18 cases in Chromium and WebKit at 390×844 and 393×852 (72 cases). It asserts actual intercepted command bodies against the unchanged normalizer and kernel, rather than relying on screenshots. Cases include 681 TWD, 1:1, 2:1, 0:1, second-member login, every payer/split mode, 33.33%/66.67%, income, transfer, all three stored correction types, frozen defaults and byte-identical replay. Existing P1-A/B/C lifecycle and scope tests remain in the full suite.

Each project records screenshots and JSON metrics in `output/playwright/p2-a/<project>/`; videos are in `output/playwright/results/p2-a-entry-*/video.webm`. The CI `p2-a-editor-evidence` artifact preserves them for 14 days. Permanent representative images and performance measurements are in [evidence/p2-a](evidence/p2-a/README.md).

The screenshot set includes default entry, partner payer, both payers, non-50/50, percentage, exact, More, invalid split, correction, 200% text, native selection surfaces and a reduced 420px keyboard viewport. Metrics assert no horizontal overflow, one modal host and at least 44×44px relevant targets. Focus tests cover Tab reachability and summary return. The reduced viewport proves the focused primary action is wholly visible; it is a browser proxy for the keyboard.

## Limits and scope

Browser command mocks prove UI-to-command mapping, not database persistence. The existing hosted disposable PostgreSQL correctness, precutover and incident gates must pass independently. No new PG test is needed because command mapping and the kernel are unchanged.

Raw lint has pre-existing debt; the baseline-delta gate is the regression check. A raw nonzero lint result is not a clean lint pass.

Physical iOS/Android LINE WebViews, a real Chinese keyboard, native close/termination and host authorization return have no new device evidence. G5 remains NOT COMPLETE / NOT PASS under Issue #8's browser-first policy; missing physical devices are not a default blocker. Browser evidence does not make a physical compatibility claim.

Home, timeline, Detail, Ledger switcher, navigation, Statistics and the final Quick Entry shell retain their current scope. No P2-B/C/D/E or V3-1 work is included. This delivery opens a review PR only; it does not merge or deploy.
