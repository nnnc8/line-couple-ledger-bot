/**
 * pending-action.tx.test.ts
 *
 * Executor unit tests for applyPendingActionPlanTx.
 * Uses an inline FakeTxClient + setMockWithTx to test the executor in
 * isolation. This file does NOT touch a real Postgres connection — see
 * pending-action.pg.test.ts for the guarded live test that does.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setMockWithTx } from "./db/tx";
import { applyPendingActionPlanTx, TransactionStaleError } from "./pending-action-executor";
import type { PendingActionPlan } from "./pending-action-types";

// ---------------------------------------------------------------------------
// Inline FakeTxClient
// ---------------------------------------------------------------------------
type FakeTxCall = { query: string; params?: unknown[] };

class FakeTxClient {
  calls: FakeTxCall[] = [];
  mockResults: Array<{ pattern: string | RegExp; result: unknown }> = [];

  async query(sql: string, params?: unknown[]) {
    const clean = sql.replace(/\s+/g, " ").trim();
    this.calls.push({ query: clean, params });
    for (const item of this.mockResults) {
      if (typeof item.pattern === "string") {
        if (clean.includes(item.pattern)) return item.result;
      } else if (item.pattern.test(clean)) {
        return item.result;
      }
    }
    return { rowCount: 1, rows: [] };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ACTION_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "user-owner-001";
const NOW = "2099-01-01T00:00:00.000Z";

function makePendingRow(overrides: Partial<{
  status: string;
  expires_at: string;
  action_type: string;
}> = {}) {
  return {
    rowCount: 1,
    rows: [{
      status: overrides.status ?? "pending",
      expires_at: overrides.expires_at ?? "2099-12-31T23:59:59.000Z",
      action_type: overrides.action_type ?? "create_expense",
    }],
  };
}

function withFakeTx(fake: FakeTxClient) {
  setMockWithTx(async (cb) => cb(fake as any));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("tx executor: not_found when row is missing", async () => {
  const fake = new FakeTxClient();
  fake.mockResults.push({ pattern: /FOR UPDATE/i, result: { rowCount: 0, rows: [] } });
  withFakeTx(fake);

  const result = await applyPendingActionPlanTx(fake as any, ACTION_ID, USER_ID, {}, NOW);
  assert.equal(result.result, "not_found");
});

test("tx executor: already_done when status is confirmed", async () => {
  const fake = new FakeTxClient();
  fake.mockResults.push({ pattern: /FOR UPDATE/i, result: makePendingRow({ status: "confirmed" }) });
  withFakeTx(fake);

  const result = await applyPendingActionPlanTx(fake as any, ACTION_ID, USER_ID, {}, NOW);
  assert.equal(result.result, "already_done");
});

test("tx executor: expired when expires_at is past", async () => {
  const fake = new FakeTxClient();
  fake.mockResults.push({
    pattern: /FOR UPDATE/i,
    result: makePendingRow({ expires_at: "2000-01-01T00:00:00.000Z" }),
  });
  withFakeTx(fake);

  const result = await applyPendingActionPlanTx(fake as any, ACTION_ID, USER_ID, {}, NOW);
  assert.equal(result.result, "expired");
  const expiredUpdate = fake.calls.find(c => c.query.includes("expired"));
  assert.ok(expiredUpdate, "should UPDATE to expired");
});

test("tx executor: confirmed with insert_expenses plan", async () => {
  const fake = new FakeTxClient();
  fake.mockResults.push({
    pattern: /FOR UPDATE/i,
    result: makePendingRow({ action_type: "create_expense" }),
  });
  withFakeTx(fake);

  const plan: PendingActionPlan = {
    insert_expenses: [{
      id: "exp-001",
      couple_id: 1,
      group_id: null,
      ledger: "private",
      description: "晚餐",
      merchant: null,
      notes: null,
      tag: "餐飲",
      amount_twd: 500,
      paid_by_user_id: USER_ID,
      created_by_user_id: USER_ID,
      expense_date: "2026-07-01",
      split_method: "equal",
      source_action_id: ACTION_ID,
    }],
    insert_expense_splits: [{ expense_id: "exp-001", user_id: USER_ID, amount_twd: 500 }],
    insert_activities: [{
      couple_id: 1, group_id: null, actor_user_id: USER_ID,
      entity_type: "expense", entity_id: "exp-001", action: "create",
      before_state: null, after_state: null,
    }],
  };

  const result = await applyPendingActionPlanTx(fake as any, ACTION_ID, USER_ID, plan, NOW);

  assert.equal(result.result, "confirmed");
  assert.equal(result.created_count, 1);
  assert.ok(fake.calls.find(c => c.query.includes("INSERT INTO public.expenses")));
  assert.ok(fake.calls.find(c => c.query.includes("INSERT INTO public.expense_splits")));
  assert.ok(fake.calls.find(c => c.query.includes("INSERT INTO public.activity_events")));
  assert.ok(fake.calls.find(c => c.query.includes("confirmed") && c.query.includes("UPDATE public.pending_actions")));
});

test("tx executor: confirmed with update_expenses plan", async () => {
  const fake = new FakeTxClient();
  fake.mockResults.push({
    pattern: /FOR UPDATE/i,
    result: makePendingRow({ action_type: "update_expense" }),
  });
  withFakeTx(fake);

  const plan: PendingActionPlan = {
    update_expenses: [{
      id: "exp-002", couple_id: 1, group_id: null, ledger: "private",
      description: "修改後", merchant: null, notes: null, tag: "生活",
      amount_twd: 200, paid_by_user_id: USER_ID, expense_date: "2026-07-02",
      split_method: "equal", expected_version: 3,
    }],
    delete_expense_splits: ["exp-002"],
    insert_expense_splits: [{ expense_id: "exp-002", user_id: USER_ID, amount_twd: 200 }],
    insert_activities: [{
      couple_id: 1, group_id: null, actor_user_id: USER_ID,
      entity_type: "expense", entity_id: "exp-002", action: "update",
      before_state: null, after_state: null,
    }],
  };

  const result = await applyPendingActionPlanTx(fake as any, ACTION_ID, USER_ID, plan, NOW);

  assert.equal(result.result, "confirmed");
  assert.equal(result.created_count, 0);
  assert.ok(fake.calls.find(c => c.query.includes("DELETE FROM public.expense_splits")));
  assert.ok(fake.calls.find(c => c.query.includes("UPDATE public.expenses")));
});

test("tx executor: stale on version mismatch (rowCount=0 from UPDATE)", async () => {
  const fake = new FakeTxClient();
  fake.mockResults.push({
    pattern: /FOR UPDATE/i,
    result: makePendingRow({ action_type: "update_expense" }),
  });
  fake.mockResults.push({
    pattern: /UPDATE public.expenses/i,
    result: { rowCount: 0, rows: [] },
  });
  withFakeTx(fake);

  const plan: PendingActionPlan = {
    update_expenses: [{
      id: "exp-003", couple_id: 1, group_id: null, ledger: "private",
      description: "失敗更新", merchant: null, notes: null, tag: "餐飲",
      amount_twd: 100, paid_by_user_id: USER_ID, expense_date: "2026-07-01",
      split_method: "equal", expected_version: 99,
    }],
  };

  await assert.rejects(
    () => applyPendingActionPlanTx(fake as any, ACTION_ID, USER_ID, plan, NOW),
    TransactionStaleError,
  );
});

test("tx executor: confirmed with insert_settlements plan", async () => {
  const fake = new FakeTxClient();
  fake.mockResults.push({
    pattern: /FOR UPDATE/i,
    result: makePendingRow({ action_type: "settle" }),
  });
  withFakeTx(fake);

  const plan: PendingActionPlan = {
    insert_settlements: [{
      id: "settle-001", couple_id: 1, group_id: "group-001",
      from_user_id: USER_ID, to_user_id: "user-partner-001",
      amount_twd: 3000, source_action_id: ACTION_ID,
    }],
    insert_activities: [{
      couple_id: 1, group_id: "group-001", actor_user_id: USER_ID,
      entity_type: "settlement", entity_id: "settle-001", action: "create",
      before_state: null, after_state: null,
    }],
  };

  const result = await applyPendingActionPlanTx(fake as any, ACTION_ID, USER_ID, plan, NOW);
  assert.equal(result.result, "confirmed");
  assert.ok(fake.calls.find(c => c.query.includes("INSERT INTO public.settlements")));
});

test("tx executor: confirmed with batch_create_expenses (2 inserts, created_count=2)", async () => {
  const fake = new FakeTxClient();
  fake.mockResults.push({
    pattern: /FOR UPDATE/i,
    result: makePendingRow({ action_type: "batch_create_expenses" }),
  });
  withFakeTx(fake);

  const plan: PendingActionPlan = {
    insert_expenses: [
      {
        id: "exp-batch-001", couple_id: 1, group_id: "group-001", ledger: "shared",
        description: "共同晚餐", merchant: null, notes: null, tag: "餐飲",
        amount_twd: 600, paid_by_user_id: USER_ID, created_by_user_id: USER_ID,
        expense_date: "2026-07-01", split_method: "equal", source_action_id: ACTION_ID,
      },
      {
        id: "exp-batch-002", couple_id: 1, group_id: null, ledger: "private",
        description: "私人咖啡", merchant: null, notes: null, tag: "餐飲",
        amount_twd: 120, paid_by_user_id: USER_ID, created_by_user_id: USER_ID,
        expense_date: "2026-07-01", split_method: "equal", source_action_id: ACTION_ID,
      },
    ],
    insert_expense_splits: [
      { expense_id: "exp-batch-001", user_id: USER_ID, amount_twd: 300 },
      { expense_id: "exp-batch-001", user_id: "user-partner-001", amount_twd: 300 },
      { expense_id: "exp-batch-002", user_id: USER_ID, amount_twd: 120 },
    ],
    insert_activities: [],
  };

  const result = await applyPendingActionPlanTx(fake as any, ACTION_ID, USER_ID, plan, NOW);
  assert.equal(result.result, "confirmed");
  assert.equal(result.created_count, 2);
});

test("tx executor: pg constraint violation (23505) → TransactionStaleError", async () => {
  const fake = new FakeTxClient();
  fake.mockResults.push({
    pattern: /FOR UPDATE/i,
    result: makePendingRow({ action_type: "create_expense" }),
  });
  withFakeTx(fake);

  // Override query to throw a pg-style constraint error after the first query
  let callCount = 0;
  const origQuery = fake.query.bind(fake);
  fake.query = async function (sql: string, params?: unknown[]) {
    callCount++;
    if (callCount > 1) {
      const err: any = new Error("duplicate key value violates unique constraint");
      err.code = "23505";
      throw err;
    }
    return origQuery(sql, params);
  } as any;

  const plan: PendingActionPlan = {
    insert_expenses: [{
      id: "exp-dup", couple_id: 1, group_id: null, ledger: "private",
      description: "重複", merchant: null, notes: null, tag: "其他",
      amount_twd: 100, paid_by_user_id: USER_ID, created_by_user_id: USER_ID,
      expense_date: "2026-07-01", split_method: "equal", source_action_id: ACTION_ID,
    }],
  };

  await assert.rejects(
    () => applyPendingActionPlanTx(fake as any, ACTION_ID, USER_ID, plan, NOW),
    TransactionStaleError,
  );
});

test("tx executor: insert_notifications included in plan", async () => {
  const fake = new FakeTxClient();
  fake.mockResults.push({
    pattern: /FOR UPDATE/i,
    result: makePendingRow({ action_type: "create_expense" }),
  });
  withFakeTx(fake);

  const plan: PendingActionPlan = {
    insert_expenses: [{
      id: "exp-notif", couple_id: 1, group_id: "group-001", ledger: "shared",
      description: "共同帳", merchant: null, notes: null, tag: "餐飲",
      amount_twd: 400, paid_by_user_id: USER_ID, created_by_user_id: USER_ID,
      expense_date: "2026-07-01", split_method: "equal", source_action_id: ACTION_ID,
    }],
    insert_expense_splits: [
      { expense_id: "exp-notif", user_id: USER_ID, amount_twd: 200 },
      { expense_id: "exp-notif", user_id: "user-partner-001", amount_twd: 200 },
    ],
    insert_activities: [{
      couple_id: 1, group_id: "group-001", actor_user_id: USER_ID,
      entity_type: "expense", entity_id: "exp-notif", action: "create",
      before_state: null, after_state: null,
    }],
    insert_notifications: [{
      recipient_user_id: "user-partner-001",
      group_id: "group-001",
      kind: "expense_created",
      title: "新增支出",
      body: "你的另一半新增了一筆支出",
      entity_type: "expense",
      entity_id: "exp-notif",
      dedupe_key: `action:${ACTION_ID}`,
    }],
  };

  const result = await applyPendingActionPlanTx(fake as any, ACTION_ID, USER_ID, plan, NOW);
  assert.equal(result.result, "confirmed");
  assert.ok(fake.calls.find(c => c.query.includes("INSERT INTO public.notifications")));
});
