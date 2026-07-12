import type { SupabaseClient } from "@supabase/supabase-js";
import type { Content, GoogleGenAI, Part } from "@google/genai";

import {
  toolDeclarations,
  executeTool,
  type ToolContext,
} from "./accountant-tools";
import { loadGroupBalances } from "./balance-loader";
import { getModelConfig } from "./server-env";

export interface AgentDeps {
  gemini: GoogleGenAI;
  supabase: SupabaseClient;
}

interface AgentMessage {
  role: "user" | "model";
  parts: Part[];
}

interface AgentResult {
  answer: string;
  toolCallCount: number;
  pendingActions: unknown[];
}

interface SessionRow {
  id: string;
  messages: AgentMessage[];
}

const MAX_TOOL_CALLS = 8;
const MAX_HISTORY = 30;

async function buildSystemPrompt(ctx: ToolContext, today: string): Promise<string> {
  let balanceInfo = "";
  try {
    const balances = await loadGroupBalances(ctx.db, ctx.groupId);
    const myBalance = balances.find((b) => b.userId === ctx.userId)?.balanceTwd ?? 0;
    if (myBalance > 0) {
      balanceInfo = `\n目前狀態：對方欠你 NT$${myBalance}`;
    } else if (myBalance < 0) {
      balanceInfo = `\n目前狀態：你欠對方 NT$${Math.abs(myBalance)}`;
    } else {
      balanceInfo = "\n目前狀態：帳務已結清";
    }
  } catch {
    // If the balance lookup fails the prompt still works without the line.
  }

  return `你是一個情侶記帳系統的 AI 助理。今天是 ${today}。
你的职责是幫助使用者記帳、查帳、分析支出。
${balanceInfo}

規則：
1. record_expense / settle_debt 等寫入工具會直接寫入資料庫，不需要使用者再按確認；送出後立刻入帳。
2. 金額必須是正整數（新台幣）。
3. record_expense 的 tag 使用自由中文標籤；不確定時可省略，由後端分類器補上。
4. 當使用者說「我付的」或「我請客」，paid_by = "self"；說「對方付的」或「另一半付的」，paid_by = "partner"。
5. 預設是 shared（共同帳），除非使用者明確說「私人」。
6. 回覆使用繁體中文，簡潔友善。
7. 不要編造資料，不確定時使用工具查詢。
8. 如果使用者的意圖不明確，先詢問再行動。`;
}

async function loadSession(
  db: SupabaseClient,
  sessionId: string,
): Promise<SessionRow | null> {
  const { data } = await db
    .from("accountant_sessions")
    .select("id, messages")
    .eq("id", sessionId)
    .single();
  return (data as SessionRow) ?? null;
}

async function saveSession(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
  messages: AgentMessage[],
  ctx: ToolContext,
): Promise<void> {
  const trimmed = messages.slice(-MAX_HISTORY * 2);
  await db.from("accountant_sessions").upsert({
    id: sessionId,
    couple_id: ctx.coupleId,
    group_id: ctx.groupId,
    user_id: userId,
    messages: trimmed,
    last_active_at: new Date().toISOString(),
  });
}

function createSessionId(): string {
  return crypto.randomUUID();
}

export interface AgentInput {
  text: string;
  imageData?: string;
  mimeType?: string;
}

export async function runAgentLoop(
  input: string | AgentInput,
  sessionId: string | null,
  userId: string,
  ctx: ToolContext,
  deps: AgentDeps,
): Promise<AgentResult & { sessionId: string }> {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const normalizedInput: AgentInput = typeof input === "string"
    ? { text: input }
    : input;

  let messages: AgentMessage[] = [];
  let effectiveSessionId = sessionId;

  if (effectiveSessionId) {
    const existing = await loadSession(deps.supabase, effectiveSessionId);
    if (existing) {
      messages = existing.messages;
    }
  }

  if (!effectiveSessionId) {
    effectiveSessionId = createSessionId();
  }

  const userParts: Part[] = [];
  if (normalizedInput.imageData && normalizedInput.mimeType) {
    userParts.push({
      inlineData: {
        mimeType: normalizedInput.mimeType,
        data: normalizedInput.imageData,
      },
    });
  }
  userParts.push({ text: normalizedInput.text });
  messages.push({
    role: "user",
    parts: userParts,
  });

  const systemInstruction = await buildSystemPrompt(ctx, today);
  const pendingActions: unknown[] = [];
  let toolCallCount = 0;

  for (let i = 0; i < MAX_TOOL_CALLS; i++) {
    const response = await deps.gemini.models.generateContent({
      model: getModelConfig().modelId,
      contents: messages,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: toolDeclarations }],
      },
    });

    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts) {
      messages.push({
        role: "model",
        parts: [{ text: "抱歉，我暫時無法處理您的請求。" }],
      });
      break;
    }

    const parts = candidate.content.parts;
    const functionCalls = parts.filter(
      (p: any): p is { functionCall: { name: string; args: Record<string, unknown> } } =>
        "functionCall" in p,
    );
    const textParts = parts.filter(
      (p: any): p is { text: string } => "text" in p,
    );

    if (functionCalls.length > 0) {
      messages.push({ role: "model", parts });

      const functionResponses: Part[] = [];

      for (const fc of functionCalls) {
        toolCallCount++;
        const toolName = fc.functionCall.name;
        const toolArgs = fc.functionCall.args;

        let result: unknown;
        try {
          result = await executeTool(toolName, toolArgs, ctx);
        } catch (error) {
          result = {
            error: error instanceof Error ? error.message : "工具執行失敗",
          };
        }

        const resultRecord = result as Record<string, unknown>;
        if (resultRecord && "pending_action" in resultRecord) {
          pendingActions.push(resultRecord.pending_action);
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
      const finalText = textParts.map((p: any) => p.text).join("") || "處理完成。";
      messages.push({
        role: "model",
        parts: [{ text: finalText }],
      });

      await saveSession(deps.supabase, effectiveSessionId, userId, messages, ctx);

      return {
        answer: finalText,
        toolCallCount,
        pendingActions,
        sessionId: effectiveSessionId,
      };
    }
  }

  const summaryResponse = await deps.gemini.models.generateContent({
    model: getModelConfig().modelId,
    contents: [
      ...messages,
      { role: "user", parts: [{ text: "請用一句話總結你剛才做了什麼。" }] },
    ] as Content[],
    config: {
      systemInstruction,
    },
  });

  const summaryText =
    summaryResponse.candidates?.[0]?.content?.parts
      ?.filter((p: any): p is { text: string } => "text" in p)
      ?.map((p: any) => p.text)
      ?.join("") || "已完成處理。";

  await saveSession(deps.supabase, effectiveSessionId, userId, messages, ctx);

  return {
    answer: summaryText,
    toolCallCount,
    pendingActions,
    sessionId: effectiveSessionId,
  };
}
