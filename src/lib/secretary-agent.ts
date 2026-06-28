/**
 * Secretary Agent — the main agent loop for the LINE financial secretary.
 *
 * Routes user messages through Gemini, executes tools, maintains
 * couple-level sessions, and collects pending actions / tasks / memories.
 *
 * Unlike the accountant agent (per-user), the secretary agent maintains
 * shared context for both partners in a couple.
 */

import type { GoogleGenAI } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Content, Part } from "@google/genai";

import {
  secretaryToolDeclarations,
  executeSecretaryTool,
  type ToolContext,
} from "./secretary-tools";
import {
  getOpenTasks,
} from "./secretary-tasks";
import {
  matchMerchantRule,
  getMemories,
} from "./secretary-memory";
import type { AgentDeps } from "./agent-loop";

/* ─── Types ─── */

export type { AgentDeps } from "./agent-loop";

interface AgentMessage {
  role: "user" | "model";
  parts: Part[];
}

export interface SecretaryResult {
  answer: string;
  toolCallCount: number;
  pendingActions: unknown[];
  sessionId: string;
  /** New tasks created during this turn */
  newTasks: string[];
  /** Whether the other partner should be notified */
  notifyPartner: boolean;
  partnerMessage: string | null;
}

/* ─── Constants ─── */

const AGENT_MODEL = "gemini-3.1-flash-lite";
const MAX_TOOL_CALLS = 8;
const MAX_HISTORY = 30;

/* ─── System Prompt ─── */

async function buildSecretaryPrompt(
  ctx: ToolContext,
  today: string,
  userName: string,
  partnerName: string,
): Promise<string> {
  // Fetch current balance
  const balanceResult = await ctx.db.rpc("group_balances", {
    p_group_id: ctx.groupId,
  });
  let balanceInfo = "";
  if (!balanceResult.error && balanceResult.data) {
    const balances = balanceResult.data as Array<{
      user_id: string;
      balance_twd: number;
    }>;
    const myBalance =
      balances.find((b) => b.user_id === ctx.userId)?.balance_twd ?? 0;
    if (myBalance > 0) {
      balanceInfo = `目前：另一半欠 ${userName} NT$${myBalance}`;
    } else if (myBalance < 0) {
      balanceInfo = `目前：${userName} 欠另一半 NT$${Math.abs(myBalance)}`;
    } else {
      balanceInfo = "目前帳務已結清。";
    }
  }

  // Fetch open task count
  const taskCount = await getOpenTasks(ctx.db, {
    coupleId: ctx.coupleId,
    groupId: ctx.groupId,
    limit: 5,
  });
  const taskInfo =
    taskCount.length > 0
      ? `目前有 ${taskCount.length} 件待處理任務。`
      : "";

  // Fetch relevant merchant rules
  const merchantRules = await getMemories(ctx.db, {
    coupleId: ctx.coupleId,
    groupId: ctx.groupId,
    kind: "merchant_rule",
    limit: 5,
  });
  const rulesInfo =
    merchantRules.length > 0
      ? `已知商家規則：${merchantRules
          .filter((m) => m.approved_at)
          .map((m) => `${m.key} → ${JSON.stringify(m.value)}`)
          .join("、")}`
      : "";

  return `你是「帳務秘書」，一個住在 LINE 裡的貼心記帳助手，服務 ${userName} 和 ${partnerName}（一對伴侶）。
今天是 ${today}。${balanceInfo}${taskInfo ? " " + taskInfo : ""}${rulesInfo ? " " + rulesInfo : ""}

你的任務是幫他們管理共同帳務：
- 記帳、改帳、查帳
- 追蹤待處理的事
- 記得對方的習慣

**語氣：** 親切、自然、像真人秘書。用「我」、「你」、「${partnerName}」稱呼。偶爾用「好喔」、「沒問題」、「我幫你」、「收到～」。
不要假裝是 AI，你就是一個在幫他們顧帳的朋友。

**規則：**
1. ⚠️ **記帳/修改/刪除/結清必須用工具！絕對不可以只說「已記帳」卻不呼叫 record_expense/propose_update_expense 工具！**
   如果使用者要記帳但你不確定金額或分類，先問清楚，不可以猜測後假裝記了。
2. 金額都是正整數新台幣。
3. 分類使用英文 enum：food / transport / shopping / entertainment / housing / utilities / health / education / travel / other。
   category_label 使用自由中文標籤如「餐飲」、「交通」、「共享機車」等。
4. 預設共同帳 shared，只有明確說「私人」才用 private。
5. 「我付」= self，「他付 / 她付 / 對方付 / 另一半付」= partner。
6. 回覆繁體中文，簡潔親切。
7. 不確定的時候先問，不要自己決定。
8. 如果使用者說「剛剛那筆」、「上一筆」，用 get_recent_expenses 查最近的支出再判斷。
9. 如果使用者說「之後XX都OO」，用 propose_merchant_rule 建立規則建議。
10. 如果使用者問「有什麼還沒處理」，用 get_open_tasks 查詢任務。
11. 如果商家名稱有已存的 approved merchant_rule，自動套用不用再問。
12. 涉及另一半的變動（結清、規則等），要告知對方。
13. 如果使用者意圖模糊，主動問清楚而不是亂猜。
14. ⚠️ **自主通知另一半的決策：** 如果你的回覆內容涉及重要的共同變動（例如建立或修改了新商家規則、共同分帳模式、提出結清等），且你認為另一半【非常有必要】知道這件事，請在你的最終文字回覆最尾端加上標籤「[通知另一半]」；如果是私人帳、私人查帳、私人閒聊，或不重要的資訊，【絕對不要】加此標籤。`;
}

/* ─── Session Management ─── */

async function loadSecretarySession(
  db: SupabaseClient,
  coupleId: number,
  groupId: string,
): Promise<{ id: string; messages: AgentMessage[] } | null> {
  const { data } = await db
    .from("secretary_sessions")
    .select("id, messages")
    .eq("couple_id", coupleId)
    .eq("group_id", groupId)
    .order("last_active_at", { ascending: false })
    .limit(1)
    .single();

  return (data as { id: string; messages: AgentMessage[] } | null) ?? null;
}

async function saveSecretarySession(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
  coupleId: number,
  groupId: string,
  messages: AgentMessage[],
): Promise<void> {
  const trimmed = messages.slice(-MAX_HISTORY * 2);
  await db.from("secretary_sessions").upsert({
    id: sessionId,
    couple_id: coupleId,
    group_id: groupId,
    messages: trimmed,
    last_active_user_id: userId,
    last_active_at: new Date().toISOString(),
  });
}

function createSecretarySessionId(): string {
  return crypto.randomUUID();
}

/* ─── Main Agent Loop ─── */

export interface SecretaryInput {
  text: string;
  imageData?: string;
  mimeType?: string;
}

export async function runSecretaryLoop(
  input: SecretaryInput,
  sessionId: string | null,
  userId: string,
  coupleId: number,
  userName: string,
  partnerName: string,
  ctx: ToolContext,
  deps: AgentDeps,
): Promise<SecretaryResult> {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  // Load or create couple-level session
  let messages: AgentMessage[] = [];
  let effectiveSessionId = sessionId;

  if (effectiveSessionId) {
    const existing = await loadSecretarySession(
      deps.supabase,
      coupleId,
      ctx.groupId,
    );
    if (existing) {
      messages = existing.messages;
      effectiveSessionId = existing.id;
    }
  }

  if (!effectiveSessionId) {
    effectiveSessionId = createSecretarySessionId();
  }

  // Before processing, try to match merchant rules
  const merchantMatch = await matchMerchantRule(deps.supabase, {
    coupleId,
    groupId: ctx.groupId,
    userId,
    merchant: input.text,
    minConfidence: 0.7,
  });

  let augmentedText = input.text;
  if (merchantMatch?.memory.approved_at) {
    const rule = merchantMatch.memory.value;
    const ruleDesc = [];
    if (rule.ledger) ruleDesc.push(rule.ledger === "private" ? "私人" : "共同");
    if (rule.tag) ruleDesc.push(String(rule.tag));
    if (rule.paid_by) ruleDesc.push(rule.paid_by === "self" ? "你付" : "對方付");
    augmentedText = `${input.text}（已知規則：${ruleDesc.join(", ")}，幫我直接套用）`;
  }

  // Append user message (with prefix to identify speaker)
  const userParts: Part[] = [];
  if (input.imageData && input.mimeType) {
    userParts.push({
      inlineData: { mimeType: input.mimeType, data: input.imageData },
    });
  }
  userParts.push({ text: `[${userName}] ${augmentedText}` });
  messages.push({ role: "user", parts: userParts });

  const systemInstruction = await buildSecretaryPrompt(
    ctx,
    today,
    userName,
    partnerName,
  );

  const pendingActions: unknown[] = [];
  const newTasks: string[] = [];
  let toolCallCount = 0;
  let notifyPartner = false;
  let partnerMessage: string | null = null;

  // Agent loop
  for (let i = 0; i < MAX_TOOL_CALLS; i++) {
    const response = await deps.gemini.models.generateContent({
      model: AGENT_MODEL,
      contents: messages,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: secretaryToolDeclarations }],
      },
    });

    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts) {
      messages.push({
        role: "model",
        parts: [{ text: "抱歉，我暫時無法處理，請稍後再試。" }],
      });
      break;
    }

    const parts = candidate.content.parts;
    const functionCalls = parts.filter(
      (p): p is { functionCall: { name: string; args: Record<string, unknown> } } =>
        "functionCall" in p,
    );
    const textParts = parts.filter(
      (p): p is { text: string } => "text" in p,
    );

    if (functionCalls.length > 0) {
      // Preserve full parts including thoughtSignature — required by Gemini thinking models.
      // Stripping thoughtSignature causes INVALID_ARGUMENT on the next request.
      messages.push({ role: "model", parts });

      const functionResponses: Part[] = [];

      for (const fc of functionCalls) {
        toolCallCount++;
        const toolName = fc.functionCall.name;
        const toolArgs = fc.functionCall.args;

        let result: unknown;
        try {
          result = await executeSecretaryTool(toolName, toolArgs, ctx);
        } catch (error) {
          result = {
            error: error instanceof Error ? error.message : "工具執行失敗",
          };
        }

        // Collect pending actions
        const resultRecord = result as Record<string, unknown>;
        if (resultRecord?.pending_action) {
          pendingActions.push(resultRecord.pending_action);
        }

        // Collect new tasks
        if (resultRecord?.task_id) {
          newTasks.push(String(resultRecord.task_id));
        }

        // Check if partner should be notified
        if (resultRecord?.notify_partner) {
          notifyPartner = true;
        }
        if (resultRecord?.partner_message) {
          partnerMessage = String(resultRecord.partner_message);
        }

        // Mark partner notification for settlement/propose tools
        const actionType =
          (resultRecord?.pending_action as Record<string, unknown>)?.type;
        if (actionType === "settle" || actionType === "update_expense") {
          notifyPartner = true;
        }

        functionResponses.push({
          functionResponse: {
            name: toolName,
            response: result,
          },
        } as Part);
      }

      messages.push({
        role: "user",
        parts: functionResponses,
      });
    } else {
      let finalText =
        textParts.map((p) => p.text).join("") || "處理完成。";

      // Parse [通知另一半] tag if present
      const notifyTag = "[通知另一半]";
      if (finalText.includes(notifyTag)) {
        notifyPartner = true;
        finalText = finalText.replace(notifyTag, "").trim();
      } else {
        notifyPartner = false;
      }

      messages.push({
        role: "model",
        parts: [{ text: finalText }],
      });

      if (notifyPartner) {
        partnerMessage = finalText.slice(0, 200);
      } else {
        partnerMessage = null;
      }

      await saveSecretarySession(
        deps.supabase,
        effectiveSessionId,
        userId,
        coupleId,
        ctx.groupId,
        messages,
      );

      return {
        answer: finalText,
        toolCallCount,
        pendingActions,
        sessionId: effectiveSessionId,
        newTasks,
        notifyPartner,
        partnerMessage,
      };
    }
  }

  // Exhausted tool calls — summarize
  const summaryResponse = await deps.gemini.models.generateContent({
    model: AGENT_MODEL,
    contents: [
      ...messages,
      {
        role: "user",
        parts: [{ text: "請用一句話總結你剛才做了什麼。" }],
      },
    ] as Content[],
    config: { systemInstruction },
  });

  let summaryText =
    summaryResponse.candidates?.[0]?.content?.parts
      ?.filter((p): p is { text: string } => "text" in p)
      .map((p) => p.text)
      .join("") || "已完成處理。";

  const notifyTag = "[通知另一半]";
  if (summaryText.includes(notifyTag)) {
    notifyPartner = true;
    summaryText = summaryText.replace(notifyTag, "").trim();
  } else {
    notifyPartner = false;
  }

  if (notifyPartner) {
    partnerMessage = summaryText.slice(0, 200);
  } else {
    partnerMessage = null;
  }

  await saveSecretarySession(
    deps.supabase,
    effectiveSessionId,
    userId,
    coupleId,
    ctx.groupId,
    messages,
  );

  return {
    answer: summaryText,
    toolCallCount,
    pendingActions,
    sessionId: effectiveSessionId,
    newTasks,
    notifyPartner,
    partnerMessage,
  };
}
