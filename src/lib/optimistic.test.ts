import assert from "node:assert/strict";
import test from "node:test";

import { applyOptimistic, type BootstrapLike, type OptimisticExpense } from "./optimistic";

const alice = "alice";
const bob = "bob";
const group = "group";

function expense(overrides: Partial<OptimisticExpense> = {}): OptimisticExpense {
  return {
    id: "expense",
    group_id: group,
    ledger: "shared",
    description: "晚餐",
    merchant: null,
    notes: null,
    tag: "food",
    mirror_kind: null,
    mirror_source_expense_id: null,
    amount_twd: 100,
    paid_by_user_id: alice,
    created_by_user_id: alice,
    expense_date: "2026-08-13",
    split_method: "equal",
    version: 1,
    deleted_at: null,
    expense_splits: [{ user_id: alice, amount_twd: 50 }, { user_id: bob, amount_twd: 50 }],
    ...overrides,
  };
}

function bootstrap(rows: OptimisticExpense[] = [expense()]): BootstrapLike {
  return {
    user: { id: alice },
    users: [{ id: alice, label: "我" }, { id: bob, label: "另一半" }],
    activeGroupId: group,
    month: "2026-08",
    expenses: rows,
    sharedExpenses: rows,
    privateExpenses: [],
    balances: [{ user_id: alice, balance_twd: 50 }, { user_id: bob, balance_twd: -50 }],
    groupBalances: { [group]: [{ user_id: alice, balance_twd: 50 }, { user_id: bob, balance_twd: -50 }] },
    dashboard: { monthlyTotalTwd: 100, monthlyCount: rows.length, categoryTotals: {}, trend: [], recent: rows },
    privateDashboard: { monthlyTotalTwd: 0, monthlyCount: 0, categoryTotals: {}, trend: [], recent: [] },
  };
}

test("optimistic update replaces the old accounting delta instead of adding the new total", () => {
  const data = bootstrap();
  const updated = applyOptimistic(data, {
    type: "update_expense",
    expenseId: "expense",
    expectedVersion: 1,
    expense: {
      ledger: "shared", groupId: group, description: "晚餐", merchant: null, notes: null, tag: "food",
      amountTwd: 200, paidBy: "self", expenseDate: "2026-08-13", splitMethod: "equal",
      selfValue: 100, partnerValue: 100,
    },
  });
  assert.deepEqual(updated.balances, [{ user_id: alice, balance_twd: 100 }, { user_id: bob, balance_twd: -100 }]);
});

test("optimistic delete reverses the old shared expense delta", () => {
  const data = bootstrap();
  const deleted = applyOptimistic(data, { type: "delete_expense", expenseId: "expense", expectedVersion: 1 });
  assert.deepEqual(deleted.balances, [{ user_id: alice, balance_twd: 0 }, { user_id: bob, balance_twd: 0 }]);
  assert.equal(deleted.groupBalances[group]?.[0]?.balance_twd, 0);
});

test("optimistic group moves apply each side to its own ledger balance", () => {
  const data = bootstrap();
  const nextGroup = "trip";
  data.groupBalances[nextGroup] = [{ user_id: alice, balance_twd: 0 }, { user_id: bob, balance_twd: 0 }];
  const updated = applyOptimistic(data, {
    type: "update_expense",
    expenseId: "expense",
    expectedVersion: 1,
    expense: {
      ledger: "shared", groupId: nextGroup, description: "旅行晚餐", merchant: null, notes: null, tag: "food",
      amountTwd: 100, paidBy: "self", expenseDate: "2026-08-13", splitMethod: "equal",
      selfValue: 50, partnerValue: 50,
    },
  });
  assert.deepEqual(updated.groupBalances[group], [{ user_id: alice, balance_twd: 0 }, { user_id: bob, balance_twd: 0 }]);
  assert.deepEqual(updated.groupBalances[nextGroup], [{ user_id: alice, balance_twd: 50 }, { user_id: bob, balance_twd: -50 }]);
});
