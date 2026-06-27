/**
 * Secretary Push Notifications.
 *
 * When a secretary action involves both partners (settlement, rule changes,
 * expense modifications), push a summary to the other partner so they stay
 * informed without opening the LIFF.
 */

import type { LineBotClient } from "@line/bot-sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/* ─── Types ─── */

export interface PartnerNotification {
  /** The user to notify (the partner, not the one who triggered the action) */
  targetUserId: string;
  /** Short message content */
  message: string;
  /** Action context for quick-reply (optional) */
  actionType?: "settlement" | "expense" | "rule" | "task_update";
  actionId?: string;
}

/* ─── Push ─── */

/**
 * Push a notification to a partner via LINE push message.
 * Falls back silently if LINE push fails (no retry — notifications are best-effort).
 */
export async function notifyPartner(
  lineClient: Pick<LineBotClient, "pushMessage">,
  supabase: SupabaseClient,
  notification: PartnerNotification,
): Promise<void> {
  // Look up the partner's LINE user ID
  const { data: userRow } = await supabase
    .from("users")
    .select("id, line_user_id")
    .eq("id", z.string().uuid().parse(notification.targetUserId))
    .single();

  if (!userRow?.line_user_id) return;

  try {
    await lineClient.pushMessage({
      to: userRow.line_user_id,
      messages: [
        {
          type: "text",
          text: `📋 ${notification.message}`,
        },
      ],
    });
  } catch (error) {
    console.error("Partner push notification failed", {
      targetUserId: notification.targetUserId,
      error: error instanceof Error ? error.message : "unknown",
    });
    // Best-effort — don't throw
  }
}

/**
 * Build a partner notification from a secretary result.
 */
export async function pushSecretaryUpdate(
  lineClient: Pick<LineBotClient, "pushMessage">,
  supabase: SupabaseClient,
  options: {
    partnerUserId: string;
    summary: string;
    triggeredBy: string;
  },
): Promise<void> {
  await notifyPartner(lineClient, supabase, {
    targetUserId: options.partnerUserId,
    message: `對方 ${options.triggeredBy}\n${options.summary}`,
  });
}

/**
 * Push when a new task is created that needs both partners' attention.
 */
export async function pushTaskUpdate(
  lineClient: Pick<LineBotClient, "pushMessage">,
  supabase: SupabaseClient,
  options: {
    partnerUserId: string;
    taskTitle: string;
  },
): Promise<void> {
  await notifyPartner(lineClient, supabase, {
    targetUserId: options.partnerUserId,
    message: `秘書幫你們新增了一個待辦：${options.taskTitle}`,
    actionType: "task_update",
  });
}
