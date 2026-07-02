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

export async function runCoreDailyJobs(options: {
  env: any;
  db: any;
  today: string;
}) {
  const { env, db, today } = options;
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
  return { drafts, purgedReceipts, accountantReports, insightNotifications };
}

export async function runDailyJobs(request: Request) {
  const env = serverEnvironment();
  if (request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`)
    throw new HttpError(401, "Unauthorized");
  const db = serverDatabase(env);
  const today = taipeiToday();
  return await runCoreDailyJobs({ env, db, today });
}
