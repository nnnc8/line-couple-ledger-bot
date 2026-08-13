import assert from "node:assert/strict";
import test from "node:test";

import { buildV2MigrationPlan, migrationPlanDigest, type LegacySnapshot } from "./v2-migration";

const alice = "00000000-0000-0000-0000-000000000001";
const bob = "00000000-0000-0000-0000-000000000002";
const groupOne = "10000000-0000-0000-0000-000000000001";
const groupTwo = "10000000-0000-0000-0000-000000000002";
const expenseOne = "20000000-0000-0000-0000-000000000001";
const expenseMirror = "20000000-0000-0000-0000-000000000002";
const privateExpense = "20000000-0000-0000-0000-000000000003";
const settlementOne = "30000000-0000-0000-0000-000000000001";

function baseSnapshot(): LegacySnapshot {
  return {
    coupleId: 1,
    users: [
      { id: alice, couple_id: 1, role: "owner" },
      { id: bob, couple_id: 1, role: "partner" },
    ],
    groups: [
      {
        id: groupOne,
        couple_id: 1,
        name: "共同生活",
        color: "#173B63",
        created_by_user_id: alice,
        archived_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: groupTwo,
        couple_id: 1,
        name: "韓國旅行",
        color: "#9B59B6",
        created_by_user_id: bob,
        archived_at: "2026-06-01T00:00:00.000Z",
        created_at: "2026-02-01T00:00:00.000Z",
      },
    ],
    expenses: [
      {
        id: expenseOne,
        couple_id: 1,
        ledger: "shared",
        group_id: groupOne,
        description: "晚餐",
        tag: "food",
        amount_twd: 101,
        paid_by_user_id: alice,
        created_by_user_id: alice,
        expense_date: "2026-01-02",
        split_method: "equal",
        deleted_at: null,
        version: 1,
        created_at: "2026-01-02T00:00:00.000Z",
        expense_splits: [
          { user_id: alice, amount_twd: 51 },
          { user_id: bob, amount_twd: 50 },
        ],
      },
      {
        id: expenseMirror,
        couple_id: 1,
        ledger: "private",
        group_id: null,
        description: "mirror",
        tag: "food",
        amount_twd: 50,
        paid_by_user_id: bob,
        created_by_user_id: bob,
        expense_date: "2026-01-02",
        split_method: "exact",
        deleted_at: null,
        version: 1,
        created_at: "2026-01-02T00:00:01.000Z",
        mirror_kind: "shared_share",
        mirror_source_expense_id: expenseOne,
        expense_splits: [{ user_id: bob, amount_twd: 50 }],
      },
      {
        id: privateExpense,
        couple_id: 1,
        ledger: "private",
        group_id: null,
        description: "partner private",
        tag: "shopping",
        amount_twd: 999,
        paid_by_user_id: bob,
        created_by_user_id: bob,
        expense_date: "2026-01-03",
        split_method: "exact",
        deleted_at: null,
        version: 1,
        created_at: "2026-01-03T00:00:00.000Z",
        expense_splits: [{ user_id: bob, amount_twd: 999 }],
      },
    ],
    settlements: [
      {
        id: settlementOne,
        couple_id: 1,
        group_id: groupOne,
        from_user_id: bob,
        to_user_id: alice,
        amount_twd: 20,
        intent: "settle",
        occurred_on: "2026-01-04",
        notes: "部分結清",
        voided_at: null,
        created_at: "2026-01-04T00:00:00.000Z",
        version: 1,
      },
    ],
  };
}

test("each legacy group becomes its own ledger without netting", () => {
  const plan = buildV2MigrationPlan(baseSnapshot());
  assert.deepEqual(plan.ledgers.map((ledger) => ledger.id), [groupOne, groupTwo]);
  assert.equal(plan.ledgers[0]?.name, "共同生活");
  assert.equal(plan.ledgers[1]?.name, "韓國旅行");
  assert.equal(plan.transactions.filter((transaction) => transaction.ledgerId === groupOne).length, 2);
  assert.equal(plan.transactions.filter((transaction) => transaction.ledgerId === groupTwo).length, 0);
  assert.equal(plan.summaries.find((summary) => summary.ledgerId === groupOne)?.v2Balance[alice], 30n);
});

test("mirrors and private rows are excluded exactly once", () => {
  const plan = buildV2MigrationPlan(baseSnapshot());
  assert.deepEqual(plan.excludedMirrorExpenseIds, [expenseMirror]);
  assert.deepEqual(plan.excludedPrivateExpenseIds, [privateExpense]);
  assert.equal(plan.transactions.some((transaction) => transaction.sourceId === expenseMirror), false);
  assert.equal(plan.transactions.some((transaction) => transaction.sourceId === privateExpense), false);
  assert.equal(plan.mappings.find((mapping) => mapping.sourceId === expenseMirror)?.mappingKind, "excluded_mirror");
  assert.equal(plan.mappings.find((mapping) => mapping.sourceId === privateExpense)?.mappingKind, "excluded_private");
});

test("settlement is a first-class transfer in the same legacy ledger", () => {
  const plan = buildV2MigrationPlan(baseSnapshot());
  const transfer = plan.transactions.find((transaction) => transaction.sourceId === settlementOne);
  assert.equal(transfer?.type, "transfer");
  assert.deepEqual(transfer?.payments, [{ userId: bob, amountTwd: 20n }]);
  assert.deepEqual(transfer?.shares, [{ userId: alice, amountTwd: 20n }]);
});

test("invalid or cross-couple source rows are quarantined, never repaired silently", () => {
  const snapshot = baseSnapshot();
  snapshot.expenses.push({
    ...snapshot.expenses[0]!,
    id: "20000000-0000-0000-0000-000000000099",
    paid_by_user_id: "00000000-0000-0000-0000-000000000099",
  });
  const plan = buildV2MigrationPlan(snapshot);
  const row = plan.quarantine.find((item) => item.sourceId.endsWith("0099"));
  assert.match(row?.reason ?? "", /outside/);
  assert.equal(plan.transactions.some((transaction) => transaction.sourceId.endsWith("0099")), false);
});

test("migration plan digest is stable for the same snapshot", () => {
  const snapshot = baseSnapshot();
  assert.equal(migrationPlanDigest(buildV2MigrationPlan(snapshot)), migrationPlanDigest(buildV2MigrationPlan(snapshot)));
});
