import type { LineBotClient } from "@line/bot-sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { LineReplyMessage } from "./flex-message-builder";

export const userRowSchema = z.object({
  id: z.string().uuid(),
  couple_id: z.number().int(),
  role: z.enum(["owner", "partner"]),
  line_user_id: z.string(),
});

export type LineUser = z.infer<typeof userRowSchema>;

export const actionResultSchema = z.object({
  result: z.enum([
    "confirmed",
    "cancelled",
    "expired",
    "stale",
    "not_found",
    "already_done",
  ]),
  action_type: z.string().nullable().optional(),
  created_count: z.number().int().optional(),
});

export type ActionResult = z.infer<typeof actionResultSchema>;

export function actionResultMessage(result: ActionResult): string {
  const messages: Record<ActionResult["result"], string> = {
    confirmed:
      result.action_type === "batch_create_expenses"
        ? `已記帳 ${result.created_count ?? "這批"} 筆。`
        : result.action_type === "create_expense"
          ? "已記帳。"
          : result.action_type === "batch_update_expenses"
            ? "分類整理已套用。"
            : result.action_type === "delete_expense"
              ? "已刪除。"
              : result.action_type === "transfer"
                ? "已記錄轉帳。"
                : result.action_type === "void_settlement"
                  ? "已撤銷轉帳。"
                  : "已結清。",
    cancelled: "已取消。",
    expired: "操作已過期，請重新操作。",
    stale: "帳目已變動，請重新操作。",
    not_found: "找不到這個操作。",
    already_done: "這個操作已處理。",
  };
  return messages[result.result];
}

export async function replyText(
  lineClient: Pick<LineBotClient, "replyMessage">,
  replyToken: string,
  text: string,
): Promise<void> {
  await lineClient.replyMessage({
    replyToken,
    messages: [{ type: "text", text }],
  });
}

export type ReplyPayload = string | LineReplyMessage | (string | LineReplyMessage)[];

function normalizeReplyPayload(payload: ReplyPayload): LineReplyMessage[] {
  const items = Array.isArray(payload) ? payload : [payload];
  return items.map((item) =>
    typeof item === "string" ? { type: "text", text: item } : item,
  );
}

export async function replyMessages(
  lineClient: Pick<LineBotClient, "replyMessage">,
  replyToken: string,
  payload: ReplyPayload,
): Promise<void> {
  const messages = normalizeReplyPayload(payload);
  await lineClient.replyMessage({ replyToken, messages: messages as never });
}

export async function findUser(
  supabase: SupabaseClient,
  lineUserId: string,
): Promise<LineUser | null> {
  const { data, error } = await supabase
    .from("users")
    .select("id, couple_id, role, line_user_id")
    .eq("line_user_id", lineUserId)
    .maybeSingle();
  if (error) throw new Error("user lookup failed");
  return userRowSchema.nullable().parse(data);
}
