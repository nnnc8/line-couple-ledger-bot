import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppUser } from "../server-runtime";
import { pendingActionService } from "../services";
import { taipeiToday } from "../ledger-shared";

export async function runPendingActionSmoke(context: {
  databaseUrl: string;
  db: SupabaseClient;
  owner: AppUser;
  partner: AppUser;
  group: { id: string; name: string };
}) {
  const { db, owner, partner, group, databaseUrl } = context;
  const dateStr = taipeiToday();
  const runTag = `${dateStr}:${Date.now()}`;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the pending action smoke run");
  }

  const createdExpenseIds: string[] = [];
  const createdSettlementIds: string[] = [];
  const createdPendingActionIds: string[] = [];

  const findPendingActionId = async (idempotencyKey: string): Promise<string> => {
    const res = await db
      .from("pending_actions")
      .select("id")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (res.error || !res.data) {
      throw new Error(
        `Failed to find pending action for idempotencyKey: ${idempotencyKey}. Error: ${res.error?.message}`
      );
    }
    return res.data.id;
  };

  const cleanup = async () => {
    const errors: string[] = [];
    let mirrorExpenseIds: string[] = [];

    if (createdExpenseIds.length > 0) {
      const mirrorRes = await db
        .from("expenses")
        .select("id")
        .in("mirror_source_expense_id", createdExpenseIds)
        .eq("mirror_kind", "shared_share");
      if (mirrorRes.error) {
        errors.push(
          `Mirror expense lookup cleanup error: ${mirrorRes.error.message} (Source IDs: ${createdExpenseIds.join(", ")})`
        );
      } else {
        mirrorExpenseIds = [...new Set((mirrorRes.data ?? []).map((row) => row.id))];
      }
    }

    const cleanupExpenseIds = [...new Set([...mirrorExpenseIds, ...createdExpenseIds])];
    const cleanupEntityIds = [
      ...new Set([...cleanupExpenseIds, ...createdPendingActionIds, ...createdSettlementIds]),
    ];

    if (createdPendingActionIds.length > 0) {
      const { error } = await db
        .from("assistant_tasks")
        .delete()
        .in("related_pending_action_id", createdPendingActionIds);
      if (error) {
        errors.push(
          `Assistant task pending-action cleanup error: ${error.message} (IDs: ${createdPendingActionIds.join(", ")})`
        );
      }
    }

    if (cleanupExpenseIds.length > 0) {
      const { error } = await db
        .from("assistant_tasks")
        .delete()
        .in("related_expense_id", cleanupExpenseIds);
      if (error) {
        errors.push(
          `Assistant task expense cleanup error: ${error.message} (IDs: ${cleanupExpenseIds.join(", ")})`
        );
      }
    }

    if (cleanupEntityIds.length > 0) {
      const { error } = await db
        .from("activity_events")
        .delete()
        .in("entity_id", cleanupEntityIds);
      if (error) {
        errors.push(
          `Activity cleanup error: ${error.message} (Entity IDs: ${cleanupEntityIds.join(", ")})`
        );
      }
    }

    if (cleanupEntityIds.length > 0) {
      const { error } = await db
        .from("notifications")
        .delete()
        .in("entity_id", cleanupEntityIds);
      if (error) {
        errors.push(
          `Notifications cleanup error: ${error.message} (Entity IDs: ${cleanupEntityIds.join(", ")})`
        );
      }
    }

    if (createdSettlementIds.length > 0) {
      const { error } = await db.from("settlements").delete().in("id", createdSettlementIds);
      if (error) {
        errors.push(
          `Settlements cleanup error: ${error.message} (IDs: ${createdSettlementIds.join(", ")})`
        );
      }
    }

    if (mirrorExpenseIds.length > 0) {
      const { error } = await db.from("expenses").delete().in("id", mirrorExpenseIds);
      if (error) {
        errors.push(
          `Mirror expenses cleanup error: ${error.message} (IDs: ${mirrorExpenseIds.join(", ")})`
        );
      }
    }

    if (createdExpenseIds.length > 0) {
      const { error } = await db.from("expenses").delete().in("id", createdExpenseIds);
      if (error) {
        errors.push(`Expenses cleanup error: ${error.message} (IDs: ${createdExpenseIds.join(", ")})`);
      }
    }

    if (createdPendingActionIds.length > 0) {
      const { error } = await db.from("pending_actions").delete().in("id", createdPendingActionIds);
      if (error) {
        errors.push(
          `Pending actions cleanup error: ${error.message} (IDs: ${createdPendingActionIds.join(", ")})`
        );
      }
    }

    if (errors.length > 0) {
      throw new Error(`Smoke cleanup failed:\n${errors.join("\n")}`);
    }
  };

  let success = false;
  try {
    const ownerContext = { db, user: owner };
    const partnerContext = { db, user: partner };

    // Case 1: Private Expense ("共享機車 185")
    console.log("Running Case 1: Private Expense...");
    const privateKey = `smoke:private:${runTag}`;
    const case1Res = await pendingActionService.proposeAction(
      ownerContext,
      {
        type: "create_expense",
        expense: {
          ledger: "private",
          groupId: null,
          description: "共享機車 185",
          tag: "交通",
          amountTwd: 185,
          paidBy: "self",
          expenseDate: dateStr,
          splitMethod: "equal",
        },
      },
      { source: "smoke", idempotencyKey: privateKey }
    );

    if (case1Res.result !== "confirmed") {
      throw new Error(`Case 1 proposal failed, result status: ${case1Res.result}`);
    }

    const actionId1 = await findPendingActionId(privateKey);
    createdPendingActionIds.push(actionId1);

    const expenseRes1 = await db
      .from("expenses")
      .select("id, group_id, ledger, paid_by_user_id, description, amount_twd")
      .eq("source_action_id", actionId1)
      .single();

    if (expenseRes1.error) {
      throw new Error(`Failed to find expense for Case 1: ${expenseRes1.error.message}`);
    }

    createdExpenseIds.push(expenseRes1.data.id);

    if (
      expenseRes1.data.group_id !== null ||
      expenseRes1.data.ledger !== "private" ||
      expenseRes1.data.paid_by_user_id !== owner.id ||
      expenseRes1.data.amount_twd !== 185
    ) {
      throw new Error(
        `Case 1 expense assertion failed: ${JSON.stringify(expenseRes1.data)}`
      );
    }
    console.log("Case 1 passed successfully.");

    // Case 2: Shared Expense ("共同晚餐 500" paid by owner)
    console.log("Running Case 2: Shared Expense...");
    const sharedKey = `smoke:shared:${runTag}`;
    const case2Res = await pendingActionService.proposeAction(
      ownerContext,
      {
        type: "create_expense",
        expense: {
          ledger: "shared",
          groupId: group.id,
          description: "共同晚餐 500",
          tag: "餐飲",
          amountTwd: 500,
          paidBy: "self",
          expenseDate: dateStr,
          splitMethod: "equal",
        },
      },
      { source: "smoke", idempotencyKey: sharedKey }
    );

    if (case2Res.result !== "confirmed") {
      throw new Error(`Case 2 proposal failed, result status: ${case2Res.result}`);
    }

    const actionId2 = await findPendingActionId(sharedKey);
    createdPendingActionIds.push(actionId2);

    const expenseRes2 = await db
      .from("expenses")
      .select("id, group_id, ledger, paid_by_user_id, amount_twd")
      .eq("source_action_id", actionId2)
      .single();

    if (expenseRes2.error) {
      throw new Error(`Failed to find expense for Case 2: ${expenseRes2.error.message}`);
    }

    createdExpenseIds.push(expenseRes2.data.id);

    if (
      expenseRes2.data.group_id !== group.id ||
      expenseRes2.data.ledger !== "shared" ||
      expenseRes2.data.paid_by_user_id !== owner.id ||
      expenseRes2.data.amount_twd !== 500
    ) {
      throw new Error(
        `Case 2 expense assertion failed: ${JSON.stringify(expenseRes2.data)}`
      );
    }

    // Verify splits
    const splitsRes2 = await db
      .from("expense_splits")
      .select("user_id, amount_twd")
      .eq("expense_id", expenseRes2.data.id);

    if (splitsRes2.error || splitsRes2.data.length !== 2) {
      throw new Error(
        `Case 2 splits query failed or counts mismatch: ${JSON.stringify(
          splitsRes2.data
        )}`
      );
    }

    const ownerSplit = splitsRes2.data.find((s) => s.user_id === owner.id);
    const partnerSplit = splitsRes2.data.find((s) => s.user_id === partner.id);
    if (!ownerSplit || !partnerSplit || ownerSplit.amount_twd !== 250 || partnerSplit.amount_twd !== 250) {
      throw new Error(`Case 2 splits split validation failed: ${JSON.stringify(splitsRes2.data)}`);
    }
    console.log("Case 2 passed successfully.");

    // Case 3: Settlement (partner owes owner 250, so partner settles 250)
    console.log("Running Case 3: Settlement...");
    const settleKey = `smoke:settle:${runTag}`;
    const case3Res = await pendingActionService.proposeAction(
      partnerContext,
      {
        type: "settle",
        groupId: group.id,
        amountTwd: 250,
      },
      { source: "smoke", idempotencyKey: settleKey }
    );

    if (case3Res.result !== "confirmed") {
      throw new Error(`Case 3 proposal failed, result status: ${case3Res.result}`);
    }

    const actionId3 = await findPendingActionId(settleKey);
    createdPendingActionIds.push(actionId3);

    const settlementRes3 = await db
      .from("settlements")
      .select("id, couple_id, group_id, from_user_id, to_user_id, amount_twd")
      .eq("source_action_id", actionId3)
      .single();

    if (settlementRes3.error) {
      throw new Error(`Failed to find settlement for Case 3: ${settlementRes3.error.message}`);
    }

    createdSettlementIds.push(settlementRes3.data.id);

    if (
      settlementRes3.data.group_id !== group.id ||
      settlementRes3.data.from_user_id !== partner.id ||
      settlementRes3.data.to_user_id !== owner.id ||
      settlementRes3.data.amount_twd !== 250
    ) {
      throw new Error(
        `Case 3 settlement assertion failed: ${JSON.stringify(settlementRes3.data)}`
      );
    }
    console.log("Case 3 passed successfully.");

    success = true;
  } finally {
    const mode = process.env.SMOKE_CLEANUP_MODE || "always";
    if (mode === "always" || (mode === "on-success" && success)) {
      console.log("Cleaning up smoke records...");
      await cleanup();
      console.log("Cleanup finished.");
    } else {
      console.warn("Skipping cleanup of smoke records per configuration.");
      console.warn(`Residual IDs:\nExpenses: ${createdExpenseIds.join(", ")}\nSettlements: ${createdSettlementIds.join(", ")}\nPending Actions: ${createdPendingActionIds.join(", ")}`);
    }
  }
}
