import type { webhook } from "@line/bot-sdk";

import { handleLineEvent, type BotDependencies } from "./line-webhook-service";
import { claimV2LineInbox, finishV2LineInbox, resetStaleV2LineInboxLeases } from "./v2-inbox-worker";

export async function dispatchV2LineInbox(dependencies: BotDependencies, limit = 20): Promise<number> {
  await resetStaleV2LineInboxLeases();
  const rows = await claimV2LineInbox(limit);
  let processed = 0;
  for (const row of rows) {
    try {
      await handleLineEvent(row.payload as unknown as webhook.Event, dependencies);
      await finishV2LineInbox(row.id, "processed");
      processed += 1;
    } catch (error) {
      await finishV2LineInbox(row.id, "failed", error instanceof Error ? error.message : "unknown error");
    }
  }
  return processed;
}
