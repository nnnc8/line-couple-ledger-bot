import { test } from "node:test";
import assert from "node:assert/strict";
import { entryCompletionTarget } from "./v2-entry-completion";
import type { V2LedgerTransaction } from "./types";

const transaction: V2LedgerTransaction = { id: "new", ledgerId: "L", type: "expense", status: "posted", amountTwd: "680", description: "晚餐", occurredOn: "2026-10-06", createdAt: "2026-10-06T12:00:00Z", payments: [], shares: [], splitMethod: "equal" };
const input = { transaction, transactions: [transaction], today: "2026-10-06", surface: "HOME", moved: false, visibleCount: 20 };

test("today targets its canonical row without shrinking the existing window", () => {
  assert.deepEqual(entryCompletionTarget({ ...input, visibleCount: 60 }), { kind: "row", visibleCount: 60 });
});
test("future rows ahead of today expand the window without breaking P2-C sort", () => {
  const rows = Array.from({ length: 41 }, (_, i) => ({ ...transaction, id: `future-${i}`, occurredOn: "2026-10-07" }));
  const transactions = [...rows, transaction];
  assert.deepEqual(entryCompletionTarget({ ...input, transactions }), { kind: "row", visibleCount: 60 });
  assert.equal(transactions.at(-1)?.id, "new");
});
for (const date of ["2026-09-03", "2026-10-07"]) test(`${date} targets Detail without changing the window`, () => {
  assert.deepEqual(entryCompletionTarget({ ...input, transaction: { ...transaction, occurredOn: date } }), { kind: "detail" });
});
for (const surface of ["SEARCH", "STATS", "TRANSACTION_DETAIL"]) test(`${surface} preserves the current reading context`, () => {
  assert.deepEqual(entryCompletionTarget({ ...input, surface }), { kind: "detail" });
});
test("moved reading position uses Detail", () => assert.deepEqual(entryCompletionTarget({ ...input, moved: true }), { kind: "detail" }));
test("missing, historical or wrong-scope canonical row uses Detail", () => {
  for (const transactions of [[], [{ ...transaction, status: "voided" as const }], [{ ...transaction, ledgerId: "B" }]]) {
    assert.deepEqual(entryCompletionTarget({ ...input, transactions }), { kind: "detail" });
  }
});
