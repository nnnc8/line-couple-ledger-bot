/**
 * pending-action.pg.test.ts
 *
 * Guarded live test for applyPendingActionPlanTx.
 *
 * Runs ONLY when DATABASE_URL + SUPABASE_URL + SUPABASE_SECRET_KEY are
 * present; otherwise every test skips. Each test creates its own fixture
 * (pending_action + expenses / splits / settlements) and cleans up its own
 * rows. We do NOT call getOrCreateSmokeTenant — these tests use the
 * existing smoke couple's owner + group looked up directly by id.
 *
 * Coverage: the three minimal real paths required for live activation:
 *   1. create_expense → confirm success
 *   2. update_expense → stale (version mismatch)
 *   3. settle → confirm success
 */

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { withTx } from "./db/tx";
import { applyPendingActionPlanTx } from "./pending-action-executor";
import type { PendingActionPlan } from "./pending-action-types";
import { getSmokeEnv } from "./smoke/smoke-tenant";

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

async function loadFixtureRefs(): Promise<FixtureRefs> {
  if (!ENABLED) {
    throw new Error("loadFixtureRefs called without required env");
  }
  const { SMOKE_LINE_USER_ID, SMOKE_PARTNER_LINE_USER_ID, SMOKE_GROUP_NAME } = getSmokeEnv();
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const ownerRes = await db
    .from("users")
    .select("id, couple_id, line_user_id")
    .eq("line_user_id", SMOKE_LINE_USER_ID)
    .maybeSingle();
  if (ownerRes.error || !ownerRes.data) {
    throw new Error(`smoke owner not found in DB: ${ownerRes.error?.message ?? "no row"}`);
  }

  const partnerRes = await db
    .from("users")
    .select("id, couple_id, line_user_id")
    .eq("line_user_id", SMOKE_PARTNER_LINE_USER_ID)
    .maybeSingle();
  if (partnerRes.error || !partnerRes.data) {
    throw new Error(`smoke partner not found in DB: ${partnerRes.error?.message ?? "no row"}`);
  }

  const groupRes = await db
    .from("groups")
    .select("id, couple_id")
    .eq("name", SMOKE_GROUP_NAME)
    .eq("couple_id", ownerRes.data.couple_id)
    .is("archived_at", null)
    .maybeSingle();
  if (groupRes.error || !groupRes.data) {
    throw new Error(`smoke group not found: ${groupRes.error?.message ?? "no row"}`);
  }

  return {
    ownerId: ownerRes.data.id,
    partnerId: partnerRes.data.id,
    groupId: groupRes.data.id,
    coupleId: ownerRes.data.couple_id,
    ownerLineId: ownerRes.data.line_user_id,
    partnerLineId: partnerRes.data.line_user_id,
  };
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
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const insert = await db.from("pending_actions").insert(row).select("id").single();
  if (insert.error || !insert.data) {
    throw new Error(`failed to seed pending_action: ${insert.error?.message ?? "no data"}`);
  }
  return actionId;
}

async function deleteByColumn(table: string, column: string, value: string) {
  if (!ENABLED) return;
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const res = await db.from(table).delete().eq(column, value);
  if (res.error) {
    console.warn(`[pg test cleanup] ${table} delete error: ${res.error.message}`);
  }
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
    await deleteByColumn("expense_splits", "expense_id", expenseId);
    await deleteByColumn("expenses", "id", expenseId);
    await deleteByColumn("activity_events", "entity_id", expenseId);
    await deleteByColumn("pending_actions", "id", actionId);
  }
});

// ---------------------------------------------------------------------------
// 2. update_expense → stale (version mismatch)
// ---------------------------------------------------------------------------
test("pg executor: update_expense version mismatch → stale (real DB)", { skip: !ENABLED }, async () => {
  const refs = await loadFixtureRefs();
  const targetExpenseId = randomUUID();
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
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
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
    await deleteByColumn("expenses", "id", targetExpenseId);
    await deleteByColumn("pending_actions", "id", actionId);
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
