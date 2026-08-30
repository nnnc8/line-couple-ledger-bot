import { claimV2NotificationOutbox, finishV2NotificationOutbox, resetStaleV2NotificationOutboxLeases } from "./v2-outbox-worker";
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyLineDeliveryError } from "./line-delivery-error";

export async function dispatchV2NotificationOutbox(input: {
  db: SupabaseClient;
  lineChannelAccessToken: string;
}, limit = 20): Promise<number> {
  console.info("v2_notification_outbox_drain_start", { limit });
  const recoveredLeases = await resetStaleV2NotificationOutboxLeases();
  const rows = await claimV2NotificationOutbox(limit);
  console.info("v2_notification_outbox_drain_selected", { limit, recoveredLeases, selected: rows.length });
  let sent = 0;
  for (const row of rows) {
    try {
      const user = await input.db
        .from("users")
        .select("line_user_id")
        .eq("id", row.recipient_user_id)
        .single();
      if (user.error || !user.data?.line_user_id) {
        await finishV2NotificationOutbox(row.id, "skipped", "recipient has no LINE identity");
        console.info("v2_notification_outbox_skipped", { outboxId: row.id, dedupeKey: row.dedupe_key });
        continue;
      }
      const payload = row.payload as { title?: unknown; message?: unknown };
      const text = [payload.title, payload.message]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join("\n")
        .slice(0, 5_000);
      const response = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.lineChannelAccessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ to: user.data.line_user_id, messages: [{ type: "text", text: text || "Couple Ledger 有新更新" }] }),
      });
      if (!response.ok) throw new Error(`LINE push failed (${response.status})`);
      await finishV2NotificationOutbox(row.id, "sent");
      sent += 1;
      console.info("v2_notification_outbox_sent", { outboxId: row.id, dedupeKey: row.dedupe_key, attempt: row.attempt_count });
    } catch (error) {
      const failure = classifyLineDeliveryError(error);
      await finishV2NotificationOutbox(
        row.id,
        failure.disposition === "permanent" ? "dead_letter" : "failed",
        failure.operationError,
      );
      console.info("v2_notification_outbox_delivery_failure", {
        outboxId: row.id,
        dedupeKey: row.dedupe_key,
        attempt: row.attempt_count,
        disposition: failure.disposition,
        error: failure.operationError,
      });
    }
  }
  console.info("v2_notification_outbox_drain_finish", { limit, selected: rows.length, sent });
  return sent;
}
