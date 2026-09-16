# V3-0 before / after evidence

Baseline application source: `dad6ffaa9bbe00308f356b78175e0ccfa617326a`. Only test fixtures/helpers were copied into the detached baseline checkout. After evidence comes from the implementation branch. Local paths in published logs are replaced with labels and trailing whitespace is removed; original log hashes are retained in results.json.

## Real PostgreSQL

The identical 39-case suite produced 12 passes / 27 failures / 0 skips before, and 39 passes / 0 failures / 0 skips after. Baseline failing cases:

- F1 refusal: zero financial write
- F1 multi-command: zero financial write
- F1 decimal: zero financial write
- F1 foreign currency: zero financial write
- F1 date-like integers: zero financial write
- F1 ambiguous numbers: zero financial write
- F1 unsupported kind: zero financial write
- F1 unknown shares: zero financial write
- F1 relative date: zero financial write
- F1 refund with old payer: zero financial write
- F1 audio and AI-derived sources never inherit direct-save eligibility
- F1 explicit Ledger must match exactly, never by substring
- F4 same key in another Ledger must not replay the first Ledger
- F4 conflicting payload has no effect; another operation has its own scope
- F4 receipt replay cannot bypass actor membership
- F5 temporary DB failure remains retryable
- F5 provider timeout remains retryable
- F5 explicit clarification is terminal without financial writes
- F5 successful accounting survives reply failure and duplicate webhook
- F4 canonical spelling and participant order replay the same transaction
- F4 historical receipts replay in place; ambiguous Ledger/actor reuse fails closed
- F4 every receipt-backed operation preserves authorized retry and resource scope
- F5 malformed input is a permanent business failure without a provider or write
- PG inbox claim token prevents an old worker from overwriting a new lease
- F1 real audio dispatch preserves the STT source and creates only a proposal
- F5 temporary DB failure recovers to exactly one canonical effect
- F4 LINE event identity cannot create a second effect after its active Ledger changes

## Browser races

Eight new regressions were run against baseline on Chromium iPhone: seven failed, history already passed. Current full configs each run 19 tests on three browser/device projects: 57/57 for `test:e2e` and 57/57 for `test:e2e:v2`. Reversed replies are explicitly held and released; assertions wait for response processing, not an arbitrary race-fix delay.

## TLS

The baseline active pool accepted the dedicated PostgreSQL server with an untrusted self-signed certificate. The after suite rejects that certificate, accepts it with the provided CA on localhost, and rejects the IP hostname mismatch. All three run against real PostgreSQL TLS.

## Test boundaries

Critical V3 PG tests, TLS, pre-cutover and incident suites have zero skipped tests. `test:tx` reports 29 passes / 3 declared skips for legacy Supabase REST-dependent smoke tests; no production connection is supplied. Missing critical PG configuration exits nonzero. Providers and UI API data are fixtures, not live LINE/AI/production sessions.

Full suite totals and per-case results are in [results.json](results.json). The tracked logs preserve failing expectations and real DB/TLS outcomes. Additional browser/build/unit logs remain in the local audit output. The visual scope screenshot was inspected: selector, summary, draft and statistics remain on Scope B after delayed Scope A completion. It is synthetic test data.
