import type { GoogleGenAI } from "@google/genai";
import type { LineBotClient, messagingApi, webhook } from "@line/bot-sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  confirmAction,
  retargetPendingActionById,
  retargetPendingActions,
  searchExpenses,
  serverEnvironment,
  transcribeAudio,
} from "./app-server";
import { runSecretaryLoop, type SecretaryResult } from "./secretary-agent";
import { notifyPartner } from "./secretary-push";
import type { ToolContext } from "./accountant-tools";
import type { AgentDeps } from "./agent-loop";
import {
  type ParsedIntent,
} from "./ledger";
import { safeSecretEqual } from "./security";

export { safeSecretEqual } from "./security";

const MAX_MESSAGE_LENGTH = 500;
const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;

const userRowSchema = z.object({
  id: z.string().uuid(),
  couple_id: z.number().int(),
  role: z.enum(["owner", "partner"]),
  line_user_id: z.string(),
});

const actionResultSchema = z.object({
  result: z.enum([
    "confirmed",
    "cancelled",
    "expired",
    "stale",
    "not_found",
    "already_done",
  ]),
  action_type: z
    .enum([
      "create_expense",
      "update_expense",
      "delete_expense",
      "restore_expense",
      "settle",
      "batch_create_expenses",
      "batch_update_expenses",
    ])
    .nullable()
    .optional(),
  created_count: z.number().int().optional(),
});

type UserRow = z.infer<typeof userRowSchema>;

interface BotDependencies {
  lineClient: Pick<LineBotClient, "replyMessage" | "getMessageContent" | "pushMessage">;
  supabase: SupabaseClient;
  gemini: GoogleGenAI;
  setupCode: string;
  onImage?: (input: { messageId: string; eventId: string; lineUserId: string }) => void;
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
      await handlePostback(event, userId, replyToken, dependencies);
      return;
    }
    if (event.type !== "message") return;
    if (event.message.type === "image") {
      await handleImageMessage(event, userId, replyToken, dependencies);
      return;
    }
    if (event.message.type === "audio") {
      await handleAudioMessage(event, userId, replyToken, dependencies);
      return;
    }
    if (event.message.type !== "text") return;
    await handleText(
      event.message.text,
      event.webhookEventId,
      userId,
      replyToken,
      dependencies,
    );
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
  lineUserId: string,
  replyToken: string,
  dependencies: BotDependencies,
): Promise<void> {
  const joinMatch = text.trim().match(/^加入\s+(.+)$/);
  if (joinMatch) {
    await joinCouple(joinMatch[1]!, lineUserId, replyToken, dependencies);
    return;
  }

  const user = await findUser(dependencies.supabase, lineUserId);
  if (!user) {
    await replyText(
      dependencies.lineClient,
      replyToken,
      "請先輸入：加入 <設定碼>",
    );
    return;
  }
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
    const result = await retargetPendingActions(
      { db: dependencies.supabase, user },
      retarget,
    );
    await replyText(
      dependencies.lineClient,
      replyToken,
      result.count
        ? `已把 ${result.count} 筆待確認收據改成私人帳｜交通。請按原本那則訊息的確認。`
        : "沒有找到還有效的待確認收據，請重新傳照片或手動新增。",
    );
    return;
  }

  // Route all other messages through the Agent Loop
  await runSecretaryWithReply(text, user, replyToken, dependencies);
}

/**
 * Route user message through the Secretary Agent Loop.
 * If the secretary produces pending actions, send confirmation UI.
 * If the secretary needs to notify the partner, push a LINE message.
 */
async function runSecretaryWithReply(
  text: string,
  user: UserRow,
  replyToken: string,
  dependencies: BotDependencies,
  imageData?: { imageData: string; mimeType: string },
): Promise<void> {

  const groupId = await getActiveGroupId(dependencies.supabase, user);

  const toolCtx: ToolContext = {
    db: dependencies.supabase,
    groupId,
    userId: user.id,
    coupleId: user.couple_id,
  };

  const agentDeps: AgentDeps = {
    gemini: dependencies.gemini,
    supabase: dependencies.supabase,
  };

  // Get partner user info for secretary context
  const partner = await findPartner(dependencies.supabase, user);

  // Load couple-level session
  const { data: lastSession } = await dependencies.supabase
    .from("secretary_sessions")
    .select("id")
    .eq("couple_id", user.couple_id)
    .eq("group_id", groupId)
    .order("last_active_at", { ascending: false })
    .limit(1)
    .single();

  const sessionId = lastSession?.id ?? null;

  try {
    const userName = user.role === "owner" ? "你" : "你";
    const partnerName = partner ? `${partner.role === "owner" ? "另一半" : "另一半"}` : "另一半";

    const input = {
      text,
      ...(imageData ? { imageData: imageData.imageData, mimeType: imageData.mimeType } : {}),
    };

    const result: SecretaryResult = await runSecretaryLoop(
      input,
      sessionId,
      user.id,
      user.couple_id,
      userName,
      partnerName,
      toolCtx,
      agentDeps,
    );

    // If there are pending actions, create them and send confirmation UI
    if (result.pendingActions.length > 0) {
      for (const action of result.pendingActions) {
        const actionRecord = action as Record<string, unknown>;
        if (actionRecord.type === "create_expense" || actionRecord.type === "update_expense") {
          const pendingResult = await createAgentPendingAction(
            dependencies.supabase,
            user,
            actionRecord,
          );
          if (pendingResult) {
            await replyConfirmation(
              dependencies.lineClient,
              replyToken,
              pendingResult.id,
              result.answer,
            );
            // Notify partner
            if (result.notifyPartner && result.partnerMessage && partner) {
              await notifyPartner(dependencies.lineClient, dependencies.supabase, {
                targetUserId: partner.id,
                message: result.partnerMessage,
              });
            }
            return;
          }
        } else if (actionRecord.type === "settle") {
          const pendingResult = await createAgentPendingAction(
            dependencies.supabase,
            user,
            actionRecord,
          );
          if (pendingResult) {
            await replyConfirmation(
              dependencies.lineClient,
              replyToken,
              pendingResult.id,
              result.answer,
            );
            if (result.notifyPartner && partner) {
              await notifyPartner(dependencies.lineClient, dependencies.supabase, {
                targetUserId: partner.id,
                message: `對方提出結清：NT$${actionRecord.amountTwd ?? "?"}`,
              });
            }
            return;
          }
        }
      }
    }

    // No pending actions — check if the secretary hallucinated an action
    const actionClaimRegex =
      /(?:已|已經|已幫|幫你|幫)(?:記帳|記了|新增|加入|修改|改|刪除|結清|建立)/;
    if (actionClaimRegex.test(result.answer)) {
      // The secretary claims to have done something but didn't call tools.
      // Retry once with an explicit instruction to use the tool.
      console.warn("Secretary hallucinated action, retrying with correction", {
        answer: result.answer.slice(0, 200),
        toolCallCount: result.toolCallCount,
      });

      const correctionResult = await runSecretaryLoop(
        { text: `⚠️ 你剛才說「${result.answer.slice(0, 100)}」，但你沒有實際呼叫工具。請立刻呼叫 record_expense（或其他對應工具）來執行，不要只用文字回覆。` },
        result.sessionId,
        user.id,
        user.couple_id,
        userName,
        partnerName,
        toolCtx,
        agentDeps,
      );

      // Process correction result
      if (correctionResult.pendingActions.length > 0) {
        for (const action of correctionResult.pendingActions) {
          const actionRecord = action as Record<string, unknown>;
          if (actionRecord.type === "create_expense" || actionRecord.type === "update_expense") {
            const pendingResult = await createAgentPendingAction(
              dependencies.supabase,
              user,
              actionRecord,
            );
            if (pendingResult) {
              await replyConfirmation(
                dependencies.lineClient,
                replyToken,
                pendingResult.id,
                correctionResult.answer,
              );
              return;
            }
          }
        }
      }
    }

    // Fall back to text reply
    await replyText(dependencies.lineClient, replyToken, result.answer);

    // Notify partner if needed (e.g., merchant rule changes)
    if (result.notifyPartner && result.partnerMessage && partner) {
      await notifyPartner(dependencies.lineClient, dependencies.supabase, {
        targetUserId: partner.id,
        message: result.partnerMessage,
      });
    }
  } catch (error) {
    console.error("Secretary loop failed", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.slice(0, 500) : undefined,
      name: error instanceof Error ? error.name : typeof error,
    });
    await replyText(
      dependencies.lineClient,
      replyToken,
      "抱歉，我暫時無法處理你的請求，請稍後再試。",
    );
  }
}

async function findPartner(
  supabase: SupabaseClient,
  user: UserRow,
): Promise<UserRow | null> {
  const { data, error } = await supabase
    .from("users")
    .select("id, couple_id, role, line_user_id")
    .eq("couple_id", user.couple_id)
    .neq("id", user.id)
    .maybeSingle();

  if (error || !data) return null;
  return userRowSchema.parse(data);
}

async function getActiveGroupId(
  supabase: SupabaseClient,
  user: UserRow,
): Promise<string> {
  const { data } = await supabase
    .from("user_preferences")
    .select("active_group_id")
    .eq("user_id", user.id)
    .single();

  if (data) {
    return z.object({ active_group_id: z.string().uuid() }).parse(data).active_group_id;
  }

  // Fallback: get any group for this couple
  const { data: groups } = await supabase
    .from("groups")
    .select("id")
    .eq("couple_id", user.couple_id)
    .is("archived_at", null)
    .limit(1);

  if (groups?.length) {
    return z.object({ id: z.string().uuid() }).parse(groups[0]).id;
  }

  throw new Error("找不到可用群組");
}

/**
 * Create a pending action for agent-created expenses/settlements.
 */
async function createAgentPendingAction(
  supabase: SupabaseClient,
  user: UserRow,
  action: Record<string, unknown>,
): Promise<{ id: string; expense: Record<string, unknown> } | null> {
  const type = action.type as string;
  const expiresAt = new Date(Date.now() + PENDING_ACTION_TTL_MS).toISOString();

  if (type === "create_expense") {
    const expense = action.expense as Record<string, unknown>;
    const splits = action.splits as Array<{ user_id: string; amount_twd: number }> | undefined;

    const { data, error } = await supabase
      .from("pending_actions")
      .insert({
        couple_id: user.couple_id,
        group_id: action.groupId as string | null,
        requested_by_user_id: user.id,
        action_type: "create_expense",
        payload: { expense, splits },
        source_event_id: `line:${crypto.randomUUID()}`,
        expires_at: expiresAt,
      })
      .select("id")
      .single();

    if (error || !data) return null;

    return { id: data.id, expense };
  }

  if (type === "settle") {
    const { data, error } = await supabase
      .from("pending_actions")
      .insert({
        couple_id: user.couple_id,
        group_id: action.groupId as string | null,
        requested_by_user_id: user.id,
        action_type: "settle",
        payload: {
          groupId: action.groupId,
          userId: action.userId,
          amountTwd: action.amountTwd,
        },
        source_event_id: `line:${crypto.randomUUID()}`,
        expires_at: expiresAt,
      })
      .select("id")
      .single();

    if (error || !data) return null;

    return { id: data.id, expense: { description: "結清", amount_twd: action.amountTwd } };
  }

  return null;
}

function parseSearchCommand(text: string): string | null {
  const match = text.trim().match(/^(?:\/?搜尋|搜)\s+(.+)$/);
  const query = match?.[1]?.trim();
  return query ? query.slice(0, 100) : null;
}

async function replySearch(
  query: string,
  user: UserRow,
  replyToken: string,
  dependencies: BotDependencies,
) {
  const env = serverEnvironment();
  const params = new URLSearchParams({ q: query, limit: "5" });
  const result = await searchExpenses(
    { env, db: dependencies.supabase, user },
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

async function handleAudioMessage(
  event: webhook.Event & { message: { id: string } },
  userId: string,
  replyToken: string,
  dependencies: BotDependencies,
): Promise<void> {
  try {
    const content = await dependencies.lineClient.getMessageContent(event.message.id);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of content) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 10 * 1024 * 1024) {
        await replyText(dependencies.lineClient, replyToken, "語音訊息太大，請傳短一點的語音。");
        return;
      }
      chunks.push(buffer);
    }
    const bytes = Buffer.concat(chunks);
    const text = await transcribeAudio(bytes, "audio/x-m4a", dependencies.gemini);
    if (!text) {
      await replyText(dependencies.lineClient, replyToken, "沒聽清楚，可以再說一次或打字嗎？");
      return;
    }

    const prefix = `聽到：「${text}」\n`;
    const wrappedLineClient = {
      ...dependencies.lineClient,
      replyMessage: async (params: {
        replyToken: string;
        messages: messagingApi.Message[];
      }) => {
        const modifiedMessages = params.messages.map((msg): messagingApi.Message => {
          if (msg.type === "text") {
            const textMsg = msg as messagingApi.TextMessage;
            if (textMsg.text) {
              return {
                ...textMsg,
                text: prefix + textMsg.text,
              };
            }
          }
          return msg;
        });
        return dependencies.lineClient.replyMessage({
          ...params,
          messages: modifiedMessages,
        });
      },
    };

    await handleText(
      text,
      event.webhookEventId ?? "",
      userId,
      replyToken,
      {
        ...dependencies,
        lineClient: wrappedLineClient,
      },
    );
  } catch (err) {
    console.error("Failed to process audio message:", err);
    await replyText(dependencies.lineClient, replyToken, "語音處理失敗，請稍後再試或直接打字。");
  }
}

async function handleImageMessage(
  event: webhook.Event & { message: { id: string } },
  userId: string,
  replyToken: string,
  dependencies: BotDependencies,
): Promise<void> {
  try {
    // Get user info
    const user = await findUser(dependencies.supabase, userId);
    if (!user) {
      await replyText(dependencies.lineClient, replyToken, "請先輸入：加入 <設定碼>");
      return;
    }

    // Download image from LINE
    const content = await dependencies.lineClient.getMessageContent(event.message.id);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of content) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 10 * 1024 * 1024) {
        await replyText(dependencies.lineClient, replyToken, "圖片太大，請傳小一點的圖片。");
        return;
      }
      chunks.push(buffer);
    }
    const bytes = Buffer.concat(chunks);
    const base64Image = bytes.toString("base64");

    // Determine MIME type from the first few bytes
    let mimeType = "image/jpeg"; // default
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      mimeType = "image/png";
    } else if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
      mimeType = "image/webp";
    }

    // Send to Agent with Vision prompt
    await runSecretaryWithReply(
      "這是一張收據或發票照片。請分析圖片內容，提取商家名稱、日期、總金額，並判斷分類，然後呼叫 record_expense 工具記帳。如果圖片不是收據或發票，請告知使用者。",
      user,
      replyToken,
      dependencies,
      { imageData: base64Image, mimeType },
    );
  } catch (err) {
    console.error("Failed to process image message:", err);
    await replyText(dependencies.lineClient, replyToken, "圖片處理失敗，請稍後再試。");
  }
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
  const { data, error } = await dependencies.supabase.rpc("claim_user", {
    p_line_user_id: lineUserId,
  });
  if (error) throw new Error("claim_user failed");
  const result = z
    .object({ result: z.enum(["joined", "already_joined", "full"]), role: z.string().optional() })
    .parse(data);
  const message =
    result.result === "full"
      ? "帳本已綁定兩位使用者。"
      : result.result === "already_joined"
        ? "你已經加入帳本。"
        : `加入成功，你是 ${result.role}。`;
  await replyText(dependencies.lineClient, replyToken, message);
}

async function handlePostback(
  event: webhook.PostbackEvent,
  lineUserId: string,
  replyToken: string,
  dependencies: BotDependencies,
): Promise<void> {
  const parameters = new URLSearchParams(event.postback.data);
  const actionId = parameters.get("id");
  const actionIds = parameters.get("ids")?.split(",").filter(Boolean) ?? [];
  const decision = parameters.get("decision");
  const edit = parameters.get("edit");
  if (edit === "private_transport") {
    if (!actionId || !z.string().uuid().safeParse(actionId).success) {
      await replyText(dependencies.lineClient, replyToken, "這個操作無效。");
      return;
    }
    const user = await findUser(dependencies.supabase, lineUserId);
    if (!user) {
      await replyText(dependencies.lineClient, replyToken, "請先加入帳本。");
      return;
    }
    const result = await retargetPendingActionById(
      { db: dependencies.supabase, user },
      actionId,
      { ledger: "private", tag: "交通" },
    );
    await replyConfirmation(
      dependencies.lineClient,
      replyToken,
      actionId,
      `已改成私人帳｜交通，共 ${result.count} 筆。\n確認後入帳。`,
    );
    return;
  }
  if (
    !["confirm", "cancel"].includes(decision ?? "") ||
    (!actionId && !actionIds.length) ||
    (actionId && !z.string().uuid().safeParse(actionId).success) ||
    actionIds.some((id) => !z.string().uuid().safeParse(id).success)
  ) {
    await replyText(dependencies.lineClient, replyToken, "這個操作無效。");
    return;
  }
  if (actionIds.length) {
    const results = [];
    for (const id of actionIds) {
      results.push(
        await confirmOneAction(id, decision === "confirm", lineUserId, dependencies),
      );
    }
    const confirmed = results.filter((result) => result.result === "confirmed").length;
    await replyText(
      dependencies.lineClient,
      replyToken,
      decision === "confirm"
        ? confirmed === results.length
          ? `已記帳 ${confirmed} 筆。`
          : `已記帳 ${confirmed} 筆，${results.length - confirmed} 筆未完成。`
        : "已取消。",
    );
    return;
  }
  const result = await confirmOneAction(actionId!, decision === "confirm", lineUserId, dependencies);
  const messages: Record<typeof result.result, string> = {
    confirmed:
      result.action_type === "batch_create_expenses"
        ? `已記帳 ${result.created_count ?? "這批"} 筆。`
        : result.action_type === "create_expense"
        ? "已記帳。"
        : result.action_type === "batch_update_expenses"
          ? "分類整理已套用。"
        : result.action_type === "delete_expense"
          ? "已刪除。"
          : "已結清。",
    cancelled: "已取消。",
    expired: "確認已過期，請重新操作。",
    stale: "帳目已變動，請重新操作。",
    not_found: "找不到這個操作。",
    already_done: "這個操作已處理。",
  };
  await replyText(dependencies.lineClient, replyToken, messages[result.result]);
}

async function confirmOneAction(
  actionId: string,
  confirm: boolean,
  lineUserId: string,
  dependencies: BotDependencies,
) {
  const user = await findUser(dependencies.supabase, lineUserId);
  if (!user) return { result: "not_found", action_type: null } as const;
  return actionResultSchema.parse(
    await confirmAction(
      { env: serverEnvironment(), db: dependencies.supabase, user },
      actionId,
      confirm,
    ),
  );
}

async function findUser(
  supabase: SupabaseClient,
  lineUserId: string,
): Promise<UserRow | null> {
  const { data, error } = await supabase
    .from("users")
    .select("id, couple_id, role, line_user_id")
    .eq("line_user_id", lineUserId)
    .maybeSingle();
  if (error) throw new Error("user lookup failed");
  return userRowSchema.nullable().parse(data);
}

async function replyText(
  lineClient: Pick<LineBotClient, "replyMessage">,
  replyToken: string,
  text: string,
): Promise<void> {
  await lineClient.replyMessage({
    replyToken,
    messages: [{ type: "text", text }],
  });
}

async function replyConfirmation(
  lineClient: Pick<LineBotClient, "replyMessage">,
  replyToken: string,
  actionId: string,
  text: string,
): Promise<void> {
  const env = serverEnvironment();
  const message: messagingApi.TextMessage = {
    type: "text",
    text,
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: "✓ 確認",
            data: `decision=confirm&id=${actionId}`,
            displayText: "確認",
          },
        },
        {
          type: "action",
          action: {
            type: "uri",
            label: "✏️ 去 LIFF 改",
            uri: `${env.APP_URL}/?tab=history`,
          },
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "取消",
            data: `decision=cancel&id=${actionId}`,
            displayText: "取消",
          },
        },
      ],
    },
  };
  await lineClient.replyMessage({ replyToken, messages: [message] });
}
