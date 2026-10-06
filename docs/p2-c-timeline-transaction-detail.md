# P2-C — Minimal date timeline and single transaction detail

Implementation source: [Issue #19](https://github.com/nnnc8/line-couple-ledger-bot/issues/19). Parent [#8](https://github.com/nnnc8/line-couple-ledger-bot/issues/8), product [#7](https://github.com/nnnc8/line-couple-ledger-bot/issues/7), P2-A [#15](https://github.com/nnnc8/line-couple-ledger-bot/issues/15), P2-B [#17](https://github.com/nnnc8/line-couple-ledger-bot/issues/17). Baseline **aa9799cdb78fab7bc91d0648113e77a76b58f70d**, verified remotely before implementation. The final candidate and exact-head hosted gates are recorded in Issue #19 and its PR, avoiding a self-referential source commit.

## Reading and data

Home renders the first 20 effective transactions from the existing complete bootstrap. Effective means `status === posted` and no `replacedByTransactionId`; full bootstrap history and canonical balances remain intact. 更早紀錄 increases only the in-memory render window by 20. It does not call an endpoint, alter accounting, or save the window in browser storage. The root keeps the render window only in memory by Ledger ID, preserving 40/60/etc visible rows across Detail navigation. Back expands to the necessary multiple of 20 if a newly read canonical row pushed the still-existing origin past the prior window. Reload resets to 20.

Order matches existing chronology: occurredOn descending, createdAt descending, ID descending. Grouping uses occurredOn and the existing Asia/Taipei context date; today/yesterday, same-year month/day and cross-year year labels are deterministic, including future dates. Visible slicing happens before grouping, so append boundaries join the same date heading. Pure helpers have focused unit coverage.

Rows are single buttons with full accessible context (purpose, transaction type, amount, payer/direction, date). Purpose visually clamps to two lines; amount remains complete, uses tabular figures, and wraps onto another line when needed. Canonical integer strings go directly through BigInt formatting. Expense summaries say 你付款 / 另一半付款 / 兩人付款; income visibly says 收入／退款 with ＋ and receiver wording; transfer shows explicit sender → receiver. Stored category snapshots and known scoped category names, including archived ones, stay truthful. A category reference without a readable name says 分類暫時無法顯示; 未分類 is reserved for an absent name/reference.

## One Detail and existing operations

`TransactionDetail` is the sole transaction detail surface. The old `TransactionRow` and its transaction-specific `<details>`/inline action block were removed. Home and Search share the same reading-only row. Detail resolves an exact transaction ID and Ledger ID from the accepted Ledger bootstrap; it never searches other Ledgers, guesses a similar transaction, or issues a transaction GET. Historical, voided and replaced records remain in bootstrap and resolve via valid scoped deep links.

Detail shows full purpose, amount, type, status, occurrence date, complete payment/receiver and share/allocation breakdowns, category and note. Transfers use sender/receiver wording. Voided records say 已作廢，不計入目前近況; replaced records say 這筆已更新 and link to an accessible known replacement. Prior-version links appear only when known scoped data supports them. There is no version-timeline system.

更多操作 is the only place for 修改 / 作廢 / 恢復 / 收據. Correction hydrates the existing controlled P2-A editor; P1-B still owns draft, immutable operation, same-key replay, recovery and commit proof. Successful live correction or replay replaces the Detail URL with the canonical new ID while preserving its app origin. A recovered committed receipt does not redirect a separately requested old-version deep link. The original Detail is hidden while editing, with its receipt state retained; it is not a second active surface. Existing dirty/submitting/unknown leave guards and the single native dialog host remain responsible for navigation.

Void/restore use the existing mutate API and object-specific inline confirmations. Their existing response must match transactionId, intended status, expectedVersion + 1, and a valid Ledger version. Confirmed status/version updates the known scoped bootstrap, invalidates earlier reads and marks balance/next payer pending the existing refresh. No client balance calculation is introduced. Confirmed success is retained if refresh fails. An ambiguous retry retains the original local object/version/key; no new financial service, generalized state machine or recovery schema was added.

Receipts retain existing list, signed PUT, complete and delete APIs and file input types/size limit. Attachment messages and busy state are separate from financial write outcome. Reopening 更多操作 refreshes expiring signed receipt links; an explicit receipt refresh remains available. Browser tests validate upload/delete interactions and failure independence. Native picker/HEIC support is not claimed.

## Navigation, accessibility and scope

The URL remains `/?v2Ledger=L&v2Transaction=T`. Wrong/missing/unauthorized scope is an error without fallback or foreign data. Direct links and reloads replace Back to Ledger Home. Same-document app-origin navigation returns to Home or Search; only bounded read filters and stable row IDs enter history state.

Opening Detail focuses its purpose heading and starts at the top. Returning restores the clicked row offset/scroll and focuses it with preventScroll. If the row disappeared, stable neighboring IDs provide a meaningful fallback. Home retains its visible window, including origins beyond the first 20. Search remains secondary, keeps its existing six filters/API and adds a bounded 包含已作廢 client filter/URL flag against existing all-status history; no backend search contract changes. A fresh Search response remains visible unless a strictly newer known canonical transaction version supersedes it, preserving confirmed mutations without overwriting current Search content with an older bootstrap.

Date headings are semantic; rows have visible keyboard focus and at least 44px height. Detail sections follow reading order, Back names its Ledger, confirmations identify their object, long notes wrap, and 200% text does not overflow horizontally. Detail enters with 160ms opacity; native browser snapshots fade the departing Detail for 140ms while the destination is already usable. Older rows fade for 120ms only when newly added, without reanimating existing rows on Back. CSS and the transition guard respect reduced-motion. Browsers without the native API and browser-history pops use immediate close; explicit in-app Back uses the native snapshot fade where supported. No motion/focus-trap runtime dependency was added.

## Validation and limits

See [permanent evidence index](evidence/p2-c/README.md) for complete checks, four mobile engine/size screenshots, recordings, performance samples and frozen-ownership hashes. All API/browser fixtures are synthetic; they prove front-end behavior without writes to a real account. Hosted PostgreSQL gates provide the existing server-contract regression evidence. Timing samples are local browser-clock paint proxies, not physical LINE latency/SLOs.

G5 remains **NOT COMPLETE / NOT PASS**. Physical LINE lifecycle, native picker/HEIC and actual screen-reader speech are unverified. Browser-first Issue #8 policy applies; absence of hardware alone is not a default blocker.

No DB migration, accounting change, server pagination, transaction GET, P2-D/P2-E, V3-1 or runtime library was added. Statistics loading defect is outside this change. No merge or production deployment is authorized or performed.
