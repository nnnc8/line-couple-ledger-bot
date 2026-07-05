import type { LineBotClient, webhook } from "@line/bot-sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentDeps } from "./agent-loop";
import { findUser, replyText } from "./line-bot-shared";
import {
  handleLineAudioTurn,
  handleLineImageTurn,
} from "./line-secretary-service";
import { handleLineTextMessage, joinCouple } from "./line-text-service";

export interface BotDependencies {
  lineClient: Pick<LineBotClient, "replyMessage" | "getMessageContent" | "pushMessage">;
  supabase: SupabaseClient;
  gemini: AgentDeps["gemini"];
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
      await replyText(
        dependencies.lineClient,
        replyToken,
        "這個操作已停用，請重新記帳或到圖形化帳本編輯。",
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
        reply: (text) => replyText(dependencies.lineClient, replyToken, text),
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
        user,
        dependencies,
        reply: (text) => replyText(dependencies.lineClient, replyToken, text),
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

// Re-export parser helpers so current tests and imports do not break
export {
  parseFixedIntent,
  parseInlineExpenseItems,
  resolveMentionedGroupTurn,
  selectMentionedGroup,
  parsePendingRetargetCommand,
  parseSearchCommand,
} from "./line-message-parsers";
