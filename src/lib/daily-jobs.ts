import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./http-error";
import {
  serverDatabase,
  serverEnvironment,
} from "./server-runtime";
import {
  taipeiToday,
  shiftMonth,
} from "./ledger-shared";
import {
  accountantService,
  pendingActionService,
  recurringService,
} from "./services";
import { purgeDeletedReceipts } from "./receipt-service";
import {
  flushQueuedNotifications,
  scanProactiveInsights,
} from "./notification-service";
import { cleanupLineMenuAmountDrafts } from "./line-menu-amount-draft";

type ServerEnvironment = ReturnType<typeof serverEnvironment>;

export async function runCoreDailyJobs(options: {
  env: ServerEnvironment;
  db: SupabaseClient;
  today: string;
}) {
  const { env, db, today } = options;
  const expiredPendingActions = await expirePendingActions(db);
  const lineMenuAmountDrafts = await cleanupLineMenuAmountDrafts(db);
  const drafts = await recurringService.runDue({
    env,
    db,
    today,
    executePendingAction: (context, input) => pendingActionService.execute(context, input),
    logError: (recurringId, error) => {
      console.error("recurring auto-post failed", {
        recurringId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const purgedReceipts = await purgeDeletedReceipts(db);
  let accountantReports = 0;
  if (today.endsWith("-01")) {
    accountantReports = await accountantService.generateMonthlyReports(
      env,
      db,
      shiftMonth(today.slice(0, 7), -1),
    );
  }
  const insightNotifications = await scanProactiveInsights(db, today);
  await flushQueuedNotifications({ env, db });
  return {
    drafts,
    purgedReceipts,
    accountantReports,
    insightNotifications,
    expiredPendingActions,
    lineMenuAmountDrafts,
  };
}

export async function expirePendingActions(db: SupabaseClient, now = new Date()): Promise<number> {
  const { data, error } = await db
    .from("pending_actions")
    .update({ status: "expired", processed_at: now.toISOString() })
    .eq("status", "pending")
    .lte("expires_at", now.toISOString())
    .select("id");
  if (error) throw new Error("pending action cleanup failed");
  return Array.isArray(data) ? data.length : 0;
}

export async function runDailyJobs(request: Request) {
  const env = serverEnvironment();
  if (request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`)
    throw new HttpError(401, "Unauthorized");
  const db = serverDatabase(env);
  const today = taipeiToday();
  return await runCoreDailyJobs({ env, db, today });
}
