import type { webhook } from "@line/bot-sdk";

import { handleLineEvent, type BotDependencies } from "./line-webhook-service";
import { areV2FinancialWritesEnabled } from "./v2-incident-freeze";
import { classifyLineDeliveryError } from "./line-delivery-error";
import { lineClarification, lineSuccess, lineProcessingFailure, malformedInboxEvent, type LineBusinessOutcome } from "./line-business-outcome";
import {
  claimV2LineInbox,
  finishV2LineInbox,
  hasV2LineAccountingCompletion,
  releaseV2LineInboxForMaintenance,
  resetStaleV2LineInboxLeases,
} from "./v2-inbox-worker";

export async function dispatchV2LineInbox(dependencies: BotDependencies, limit = 20): Promise<number> {
  if (process.env.V2_LEDGER_ENABLED !== "1") return 0;
  if (!(await areV2FinancialWritesEnabled())) return 0;
  await resetStaleV2LineInboxLeases();
  const rows = await claimV2LineInbox(limit);
  let processed = 0;
  for (const row of rows) {
    // Replies are delivery intents until the business outcome is durable.
    // A failed/expired reply token must never schedule the accounting again.
    const deliveries: Array<() => Promise<unknown>> = [];
    const deferred: BotDependencies = { ...dependencies, lineClient: {
      getMessageContent: (...args) => dependencies.lineClient.getMessageContent(...args),
      replyMessage: async (...args) => { deliveries.push(() => dependencies.lineClient.replyMessage(...args)); return { sentMessages: [] }; },
      pushMessage: async (...args) => { deliveries.push(() => dependencies.lineClient.pushMessage(...args)); return { sentMessages: [] }; },
    } };
    let outcome: LineBusinessOutcome;
    try {
      outcome = malformedInboxEvent(row.payload)
        ? { kind: "PERMANENT_BUSINESS_FAILURE", error: "malformed LINE event" }
        : await hasV2LineAccountingCompletion(row) ? lineSuccess
          : await handleLineEvent(row.payload as unknown as webhook.Event, deferred) ?? lineClarification;
    } catch (error) {
      outcome = lineProcessingFailure(error);
    }
    if (outcome.kind === "MAINTENANCE") {
      await releaseV2LineInboxForMaintenance(row);
      continue;
    }
    const status = outcome.kind === "SUCCESS" ? "processed"
      : outcome.kind === "USER_REJECTED_OR_CLARIFICATION" ? "ignored"
        : outcome.kind === "PERMANENT_BUSINESS_FAILURE" ? "dead_letter" : "failed";
    const accepted = await finishV2LineInbox(row, status, "error" in outcome ? outcome.error : undefined);
    if (!accepted) continue; // Another lease owns the row; never overwrite its outcome.
    if (outcome.kind === "SUCCESS") processed += 1;
    if (status === "failed" || status === "dead_letter") {
      console.info("v2_line_inbox_business_failure", { inboxId: row.id, kind: outcome.kind });
      continue;
    }
    for (const deliver of deliveries) {
      try { await deliver(); }
      catch (error) {
        console.info("v2_line_inbox_reply_failure", { inboxId: row.id, ...classifyLineDeliveryError(error) });
      }
    }
  }
  return processed;
}
