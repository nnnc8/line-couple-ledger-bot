import assert from "node:assert/strict";
import test from "node:test";
import type { V2Category, V2LedgerTransaction } from "./types";
import {
  TIMELINE_PAGE_SIZE,
  effectiveTimelineTransactions,
  groupTimelineTransactions,
  lookupTimelineTransaction,
  timelineCategoryLabel,
  timelineDateLabel,
  timelineMoney,
  timelinePaymentSummary,
  timelinePurpose,
  timelineTransferDirection,
  timelineTypeLabel,
  visibleTimelineTransactions,
} from "./v2-timeline";

const ledgerId = "ledger-a";
const selfId = "alice";
const partnerId = "bob";
const today = "2026-10-03";

function transaction(overrides: Partial<V2LedgerTransaction> = {}): V2LedgerTransaction {
  return {
    id: "transaction-a", ledgerId, type: "expense", amountTwd: "100", status: "posted",
    occurredOn: today, createdAt: "2026-10-03T00:00:00.000Z", description: "晚餐",
    payments: [{ userId: selfId, amountTwd: "100" }],
    shares: [{ userId: selfId, amountTwd: "50" }, { userId: partnerId, amountTwd: "50" }],
    ...overrides,
  };
}

function history(count: number): V2LedgerTransaction[] {
  return Array.from({ length: count }, (_, index) => transaction({
    id: `transaction-${String(index).padStart(3, "0")}`,
    createdAt: `2026-10-03T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
  }));
}

test("chronology sorts occurrence date before creation time", () => {
  const rows = [transaction({ id: "older-date", occurredOn: "2026-10-02", createdAt: "2026-10-03T12:00:00.000Z" }),
    transaction({ id: "later-created", createdAt: "2026-10-03T02:00:00.000Z" }), transaction({ id: "earlier-created" })];
  assert.deepEqual(effectiveTimelineTransactions(rows).map(row => row.id), ["later-created", "earlier-created", "older-date"]);
});

test("equal chronology uses the existing descending stable ID tie-break", () => {
  const rows = [transaction({ id: "a" }), transaction({ id: "c" }), transaction({ id: "b" })];
  assert.deepEqual(effectiveTimelineTransactions(rows).map(row => row.id), ["c", "b", "a"]);
  assert.deepEqual(effectiveTimelineTransactions([...rows].reverse()).map(row => row.id), ["c", "b", "a"]);
});

test("filtering and sorting do not mutate canonical bootstrap data", () => {
  const rows = Object.freeze([Object.freeze(transaction({ id: "a" })), Object.freeze(transaction({ id: "b" }))]);
  assert.deepEqual(effectiveTimelineTransactions(rows).map(row => row.id), ["b", "a"]);
  assert.deepEqual(rows.map(row => row.id), ["a", "b"]);
});

test("today is grouped by the Taipei context calendar date", () => {
  assert.equal(timelineDateLabel(today, today), "今天");
  assert.equal(groupTimelineTransactions([transaction({ createdAt: "2026-10-02T16:00:00.000Z" })], today)[0]?.label, "今天");
});

test("yesterday label uses calendar arithmetic independent of runtime timezone", () => {
  assert.equal(timelineDateLabel("2026-10-02", today), "昨天");
});

test("yesterday crosses month and year boundaries", () => {
  assert.equal(timelineDateLabel("2026-09-30", "2026-10-01"), "昨天");
  assert.equal(timelineDateLabel("2025-12-31", "2026-01-01"), "昨天");
});

test("same-year dates have month and day labels", () => {
  assert.equal(timelineDateLabel("2026-08-09", today), "8月9日");
});

test("cross-year dates retain their year", () => {
  assert.equal(timelineDateLabel("2025-08-09", today), "2025年8月9日");
});

test("future dates show their actual date and remain ahead of today", () => {
  assert.equal(timelineDateLabel("2026-10-04", today), "10月4日");
  assert.equal(timelineDateLabel("2027-01-01", today), "2027年1月1日");
  assert.equal(effectiveTimelineTransactions([transaction(), transaction({ id: "future", occurredOn: "2026-10-04" })])[0]?.id, "future");
});

test("missing occurrence date remains explicit instead of using createdAt", () => {
  assert.equal(groupTimelineTransactions([transaction({ occurredOn: undefined })], today)[0]?.label, "日期未提供");
});

test("initial client render window contains only the first 20", () => {
  const rows = effectiveTimelineTransactions(history(61));
  assert.equal(TIMELINE_PAGE_SIZE, 20);
  assert.equal(visibleTimelineTransactions(rows).length, 20);
  assert.deepEqual(visibleTimelineTransactions(rows), rows.slice(0, 20));
});

test("20 to 40 append preserves visible IDs and adds the next 20 once", () => {
  const rows = effectiveTimelineTransactions(history(61));
  const initial = visibleTimelineTransactions(rows, 20);
  const appended = visibleTimelineTransactions(rows, 40);
  assert.deepEqual(appended.slice(0, 20), initial);
  assert.deepEqual(appended.slice(20), rows.slice(20, 40));
  assert.equal(new Set(appended.map(row => row.id)).size, 40);
});

test("append boundaries 20/21 and 40/41 share one date heading", () => {
  const rows = effectiveTimelineTransactions(history(61));
  for (const count of [20, 40, 60]) {
    const grouped = groupTimelineTransactions(visibleTimelineTransactions(rows, count), today);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0]?.transactions.length, count);
  }
});

test("a partially visible date group grows in place without another heading", () => {
  const rows = effectiveTimelineTransactions([...history(10), ...history(35).map(row => ({ ...row, id: `previous-${row.id}`, occurredOn: "2026-10-02" }))]);
  const initial = groupTimelineTransactions(visibleTimelineTransactions(rows, 20), today);
  const appended = groupTimelineTransactions(visibleTimelineTransactions(rows, 40), today);
  assert.deepEqual(initial.map(group => group.occurredOn), [today, "2026-10-02"]);
  assert.deepEqual(appended.map(group => group.occurredOn), [today, "2026-10-02"]);
  assert.equal(initial[1]?.transactions.length, 10);
  assert.equal(appended[1]?.transactions.length, 30);
});

test("final window stops at loaded record count", () => {
  const rows = effectiveTimelineTransactions(history(41));
  assert.equal(visibleTimelineTransactions(rows, 60).length, 41);
  assert.equal(visibleTimelineTransactions(rows, -1).length, 0);
});

test("effective Home history contains current posted transactions only", () => {
  const rows = [transaction({ id: "current" }), transaction({ id: "void", status: "voided" }),
    transaction({ id: "deleted", status: "deleted" }), transaction({ id: "replaced", replacedByTransactionId: "current" })];
  assert.deepEqual(effectiveTimelineTransactions(rows).map(row => row.id), ["current"]);
});

test("voided rows remain excluded even without a replacement", () => {
  assert.equal(effectiveTimelineTransactions([transaction({ status: "voided", replacedByTransactionId: null })]).length, 0);
});

test("replaced old posted rows are excluded and the new replacement remains", () => {
  const old = transaction({ id: "old", replacedByTransactionId: "new" });
  const replacement = transaction({ id: "new", replacesTransactionId: "old" });
  assert.deepEqual(effectiveTimelineTransactions([old, replacement]).map(row => row.id), ["new"]);
});

test("Detail lookup resolves exact old and void IDs from available history", () => {
  const old = transaction({ id: "old", replacedByTransactionId: "new", status: "voided" });
  const voided = transaction({ id: "void", status: "voided" });
  assert.equal(lookupTimelineTransaction([old, voided], ledgerId, "old"), old);
  assert.equal(lookupTimelineTransaction([old, voided], ledgerId, "void"), voided);
});

test("Detail lookup never substitutes a similar transaction or another Ledger", () => {
  const row = transaction();
  assert.equal(lookupTimelineTransaction([row], "ledger-b", row.id), undefined);
  assert.equal(lookupTimelineTransaction([row], ledgerId, "missing"), undefined);
});

test("expense payer summary distinguishes you and partner", () => {
  assert.equal(timelinePaymentSummary(transaction(), selfId), "你付款");
  assert.equal(timelinePaymentSummary(transaction({ payments: [{ userId: partnerId, amountTwd: "100" }] }), selfId), "另一半付款");
});

test("both-payer expense summary hides individual amounts", () => {
  assert.equal(timelinePaymentSummary(transaction({ payments: [{ userId: selfId, amountTwd: "60" }, { userId: partnerId, amountTwd: "40" }] }), selfId), "兩人付款");
});

test("zero allocations are not described as another active payer", () => {
  assert.equal(timelinePaymentSummary(transaction({ payments: [{ userId: selfId, amountTwd: "100" }, { userId: partnerId, amountTwd: "0" }] }), selfId), "你付款");
});

test("income identifies the receiver and has an explicit type label", () => {
  assert.equal(timelinePaymentSummary(transaction({ type: "income" }), selfId), "你收款");
  assert.equal(timelinePaymentSummary(transaction({ type: "income", payments: [{ userId: partnerId, amountTwd: "100" }] }), selfId), "另一半收款");
  assert.equal(timelineTypeLabel("income"), "收入／退款");
});

test("income received by both uses receiver language", () => {
  assert.equal(timelinePaymentSummary(transaction({ type: "income", payments: [{ userId: selfId, amountTwd: "60" }, { userId: partnerId, amountTwd: "40" }] }), selfId), "兩人收款");
});

test("transfer directions describe sender to receiver without split language", () => {
  const transfer = transaction({ type: "transfer", shares: [{ userId: partnerId, amountTwd: "100" }] });
  assert.equal(timelineTransferDirection(transfer, selfId), "你 → 另一半");
  assert.equal(timelinePaymentSummary(transfer, selfId), "你 → 另一半");
  assert.equal(timelineTransferDirection(transfer, partnerId), "另一半 → 你");
  assert.equal(timelineTypeLabel("transfer"), "轉帳");
});

test("huge canonical amount strings retain every digit", () => {
  assert.equal(timelineMoney("900719925474099312345678901"), "NT$900,719,925,474,099,312,345,678,901");
  assert.equal(timelineMoney("100000000000"), "NT$100,000,000,000");
  assert.equal(timelineMoney("0"), "NT$0");
});

test("invalid amounts are not silently rounded into a different financial value", () => {
  assert.equal(timelineMoney("123.45"), "NT$—");
  assert.equal(timelineMoney("not-money"), "NT$—");
});

test("long purpose text stays complete for Detail and accessible row names", () => {
  const description = "一起買晚餐、生活用品，還有這次旅行所需的車票。".repeat(20);
  assert.equal(timelinePurpose(transaction({ description })), description);
});

test("missing purpose uses the truthful transaction type", () => {
  assert.equal(timelinePurpose(transaction({ type: "income", description: "  " })), "收入／退款");
});

test("stored and archived category data remain truthful without a fabricated replacement", () => {
  const category: V2Category = { id: "category-a", ledgerId, name: "餐飲", status: "archived", isDefault: false, createdAt: "", updatedAt: "" };
  const row = transaction({ categoryId: category.id, category: "stored category" });
  assert.equal(timelineCategoryLabel(row, [category]), "stored category");
  assert.equal(timelineCategoryLabel({ ...row, category: null }, [category]), "餐飲");
  assert.equal(timelineCategoryLabel(row, []), "stored category");
  assert.equal(timelineCategoryLabel(transaction({ categoryId: "missing", category: null }), []), null);
  assert.equal(timelineCategoryLabel(row, [{ ...category, ledgerId: "foreign-ledger" }]), "stored category");
});
