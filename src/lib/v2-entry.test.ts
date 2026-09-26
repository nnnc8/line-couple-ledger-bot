import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, parseResponse } from "./api";
import { applyCanonicalSnapshot, canApplySnapshot, classifyWriteFailure, commandOf, ENTRY_RECOVERY_KEY, freezeOperation, isCurrentBootstrap, parseCommitProof, readRecovery, recoveryMatches, writeRecovery, type EntryOperation } from "./v2-entry-operation";
import { correctionDraft, draftPreview, newTransactionDraft, normalizeTransactionDraft } from "./v2-transaction-draft";
import { splitWeights } from "./v2-ledger";
import type { V2CreateTransactionResult, V2LedgerBootstrap } from "./types";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", L = "33333333-3333-4333-8333-333333333333", T = "44444444-4444-4444-8444-444444444444";
function bootstrap(): V2LedgerBootstrap {
  return { ledger: { id: L, name: "家用", color: "#173B63", status: "active", version: 1, coupleId: 1, createdAt: "2026-09-25T00:00:00Z", updatedAt: "2026-09-25T00:00:00Z", members: [{ userId: A, role: "owner" }, { userId: B, role: "partner" }], defaultShares: { [A]: "1", [B]: "1" } }, transactions: [], balance: { [A]: "0", [B]: "0" }, nextPayer: null };
}
function draft(actor = A) { return { ...newTransactionDraft(bootstrap(), actor, "2026-09-25", "draft"), amountTwd: "681", description: " 晚餐 ", dirty: true }; }
function operation(): EntryOperation { return freezeOperation(draft(), "entry-key", "2026-09-25T00:00:00Z"); }
function result(op = operation()): V2CreateTransactionResult {
  return { transaction: { ...commandOf(op), id: T, ledgerId: L, status: "posted", version: 1, createdAt: "2026-09-25T00:00:01Z" }, ledgerVersion: 2, balance: { [A]: "340", [B]: "-340" }, nextPayer: { payerUserId: B, payeeUserId: A, amountTwd: "340" } };
}
function storage() { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } }; }

test("normalization validates input and freezes explicit kernel shares", () => {
  const normalized = normalizeTransactionDraft({ ...draft(), amountTwd: "00681", note: " 備註 " });
  assert.equal(normalized.amountTwd, "681"); assert.equal(normalized.description, "晚餐"); assert.equal(normalized.note, "備註");
  assert.deepEqual(normalized.shares, [{ userId: A, amountTwd: "341" }, { userId: B, amountTwd: "340" }]);
  for (const amountTwd of ["0", "-1", "1.2", "100000000001", ""]) assert.throws(() => normalizeTransactionDraft({ ...draft(), amountTwd }));
  assert.throws(() => normalizeTransactionDraft({ ...draft(), occurredOn: "2026-02-30" }));
  assert.throws(() => normalizeTransactionDraft({ ...draft(), description: " " }));
});

for (const weights of [["1", "1"], ["2", "1"], ["0", "1"]] as const) {
  for (const paymentMode of ["self", "partner", "both"] as const) test(`681 kernel member ordering: signed-in second member, ${weights.join(":")}, ${paymentMode}`, () => {
    const input = { ...draft(B), defaultShares: { [A]: weights[0], [B]: weights[1] }, paymentMode, selfPayment: "300", partnerPayment: "381" };
    const command = normalizeTransactionDraft(input);
    const kernel = splitWeights("681", [A, B], weights);
    assert.deepEqual(command.shares, [{ userId: A, amountTwd: String(kernel[A]) }, { userId: B, amountTwd: String(kernel[B]) }]);
    assert.deepEqual(draftPreview(input), command);
    assert.deepEqual(command.payments, paymentMode === "both" ? [{ userId: A, amountTwd: "381" }, { userId: B, amountTwd: "300" }] : [{ userId: paymentMode === "partner" ? A : B, amountTwd: "681" }]);
  });
}

test("percentage choices are mapped by member ID, exact shares and transfers use the same kernel validation", () => {
  const command = normalizeTransactionDraft({ ...draft(B), splitMode: "percentage", selfPercentage: "25", partnerPercentage: "75" });
  assert.deepEqual(command.shares, [{ userId: A, amountTwd: "511" }, { userId: B, amountTwd: "170" }]);
  assert.deepEqual(normalizeTransactionDraft({ ...draft(B), splitMode: "equal" }).shares, result().transaction.shares);
  assert.equal(normalizeTransactionDraft({ ...draft(), type: "income" }).type, "income");
  const transfer = normalizeTransactionDraft({ ...draft(B), type: "transfer", paymentMode: "partner" });
  assert.deepEqual(transfer.shares, [{ userId: B, amountTwd: "681" }]); assert.equal(transfer.splitMethod, "none");
  assert.throws(() => normalizeTransactionDraft({ ...draft(), splitMode: "percentage", selfPercentage: "40", partnerPercentage: "50" }));
  assert.throws(() => normalizeTransactionDraft({ ...draft(), paymentMode: "both", selfPayment: "680", partnerPayment: "0" }));
});

test("opening defaults are a copy; later defaults cannot alter frozen shares or replay bytes", () => {
  const base = bootstrap(); const input = { ...newTransactionDraft(base, B, "2026-09-25", "draft"), amountTwd: "681", description: "晚餐" };
  base.ledger.defaultShares[A] = "0";
  assert.equal(input.defaultShares[A], "1");
  const op = freezeOperation(input, "fixed-key", "2026-09-25T00:00:00Z"), bytes = JSON.stringify(op.body);
  input.amountTwd = "200"; input.defaultShares[A] = "9";
  assert.equal(JSON.stringify(op.body), bytes);
  assert.throws(() => { commandOf(op).shares[0]!.amountTwd = "1"; });
  const db = storage(); writeRecovery(db, op);
  const recovered = readRecovery(db)!;
  assert.equal(recovered.phase, "unknown"); assert.equal(recovered.hadUnknown, true);
  assert.equal(recovered.idempotencyKey, op.idempotencyKey); assert.equal(JSON.stringify(recovered.body), bytes);
});

test("correction hydrates actual payments/shares/version, never an invented historical percentage", () => {
  const old = result().transaction; const base = bootstrap(); base.ledger.defaultShares = { [A]: "9", [B]: "1" };
  const correction = correctionDraft(base, B, "2026-10-01", "edit", { ...old, splitMethod: "percentage", note: "原備註" });
  assert.equal(correction.splitMode, "exact"); assert.equal(correction.selfShare, "340"); assert.equal(correction.partnerShare, "341");
  assert.equal(correction.paymentMode, "partner"); assert.equal(correction.expectedVersion, 1); assert.equal(correction.occurredOn, old.occurredOn);
  assert.deepEqual(normalizeTransactionDraft(correction).shares, old.shares);
  const fresh = newTransactionDraft(base, B, "2026-10-01", "next");
  assert.equal(fresh.paymentMode, "self"); assert.equal(fresh.note, ""); assert.equal(fresh.splitMode, "weights"); assert.equal(fresh.occurredOn, "2026-10-01");
});

test("only recognized first-attempt endpoint rejections prove no write; any previous unknown stays unknown", async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const error = await parseResponse(new Response(JSON.stringify({ error: "fixture" }), { status })).catch(error => error);
    assert.equal(classifyWriteFailure(error, operation()), "rejected");
    assert.equal(classifyWriteFailure(error, { ...operation(), hadUnknown: true }), "unknown");
  }
  for (const error of [new TypeError("fetch"), new DOMException("aborted", "AbortError"), ...[408, 409, 429, 500, 503].map(status => new ApiError("fixture", status, true)), new ApiError("unrecognized", 400, false)]) assert.equal(classifyWriteFailure(error, operation()), "unknown");
});

test("recovery storage requires exact read-back; no editing draft or credentials are serialized", () => {
  const db = storage(); const op = operation(); writeRecovery(db, op);
  const text = db.getItem(ENTRY_RECOVERY_KEY)!;
  assert.equal(text.includes("defaultShares"), false); assert.equal(text.includes("token"), false); assert.equal(text.includes("draft"), false);
  assert.throws(() => writeRecovery({ ...db, setItem() { throw new Error("quota"); } }, op));
  assert.throws(() => writeRecovery({ ...db, getItem() { return ""; } }, op));
  for (const modified of [{ ...op, schemaVersion: 2 }, { ...op, endpoint: "https://other.example/write" }, { ...op, token: "forbidden" }, { ...op, body: { ...op.body, idempotencyKey: "changed" } }]) {
    db.setItem(ENTRY_RECOVERY_KEY, JSON.stringify(modified)); assert.throws(() => readRecovery(db));
  }
});

test("identity/couple/Ledger validation rejects cross-scope replay without changing the operation", () => {
  const op = operation(), base = bootstrap(); assert.equal(recoveryMatches(op, A, base), true);
  assert.equal(recoveryMatches(op, B, base), false);
  assert.equal(recoveryMatches(op, A, { ...base, ledger: { ...base.ledger, coupleId: 2 } }), false);
  assert.equal(recoveryMatches(op, A, { ...base, ledger: { ...base.ledger, id: T } }), false);
});

test("complete and compatible partial responses prove commit; malformed, mismatched content or scope do not", () => {
  const op = operation(), full = result(op); assert.deepEqual(parseCommitProof(full, op)?.snapshot, full);
  const partial = parseCommitProof({ transaction: full.transaction }, op)!;
  assert.equal(partial.transaction.id, T); assert.equal(partial.snapshot, undefined);
  for (const value of [{ ok: true }, null, { transaction: { ...full.transaction, ledgerId: T } }, { transaction: { ...full.transaction, amountTwd: "682" } }, { transaction: { ...full.transaction, shares: [full.transaction.shares[0], full.transaction.shares[0]] } }]) assert.equal(parseCommitProof(value, op), null);
  assert.equal(parseCommitProof({ ...full, balance: { [A]: "-340", [B]: "340" } }, op)?.snapshot?.balance[A], "-340");
  const db = storage(); writeRecovery(db, { ...op, phase: "committed", proof: partial });
  assert.equal(readRecovery(db)?.phase, "committed");
  assert.equal(readRecovery(db)?.proof?.transaction.id, T);
});

test("replace commit proof binds original ID, expected version and actual replacement", () => {
  const edit = correctionDraft(bootstrap(), A, "2026-09-25", "edit", result().transaction);
  const op = freezeOperation(edit, "replace-key", "2026-09-25T00:00:02Z");
  const response = { transaction: { ...result(op).transaction, id: L, replacesTransactionId: T }, replacedTransactionId: T, version: 2, ledgerVersion: 4 };
  const proof = parseCommitProof(response, op)!; assert.equal(proof.replacedTransactionId, T); assert.equal(proof.snapshot, undefined);
  assert.equal(parseCommitProof({ ...response, version: 3 }, op), null);
  const db = storage(); writeRecovery(db, { ...op, phase: "committed", proof }); assert.equal(readRecovery(db)?.proof?.originalVersion, 2);
});

test("canonical result atomically changes row, balance and next payer; old receipts and reads cannot downgrade", () => {
  const base = bootstrap(), receipt = result(); const current = applyCanonicalSnapshot(base, receipt);
  assert.equal(current.transactions[0]?.id, T); assert.deepEqual(current.balance, receipt.balance); assert.deepEqual(current.nextPayer, receipt.nextPayer);
  const newer = { ...current, ledger: { ...current.ledger, version: 8 } };
  assert.equal(canApplySnapshot(newer, receipt), false); assert.equal(applyCanonicalSnapshot(newer, receipt), newer);
  for (const status of ["voided", "posted"] as const) {
    const changed = { ...current, transactions: [{ ...receipt.transaction, status, version: 2, replacedByTransactionId: L }] };
    assert.equal(canApplySnapshot(changed, receipt), false); assert.equal(isCurrentBootstrap(changed, current, 2), false);
  }
  assert.equal(isCurrentBootstrap(current, base, 2), false);
  assert.equal(isCurrentBootstrap(current, newer, 2), true);
  const otherLedger = { ...base, ledger: { ...base.ledger, id: T } };
  assert.equal(applyCanonicalSnapshot(otherLedger, receipt), otherLedger, "late A receipt never changes B even if a future caller bypasses the UI guard");
  assert.equal(parseCommitProof(receipt, operation())?.transaction.id, T, "historical receipt still proves commit");
});
