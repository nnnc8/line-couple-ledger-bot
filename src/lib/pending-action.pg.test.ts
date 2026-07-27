/**
 * pending-action.pg.test.ts
 *
 * Guarded live test for applyPendingActionPlanTx.
 *
 * Runs ONLY when DATABASE_URL + SUPABASE_URL + SUPABASE_SECRET_KEY are
 * present; otherwise every test skips. Each test creates its own fixture
 * (pending_action + expenses / splits / settlements) and cleans up its own
 * rows. The suite creates or reuses the isolated smoke group, restores the
 * users' prior active-group preferences, and removes a newly created group.
 *
 * Coverage: the three minimal real paths required for live activation:
 *   1. create_expense → confirm success
 *   2. update_expense → stale (version mismatch)
 *   3. settle → confirm success
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { withTx } from "./db/tx";
import { applyPendingActionPlanTx } from "./pending-action-executor";
import type { PendingActionPlan } from "./pending-action-types";
import { getOrCreateSmokeTenant, type SmokeTenant } from "./smoke/smoke-tenant";

const HAS_DB = !!process.env.DATABASE_URL;
const HAS_SUPABASE = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SECRET_KEY;
const ENABLED = HAS_DB && HAS_SUPABASE;

if (!ENABLED) {
  console.warn(
    "[pending-action.pg.test.ts] SKIPPED — requires DATABASE_URL + SUPABASE_URL + SUPABASE_SECRET_KEY",
  );
}

interface FixtureRefs {
  ownerId: string;
  partnerId: string;
  groupId: string;
  coupleId: number;
  ownerLineId: string;
  partnerLineId: string;
}

function createAdminClient() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

let smokeTenant: SmokeTenant | null = null;
let fixtureRefs: FixtureRefs | null = null;

before(async () => {
  if (!ENABLED) return;

  const db = createAdminClient();
  smokeTenant = await getOrCreateSmokeTenant(db);
  fixtureRefs = {
    ownerId: smokeTenant.owner.id,
    partnerId: smokeTenant.partner.id,
    groupId: smokeTenant.group.id,
    coupleId: smokeTenant.owner.couple_id,
    ownerLineId: smokeTenant.owner.line_user_id,
    partnerLineId: smokeTenant.partner.line_user_id,
  };
});

after(async () => {
  if (!smokeTenant) return;
  await smokeTenant.cleanup();
});

async function loadFixtureRefs(): Promise<FixtureRefs> {
  if (!fixtureRefs) {
    throw new Error("live PostgreSQL fixture is not initialized");
  }
  return fixtureRefs;
}

function makePendingRow(actionId: string, refs: FixtureRefs, actionType: string, payload: Record<string, unknown>) {
  return {
    id: actionId,
    couple_id: refs.coupleId,
    group_id: refs.groupId,
    requested_by_user_id: refs.ownerId,
    action_type: actionType,
    payload,
    status: "pending",
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    source_event_id: `pg-test:${actionId}`,
    idempotency_key: `pg-test:${actionId}`,
  };
}

async function seedPendingAction(refs: FixtureRefs, actionType: string, payload: Record<string, unknown>) {
  if (!ENABLED) throw new Error("seedPendingAction called without required env");
  const actionId = randomUUID();
  const row = makePendingRow(actionId, refs, actionType, payload);
  const db = createAdminClient();
  const insert = await db.from("pending_actions").insert(row).select("id").single();
  if (insert.error || !insert.data) {
    throw new Error(`failed to seed pending_action: ${insert.error?.message ?? "no data"}`);
  }
  return actionId;
}

async function deleteByColumn(table: string, column: string, value: string) {
  if (!ENABLED) return;
  const db = createAdminClient();
  const res = await db.from(table).delete().eq(column, value);
  if (res.error) {
    throw new Error(`[pg test cleanup] ${table} delete error: ${res.error.message}`);
  }
}

async function cleanupExpenseFixture(expenseId: string, actionIds: string[]) {
  if (!ENABLED) return;
  const db = createAdminClient();
  const mirrorRes = await db
    .from("expenses")
    .select("id")
    .eq("mirror_kind", "shared_share")
    .eq("mirror_source_expense_id", expenseId);
  if (mirrorRes.error) {
    throw new Error(`[pg test cleanup] mirror lookup failed: ${mirrorRes.error.message}`);
  }

  const mirrorIds = (mirrorRes.data ?? []).map((row) => row.id);
  const expenseIds = [...mirrorIds, expenseId];
  const entityIds = [...expenseIds, ...actionIds];

  const assistantByAction = await db
    .from("assistant_tasks")
    .delete()
    .in("related_pending_action_id", actionIds);
  if (assistantByAction.error) throw new Error(assistantByAction.error.message);
  const assistantByExpense = await db
    .from("assistant_tasks")
    .delete()
    .in("related_expense_id", expenseIds);
  if (assistantByExpense.error) throw new Error(assistantByExpense.error.message);

  const activities = await db.from("activity_events").delete().in("entity_id", entityIds);
  if (activities.error) throw new Error(activities.error.message);
  const notifications = await db.from("notifications").delete().in("entity_id", entityIds);
  if (notifications.error) throw new Error(notifications.error.message);
  const splits = await db.from("expense_splits").delete().in("expense_id", expenseIds);
  if (splits.error) throw new Error(splits.error.message);

  if (mirrorIds.length > 0) {
    const mirrors = await db.from("expenses").delete().in("id", mirrorIds);
    if (mirrors.error) throw new Error(mirrors.error.message);
  }
  const source = await db.from("expenses").delete().eq("id", expenseId);
  if (source.error) throw new Error(source.error.message);
  const actions = await db.from("pending_actions").delete().in("id", actionIds);
  if (actions.error) throw new Error(actions.error.message);
}

// ---------------------------------------------------------------------------
// 1. create_expense → confirm success
// ---------------------------------------------------------------------------
test("pg executor: create_expense confirm success (real DB)", { skip: !ENABLED }, async () => {
  const refs = await loadFixtureRefs();
  const expenseId = randomUUID();
  const actionId = await seedPendingAction(refs, "create_expense", {
    group_id: refs.groupId,
    ledger: "shared",
    description: "pg-test create",
    amount_twd: 200,
    paid_by_user_id: refs.ownerId,
    expense_date: new Date().toISOString().slice(0, 10),
    tag: "餐飲",
    split_method: "equal",
    splits: { [refs.ownerId]: 100, [refs.partnerId]: 100 },
  });

  const plan: PendingActionPlan = {
    insert_expenses: [{
      id: expenseId,
      couple_id: refs.coupleId,
      group_id: refs.groupId,
      ledger: "shared",
      description: "pg-test create",
      merchant: null,
      notes: null,
      tag: "餐飲",
      amount_twd: 200,
      paid_by_user_id: refs.ownerId,
      created_by_user_id: refs.ownerId,
      expense_date: new Date().toISOString().slice(0, 10),
      split_method: "equal",
      source_action_id: actionId,
    }],
    insert_expense_splits: [
      { expense_id: expenseId, user_id: refs.ownerId, amount_twd: 100 },
      { expense_id: expenseId, user_id: refs.partnerId, amount_twd: 100 },
    ],
    insert_activities: [{
      couple_id: refs.coupleId,
      group_id: refs.groupId,
      actor_user_id: refs.ownerId,
      entity_type: "expense",
      entity_id: expenseId,
      action: "create",
      before_state: null,
      after_state: null,
    }],
  };

  try {
    const result = await withTx(async (client) =>
      applyPendingActionPlanTx(client, actionId, refs.ownerId, plan, new Date().toISOString()),
    );
    assert.equal(result.result, "confirmed");
    assert.equal(result.created_count, 1);
  } finally {
    await cleanupExpenseFixture(expenseId, [actionId]);
  }
});

// ---------------------------------------------------------------------------
// 2. update_expense → stale (version mismatch)
// ---------------------------------------------------------------------------
test("pg executor: update_expense version mismatch → stale (real DB)", { skip: !ENABLED }, async () => {
  const refs = await loadFixtureRefs();
  const targetExpenseId = randomUUID();
  const seedActionId = await seedPendingAction(refs, "create_expense", {
    group_id: null,
    ledger: "private",
    description: "pg-test stale target seed",
    amount_twd: 50,
    paid_by_user_id: refs.ownerId,
    expense_date: new Date().toISOString().slice(0, 10),
    tag: "其他",
    split_method: "equal",
  });
  const actionId = await seedPendingAction(refs, "update_expense", {
    expense_id: targetExpenseId,
    expected_version: 99,
    group_id: refs.groupId,
    ledger: "private",
    description: "pg-test stale",
    amount_twd: 50,
    paid_by_user_id: refs.ownerId,
    expense_date: new Date().toISOString().slice(0, 10),
    tag: "其他",
    split_method: "equal",
  });

  // Seed the existing target expense with version=1, so expected_version=99 fails.
  const db = createAdminClient();
  const seed = await db.from("expenses").insert({
    id: targetExpenseId,
    couple_id: refs.coupleId,
    group_id: null,
    ledger: "private",
    description: "pg-test stale target",
    amount_twd: 50,
    paid_by_user_id: refs.ownerId,
    created_by_user_id: refs.ownerId,
    expense_date: new Date().toISOString().slice(0, 10),
    split_method: "equal",
    version: 1,
    source_action_id: seedActionId,
  }).select("id").single();
  if (seed.error) {
    throw new Error(`failed to seed target expense: ${seed.error.message}`);
  }

  const plan: PendingActionPlan = {
    update_expenses: [{
      id: targetExpenseId,
      couple_id: refs.coupleId,
      group_id: null,
      ledger: "private",
      description: "stale attempt",
      merchant: null,
      notes: null,
      tag: "其他",
      amount_twd: 999,
      paid_by_user_id: refs.ownerId,
      expense_date: new Date().toISOString().slice(0, 10),
      split_method: "equal",
      expected_version: 99,
    }],
  };

  try {
    // We expect the executor to throw TransactionStaleError, and withTx to
    // roll back. The end-state on the row is "stale" (per applyPendingActionPlanTx
    // semantics). We can only assert the executor contract here.
    const { TransactionStaleError } = await import("./pending-action-executor");
    await assert.rejects(
      () => withTx(async (client) =>
        applyPendingActionPlanTx(client, actionId, refs.ownerId, plan, new Date().toISOString()),
      ),
      TransactionStaleError,
    );
  } finally {
    await cleanupExpenseFixture(targetExpenseId, [actionId, seedActionId]);
  }
});

// ---------------------------------------------------------------------------
// 3. settle → confirm success
// ---------------------------------------------------------------------------
test("pg executor: settle confirm success (real DB)", { skip: !ENABLED }, async () => {
  const refs = await loadFixtureRefs();
  const settlementId = randomUUID();
  const actionId = await seedPendingAction(refs, "settle", {
    group_id: refs.groupId,
    from_user_id: refs.partnerId,
    to_user_id: refs.ownerId,
    amount_twd: 100,
    expected_balance_twd: 100,
  });

  const plan: PendingActionPlan = {
    insert_settlements: [{
      id: settlementId,
      couple_id: refs.coupleId,
      group_id: refs.groupId,
      from_user_id: refs.partnerId,
      to_user_id: refs.ownerId,
      amount_twd: 100,
      source_action_id: actionId,
    }],
    insert_activities: [{
      couple_id: refs.coupleId,
      group_id: refs.groupId,
      actor_user_id: refs.ownerId,
      entity_type: "settlement",
      entity_id: settlementId,
      action: "create",
      before_state: null,
      after_state: null,
    }],
  };

  try {
    const result = await withTx(async (client) =>
      applyPendingActionPlanTx(client, actionId, refs.ownerId, plan, new Date().toISOString()),
    );
    assert.equal(result.result, "confirmed");
    assert.equal(result.created_count, 0);
  } finally {
    await deleteByColumn("settlements", "id", settlementId);
    await deleteByColumn("activity_events", "entity_id", settlementId);
    await deleteByColumn("pending_actions", "id", actionId);
  }
});
