import type { LineBotClient, webhook } from "@line/bot-sdk";
import type { GoogleGenAI } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  actionResultMessage,
  actionResultSchema,
  findUser,
  replyText,
  replyMessages,
} from "./line-bot-shared";
import {
  handleLineAudioTurn,
  handleLineImageTurn,
} from "./line-secretary-service";
import { handleLineTextMessage, joinCouple } from "./line-text-service";
import { serverEnvironment } from "./server-runtime";
import { pendingActionService } from "./services";

export interface BotDependencies {
  lineClient: Pick<LineBotClient, "replyMessage" | "getMessageContent" | "pushMessage">;
  supabase: SupabaseClient;
  gemini: GoogleGenAI;
  setupCode: string;
}

export async function handleLineEvent(
  event: webhook.Event,
  dependencies: BotDependencies,
): Promise<void> {
  const userId = event.source?.userId;
  const replyToken = "replyToken" in event ? event.replyToken : undefined;
  if (!userId || !replyToken) return;

  try {
    if (event.type === "postback") {
      const user = await findUser(dependencies.supabase, userId);
      if (!user) {
        await replyText(
          dependencies.lineClient,
          replyToken,
          "請先輸入：加入 <設定碼>",
        );
        return;
      }
      const decision = parsePendingActionPostback(event.postback.data);
      if (!decision) {
        await replyText(
          dependencies.lineClient,
          replyToken,
          "這個操作無效，請重新輸入轉帳內容。",
        );
        return;
      }
      const result = actionResultSchema.parse(
        await pendingActionService.confirm(
          {
            env: serverEnvironment(),
            db: dependencies.supabase,
            user,
          },
          decision.actionId,
          decision.confirm,
        ),
      );
      await replyText(
        dependencies.lineClient,
        replyToken,
        actionResultMessage(result),
      );
      return;
    }
    if (event.type !== "message") return;

    if (event.message.type === "text") {
      const text = event.message.text;
      const joinMatch = text.trim().match(/^加入\s+(.+)$/);
      if (joinMatch) {
        await joinCouple(joinMatch[1]!, userId, replyToken, dependencies);
        return;
      }

      const user = await findUser(dependencies.supabase, userId);
      if (!user) {
        await replyText(
          dependencies.lineClient,
          replyToken,
          "請先輸入：加入 <設定碼>",
        );
        return;
      }

      await handleLineTextMessage(
        text,
        event.webhookEventId,
        user,
        replyToken,
        dependencies,
        event.timestamp,
      );
      return;
    }

    if (event.message.type === "image") {
      const user = await findUser(dependencies.supabase, userId);
      if (!user) {
        await replyText(
          dependencies.lineClient,
          replyToken,
          "請先輸入：加入 <設定碼>",
        );
        return;
      }
      await handleLineImageTurn({
        messageId: event.message.id,
        sourceEventId: event.webhookEventId,
        user,
        dependencies,
        reply: (msg) => replyMessages(dependencies.lineClient, replyToken, msg),
      });
      return;
    }

    if (event.message.type === "audio") {
      const user = await findUser(dependencies.supabase, userId);
      if (!user) {
        await replyText(
          dependencies.lineClient,
          replyToken,
          "請先輸入：加入 <設定碼>",
        );
        return;
      }
      await handleLineAudioTurn({
        messageId: event.message.id,
        sourceEventId: event.webhookEventId,
        sourceEventTimestamp: event.timestamp,
        user,
        dependencies,
        reply: (msg) => replyMessages(dependencies.lineClient, replyToken, msg),
      });
      return;
    }
  } catch (error) {
    console.error("LINE event failed", {
      eventId: event.webhookEventId,
      error: error instanceof Error ? error.name : "unknown",
    });
    await replyText(
      dependencies.lineClient,
      replyToken,
      "暫時無法處理，請稍後再試。",
    );
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parsePendingActionPostback(data: string): {
  actionId: string;
  confirm: boolean;
} | null {
  if (data.length > 200) return null;
  const params = new URLSearchParams(data);
  const keys = [...params.keys()];
  if (
    keys.length !== 2 ||
    keys.filter((key) => key === "decision").length !== 1 ||
    keys.filter((key) => key === "id").length !== 1
  ) {
    return null;
  }
  const decision = params.get("decision");
  const actionId = params.get("id");
  if (
    (decision !== "confirm" && decision !== "cancel") ||
    !actionId ||
    !UUID_PATTERN.test(actionId)
  ) {
    return null;
  }
  return { actionId, confirm: decision === "confirm" };
}

// Re-export parser helpers so current tests and imports do not break
export {
  parseFixedIntent,
  parseInlineExpenseItems,
  resolveMentionedGroupTurn,
  selectMentionedGroup,
  parsePendingRetargetCommand,
  parseSearchCommand,
} from "./line-message-parsers";
