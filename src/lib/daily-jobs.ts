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
  receiptService,
  recurringService,
} from "./services";
import {
  flushQueuedNotifications,
  scanProactiveInsights,
} from "./notification-service";

export async function runDailyJobs(request: Request) {
  const env = serverEnvironment();
  if (request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`)
    throw new HttpError(401, "Unauthorized");
  const db = serverDatabase(env);
  const today = taipeiToday();
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
  const purgedReceipts = await receiptService.purgeDeleted(db);
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
  return { drafts, purgedReceipts, accountantReports, insightNotifications };
}
