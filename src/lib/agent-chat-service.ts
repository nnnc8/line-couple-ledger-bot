import { generateText } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { type ToolContext } from "./accountant-tools";
import { buildAccountantVercelTools } from "./accountant-tool-registry";
import { getModel } from "./model-provider";

const AGENT_MODEL = "gemini-3.1-flash-lite";
const SESSION_EXPIRE_MS = 2 * 60 * 60 * 1_000;
const MAX_HISTORY = 30;

const chatInputSchema = z.object({
  sessionId: z.string().uuid().nullable().optional(),
  message: z.string().trim().min(1).max(500),
});

type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
  tool_results?: Array<{ name: string; result: unknown }>;
};

type ChatContext = {
  db: SupabaseClient;
  user: {
    id: string;
    couple_id: number;
  };
  getActiveGroupId: () => Promise<string>;
};

export class AgentChatService {
  private readonly generateTextImpl: (input: any) => Promise<any>;
  private readonly model: string;
  private readonly sessionExpireMs: number;

  constructor(input?: {
    generateTextImpl?: (input: any) => Promise<any>;
    model?: string;
    sessionExpireMs?: number;
  }) {
    this.generateTextImpl = input?.generateTextImpl ?? generateText;
    this.model = input?.model ?? AGENT_MODEL;
    this.sessionExpireMs = input?.sessionExpireMs ?? SESSION_EXPIRE_MS;
  }

  async chat(context: ChatContext, input: unknown) {
    const parsed = chatInputSchema.parse(input);
    const groupId = await context.getActiveGroupId();

    let sessionId = parsed.sessionId ?? null;
    let messages: ChatMessage[] = [];

    if (sessionId) {
      const session = await context.db
        .from("accountant_sessions")
        .select("id, messages, last_active_at")
        .eq("id", sessionId)
        .eq("user_id", context.user.id)
        .single();

      if (
        !session.error &&
        new Date(session.data.last_active_at).getTime() >
          Date.now() - this.sessionExpireMs
      ) {
        messages = z.array(z.any()).parse(session.data.messages) as ChatMessage[];
      } else {
        sessionId = null;
      }
    }

    if (!sessionId) {
      const insert = await context.db
        .from("accountant_sessions")
        .insert({
          couple_id: context.user.couple_id,
          group_id: groupId,
          user_id: context.user.id,
        })
        .select("id")
        .single();
      if (insert.error) throw new Error("session create failed");
      sessionId = z.object({ id: z.string().uuid() }).parse(insert.data).id;
    }

    messages.push({ role: "user", content: parsed.message });

    const toolCtx: ToolContext = {
      db: context.db,
      groupId,
      userId: context.user.id,
      coupleId: context.user.couple_id,
    };

    const coreMessages: any[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "user") {
        coreMessages.push({ role: "user", content: msg.content });
        continue;
      }
      if (msg.role === "assistant") {
        if (msg.tool_calls?.length) {
          coreMessages.push({
            role: "assistant",
            content: msg.content,
            toolCalls: msg.tool_calls.map((toolCall, index) => ({
              type: "function",
              id: `call_${i}_${index}`,
              name: toolCall.name,
              args: toolCall.args,
            })),
          });
        } else {
          coreMessages.push({ role: "assistant", content: msg.content });
        }
        continue;
      }
      if (msg.tool_results?.length) {
        coreMessages.push({
          role: "tool",
          content: msg.tool_results.map((toolResult, index) => ({
            type: "tool-result" as const,
            toolCallId: `call_${i - 1}_${index}`,
            toolName: toolResult.name,
            result: toolResult.result,
          })),
        });
      }
    }

    const result = await this.generateTextImpl({
      model: getModel(this.model),
      system:
        "你是台灣情侶帳本的 AI 會計師。你有工具可以查詢帳務資料。" +
        "根據使用者的問題，自己決定需要查什麼資料，用工具查詢後再回答。" +
        "回答用繁體中文、口語、簡短。數字要具體。" +
        "你只能讀取資料，不能修改帳務。如果使用者要改帳，告訴他到 LIFF 操作。" +
        "不要捏造數字，所有數字都必須來自工具查詢結果。",
      messages: coreMessages,
      temperature: 0.3,
      tools: buildAccountantVercelTools(toolCtx),
      stopWhen: ({ steps }: any) => steps.length >= 8,
    });

    let toolCallCount = 0;
    for (const step of Array.isArray(result.steps) ? result.steps : []) {
      if (step.toolCalls?.length) {
        toolCallCount += step.toolCalls.length;
        messages.push({
          role: "assistant",
          content: step.text ?? "",
          tool_calls: step.toolCalls.map((toolCall: any) => ({
            name: toolCall.toolName,
            args: toolCall.args,
          })),
        });
        messages.push({
          role: "tool",
          content: "",
          tool_results: (step.toolResults ?? []).map((toolResult: any) => ({
            name: toolResult.toolName,
            result: toolResult.result,
          })),
        });
      }
    }

    const assistantResponse = result.text || "已為您處理完畢。";
    messages.push({ role: "assistant", content: assistantResponse });

    await context.db
      .from("accountant_sessions")
      .update({
        messages: messages.slice(-MAX_HISTORY),
        last_active_at: new Date().toISOString(),
      })
      .eq("id", sessionId);

    return {
      sessionId,
      answer: assistantResponse,
      toolCallCount,
    };
  }

  async transcribeAudio(audioBytes: Buffer, mimeType: string): Promise<string> {
    const response = await this.generateTextImpl({
      model: getModel(this.model),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              data: audioBytes,
              mimeType,
            },
            {
              type: "text",
              text: "把這段語音轉成文字。只輸出辨識到的文字內容，不加任何前綴或說明。如果聽不清楚，回傳空字串。",
            },
          ],
        },
      ],
      temperature: 0,
    });
    return String(response.text ?? "").trim();
  }
}
