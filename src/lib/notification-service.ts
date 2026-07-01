import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export interface NotificationDeliveryContext {
  env: {
    LINE_CHANNEL_ACCESS_TOKEN: string;
  };
  db: SupabaseClient;
}

export interface NotificationQueueContext {
  db: SupabaseClient;
  user: {
    id: string;
    couple_id: number;
  };
}

export async function queuePartnerNotifications(
  context: NotificationQueueContext,
  input: {
    kind: "recurring";
    title: string;
    body: string;
    groupId: string | null;
    entityType: string;
    entityId: string;
  },
) {
  const users = await context.db
    .from("users")
    .select("id")
    .eq("couple_id", context.user.couple_id)
    .neq("id", context.user.id);
  if (users.error) throw new Error("partner lookup failed");
  for (const user of users.data ?? []) {
    await context.db.from("notifications").insert({
      recipient_user_id: user.id,
      group_id: input.groupId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      entity_type: input.entityType,
      entity_id: input.entityId,
      dedupe_key: `${input.kind}:${input.entityId}:${randomUUID()}:user:${user.id}`,
    });
  }
}

export async function deliverNotifications(context: NotificationDeliveryContext) {
  const pending = await context.db
    .from("notifications")
    .select(
      "id, group_id, kind, recipient_user_id, title, body, entity_type, entity_id, users!notifications_recipient_user_id_fkey(line_user_id)",
    )
    .eq("line_status", "pending")
    .order("created_at")
    .limit(20);
  if (pending.error || !pending.data?.length) return;
  for (const notification of pending.data) {
    const claim = await context.db
      .from("notifications")
      .update({ line_status: "sending" })
      .eq("id", notification.id)
      .eq("line_status", "pending")
      .select("id");
    if (claim.error || !claim.data?.length) continue;
    const userRelation = notification.users as unknown;
    const lineUserId = z
      .union([
        z.object({ line_user_id: z.string() }),
        z
          .array(z.object({ line_user_id: z.string() }))
          .transform((rows) => rows[0]),
      ])
      .parse(userRelation)?.line_user_id;
    let status = lineUserId ? "failed" : "skipped";
    if (lineUserId) {
      const text = await lineNotificationText(context.db, notification);
      try {
        const response = await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: {
            authorization: `Bearer ${context.env.LINE_CHANNEL_ACCESS_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            to: lineUserId,
            messages: [
              {
                type: "text",
                text,
              },
            ],
          }),
        });
        status = response.ok ? "sent" : "failed";
      } catch {
        status = "failed";
      }
    }
    await context.db
      .from("notifications")
      .update({ line_status: status })
      .eq("id", notification.id);
  }
}

export async function flushQueuedNotifications(context: NotificationDeliveryContext) {
  return deliverNotifications(context);
}

export async function scanProactiveInsights(
  _db: SupabaseClient,
  _today: string,
) {
  // ponytail: proactive insight reminders are disabled; restore a real scan here only if the product wants them back.
  return 0;
}

async function lineNotificationText(
  db: SupabaseClient,
  notification: {
    title: string;
    body: string;
    kind?: string | null;
    group_id?: string | null;
    entity_type?: string | null;
    entity_id?: string | null;
  },
) {
  if (
    notification.kind === "expense" &&
    notification.entity_type === "expense" &&
    z.string().uuid().safeParse(notification.entity_id).success
  ) {
    const [expenseResult, groupResult] = await Promise.all([
      db
        .from("expenses")
        .select("description, amount_twd, expense_date, tag")
        .eq("id", notification.entity_id)
        .single(),
      notification.group_id
        ? db.from("groups").select("name").eq("id", notification.group_id).single()
        : Promise.resolve({ data: null, error: null }),
    ]);
    const expense = z
      .object({
        description: z.string(),
        amount_twd: z.coerce.number().int(),
        expense_date: z.string(),
        tag: z.string(),
      })
      .safeParse(expenseResult.data);
    const group = z
      .object({ name: z.string() })
      .nullable()
      .safeParse(groupResult.data);
    if (!expenseResult.error && expense.success) {
      const groupName = group.success && group.data ? ` ${group.data.name}` : "";
      return `${notification.body}${groupName}\n${expense.data.description} ${notificationMoney(expense.data.amount_twd)}｜${expense.data.expense_date}｜${expense.data.tag}`;
    }
  }
  return notification.title ? `${notification.title}\n${notification.body}` : notification.body;
}

function notificationMoney(amount: number) {
  return `NT$${amount.toLocaleString("en-US")}`;
}
