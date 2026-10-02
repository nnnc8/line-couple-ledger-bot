import assert from "node:assert/strict";
import test from "node:test";
import { entryPresentation, entrySummaries, allocationDifference } from "./v2-entry-presentation";
import { newTransactionDraft, normalizeTransactionDraft } from "./v2-transaction-draft";
import type { V2LedgerBootstrap } from "./types";
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", L = "33333333-3333-4333-8333-333333333333";
function draft() {
  const bootstrap: V2LedgerBootstrap = { ledger: { id: L, name: "家用", color: "#173B63", status: "active", version: 1, coupleId: 1, createdAt: "2026-09-25T00:00:00Z", updatedAt: "2026-09-25T00:00:00Z", members: [{ userId: A, role: "owner" }, { userId: B, role: "partner" }], defaultShares: { [A]: "2", [B]: "1" } }, transactions: [], balance: { [A]: "0", [B]: "0" }, nextPayer: null };
  return { ...newTransactionDraft(bootstrap, B, "2026-09-25", "draft"), amountTwd: "681", description: " 晚餐 " };
}
const labels = { [A]: "另一半", [B]: "你" };
test("truthful summaries use Ledger order for second-member actor and frozen ratio", () => {
  const input = draft(); const before = structuredClone(input);
  assert.equal(entrySummaries(input, labels).splitSummary, "另一半 2：你 1 分攤");
  assert.deepEqual(entryPresentation(input).validation.command, normalizeTransactionDraft(input));
  assert.deepEqual(input, before);
});
test("invalid exact shares and payer totals remain explicit and never claim equal", () => {
  const input = { ...draft(), amountTwd: "700", paymentMode: "both" as const, selfPayment: "400", partnerPayment: "281", splitMode: "exact" as const, selfShare: "600", partnerShare: "81" };
  const presentation = entryPresentation(input);
  assert.equal(presentation.validation.command, null); assert.equal(presentation.payer.command, null); assert.equal(presentation.split.command, null);
  assert.equal(entrySummaries(input, labels).splitSummary, "分攤尚未完成");
  assert.match(entrySummaries(input, labels).payerSummary, /另一半 NT\$281／你 NT\$400/);
  assert.equal(allocationDifference("700", "600", "81"), "還差 NT$19");
});
test("percentage supports kernel precision while blank inputs remain incomplete", () => {
  const input = { ...draft(), splitMode: "percentage" as const, selfPercentage: "33.33", partnerPercentage: "66.67" };
  assert.deepEqual(entryPresentation(input).validation.command, normalizeTransactionDraft(input));
  assert.equal(entrySummaries(input, labels).splitSummary, "另一半 66.67%／你 33.33%");
  for (const selfPercentage of ["", " ", "33.333"]) assert.equal(entryPresentation({ ...input, selfPercentage }).validation.command, null);
});
test("income receiver and transfer direction come from actual payer identity", () => {
  assert.equal(entrySummaries({ ...draft(), type: "income", paymentMode: "partner" }, labels).payerSummary, "另一半收款");
  const input = { ...draft(), type: "transfer" as const, paymentMode: "partner" as const };
  assert.equal(entrySummaries(input, labels).payerSummary, "另一半 → 你");
  assert.deepEqual(entryPresentation(input).validation.command, normalizeTransactionDraft(input));
});
test("purpose normalization is separate from the untrimmed input and invalid dates stay invalid", () => {
  const input = draft(); assert.equal(input.description, " 晚餐 "); assert.equal(entryPresentation(input).validation.command!.description, "晚餐"); assert.equal(input.description, " 晚餐 ");
  assert.equal(entryPresentation({ ...input, occurredOn: "2026-02-30" }).validation.field, "occurredOn");
  for (const amountTwd of ["0", "1.5", "-1", "100000000001"]) assert.equal(entryPresentation({ ...input, amountTwd }).validation.command, null);
});


test("historical exact copy disappears when the user changes the stored allocation", () => {
  const input = { ...draft(), operationType: "replace" as const, splitMode: "exact" as const, selfShare: "600", partnerShare: "81", seed: { ...draft().seed, splitMode: "exact" as const, selfShare: "600", partnerShare: "81" } };
  assert.match(entrySummaries(input, labels).splitSummary, /沿用這筆分攤/);
  assert.equal(entrySummaries({ ...input, selfShare: "599", partnerShare: "82" }, labels).splitSummary, "另一半 NT$82／你 NT$599");
});
