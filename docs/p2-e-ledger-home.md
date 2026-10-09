# P2-E — Quiet single-purpose Ledger Home

Issue [#23](https://github.com/nnnc8/line-couple-ledger-bot/issues/23), PR [#24](https://github.com/nnnc8/line-couple-ledger-bot/pull/24). The frozen source is [#8](https://github.com/nnnc8/line-couple-ledger-bot/issues/8), with product context in [#7](https://github.com/nnnc8/line-couple-ledger-bot/issues/7). Baseline: `1d52fd6371440833118dae0ac072256e00fd2764`. Branch: `codex/p2-e-ledger-home`.

The Home now answers location, balance relationship, canonical next payer, recent activity and entry in that order. The header owns the actual Ledger identity and its existing switcher, followed by direct Search and More. The balance summary sits on the page background; 收支概況 is a quiet text entry; 最近紀錄 is a semantic section; P2-D 記一筆 remains the single bottom primary action. More contains only 帳本設定 and 重新整理.

## Presentation and ownership

`LedgerBalanceSummary` takes the canonical integer string, an optional resolved canonical payer label, freshness and version. It uses BigInt for sign, absolute value and `Intl.NumberFormat` display. It has no hooks, request, transaction-derived accounting or state owner. A missing/unknown payer does not produce a recommendation, and zero suppresses a payer even if one is supplied. Positive and negative values have the same typography and color; neither state describes debt.

Loading reserves quiet summary space and the existing timeline skeleton. A first read failure shows 暫時無法讀取近況 and 暫時讀不到這本帳本 with a read-only retry. A failed refresh retains same-scope values, payer and rows with 尚未更新. Authentication remains distinct. A validated name can appear before bootstrap; no balance or entry authority is inferred from that name. No-Ledger uses the existing create flow without a financial Home shell; an existing Ledger with zero rows keeps its real identity, balanced truth, timeline empty copy and Quick Entry.

The root only extends the existing bounded dialog union with `home-more`; it uses the same `LedgerSurfaceHost`. Opening More makes no request, URL mutation or history push. Close restores its trigger. Settings uses the existing P1-C navigation/leave guard; Refresh calls the existing scope owner. The header uses 22/28 typography and wrapping. At large text the controls move to a separate row instead of compressing a 40-character name into a narrow column; DOM and keyboard order remain identity, Search, More.

The gradient, duplicate name, permanent refresh icon, equal-weight three-action strip and timeline Card wrapper are removed only from Home. `components/ui/card.tsx`, Settings, attachments, Search, recurring, export and proposal remain outside this presentation change. Two scoped CSS rules keep the newly exposed timeline text and More close text readable; no global token, palette, dependency, motion or theme system changes.

The financial hooks, accounting/service/command/draft/recovery code, P1-C navigation mapping, P2-C timeline, P2-D Quick Entry and single host remain byte-identical to the baseline. [Ownership hashes](evidence/p2-e/checks/ownership.json) verify those boundaries. No DB migration, accounting change, financial writer change, state-ownership change or V3-1 work.

## Verification

The new balance/helper unit tests cover zero, positive/negative, both very large signs, payer present/absent, loading, known refreshing, stale, invalid and unavailable values. New Home browser coverage runs in Chromium and WebKit at 390×844 and 393×852. Existing P1-B/C and P2-A/B/C/D tests retain their behavioral assertions and use the final header/More contract. The old reversed-bootstrap fixture now waits for canonical version and Quick Entry before intercepting a subsequent read: a truthful list-backed header is no longer mistaken for completed bootstrap.

The [evidence index](evidence/p2-e/README.md) includes all ten required before/after states, no-Ledger, More, 200% scrolled amount proof, viewport plus full-page images, dimensions/request metadata, recordings and checks. All normal first-fold captures have six complete rows above the primary-action footer, all three header targets are at least 44×44, and the primary action is 52px high. Long names and huge values remain complete without horizontal scrolling. Large text, host chrome and keyboard may require vertical scrolling; there is no fixed first-fold promise for those conditions.

The complete local run initially passed 972/973; its sole failure was the premature old fixture wait described above. After correcting it, the V3-0 scope subset passed 24/24 and the Home/identity subset passed 164/164. The exact final-candidate full CI, unit/PG/build and baseline-lint results are recorded in the final Issue #23 report. Raw lint retains the existing 280 errors and 37 warnings; the release check rejects additions rather than claiming the legacy tree is lint-clean.

## Performance and release boundary

Initial production route JS is measured with the same deduplicated manifest and gzip level 9 on both builds: [baseline](evidence/p2-e/metrics/initial-js-before.json), [candidate](evidence/p2-e/metrics/initial-js-after.json). Delta: **+675 bytes** (201,954 → 202,629), below 10KB. Runtime dependencies and lockfile are unchanged.

[Before](evidence/p2-e/metrics/before/performance.json) and [after](evidence/p2-e/metrics/after/performance.json) contain twenty raw samples for each of empty, 50 rows, and 200 mixed rows, including multiple dates, income, transfer, void and replacement references. Both use production `next start`, fresh Chromium contexts, 390×844, the same mocked API delay of 30ms and native browser timing. MutationObserver plus two animation frames is a paint proxy. The waterfall records session/context/list/bootstrap/categories separately. No new Home blocking request, transaction GET or payload reduction is claimed. See [comparison](evidence/p2-e/metrics/comparison.json) for median/p75/p95, request counts, initial DOM rows, Quick Entry feedback, CLS and observed long tasks. Mock transport, an emulated device and a local machine do not establish physical LINE/4G latency or a production SLA.

Browser-first release policy from [the owner decision](https://github.com/nnnc8/line-couple-ledger-bot/issues/8#issuecomment-5854251118) applies. Physical iOS/Android LINE, actual OS keyboard/IME, VoiceOver speech and native lifecycle remain unverified. **G5 remains NOT COMPLETE / NOT PASS.** The known all-history Statistics loading defect is not addressed and no monthly analytics are introduced.

P2-E is the final Phase 2 Home implementation unit. The frozen Home experience can proceed to deployment review once the exact final candidate has green required checks. This task does not authorize merge or deployment, and does not declare Phase 2 deployed or G5 complete.
