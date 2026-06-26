/**
 * Agent Loop for LINE Bot.
 * Receives user messages, calls Gemini with tools, executes tool calls,
 * and returns final responses.
 */

import { GoogleGenAI } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Content, Part } from "@google/genai";

import {
  toolDeclarations,
  executeTool,
  type ToolContext,
} from "./accountant-tools";

/* ─── Types ─── */

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

/* ─── Constants ─── */

const AGENT_MODEL = "gemini-3.1-flash-lite";
const MAX_TOOL_CALLS = 8;
const MAX_HISTORY = 30;

/* ─── System prompt ─── */

async function buildSystemPrompt(ctx: ToolContext, today: string): Promise<string> {
  // Fetch current balance and budget status
  const [balanceResult, budgetResult] = await Promise.all([
    ctx.db.rpc("group_balances", { p_group_id: ctx.groupId }),
    ctx.db
      .from("budgets")
      .select("category, category_label, limit_twd")
      .eq("group_id", ctx.groupId)
      .is("archived_at", null),
  ]);

  // Build balance info
  let balanceInfo = "";
  if (!balanceResult.error && balanceResult.data) {
    const balances = balanceResult.data as Array<{ user_id: string; balance_twd: number }>;
    const myBalance = balances.find((b) => b.user_id === ctx.userId)?.balance_twd ?? 0;
    if (myBalance > 0) {
      balanceInfo = `\n目前狀態：對方欠你 NT$${myBalance}`;
    } else if (myBalance < 0) {
      balanceInfo = `\n目前狀態：你欠對方 NT$${Math.abs(myBalance)}`;
    } else {
      balanceInfo = "\n目前狀態：帳務已結清";
    }
  }

  // Build budget info
  let budgetInfo = "";
  if (!budgetResult.error && budgetResult.data && budgetResult.data.length > 0) {
    const budgetLines = budgetResult.data
      .filter((b) => b.limit_twd)
      .map((b) => {
        const label = b.category_label ?? b.category ?? "總預算";
        return `${label}: NT$${b.limit_twd}`;
      });
    if (budgetLines.length > 0) {
      budgetInfo = `\n預算設定：${budgetLines.join("、")}`;
    }
  }

  return `你是一個情侶記帳系統的 AI 助理。今天是 ${today}。
你的职责是幫助使用者記帳、查帳、分析支出、設定預算等。
${balanceInfo}${budgetInfo}

規則：
1. 使用 record_expense 工具時，必須回傳 pending_action，讓使用者在 LINE 上確認。
2. 金額必須是正整數（新台幣）。
3. 分類使用英文 enum：food / transport / shopping / entertainment / housing / utilities / health / education / travel / other。
4. 當使用者說「我付的」或「我請客」，paid_by = "self"；說「對方付的」或「另一半付的」，paid_by = "partner"。
5. 預設是 shared（共同帳），除非使用者明確說「私人」。
6. 回覆使用繁體中文，簡潔友善。
7. 不要編造資料，不確定時使用工具查詢。
8. 如果使用者的意圖不明確，先詢問再行動。`;
}

/* ─── Session management ─── */

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

/* ─── Main agent loop ─── */

export interface AgentInput {
  text: string;
  imageData?: string; // base64 encoded image
  mimeType?: string; // image/jpeg, image/png, etc.
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

  // Normalize input
  const normalizedInput: AgentInput = typeof input === "string"
    ? { text: input }
    : input;

  // Load or create session
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

  // Append user message (with or without image)
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

  // Agent loop
  for (let i = 0; i < MAX_TOOL_CALLS; i++) {
    const response = await deps.gemini.models.generateContent({
      model: AGENT_MODEL,
      contents: messages,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: toolDeclarations }],
      },
    });

    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts) {
      // No response from Gemini
      messages.push({
        role: "model",
        parts: [{ text: "抱歉，我暫時無法處理您的請求。" }],
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

    // If there are function calls, execute them
    if (functionCalls.length > 0) {
      // Append model message with function calls
      messages.push({
        role: "model",
        parts: functionCalls.map((fc) => ({ functionCall: fc.functionCall })),
      });

      // Execute each tool call
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

        // Check if this is a write tool that produced a pending action
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

      // Append function responses
      messages.push({
        role: "user",
        parts: functionResponses,
      });
    } else {
      // No function calls — this is the final text response
      const finalText = textParts.map((p) => p.text).join("") || "處理完成。";
      messages.push({
        role: "model",
        parts: [{ text: finalText }],
      });

      // Save session
      await saveSession(deps.supabase, effectiveSessionId, userId, messages, ctx);

      return {
        answer: finalText,
        toolCallCount,
        pendingActions,
        sessionId: effectiveSessionId,
      };
    }
  }

  // If we exhausted tool calls, generate a summary
  const summaryResponse = await deps.gemini.models.generateContent({
    model: AGENT_MODEL,
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
      ?.filter((p): p is { text: string } => "text" in p)
      .map((p) => p.text)
      .join("") || "已完成處理。";

  await saveSession(deps.supabase, effectiveSessionId, userId, messages, ctx);

  return {
    answer: summaryText,
    toolCallCount,
    pendingActions,
    sessionId: effectiveSessionId,
  };
}
