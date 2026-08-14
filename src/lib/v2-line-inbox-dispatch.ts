import type { webhook } from "@line/bot-sdk";

import { handleLineEvent, type BotDependencies } from "./line-webhook-service";
import { isV2IncidentFreezeError, areV2FinancialWritesEnabled } from "./v2-incident-freeze";
import {
  claimV2LineInbox,
  finishV2LineInbox,
  releaseV2LineInboxForMaintenance,
  resetStaleV2LineInboxLeases,
} from "./v2-inbox-worker";

export async function dispatchV2LineInbox(dependencies: BotDependencies, limit = 20): Promise<number> {
  // Do not claim work while the persistent incident gate is closed. The row
  // remains received and is therefore durable without burning an attempt.
  if (!(await areV2FinancialWritesEnabled())) return 0;
  await resetStaleV2LineInboxLeases();
  const rows = await claimV2LineInbox(limit);
  let processed = 0;
  for (const row of rows) {
    try {
      await handleLineEvent(row.payload as unknown as webhook.Event, dependencies);
      await finishV2LineInbox(row.id, "processed");
      processed += 1;
    } catch (error) {
      if (isV2IncidentFreezeError(error)) {
        await releaseV2LineInboxForMaintenance(row.id);
        continue;
      }
      await finishV2LineInbox(row.id, "failed", error instanceof Error ? error.message : "unknown error");
    }
  }
  return processed;
}
