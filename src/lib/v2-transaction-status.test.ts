import assert from "node:assert/strict";
import test from "node:test";
import type { V2LedgerTransaction } from "./types";
import { transactionStatusProof } from "./v2-transaction-status";

const transaction: V2LedgerTransaction = { id: "original", ledgerId: "ledger", type: "expense", amountTwd: "100", payments: [], shares: [], status: "posted", version: 3 };
test("void proof matches resource, action and expected version", () => {
  assert.deepEqual(transactionStatusProof({ transactionId: "original", status: "voided", version: 4, ledgerVersion: 8 }, transaction, "void"),
    { transactionId: "original", status: "voided", version: 4, ledgerVersion: 8 });
});
test("restore uses existing posted response proof", () => {
  assert.equal(transactionStatusProof({ transactionId: "original", status: "posted", version: 4, ledgerVersion: 8 }, { ...transaction, status: "voided" }, "restore")?.status, "posted");
});
test("ok alone, wrong object, wrong action and stale versions do not prove mutation", () => {
  for (const response of [null, { ok: true }, { transactionId: "foreign", status: "voided", version: 4, ledgerVersion: 8 },
    { transactionId: "original", status: "posted", version: 4, ledgerVersion: 8 }, { transactionId: "original", status: "voided", version: 3, ledgerVersion: 8 },
    { transactionId: "original", status: "voided", version: 4, ledgerVersion: 0 }]) assert.equal(transactionStatusProof(response, transaction, "void"), null);
});
