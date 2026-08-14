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
import {
  handleLineMenuPostback,
  lineMenuRestartReply,
  LineMenuStateError,
  parseLineMenuPostbackDetailed,
} from "./line-menu-service";
import { requireLiffId } from "./liff-url";
import {
  isV2IncidentBootstrapOnly,
  isV2IncidentFreezeError,
  V2IncidentFreezeError,
} from "./v2-incident-freeze";

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
      if (parseRichMenuSwitchPostback(event.postback.data)) return;
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
      if (decision) {
        if (process.env.V2_LEDGER_ENABLED === "1") {
          await replyText(
            dependencies.lineClient,
            replyToken,
            "V2 Ledger 的記帳請用文字格式，例如「晚餐 500 我付」；確認草稿請開啟 LIFF。",
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
        if (
          result.result === "expired" ||
          result.result === "stale" ||
          result.result === "not_found" ||
          result.result === "already_done"
        ) {
          await replyMessages(
            dependencies.lineClient,
            replyToken,
            lineMenuRestartReply(actionResultMessage(result)),
          );
          return;
        }
        await replyText(
          dependencies.lineClient,
          replyToken,
          actionResultMessage(result),
        );
        return;
      }
      if (process.env.V2_LEDGER_ENABLED === "1") {
        await replyText(
          dependencies.lineClient,
          replyToken,
          "V2 Ledger 的記帳請用文字格式，例如「晚餐 500 我付」；確認草稿請開啟 LIFF。",
        );
        return;
      }
      const parsedMenu = parseLineMenuPostbackDetailed(event.postback.data);
      if (!parsedMenu.ok) {
        console.warn("LINE menu postback rejected", {
          eventId: event.webhookEventId,
          reason: parsedMenu.reason,
        });
        await replyMessages(
          dependencies.lineClient,
          replyToken,
          lineMenuRestartReply("這個操作無效或已更新，請重新開始。"),
        );
        return;
      }
      let response;
      try {
        response = await handleLineMenuPostback({
          menu: parsedMenu.menu,
          user,
          db: dependencies.supabase,
          liffId: requireLiffId(),
          sourceEventId: event.webhookEventId,
          sourceEventTimestamp: event.timestamp,
        });
      } catch (error) {
        if (!(error instanceof LineMenuStateError)) throw error;
        console.warn("LINE menu state rejected", {
          eventId: event.webhookEventId,
          reason: error.reason,
        });
        await replyMessages(
          dependencies.lineClient,
          replyToken,
          lineMenuRestartReply("群組已變更，請重新開始。"),
        );
        return;
      }
      await replyMessages(
        dependencies.lineClient,
        replyToken,
        response,
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

      if (isV2IncidentBootstrapOnly() && process.env.V2_LEDGER_ENABLED === "1") {
        throw new V2IncidentFreezeError();
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
      if (isV2IncidentBootstrapOnly() && process.env.V2_LEDGER_ENABLED === "1") {
        throw new V2IncidentFreezeError();
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
      if (isV2IncidentBootstrapOnly() && process.env.V2_LEDGER_ENABLED === "1") {
        throw new V2IncidentFreezeError();
      }
      await handleLineAudioTurn({
        messageId: event.message.id,
        replyToken,
        sourceEventId: event.webhookEventId,
        sourceEventTimestamp: event.timestamp,
        user,
        dependencies,
        reply: (msg) => replyMessages(dependencies.lineClient, replyToken, msg),
        v2Only: process.env.V2_LEDGER_ENABLED === "1",
      });
      return;
    }
  } catch (error) {
    // Durable V2 inbox dispatch must retain the event while maintenance is
    // active. Do not mark it processed or send a generic failure reply.
    if (isV2IncidentFreezeError(error)) throw error;
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

export function parseRichMenuSwitchPostback(
  data: string,
): { tab: "record" | "manage" } | null {
  if (data.length > 32) return null;
  const entries = [...new URLSearchParams(data).entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== "tab") return null;
  const tab = entries[0][1];
  return tab === "record" || tab === "manage" ? { tab } : null;
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
