import type { LineBotClient, webhook } from "@line/bot-sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { serverEnvironment } from "./server-runtime";
import { pendingActionService, ledgerQueryService } from "./services";
import { taipeiToday } from "./ledger-shared";
import type { AgentDeps } from "./agent-loop";
import {
  type ParsedIntent,
} from "./ledger";
import { safeSecretEqual } from "./security";
import {
  findUser,
  replyText,
  LineUser,
} from "./line-bot-shared";
import {
  handleLineAudioTurn,
  handleLineImageTurn,
  runLineSecretaryTurn,
} from "./line-secretary-service";
import { claimUser } from "./claim-user";

const MAX_MESSAGE_LENGTH = 500;

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

      await handleText(
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

function emptyIntent(intent: ParsedIntent["intent"]): ParsedIntent {
  return {
    intent,
    description: null,
    amountTwd: null,
    ledger: null,
    paidBy: null,
    expenseDate: null,
    tag: null,
  };
}

function cleanInlineDescription(value: string) {
  return value
    .replace(/[，,。.!！?？|｜]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function inferInlineTag(text: string): ParsedIntent["tag"] {
  return /早餐|午餐|晚餐|宵夜|餐|吃|喝|咖啡|飲料|漢堡|便當|火鍋|越南|拉麵|麵|飯|披薩|甜點/.test(
    text,
  )
    ? "food"
    : /車|捷運|高鐵|火車|公車|計程車|uber|停車|加油|交通/.test(text)
      ? "transport"
      : "other";
}

function normalizeGroupText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

export function parseFixedIntent(text: string): ParsedIntent | null {
  const intent = new Map<string, ParsedIntent["intent"]>([
    ["誰欠誰", "balance"],
    ["查詢目前誰欠誰", "balance"],
    ["本月共同支出", "shared_monthly"],
    ["本月私人支出", "private_monthly"],
    ["刪除剛剛那筆", "delete_last"],
    ["結清", "settle"],
    ["說明", "help"],
    ["help", "help"],
  ]).get(text.trim());
  return intent ? emptyIntent(intent) : null;
}

export function parseInlineExpenseItems(
  text: string,
  today: string,
): ParsedIntent[] {
  const matches = [
    ...text.matchAll(/(\d{1,9})\s*(?:元|塊|nt\$?)?\s*(我付|你付|他付|她付)/giu),
  ];
  if (matches.length < 2) return [];
  let cursor = 0;
  return matches.slice(0, 5).flatMap((match) => {
    const index = match.index ?? 0;
    const description = cleanInlineDescription(text.slice(cursor, index));
    cursor = index + match[0].length;
    const amountTwd = Number(match[1]);
    if (!description || !Number.isSafeInteger(amountTwd) || amountTwd <= 0)
      return [];
    return [
      {
        intent: "record_expense",
        description,
        amountTwd,
        ledger: /私人/.test(text) ? "private" : "shared",
        paidBy: match[2] === "我付" ? "self" : "partner",
        expenseDate: today,
        tag: inferInlineTag(`${text} ${description}`),
      } satisfies ParsedIntent,
    ];
  });
}

export function selectMentionedGroup<T extends { id: string; name: string }>(
  text: string,
  groups: T[],
  activeGroupId: string,
): T | null {
  const normalizedText = normalizeGroupText(text);
  const mentioned = groups
    .filter((group) => normalizedText.includes(normalizeGroupText(group.name)))
    .sort((left, right) => right.name.length - left.name.length);
  return (
    mentioned[0] ??
    groups.find((group) => group.id === activeGroupId) ??
    groups[0] ??
    null
  );
}

export function parsePendingRetargetCommand(text: string) {
  const normalized = text.replace(/\s+/g, "");
  if (!/(都|全部|這批|剛剛|剛才|上面|那些)/.test(normalized)) return null;
  if (!/(改成|改到|轉成|轉到|移到|換成)/.test(normalized)) return null;
  if (!/私人帳|私人/.test(normalized)) return null;
  if (!/交通|車資|搭車|行程|uber|計程車/i.test(normalized)) return null;
  return {
    ledger: "private",
    tag: "交通",
  } as const;
}

async function handleText(
  text: string,
  eventId: string,
  user: LineUser,
  replyToken: string,
  dependencies: BotDependencies,
): Promise<void> {
  if (text.length > MAX_MESSAGE_LENGTH) {
    await replyText(dependencies.lineClient, replyToken, "訊息太長，請縮短後再試。");
    return;
  }

  // Search command (kept for LIFF integration)
  const searchQuery = parseSearchCommand(text);
  if (searchQuery) {
    await replySearch(searchQuery, user, replyToken, dependencies);
    return;
  }

  // Pending retarget command
  const retarget = parsePendingRetargetCommand(text);
  if (retarget) {
    const result = await pendingActionService.retargetActions(
      { db: dependencies.supabase, user },
      retarget,
    );
    const serverContext = {
      env: serverEnvironment(),
      db: dependencies.supabase,
      user,
    };
    for (const actionId of result.actionIds) {
      await pendingActionService.confirm(serverContext, actionId, true);
    }
    await replyText(
      dependencies.lineClient,
      replyToken,
      result.count
        ? `已把 ${result.count} 筆待確認草稿改成私人帳｜交通，並直接入帳。`
        : "沒有找到還有效的待確認草稿，請重新傳照片或手動新增。",
    );
    return;
  }

  // Route all other messages through the Agent Loop
  await runLineSecretaryTurn({
    text,
    user,
    dependencies,
    reply: (replyMsg) => replyText(dependencies.lineClient, replyToken, replyMsg),
  });
}

export function parseSearchCommand(text: string): string | null {
  const match = text.trim().match(/^(?:\/?搜尋|搜)\s+(.+)$/);
  const query = match?.[1]?.trim();
  return query ? query.slice(0, 100) : null;
}

async function replySearch(
  query: string,
  user: LineUser,
  replyToken: string,
  dependencies: BotDependencies,
) {
  const env = serverEnvironment();
  const params = new URLSearchParams({ q: query, limit: "5" });
  const result = await ledgerQueryService.searchExpenses(
    { db: dependencies.supabase, user },
    params,
  );
  const expenses = result.expenses.slice(0, 5);
  const link = `${env.APP_URL}/?search=${encodeURIComponent(query)}`;
  const lines = expenses.length
    ? [
        `找到 ${expenses.length} 筆：`,
        ...expenses.map((expense) => {
          const label = expense.tag;
          return `• ${expense.description} NT$${expense.amount_twd.toLocaleString("en-US")}｜${expense.expense_date}｜${label}`;
        }),
        `看更多：${link}`,
      ]
    : [`找不到「${query}」。`, `可到 LIFF 放寬日期或金額條件：${link}`];
  await replyText(dependencies.lineClient, replyToken, lines.join("\n"));
}

async function joinCouple(
  receivedCode: string,
  lineUserId: string,
  replyToken: string,
  dependencies: BotDependencies,
): Promise<void> {
  if (!safeSecretEqual(receivedCode.trim(), dependencies.setupCode)) {
    await replyText(dependencies.lineClient, replyToken, "設定碼不正確。");
    return;
  }
  const result = await claimUser(dependencies.supabase, lineUserId);
  const message =
    result.result === "full"
      ? "帳本已綁定兩位使用者。"
      : result.result === "already_joined"
        ? "你已經加入帳本。"
        : `加入成功，你是 ${result.role}。`;
  await replyText(dependencies.lineClient, replyToken, message);
}
