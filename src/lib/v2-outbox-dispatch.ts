import { claimV2NotificationOutbox, finishV2NotificationOutbox, resetStaleV2NotificationOutboxLeases } from "./v2-outbox-worker";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function dispatchV2NotificationOutbox(input: {
  db: SupabaseClient;
  lineChannelAccessToken: string;
}, limit = 20): Promise<number> {
  await resetStaleV2NotificationOutboxLeases();
  const rows = await claimV2NotificationOutbox(limit);
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
    } catch (error) {
      await finishV2NotificationOutbox(row.id, "failed", error instanceof Error ? error.message : "unknown");
    }
  }
  return sent;
}
