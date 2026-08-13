import assert from "node:assert/strict";
import test from "node:test";

import { taipeiDateFromInstant } from "./ledger-shared";
import {
  buildV2LedgerCsv,
  decodeV2TransactionCursor,
  encodeV2TransactionCursor,
  type V2LedgerCsvRow,
} from "./v2-ledger-service";

test("transaction cursor round-trips the complete deterministic sort key", () => {
  const cursor = {
    occurredOn: "2026-08-12",
    createdAt: "2026-08-12T04:05:06.000Z",
    id: "10000000-0000-4000-8000-000000000001",
  };
  assert.deepEqual(decodeV2TransactionCursor(encodeV2TransactionCursor(cursor)), cursor);
  assert.throws(() => decodeV2TransactionCursor("bad"), /cursor 無效/);
});

test("CSV export is unbounded, semantically complete, and formula-safe", () => {
  const rows: V2LedgerCsvRow[] = Array.from({ length: 2_001 }, (_, index) => ({
    id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    occurredOn: "2026-08-12",
    type: "expense",
    description: index === 0 ? "=HYPERLINK(\"https://bad\")" : `晚餐 ${index}`,
    category: "food",
    amountTwd: "101",
    payments: [{ userId: "alice", amountTwd: "101" }],
    shares: [{ userId: "alice", amountTwd: "51" }, { userId: "bob", amountTwd: "50" }],
    note: "note",
    splitMethod: "equal",
    status: "posted",
    replacesTransactionId: null,
    replacedByTransactionId: null,
  }));
  const csv = buildV2LedgerCsv(rows);
  assert.equal(csv.split("\n").length, 2_003);
  assert.match(csv, /transaction_id/);
  assert.match(csv, /replaces_transaction_id/);
  assert.match(csv, /'=?HYPERLINK/);
  assert.match(csv, /晚餐 2000/);
});

test("Taipei local date does not roll back during Taiwan morning", () => {
  assert.equal(taipeiDateFromInstant(new Date("2026-08-12T15:59:59.000Z")), "2026-08-12");
  assert.equal(taipeiDateFromInstant(new Date("2026-08-12T16:00:00.000Z")), "2026-08-13");
});
