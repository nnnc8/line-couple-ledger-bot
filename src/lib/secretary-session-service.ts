import type { Part } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";

import { RuleService } from "./rule-service";
import type { MemoryMatch } from "./secretary-memory";
import type { SecretaryInput } from "./secretary-agent";

const MAX_HISTORY = 30;
const SESSION_TTL_MS = 30 * 60 * 1000;

export interface SecretaryAgentMessage {
  role: "user" | "model";
  parts: Part[];
}

export class SecretarySessionService {
  private readonly db: SupabaseClient;
  private readonly createSessionId: () => string;
  private readonly matchMerchantRuleImpl: (input: {
    coupleId: number;
    groupId: string;
    userId: string;
    merchant: string;
    minConfidence?: number;
  }) => Promise<MemoryMatch | null>;

  constructor(input: {
    db: SupabaseClient;
    createSessionId?: () => string;
    matchMerchantRule?: (input: {
      coupleId: number;
      groupId: string;
      userId: string;
      merchant: string;
      minConfidence?: number;
    }) => Promise<MemoryMatch | null>;
  }) {
    this.db = input.db;
    this.createSessionId = input.createSessionId ?? (() => crypto.randomUUID());
    this.matchMerchantRuleImpl =
      input.matchMerchantRule ??
      ((options) => new RuleService(this.db).matchMerchantRule(options));
  }

  async prepareTurn(input: {
    input: SecretaryInput;
    sessionId: string | null;
    userId: string;
    coupleId: number;
    groupId: string;
    userName: string;
  }): Promise<{
    sessionId: string;
    messages: SecretaryAgentMessage[];
  }> {
    let messages: SecretaryAgentMessage[] = [];
    let effectiveSessionId = input.sessionId;

    if (effectiveSessionId) {
      const existing = await this.loadSession(input.coupleId, input.groupId);
      if (existing) {
        messages = existing.messages;
        effectiveSessionId = existing.id;
      }
    }

    if (!effectiveSessionId) {
      effectiveSessionId = this.createSessionId();
    }

    const augmentedText = await this.augmentText({
      coupleId: input.coupleId,
      groupId: input.groupId,
      userId: input.userId,
      text: input.input.text,
    });

    const userParts: Part[] = [];
    if (input.input.imageData && input.input.mimeType) {
      userParts.push({
        inlineData: { mimeType: input.input.mimeType, data: input.input.imageData },
      });
    }
    userParts.push({ text: `[${input.userName}] ${augmentedText}` });

    return {
      sessionId: effectiveSessionId,
      messages: [...messages, { role: "user", parts: userParts }],
    };
  }

  async saveTurn(input: {
    sessionId: string;
    userId: string;
    coupleId: number;
    groupId: string;
    messages: SecretaryAgentMessage[];
    answer: string;
  }): Promise<void> {
    const nextMessages = [
      ...input.messages,
      {
        role: "model" as const,
        parts: [{ text: input.answer }],
      },
    ];
    const trimmed = nextMessages.slice(-MAX_HISTORY * 2);

    await this.db.from("secretary_sessions").upsert({
      id: input.sessionId,
      couple_id: input.coupleId,
      group_id: input.groupId,
      messages: trimmed,
      last_active_user_id: input.userId,
      last_active_at: new Date().toISOString(),
    });
  }

  private async loadSession(
    coupleId: number,
    groupId: string,
  ): Promise<{ id: string; messages: SecretaryAgentMessage[] } | null> {
    const { data } = await this.db
      .from("secretary_sessions")
      .select("id, messages, last_active_at")
      .eq("couple_id", coupleId)
      .eq("group_id", groupId)
      .order("last_active_at", { ascending: false })
      .limit(1)
      .single();

    if (!data) return null;

    const lastActiveAt = (data as { last_active_at?: string }).last_active_at;
    if (lastActiveAt) {
      const elapsed = Date.now() - new Date(lastActiveAt).getTime();
      if (elapsed > SESSION_TTL_MS) {
        return null;
      }
    }

    return {
      id: (data as { id: string }).id,
      messages: (data as { messages: SecretaryAgentMessage[] }).messages ?? [],
    };
  }

  private async augmentText(input: {
    coupleId: number;
    groupId: string;
    userId: string;
    text: string;
  }): Promise<string> {
    const merchantMatch = await this.matchMerchantRuleImpl({
      coupleId: input.coupleId,
      groupId: input.groupId,
      userId: input.userId,
      merchant: input.text,
      minConfidence: 0.7,
    });

    if (!merchantMatch?.memory.approved_at) {
      return input.text;
    }

    const rule = merchantMatch.memory.value;
    const ruleDesc = [];
    if (rule.ledger) ruleDesc.push(rule.ledger === "private" ? "私人" : "共同");
    if (rule.tag) ruleDesc.push(String(rule.tag));
    if (rule.paid_by) ruleDesc.push(rule.paid_by === "self" ? "你付" : "對方付");
    return `${input.text}（已知規則：${ruleDesc.join(", ")}，幫我直接套用）`;
  }
}
