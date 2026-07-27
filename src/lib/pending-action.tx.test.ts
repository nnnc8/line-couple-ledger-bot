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
import type { PoolClient } from "pg";
import { setMockWithTx } from "./db/tx";
import { HttpError } from "./http-error";
import {
  createSettlementCommandSchema,
  LedgerCommandService,
  transferCommandSchema,
  voidSettlementCommandSchema,
  type PendingLedgerCommand,
} from "./ledger-core";
import { applyPendingActionPlanTx, TransactionStaleError } from "./pending-action-executor";
import { pendingActionRequestFingerprint } from "./pending-action-idempotency";
import {
  applyLedgerActionTx,
  LedgerActionStaleError,
  lockGroupLedgers,
  type PendingLedgerActionRow,
} from "./pending-action-ledger-tx";
import { PendingActionService } from "./pending-action-service";
import type {
  PendingActionContext,
  PendingActionPlan,
} from "./pending-action-types";

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
  expires_at: string | Date;
  action_type: string;
  request_fingerprint: string | null;
}> = {}) {
  return {
    rowCount: 1,
    rows: [{
      couple_id: 1,
      group_id: null,
      requested_by_user_id: USER_ID,
      status: overrides.status ?? "pending",
      expires_at: overrides.expires_at ?? "2099-12-31T23:59:59.000Z",
      action_type: overrides.action_type ?? "create_expense",
      payload: {},
      request_fingerprint: overrides.request_fingerprint ?? null,
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

test("tx executor: cancelled or expired rows never masquerade as successful", async () => {
  for (const status of ["cancelled", "expired"] as const) {
    const fake = new FakeTxClient();
    fake.mockResults.push({ pattern: /FOR UPDATE/i, result: makePendingRow({ status }) });
    withFakeTx(fake);

    const result = await applyPendingActionPlanTx(
      fake as unknown as PoolClient,
      ACTION_ID,
      USER_ID,
      {},
      NOW,
    );
    assert.equal(result.result, status);
  }
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

test("tx executor: expires a pg Date value instead of comparing object identity", async () => {
  const fake = new FakeTxClient();
  fake.mockResults.push({
    pattern: /FOR UPDATE/i,
    result: makePendingRow({ expires_at: new Date("2000-01-01T00:00:00.000Z") }),
  });
  withFakeTx(fake);

  const result = await applyPendingActionPlanTx(fake as any, ACTION_ID, USER_ID, {}, NOW);
  assert.equal(result.result, "expired");
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

test("tx executor: shared-to-private rechecks settlements after the group lock", async () => {
  const fake = new FakeTxClient();
  const groupId = "00000000-0000-4000-8000-000000000099";
  fake.mockResults.push({
    pattern: /FROM public\.pending_actions.*FOR UPDATE/i,
    result: makePendingRow({ action_type: "update_expense" }),
  });
  fake.mockResults.push({
    pattern: /FROM public\.groups.*FOR UPDATE/i,
    result: {
      rowCount: 1,
      rows: [{ id: groupId, name: "共同生活", archived_at: null }],
    },
  });
  fake.mockResults.push({
    pattern: /FROM public\.settlements.*voided_at IS NULL/i,
    result: { rowCount: 1, rows: [{ "?column?": 1 }] },
  });

  const plan: PendingActionPlan = {
    lock_group_ids: [groupId],
    reject_shared_to_private_if_settled_group_id: groupId,
    update_expenses: [{
      id: "exp-guarded",
      couple_id: 1,
      group_id: null,
      ledger: "private",
      description: "不能競態轉私人",
      merchant: null,
      notes: null,
      tag: "生活",
      amount_twd: 200,
      paid_by_user_id: USER_ID,
      expense_date: "2026-07-02",
      split_method: "equal",
      expected_version: 3,
    }],
  };

  await assert.rejects(
    () =>
      applyPendingActionPlanTx(
        fake as unknown as PoolClient,
        ACTION_ID,
        USER_ID,
        plan,
        NOW,
      ),
    TransactionStaleError,
  );
  assert.equal(
    fake.calls.some((call) => call.query.includes("UPDATE public.expenses")),
    false,
  );
  const groupLockIndex = fake.calls.findIndex((call) =>
    call.query.includes("FROM public.groups"),
  );
  const settlementCheckIndex = fake.calls.findIndex((call) =>
    call.query.includes("FROM public.settlements"),
  );
  assert.ok(groupLockIndex >= 0 && settlementCheckIndex > groupLockIndex);
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

test("tx executor: rejects a plan when retarget changed the locked fingerprint", async () => {
  const fake = new FakeTxClient();
  fake.mockResults.push({
    pattern: /FOR UPDATE/i,
    result: makePendingRow({
      action_type: "create_expense",
      request_fingerprint: "new-fingerprint",
    }),
  });

  await assert.rejects(
    () => applyPendingActionPlanTx(
      fake as unknown as PoolClient,
      ACTION_ID,
      USER_ID,
      { expected_request_fingerprint: "old-fingerprint" },
      NOW,
    ),
    TransactionStaleError,
  );
  assert.equal(
    fake.calls.some((call) => call.query.includes("INSERT INTO public.expenses")),
    false,
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

// ---------------------------------------------------------------------------
// First-class transfer / settlement / void contracts
// ---------------------------------------------------------------------------

const OWNER_ID = "00000000-0000-4000-8000-000000000002";
const PARTNER_ID = "00000000-0000-4000-8000-000000000003";
const GROUP_ID = "00000000-0000-4000-8000-000000000004";
const SETTLEMENT_ID = "00000000-0000-4000-8000-000000000005";

type BalanceRows = Array<{ user_id: string; balance_twd: number }>;

class LedgerFakeTxClient {
  calls: FakeTxCall[] = [];
  balances: BalanceRows[] = [];
  settlementCandidate: Record<string, unknown> | null = null;
  settlementVersion = 1;
  updateRowCount = 1;

  async query(sql: string, params?: unknown[]) {
    const clean = sql.replace(/\s+/g, " ").trim();
    this.calls.push({ query: clean, params });
    if (clean.includes("FROM public.groups") && clean.includes("FOR UPDATE")) {
      return {
        rowCount: 1,
        rows: [{ id: params?.[0], name: `Group ${String(params?.[0]).slice(-1)}`, archived_at: null }],
      };
    }
    if (clean.includes("FROM public.users")) {
      return {
        rowCount: 2,
        rows: [{ id: OWNER_ID }, { id: PARTNER_ID }],
      };
    }
    if (clean.includes("FROM public.group_balances")) {
      const rows = this.balances.shift();
      if (!rows) throw new Error("missing fake balance result");
      return { rowCount: rows.length, rows };
    }
    if (clean.includes("INSERT INTO public.settlements")) {
      return { rowCount: 1, rows: [{ version: this.settlementVersion }] };
    }
    if (clean.includes("FROM public.settlements") && clean.includes("FOR UPDATE")) {
      return this.settlementCandidate
        ? { rowCount: 1, rows: [this.settlementCandidate] }
        : { rowCount: 0, rows: [] };
    }
    if (clean.includes("UPDATE public.settlements")) {
      return this.updateRowCount === 1
        ? { rowCount: 1, rows: [{ version: this.settlementVersion + 1 }] }
        : { rowCount: 0, rows: [] };
    }
    throw new Error(`unexpected fake SQL: ${clean}`);
  }
}

function storedAction(
  actionType: "transfer" | "settle" | "void_settlement",
  command: PendingLedgerCommand,
  legacyPayload: Record<string, unknown> = {},
): PendingLedgerActionRow {
  const payload = new LedgerCommandService().createPendingActionEnvelope(
    command,
    {
      source: "liff",
      actorUserId: OWNER_ID,
      idempotencyKey: "test-key",
    },
    legacyPayload,
  );
  return {
    id: ACTION_ID,
    couple_id: 1,
    group_id: GROUP_ID,
    action_type: actionType,
    payload,
  };
}

function lockedGroup() {
  return new Map([
    [GROUP_ID, { id: GROUP_ID, name: "生活", archived_at: null }],
  ]);
}

test("transfer command rejects invalid money, future dates and long notes", () => {
  const base = {
    type: "transfer" as const,
    groupId: GROUP_ID,
    direction: "me_to_partner" as const,
    amountTwd: 500,
    occurredOn: "2026-07-01",
  };
  for (const amountTwd of [0, -1, 1.5, 100_000_001]) {
    assert.equal(
      transferCommandSchema.safeParse({ ...base, amountTwd }).success,
      false,
      `amount ${amountTwd} must be rejected`,
    );
  }
  assert.equal(
    transferCommandSchema.safeParse({ ...base, occurredOn: "9999-01-01" }).success,
    false,
  );
  assert.equal(
    transferCommandSchema.safeParse({ ...base, notes: "x".repeat(201) }).success,
    false,
  );
  assert.equal(createSettlementCommandSchema.safeParse({
    type: "settle",
    groupId: GROUP_ID,
    direction: "partner_to_me",
  }).success, true);
  assert.equal(voidSettlementCommandSchema.safeParse({
    type: "void_settlement",
    settlementId: SETTLEMENT_ID,
    expectedVersion: 0,
  }).success, false);
});

test("idempotency fingerprint is canonical and changes with payload or type", () => {
  const first = pendingActionRequestFingerprint({
    actionType: "transfer",
    groupId: GROUP_ID,
    payload: { amount_twd: 500, nested: { z: 2, a: 1 } },
  });
  const reordered = pendingActionRequestFingerprint({
    actionType: "transfer",
    groupId: GROUP_ID,
    payload: { nested: { a: 1, z: 2 }, amount_twd: 500 },
  });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(reordered, first);
  assert.notEqual(
    pendingActionRequestFingerprint({
      actionType: "transfer",
      groupId: GROUP_ID,
      payload: { amount_twd: 501, nested: { a: 1, z: 2 } },
    }),
    first,
  );
  assert.notEqual(
    pendingActionRequestFingerprint({
      actionType: "settle",
      groupId: GROUP_ID,
      payload: { amount_twd: 500, nested: { a: 1, z: 2 } },
    }),
    first,
  );
});

test("void settlement surfaces transaction version races as 409 stale_action", async () => {
  const service = new PendingActionService();
  service.insert = async () => ACTION_ID;
  service.confirm = async () => ({
    result: "stale" as const,
    action_type: "void_settlement",
  });
  await assert.rejects(
    () => service.execute({} as unknown as PendingActionContext, {
      actionType: "void_settlement",
      groupId: GROUP_ID,
      payload: {},
      sourceEventId: "test:void",
    }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.status === 409 &&
      error.message === "stale_action",
  );
});

test("cancel reports the confirmed state when confirmation wins the CAS race", async () => {
  const service = new PendingActionService();
  let mode: "select" | "update" = "select";
  let selectCalls = 0;
  const db = {
    from(table: string) {
      assert.equal(table, "pending_actions");
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.update = () => {
        mode = "update";
        return chain;
      };
      chain.eq = () => chain;
      chain.maybeSingle = async () => {
        if (mode === "update") {
          mode = "select";
          return { data: null, error: null };
        }
        selectCalls += 1;
        if (selectCalls === 1) {
          return {
            data: {
              id: ACTION_ID,
              couple_id: 1,
              group_id: null,
              action_type: "create_expense",
              payload: {},
              status: "pending",
              expires_at: "2099-12-31T23:59:59.000Z",
            },
            error: null,
          };
        }
        return {
          data: { status: "confirmed", action_type: "create_expense" },
          error: null,
        };
      };
      return chain;
    },
  };

  const result = await service.confirm(
    {
      db: db as unknown as PendingActionContext["db"],
      user: {
        id: USER_ID,
        couple_id: 1,
        line_user_id: "line-owner",
        role: "owner",
      },
    },
    ACTION_ID,
    false,
  );

  assert.equal(result.result, "already_done");
});

test("group locks are deduplicated and acquired in UUID order", async () => {
  const fake = new LedgerFakeTxClient();
  const later = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const earlier = "00000000-0000-4000-8000-000000000010";
  await lockGroupLedgers(fake as unknown as PoolClient, 1, [later, earlier, later]);
  assert.deepEqual(
    fake.calls.map((call) => call.params?.[0]),
    [earlier, later],
  );
});

test("partner-to-me transfer derives users server-side and may cross zero", async () => {
  const fake = new LedgerFakeTxClient();
  fake.balances.push(
    [
      { user_id: OWNER_ID, balance_twd: 100 },
      { user_id: PARTNER_ID, balance_twd: -100 },
    ],
    [
      { user_id: OWNER_ID, balance_twd: -400 },
      { user_id: PARTNER_ID, balance_twd: 400 },
    ],
  );
  const action = storedAction(
    "transfer",
    {
      type: "transfer",
      groupId: GROUP_ID,
      direction: "partner_to_me",
      amountTwd: 500,
      occurredOn: "2026-07-01",
      notes: " 已收到 ",
    },
    {
      from_user_id: "00000000-0000-4000-8000-000000000099",
      to_user_id: "00000000-0000-4000-8000-000000000098",
    },
  );

  const applied = await applyLedgerActionTx(
    fake as unknown as PoolClient,
    action,
    lockedGroup(),
    OWNER_ID,
    NOW,
  );

  const insert = fake.calls.find((call) => call.query.includes("INSERT INTO public.settlements"));
  assert.equal(insert?.params?.[3], PARTNER_ID);
  assert.equal(insert?.params?.[4], OWNER_ID);
  assert.equal(insert?.params?.[5], 500);
  assert.equal(insert?.params?.[7], "transfer");
  assert.equal(insert?.params?.[9], "已收到");
  assert.deepEqual(applied.result.balance?.after_by_user_id, {
    [OWNER_ID]: -400,
    [PARTNER_ID]: 400,
  });
  assert.equal(applied.plan.insert_activities?.[0]?.action, "create");
  assert.match(
    String(applied.plan.insert_notifications?.[0]?.body ?? ""),
    /另一半記錄你轉出 NT\$500/,
  );
});

test("settle supports partner-to-me full repayment but rejects overpayment", async () => {
  const success = new LedgerFakeTxClient();
  success.balances.push(
    [
      { user_id: OWNER_ID, balance_twd: 300 },
      { user_id: PARTNER_ID, balance_twd: -300 },
    ],
    [
      { user_id: OWNER_ID, balance_twd: 0 },
      { user_id: PARTNER_ID, balance_twd: 0 },
    ],
  );
  const full = storedAction(
    "settle",
    {
      type: "settle",
      groupId: GROUP_ID,
      direction: "partner_to_me",
    },
    {
      amount_twd: 300,
      expected_balance_twd: -300,
    },
  );
  const applied = await applyLedgerActionTx(
    success as unknown as PoolClient,
    full,
    lockedGroup(),
    OWNER_ID,
    NOW,
  );
  const insert = success.calls.find((call) => call.query.includes("INSERT INTO public.settlements"));
  assert.equal(insert?.params?.[3], PARTNER_ID);
  assert.equal(insert?.params?.[4], OWNER_ID);
  assert.equal(insert?.params?.[5], 300);
  assert.equal(applied.plan.insert_activities?.[0]?.action, "settle");

  const unsafeLegacy = new LedgerFakeTxClient();
  unsafeLegacy.balances.push([
    { user_id: OWNER_ID, balance_twd: 300 },
    { user_id: PARTNER_ID, balance_twd: -300 },
  ]);
  await assert.rejects(
    () => applyLedgerActionTx(
      unsafeLegacy as unknown as PoolClient,
      storedAction("settle", {
        type: "settle",
        groupId: GROUP_ID,
        direction: "partner_to_me",
      }),
      lockedGroup(),
      OWNER_ID,
      NOW,
    ),
  );
  assert.equal(
    unsafeLegacy.calls.some((call) =>
      call.query.includes("INSERT INTO public.settlements"),
    ),
    false,
  );

  const overpay = new LedgerFakeTxClient();
  overpay.balances.push([
    { user_id: OWNER_ID, balance_twd: 300 },
    { user_id: PARTNER_ID, balance_twd: -300 },
  ]);
  await assert.rejects(
    () => applyLedgerActionTx(
      overpay as unknown as PoolClient,
      storedAction("settle", {
        type: "settle",
        groupId: GROUP_ID,
        direction: "partner_to_me",
        amountTwd: 301,
      }),
      lockedGroup(),
      OWNER_ID,
      NOW,
    ),
    LedgerActionStaleError,
  );
  assert.equal(
    overpay.calls.some((call) => call.query.includes("INSERT INTO public.settlements")),
    false,
  );
});

test("full-settle confirmation is stale when debt changed after preview", async () => {
  const fake = new LedgerFakeTxClient();
  fake.balances.push([
    { user_id: OWNER_ID, balance_twd: -500 },
    { user_id: PARTNER_ID, balance_twd: 500 },
  ]);
  const frozen = storedAction(
    "settle",
    {
      type: "settle",
      groupId: GROUP_ID,
      direction: "me_to_partner",
      amountTwd: 300,
    },
    {
      settle_all: true,
      expected_balance_twd: -300,
    },
  );

  await assert.rejects(
    () => applyLedgerActionTx(
      fake as unknown as PoolClient,
      frozen,
      lockedGroup(),
      OWNER_ID,
      NOW,
    ),
    LedgerActionStaleError,
  );
  assert.equal(
    fake.calls.some((call) => call.query.includes("INSERT INTO public.settlements")),
    false,
  );
});

test("void settlement is a versioned soft void and stale repeats are rejected", async () => {
  const fake = new LedgerFakeTxClient();
  fake.settlementCandidate = {
    id: SETTLEMENT_ID,
    couple_id: 1,
    group_id: GROUP_ID,
    from_user_id: OWNER_ID,
    to_user_id: PARTNER_ID,
    amount_twd: 500,
    intent: "transfer",
    occurred_on: "2026-07-01",
    notes: null,
    voided_at: null,
    version: 1,
  };
  fake.balances.push(
    [
      { user_id: OWNER_ID, balance_twd: 500 },
      { user_id: PARTNER_ID, balance_twd: -500 },
    ],
    [
      { user_id: OWNER_ID, balance_twd: 0 },
      { user_id: PARTNER_ID, balance_twd: 0 },
    ],
  );
  const action = storedAction("void_settlement", {
    type: "void_settlement",
    settlementId: SETTLEMENT_ID,
    expectedVersion: 1,
  });
  const applied = await applyLedgerActionTx(
    fake as unknown as PoolClient,
    action,
    lockedGroup(),
    OWNER_ID,
    NOW,
  );
  const update = fake.calls.find((call) => call.query.includes("UPDATE public.settlements"));
  assert.deepEqual(update?.params?.slice(0, 3), [NOW, OWNER_ID, ACTION_ID]);
  assert.equal(applied.result.settlement_version, 2);
  assert.equal(applied.plan.insert_activities?.[0]?.action, "delete");

  const stale = new LedgerFakeTxClient();
  stale.settlementCandidate = { ...fake.settlementCandidate, voided_at: NOW };
  await assert.rejects(
    () => applyLedgerActionTx(
      stale as unknown as PoolClient,
      action,
      lockedGroup(),
      OWNER_ID,
      NOW,
    ),
    LedgerActionStaleError,
  );
});
