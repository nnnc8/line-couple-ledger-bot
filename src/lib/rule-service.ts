import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createMemory,
  getMemories,
  matchMerchantRule as findMerchantRule,
  type AssistantMemory,
  type MemoryKind,
  type MemoryMatch,
  type MemoryScope,
} from "./secretary-memory";

export interface MerchantRuleInput {
  ledger?: "shared" | "private";
  category?: string;
  tag?: string;
  paidBy?: "self" | "partner";
}

export interface CreateMerchantRuleInput {
  coupleId: number;
  groupId?: string | null;
  userId?: string | null;
  scope?: MemoryScope;
  merchant: string;
  rule: MerchantRuleInput;
  confidence?: number;
  source?: string;
  approvedAt?: string;
}

export class RuleService {
  constructor(private readonly db: SupabaseClient) {}

  async createMerchantRule(input: CreateMerchantRuleInput): Promise<{
    memoryId: string;
    message: string;
    memory: {
      kind: "merchant_rule";
      key: string;
      value: Record<string, unknown>;
    };
  }> {
    const scope = input.scope ?? "group";
    if (scope === "group" && !input.groupId) {
      throw new Error("group-scoped merchant rule requires groupId");
    }

    const value = buildMerchantRuleValue(input.rule);
    const memoryId = await createMemory(this.db, {
      coupleId: input.coupleId,
      groupId: input.groupId ?? null,
      userId: input.userId ?? null,
      scope,
      kind: "merchant_rule",
      key: input.merchant,
      value,
      confidence: input.confidence,
      approvedAt: input.approvedAt ?? new Date().toISOString(),
      source: input.source,
    });

    return {
      memoryId,
      message: `我記住了：之後「${input.merchant}」預設為 ${formatMerchantRuleSummary(input.rule)}。`,
      memory: {
        kind: "merchant_rule",
        key: input.merchant,
        value,
      },
    };
  }

  async listMemories(options: {
    coupleId: number;
    groupId?: string;
    userId?: string;
    kind?: MemoryKind;
    scope?: MemoryScope;
    limit?: number;
  }): Promise<AssistantMemory[]> {
    return getMemories(this.db, options);
  }

  async matchMerchantRule(options: {
    coupleId: number;
    groupId?: string;
    userId?: string;
    merchant: string;
    minConfidence?: number;
  }): Promise<MemoryMatch | null> {
    return findMerchantRule(this.db, options);
  }
}

function buildMerchantRuleValue(rule: MerchantRuleInput): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  if (rule.ledger) value.ledger = rule.ledger;
  if (rule.category) value.category = rule.category;
  if (rule.tag) value.tag = rule.tag;
  if (rule.paidBy) value.paid_by = rule.paidBy;
  return value;
}

function formatMerchantRuleSummary(rule: MerchantRuleInput): string {
  const parts: string[] = [];
  if (rule.ledger === "private") parts.push("私人帳");
  else if (rule.ledger === "shared") parts.push("共同帳");
  if (rule.tag) parts.push(rule.tag);
  if (rule.paidBy) {
    parts.push(rule.paidBy === "self" ? "你付" : "對方付");
  }
  return parts.join(" / ") || "目前設定";
}
