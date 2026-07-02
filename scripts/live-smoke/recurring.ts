import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

import { getOrCreateSmokeTenant } from "../../src/lib/smoke/smoke-tenant";
import { recurringService } from "../../src/lib/services";
import { pendingActionService } from "../../src/lib/services";
import { taipeiToday } from "../../src/lib/ledger-shared";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function shiftDate(isoDate: string, offsetDays: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + offsetDays));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

async function main() {
  console.log("Starting Recurring Live Smoke Test...");

  requireEnv("DATABASE_URL");
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseSecretKey = requireEnv("SUPABASE_SECRET_KEY");

  const db = createClient(supabaseUrl, supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let tenant: Awaited<ReturnType<typeof getOrCreateSmokeTenant>> | null = null;
  let runError: unknown = null;
  let cleanupError: unknown = null;

  try {
    tenant = await getOrCreateSmokeTenant(db);

    const today = taipeiToday();
    const yesterday = shiftDate(today, -1);
    const description = `煙霧測試定期費:${Date.now()}`;

    console.log(`Seeding recurring expense (nextRunDate=${yesterday}, today=${today})...`);
    const saveRes = await db
      .from("recurring_expenses")
      .insert({
        couple_id: 1,
        group_id: tenant.group.id,
        created_by_user_id: tenant.owner.id,
        paid_by_user_id: tenant.owner.id,
        ledger: "shared",
        description,
        tag: "娛樂",
        amount_twd: 100,
        split_method: "equal",
        splits: {
          [tenant.owner.id]: 50,
          [tenant.partner.id]: 50,
        },
        frequency: "monthly",
        anchor_day: Number(yesterday.slice(8, 10)),
        next_run_date: yesterday,
        end_date: null,
        active: true,
        updated_at: new Date().toISOString(),
      })
      .select("id, next_run_date, active")
      .single();

    if (saveRes.error || !saveRes.data) {
      throw new Error(
        `Failed to seed recurring expense: ${saveRes.error?.message ?? "no data"}`,
      );
    }

    const recurringId = saveRes.data.id;
    console.log(`Created Recurring Expense ID: ${recurringId}`);

    console.log("Running runDue...");
    await recurringService.runDue({
      env: { DATABASE_URL: process.env.DATABASE_URL! },
      db,
      today,
      executePendingAction: async (ctx, input) => {
        return pendingActionService.execute(ctx, input);
      },
      logError: (id, err) => {
        console.error(`Error in runDue for recurring ID ${id}:`, err);
      },
    });

    const expectedIdempotencyKey = `recurring:${recurringId}:${yesterday}`;
    const actionRes = await db
      .from("pending_actions")
      .select("id, status")
      .eq("idempotency_key", expectedIdempotencyKey)
      .maybeSingle();

    if (actionRes.error || !actionRes.data) {
      throw new Error(`Failed to find generated pending action for key: ${expectedIdempotencyKey}`);
    }

    const actionId = actionRes.data.id;
    console.log(`Generated Pending Action ID: ${actionId} (status=${actionRes.data.status})`);

    const expenseRes = await db
      .from("expenses")
      .select("id, description, amount_twd, ledger, group_id, source_action_id")
      .eq("source_action_id", actionId)
      .maybeSingle();

    if (expenseRes.error || !expenseRes.data) {
      throw new Error(`Failed to find generated expense for action: ${actionId}`);
    }

    console.log(`Generated Expense ID: ${expenseRes.data.id}`);
    if (
      expenseRes.data.description !== description ||
      expenseRes.data.amount_twd !== 100 ||
      expenseRes.data.ledger !== "shared" ||
      expenseRes.data.group_id !== tenant.group.id
    ) {
      throw new Error(`Generated expense attributes mismatch: ${JSON.stringify(expenseRes.data)}`);
    }

    console.log("Cleaning up recurring smoke records...");
    const cleanupErrors: string[] = [];

    const mirrorExpenseRes = await db
      .from("expenses")
      .select("id")
      .eq("mirror_source_expense_id", expenseRes.data.id)
      .eq("mirror_kind", "shared_share");
    if (mirrorExpenseRes.error) {
      cleanupErrors.push(`Mirror expenses lookup cleanup: ${mirrorExpenseRes.error.message}`);
    }

    const mirrorExpenseIds = [...new Set((mirrorExpenseRes.data ?? []).map((row) => row.id))];
    const cleanupEntityIds = [...new Set([recurringId, actionId, expenseRes.data.id, ...mirrorExpenseIds])];

    const delNotification = await db
      .from("notifications")
      .delete()
      .in("entity_id", cleanupEntityIds);
    if (delNotification.error) cleanupErrors.push(`Notifications cleanup: ${delNotification.error.message}`);

    const delActivity = await db
      .from("activity_events")
      .delete()
      .in("entity_id", cleanupEntityIds);
    if (delActivity.error) cleanupErrors.push(`Activity cleanup: ${delActivity.error.message}`);

    if (mirrorExpenseIds.length > 0) {
      const delMirrorExpense = await db
        .from("expenses")
        .delete()
        .in("id", mirrorExpenseIds);
      if (delMirrorExpense.error) {
        cleanupErrors.push(`Mirror expenses cleanup: ${delMirrorExpense.error.message}`);
      }
    }

    const delExpense = await db
      .from("expenses")
      .delete()
      .eq("id", expenseRes.data.id);
    if (delExpense.error) cleanupErrors.push(`Expenses cleanup: ${delExpense.error.message}`);

    const delAction = await db
      .from("pending_actions")
      .delete()
      .eq("id", actionId);
    if (delAction.error) cleanupErrors.push(`Pending actions cleanup: ${delAction.error.message}`);

    const delRecurring = await db
      .from("recurring_expenses")
      .delete()
      .eq("id", recurringId);
    if (delRecurring.error) cleanupErrors.push(`Recurring expense cleanup: ${delRecurring.error.message}`);

    if (cleanupErrors.length > 0) {
      throw new Error(`Cleanup failed with errors:\n${cleanupErrors.join("\n")}`);
    }
  } catch (error) {
    runError = error;
  } finally {
    if (tenant) {
      try {
        await tenant.cleanup();
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  if (runError && cleanupError) {
    throw new AggregateError(
      [runError, cleanupError],
      "Recurring smoke run and tenant cleanup both failed",
    );
  }
  if (runError) {
    throw runError;
  }
  if (cleanupError) {
    throw cleanupError;
  }

  console.log("Recurring Live Smoke Test finished successfully!");
}

main().catch((err) => {
  console.error("Recurring smoke test failed with error:");
  console.error(err);
  process.exit(1);
});
