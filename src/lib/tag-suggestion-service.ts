/**
 * tag-suggestion-service — recommends tags for expense descriptions.
 *
 * Three-tier suggestion logic:
 *   1. Check `assistant_memories` for `merchant_rule` exact match
 *   2. Check recent 30-day tag frequency for the user
 *   3. Token overlap fuzzy match against historical tags
 *
 * Returns top-3 suggestions ranked by confidence.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isGenericCategoryTag, normalizeCategoryTag } from "./category-tags";

export interface TagSuggestion {
  tag: string;
  confidence: number;
  source: "merchant_rule" | "frequency" | "fuzzy";
}

export async function suggestTag(
  ctx: { db: SupabaseClient; coupleId: number; groupId: string; userId: string },
  description: string,
  merchant?: string,
): Promise<TagSuggestion[]> {
  const suggestions: TagSuggestion[] = [];
  const seen = new Set<string>();

  if (merchant) {
    const ruleTag = await lookupMerchantRuleTag(ctx, merchant);
    if (ruleTag && !seen.has(ruleTag)) {
      suggestions.push({ tag: ruleTag, confidence: 0.95, source: "merchant_rule" });
      seen.add(ruleTag);
    }
  }

  const freqTags = await loadTagFrequency(ctx, 30);
  for (const { tag, count } of freqTags) {
    if (seen.has(tag)) continue;
    suggestions.push({
      tag,
      confidence: Math.min(0.5 + count * 0.1, 0.9),
      source: "frequency",
    });
    seen.add(tag);
  }

  const descTokens = tokenize(description);
  for (const { tag } of freqTags) {
    if (seen.has(tag)) continue;
    const tagTokens = tokenize(tag);
    const overlap = tagTokens.filter((t) => descTokens.includes(t));
    if (overlap.length > 0) {
      const confidence = Math.min(overlap.length / Math.max(descTokens.length, 1), 0.7);
      suggestions.push({ tag, confidence, source: "fuzzy" });
      seen.add(tag);
    }
  }

  return suggestions.slice(0, 3);
}

async function lookupMerchantRuleTag(
  ctx: { db: SupabaseClient; coupleId: number; groupId: string },
  merchant: string,
): Promise<string | null> {
  try {
    const { data } = await ctx.db
      .from("assistant_memories")
      .select("value")
      .eq("couple_id", ctx.coupleId)
      .eq("kind", "merchant_rule")
      .ilike("key", `%${merchant}%`)
      .not("approved_at", "is", null)
      .limit(1)
      .single();
    if (data?.value?.tag && !isGenericCategoryTag(data.value.tag)) {
      return normalizeCategoryTag(data.value.tag);
    }
    return null;
  } catch {
    return null;
  }
}

async function loadTagFrequency(
  ctx: { db: SupabaseClient; userId: string },
  days: number,
): Promise<Array<{ tag: string; count: number }>> {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const { data, error } = await ctx.db
      .from("expenses")
      .select("tag")
      .eq("created_by_user_id", ctx.userId)
      .is("deleted_at", null)
      .gte("expense_date", cutoffStr);

    if (error || !data) return [];

    const counts = new Map<string, number>();
    for (const row of data) {
      const tag = (row as { tag?: string }).tag;
      if (tag && !isGenericCategoryTag(tag)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }

    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
  } catch {
    return [];
  }
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s,，、]+/).filter((t) => t.length > 0);
}

export function normalizeTag(input: string, suggestions: TagSuggestion[]): string {
  const normalized = input.trim();
  if (suggestions.length === 0) return normalized;

  const inputLower = normalized.toLowerCase();
  for (const s of suggestions) {
    if (s.tag.toLowerCase() === inputLower) {
      return s.tag;
    }
  }

  for (const s of suggestions) {
    const tagLower = s.tag.toLowerCase();
    const inputTokens = tokenize(normalized);
    const tagTokens = tokenize(s.tag);
    if (
      inputTokens.some((t) => tagTokens.includes(t)) ||
      tagLower.includes(inputLower) ||
      inputLower.includes(tagLower)
    ) {
      return s.tag;
    }
  }

  return normalized;
}

export async function loadTagFrequencyForPrompt(
  db: SupabaseClient,
  userId: string,
  days = 60,
): Promise<Array<{ tag: string; count: number }>> {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const { data, error } = await db
      .from("expenses")
      .select("tag")
      .eq("created_by_user_id", userId)
      .is("deleted_at", null)
      .gte("expense_date", cutoffStr);

    if (error || !data) return [];

    const counts = new Map<string, number>();
    for (const row of data) {
      const tag = (row as { tag?: string }).tag;
      if (tag && !isGenericCategoryTag(tag)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }

    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  } catch {
    return [];
  }
}
