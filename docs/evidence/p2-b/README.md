# P2-B evidence

[Implementation Issue #17](https://github.com/nnnc8/line-couple-ledger-bot/issues/17) · [behavior and scope contract](../../p2-b-ledger-identity-switcher.md). Baseline `18b64b168ee1afcfc2799f112536c0efbfdea7fe`. The final PR/Issue report records the exact remote candidate SHA and associated hosted workflow. No self-referential commit hash is embedded here.

## Local verification

- Typecheck: PASS. Unit: 272 passed, zero skipped. Production build: PASS.
- P2-B focused matrix: 56 passed, 14 cases on each of Chromium/WebKit at 390×844 and 393×852.
- Full regression: **568 passed, zero failures/skips**, with `P1B_MEASURE_STAGE=after` matching CI. Per project: Chromium 390: 148; WebKit 390: 148; Chromium 393: 124; WebKit 393: 124; Chromium 430: 24. [Raw log](checks/e2e.log).
- Raw lint: **280 errors / 37 warnings**, identical to the baseline. Raw lint exits 1; it is not clean. Semantic baseline comparison (relative file, rule, severity, message, multiplicity) has zero new findings. [Comparison](checks/lint-delta.json).
- Existing required hosted typecheck, unit, PostgreSQL, E2E, artifact preservation and Build gates remain. Hosted outcomes must be read from the exact candidate's run, not inferred from local or browser evidence.

[Raw check logs](checks/) include the final focused run, full regression, build, unit/typecheck and lint comparison. An initial exploratory full run was interrupted after the two WebKit focus failures were identified. The empty-create trigger return was fixed; keyboard traversal uses documented native WebKit Option-Tab. The final focused and full runs verify those corrections without deleting or weakening the original financial/scope assertions.

## Production-build performance

Same Node 22.23.1 / Next 16.2.11 and frozen lockfile, LIFF stub, two empty account fixtures, separate `next start` processes, same Python Playwright 1.61.0 and cached browser revisions. Each stage uses three fresh mobile Chromium 390×844 contexts without network throttling. Measurements ran without concurrent E2E or builds. Values are local browser-clock proxies, not physical LINE/device measurements or an SLO.

Initial-route gzip JS: **191,749 → 192,668 bytes; +919 bytes (0.90 KiB)**. Computed at gzip level 6 from actual initial JS response bodies. No new runtime dependency or package/lockfile changes.

| Measurement | Before median | After median |
| --- | ---: | ---: |
| Name tap to dialog, two-frame paint proxy | 41.3 ms | 45.9 ms |
| Choice to visible identity, two-frame paint proxy | 16.3 ms | 30.5 ms |
| Bootstrap response to identity, two-frame paint proxy | 9.0 ms | 12.5 ms |
| Startup API count, each sample | 5 | 5 |
| Open switcher API count, each sample | 0 | 0 |
| Manual switch API count, each sample | 3 | 3 |

Accepted identity changed **before B's bootstrap response in all three after samples**. The response-to-paint value includes two animation frames even when the DOM identity was already accepted; it is not an isolated rendering time. Opening has no server response and is measured from input to dialog paint. Startup remains session → context → list → accepted bootstrap → categories. Switch remains activation + accepted bootstrap + categories. [Raw before](metrics/before/metrics.json) · [Raw after](metrics/after/metrics.json) · [Summary](metrics/summary.json). Reproduce with `tests/p2-b-metrics.py` via the webapp-testing server helper and a temporary Python Playwright 1.61.0 environment; Python is an evidence tool only, not an app dependency.

## Browser, accessibility and guard evidence

[Four mobile screenshot sets](screenshots/) contain the switcher, viewed/default distinction, preference failure, 40-character Chinese names at 100%/200%, unbroken Latin name at 200%, full header after selection, keyboard selection, create/cancel/rejection, new Ledger and legitimate empty list. Long identity text is complete in layout and accessibility names, wraps vertically and has no ellipsis. Dialog vertical scrolling is allowed for large text; the document and dialog do not overflow horizontally. Targets are at least 44px. Representative captures on both engines and widths were visually inspected, along with production-build before/after captures in `metrics/`.

The new suite asserts the trigger's full name and current-account meaning, titled single native dialog, heading focus on entry, selected option and current/default descriptions, arrow/Home/End focus movement without a write, keyboard selection, focus return after Escape/visible close and empty-create cancellation, body/dialog overflow and option dimensions. Native modal background exclusion and all seven frozen guard cases remain covered by the retained P1-C/P1-B suites. WebKit's keyboard traversal follows [Safari's native Option-Tab behavior](https://support.apple.com/guide/safari/cpsh003/mac).

[Request traces](requests/) demonstrate zero writes on opening/cancellation, independent preference retry, correctly scoped bootstrap and no financial POST from account creation/switching. [Recordings](recordings/) cover A→B→A and preference failure in Chromium/WebKit; `provenance.json` maps each copy to the final local test. The hosted workflow additionally uploads full P2-B results and videos for 14 days.

## Limits

Browser fixtures prove client transitions; they do not establish authenticated backend/production writes. Existing hosted PostgreSQL gates are separate evidence; no new PG test was required because API/write semantics did not change. Physical LINE back/termination, real VoiceOver speech and physical device latency have not been newly verified. Existing createLedger network/list-refresh failure behavior is retained; no new idempotency/recovery promise. Statistics loading remains an unrelated known defect. No merge or deployment command was executed; existing GitHub integrations may create Preview checks automatically.

`changed-files.txt` lists final paths relative to the baseline. `sha256.json` hashes all evidence files except itself.
