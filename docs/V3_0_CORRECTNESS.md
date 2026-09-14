# V3-0 correctness and scope safety

Implementation: [Issue #4](https://github.com/nnnc8/line-couple-ledger-bot/issues/4).
Evidence baseline: [Issue #3 full re-audit](https://github.com/nnnc8/line-couple-ledger-bot/issues/3#issuecomment-5652255482), commit `dad6ffaa9bbe00308f356b78175e0ccfa617326a`.

This change addresses F1, F3, F4 and F5, with F7/F8 database verification. It adds no image/audio capability or analytics feature. The accounting kernel and production schema are unchanged.

## Direct LINE entry

[`v2-direct-command.ts`](../src/lib/v2-direct-command.ts) accepts one complete, bounded command. Examples:

| Type | Supported example | Allocation |
| --- | --- | --- |
| Expense | `晚餐 500 我付` | Explicit payer, selected Ledger's existing default shares |
| Income/refund | `退款 100 我收到` | Explicit receiver, existing income allocation rules |
| Transfer | `我轉 100 給另一半` | Explicit direction between the two members |
| Explicit Ledger | `晚餐 500 我付 記在 旅行` | One exact, authorized Ledger name |

Expense descriptions come from the literal allowlist in the classifier. Currency is TWD; amounts are positive integers, at most 100,000,000. Proper thousands separators and `TWD` / `NT$` are accepted. The grammar does not round decimals, convert currencies, infer a date, split multiple commands or interpret extra share instructions. Inputs outside this boundary remain proposals, clarification or unsupported responses with zero direct financial effect.

Direct eligibility also requires `source === "text"`. The existing audio handler carries `source: "audio"` through transcription, even when its transcript matches the grammar. AI candidates and omitted source metadata cannot direct-save. AI remains a proposal interface. An explicit Ledger must match exactly once; otherwise selection is requested. An omitted Ledger is resolved only from one available Ledger or one active preference.

## Ledger ownership in LIFF

[`use-v2-ledgers.ts`](../src/hooks/use-v2-ledgers.ts) assigns an owner object on every selection, plus a sequence for each bootstrap request. A → B → A produces distinct A owners. Only the current owner and latest request may apply data or errors. Bootstrap responses must name the requested Ledger. A canonical save invalidates older bootstrap requests.

[`v2-liff-home.tsx`](../src/components/ledger/v2-liff-home.tsx) keys the Ledger view by Ledger ID, which gives drafts, editors and idempotency keys the same lifetime as their Ledger. Statistics, categories and recurring reads check mounted ownership and request order. History uses cancellation, filter identity and bootstrap identity. Old saves cannot update another Ledger's feedback or committed state. Server activation requests are serialized so the final LINE preference follows the user's final manual selection. A deep link establishes the initial selection only.

The [browser regressions](../tests/v2-liff.spec.ts) hold A responses, resolve B, then deliberately release A. Completion barriers use the response and browser rendering, rather than a delay to hide the race. Existing search debounce behavior remains unchanged.

## Idempotency identity and historical receipts

[`v2-command-identity.ts`](../src/lib/v2-command-identity.ts) separates the storage key from the canonical request hash. Both bind operation, Couple, authoritative Ledger/resource and actor. The storage key additionally binds the caller's idempotency key; the request hash binds the canonical payload. Object keys, equivalent number/string money fields and payment/share participant order are normalized; command order remains significant.

All nine receipt-backed entry points in [`v2-ledger-service.ts`](../src/lib/v2-ledger-service.ts) use the boundary:

| Entry point | Operation | Authoritative scope |
| --- | --- | --- |
| `createV2Ledger` | `ledger.create` | Couple + actor |
| `updateV2LedgerDefaultShares` | `ledger.defaults` | Ledger + actor |
| `createV2LedgerCategory` | `category.create` | Ledger + actor |
| `updateV2LedgerCategory` | `category.update` | Category's database Ledger + category + actor |
| `createV2RecurringRule` | `recurring.create` | Ledger + actor |
| `createV2Transaction` | `transaction.create` | Ledger + actor |
| `settleAllV2Ledger` | `ledger.settle` | Ledger + actor |
| `mutateV2Transaction` | `transaction.void/restore/replace` | Transaction's database Ledger + transaction + actor |
| `createV2Proposal` | `proposal.create` | Ledger + actor |

Membership is checked before receipt lookup, including replay. Valid same-scope retries return the same canonical result, including concurrent duplicates. New ordinary keys can be used independently in another Ledger or operation/resource. Changed payload in the same scope returns HTTP 409 with no additional effect. Proposal confirm/cancel and recurring execution retain their existing locked-state/run-deduplication boundaries; no second financial writer was introduced.

Existing raw-key receipts are read in place using their original hash, creator, Ledger and operation/result shape. They are not rehashed, rewritten or deleted. A valid historical retry succeeds. Historical reuse that is ambiguous or crosses scope fails with 409; the caller must choose a fresh key for a new operation. No unique constraint or schema change is needed.

Server-generated `line:v2:*` keys intentionally retain one global event identity. Reinterpreting the same LINE event after the user's Ledger preference changes cannot create another financial effect. The durable inbox can recover a committed direct entry before its acknowledgement by checking the original receipt, actor membership and canonical transaction. It returns completion only, never another Ledger's response to a command caller.

### Rollback boundary

Forward compatibility with historical receipts is tested. **An old writer does not understand newly namespaced V3 receipts.** Do not roll the writer back blindly after V3 traffic: freeze financial writes, stop/drain workers, inventory and reconcile post-release receipts/inbox outcomes, and review a compatible recovery before reopening writes. Prefer a forward fix. This change performs no receipt migration and claims no automatic old-binary rollback safety.

## Durable inbox outcomes

The path is webhook → durable inbox → claim → handler → explicit business outcome → durable final state → reply delivery.

| Business outcome | Inbox state | Retry / delivery |
| --- | --- | --- |
| `SUCCESS` | `processed` | Accounting is complete; reply failure cannot repeat it |
| `USER_REJECTED_OR_CLARIFICATION` | `ignored` | Terminal clarification; reply is attempted |
| `PERMANENT_BUSINESS_FAILURE` | `dead_letter` | Explicit malformed/business rejection; no automatic retry |
| `RETRYABLE_PROCESSING_FAILURE` | `failed` | Existing backoff/attempt budget; eventually dead-letter |
| `MAINTENANCE` | Retained/released to `received` | No consumed attempt during freeze |

The [dispatcher](../src/lib/v2-line-inbox-dispatch.ts) owns this mapping. Unknown DB/network/provider/configuration exceptions remain retryable. HTTP status numbers are not guessed from error strings. The handler does not turn exceptions into a generic successful reply.

Reply/push calls from this handler are deferred until the business state is durable. Delivery is best effort and separate from the existing durable accounting outbox. A crash after inbox acknowledgement can lose a reply; it cannot retry successful accounting. A crash between financial commit and inbox acknowledgement recovers from the receipt. Every finish/release checks the claim's exact lease timestamp and attempt number, so a stale worker cannot overwrite a newer lease.

## PostgreSQL and TLS proof

[`connection-config.ts`](../src/lib/db/connection-config.ts) verifies certificates and the requested hostname for remote or production connections. Only loopback in non-production may use plaintext. `no-verify` is rejected. CA material can be supplied as `DATABASE_SSL_CA` PEM or `sslrootcert`; client certificate options remain supported. SSL URL options are resolved and stripped before `pg` parsing so they cannot replace explicit verification options. This follows the [node-postgres SSL configuration warning](https://node-postgres.com/features/ssl). Production CA/hostname configuration must be checked during deployment review using the [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres).

Tests ran on a dedicated local PostgreSQL 17.10 cluster. Each suite creates and drops its own random `v3_0_test_*` database. Fixtures are synthetic, including the pre-category incident data. No production database or provider was used. The test URL guard rejects remote hosts and connection-target query overrides before connecting. Missing PG configuration fails explicitly.

To reproduce with a dedicated local PostgreSQL 17 installation (run from the repository root):

```sh
PG_V30_ROOT=$(mktemp -d /tmp/v3-0-pg.XXXXXX)
initdb -D "$PG_V30_ROOT/data" -U postgres -A trust --no-locale -E UTF8
pg_ctl -D "$PG_V30_ROOT/data" -l "$PG_V30_ROOT/server.log" -o '-h 127.0.0.1 -p 53660' start
export V3_PG_ADMIN_URL='postgresql://postgres@127.0.0.1:53660/postgres'
pnpm test:v3:pg
pnpm exec tsx scripts/test-v3-0-release-pg.ts test:tx
pnpm exec tsx scripts/test-v3-0-release-pg.ts test:precutover
pnpm exec tsx scripts/test-v3-0-release-pg.ts test:incident
pg_ctl -D "$PG_V30_ROOT/data" stop -m fast
```

Use an unused local port if 53660 is occupied. The trust-authenticated cluster must bind only to loopback and contain test data only. The release wrapper deliberately withholds production connection variables. Three legacy REST-dependent tests in `test:tx` remain explicitly skipped; all six relevant pre-cutover PG tests and all 39 V3 correctness PG tests execute with zero skips.

For the TLS suite, enable SSL on this same isolated cluster using a throwaway self-signed certificate with `subjectAltName=DNS:localhost`, then run `V3_TEST_TLS_CA` containing its PEM certificate with `pnpm test:v3:tls`. The suite proves rejection of untrusted certificates, acceptance with the explicit CA, and rejection through `127.0.0.1` because that hostname is absent from the certificate. Never weaken verification to run these tests. Stop the dedicated cluster after use.

The [CI workflow](../.github/workflows/ci.yml) now provisions PostgreSQL 17 and invokes the critical PG, pre-cutover and incident suites. Its service layout follows [GitHub's PostgreSQL service documentation](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers). YAML and local equivalent commands are verified; hosted CI awaits the existing main/PR trigger. TLS verification was tested locally, not in the hosted service container.

## Results and review limits

See [machine-readable evidence](evidence/v3-0/results.json), [before/after regressions](evidence/v3-0/regressions.md), and the final Issue #4 comment for the pushed SHA and complete release checklist.

The 39-case PG regression suite fails 27 cases against the baseline and passes all 39 after the fix. The eight browser regressions fail seven baseline cases; the history race case already passes and remains as protection. Both full browser configurations pass 57/57. Real TLS tests pass 3/3. Units pass 235/235, pre-cutover 6/6 and incident 5/5. Typecheck and build pass. `test:tx` passes 29 with the three declared legacy skips.

Lint changes from 287 errors / 39 warnings to 282 / 37. There are zero new violations. Two pre-existing `set-state-in-effect` findings remain at the statistics/recurring effect calls in the touched Ledger view; resolving them would broaden the change beyond the scope-safety fix. Unrelated lint debt remains.

The kernel, exactly-two-member rule, TWD-only amounts, payments = shares = amount, per-Ledger zero-sum, immutable transaction/void-and-replace lineage, writer-plane/fence and V1 writer trigger were exercised without changing their formulas or schema. These results authorize **production deployment review**, not deployment itself. Review still needs the real production CA/hostname, hosted CI, and the freeze/rollback procedure. The author performed review and executable verification without subagents; independent human review is still pending. F2/F6 product/architecture work remains outside V3-0.
