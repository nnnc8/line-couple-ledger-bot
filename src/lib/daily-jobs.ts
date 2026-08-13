import type { SupabaseClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import { LineBotClient } from "@line/bot-sdk";
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
import { runDueV2RecurringRules } from "./v2-ledger-service";
import { cleanupV2AbandonedAttachments } from "./v2-attachment-service";
import { dispatchV2NotificationOutbox } from "./v2-outbox-dispatch";
import { dispatchV2LineInbox } from "./v2-line-inbox-dispatch";

type ServerEnvironment = ReturnType<typeof serverEnvironment>;

export async function runCoreDailyJobs(options: {
  env: ServerEnvironment;
  db: SupabaseClient;
  today: string;
}) {
  const { env, db, today } = options;
  const expiredPendingActions = await expirePendingActions(db);
  const lineMenuAmountDrafts = await cleanupLineMenuAmountDrafts(db);
  const v2Recurring = env.V2_LEDGER_ENABLED === "1"
    ? await runDueV2RecurringRules(today)
    : 0;
  const v2Notifications = env.V2_LEDGER_ENABLED === "1"
    ? await dispatchV2NotificationOutbox({ db, lineChannelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN }, 50)
    : 0;
  const v2Inbox = env.V2_LINE_INBOX_ENABLED === "1"
    ? await dispatchV2LineInbox({
        lineClient: LineBotClient.fromChannelAccessToken({ channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN }),
        supabase: db,
        gemini: new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }),
        setupCode: env.COUPLE_SETUP_CODE,
      }, 50)
    : 0;
  let drafts = 0;
  if (env.V2_LEDGER_ENABLED !== "1") {
    drafts = await recurringService.runDue({
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
  }
  const purgedReceipts = await purgeDeletedReceipts(db);
  const v2AbandonedAttachments = env.V2_LEDGER_ENABLED === "1"
    ? await cleanupV2AbandonedAttachments(db)
    : 0;
  let accountantReports = 0;
  if (env.V2_LEDGER_ENABLED !== "1" && today.endsWith("-01")) {
    accountantReports = await accountantService.generateMonthlyReports(
      env,
      db,
      shiftMonth(today.slice(0, 7), -1),
    );
  }
  const insightNotifications = env.V2_LEDGER_ENABLED === "1"
    ? 0
    : await scanProactiveInsights(db, today);
  if (env.V2_LEDGER_ENABLED !== "1") {
    await flushQueuedNotifications({ env, db });
  }
  return {
    drafts,
    purgedReceipts,
    accountantReports,
    insightNotifications,
    expiredPendingActions,
    lineMenuAmountDrafts,
    v2Recurring,
    v2Notifications,
    v2Inbox,
    v2AbandonedAttachments,
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
