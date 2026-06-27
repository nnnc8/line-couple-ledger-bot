/**
 * Assistant Memory helpers.
 * Stores user/couple/group preferences, merchant rules, and routines.
 * Memories are matched by key (e.g., merchant name, category label)
 * and applied as defaults when creating expenses.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/* ─── Consts ─── */

const MEMORY_KINDS = [
  "merchant_rule",
  "category_rule",
  "split_rule",
  "routine",
  "wording_preference",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryScope = "user" | "couple" | "group";

/* ─── Types ─── */

export interface AssistantMemory {
  id: string;
  couple_id: number;
  group_id: string | null;
  user_id: string | null;
  scope: MemoryScope;
  kind: MemoryKind;
  key: string;
  value: Record<string, unknown>;
  confidence: number;
  source: string | null;
  approved_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateMemoryInput {
  coupleId: number;
  groupId?: string | null;
  userId?: string | null;
  scope: MemoryScope;
  kind: MemoryKind;
  key: string;
  value: Record<string, unknown>;
  confidence?: number;
  source?: string;
  approvedAt?: string;
}

export interface MemoryMatch {
  memory: AssistantMemory;
  matchScore: number;
}

const memoryRowSchema = z.object({
  id: z.string().uuid(),
  couple_id: z.number().int(),
  group_id: z.string().uuid().nullable(),
  user_id: z.string().uuid().nullable(),
  scope: z.enum(["user", "couple", "group"]),
  kind: z.enum(MEMORY_KINDS),
  key: z.string(),
  value: z.record(z.string(), z.unknown()),
  confidence: z.number().min(0).max(1),
  source: z.string().nullable(),
  approved_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/* ─── Create ─── */

export async function createMemory(
  db: SupabaseClient,
  input: CreateMemoryInput,
): Promise<string> {
  const { data, error } = await db
    .from("assistant_memories")
    .insert({
      couple_id: input.coupleId,
      group_id: input.groupId ?? null,
      user_id: input.userId ?? null,
      scope: input.scope,
      kind: input.kind,
      key: normalizeMemoryKey(input.key),
      value: input.value,
      confidence: input.confidence ?? 0.8,
      source: input.source ?? null,
      approved_at: input.approvedAt ?? null,
    })
    .select("id")
    .single();

  if (error) throw new Error(`create memory failed: ${error.message}`);
  return z.object({ id: z.string().uuid() }).parse(data).id;
}

/* ─── Query ─── */

export async function getMemories(
  db: SupabaseClient,
  options: {
    coupleId: number;
    groupId?: string;
    userId?: string;
    kind?: MemoryKind;
    scope?: MemoryScope;
    limit?: number;
  },
): Promise<AssistantMemory[]> {
  let query = db
    .from("assistant_memories")
    .select("*")
    .eq("couple_id", options.coupleId)
    .is("expires_at", null)
    .order("confidence", { ascending: false })
    .order("created_at", { ascending: false });

  if (options.groupId) {
    query = query.eq("group_id", options.groupId);
  }
  if (options.userId) {
    query = query.or(`user_id.eq.${options.userId},scope.eq.couple,scope.eq.group`);
  }
  if (options.kind) {
    query = query.eq("kind", options.kind);
  }
  if (options.scope) {
    query = query.eq("scope", options.scope);
  }
  if (options.limit) {
    query = query.limit(options.limit);
  } else {
    query = query.limit(50);
  }

  const { data, error } = await query;
  if (error) throw new Error(`get memories failed: ${error.message}`);
  return z.array(memoryRowSchema).parse(data).map(toMemory);
}

export async function getMemory(
  db: SupabaseClient,
  memoryId: string,
): Promise<AssistantMemory | null> {
  const { data, error } = await db
    .from("assistant_memories")
    .select("*")
    .eq("id", z.string().uuid().parse(memoryId))
    .single();

  if (error) return null;
  return toMemory(memoryRowSchema.parse(data));
}

/* ─── Match ─── */

/**
 * Match a text query against stored memories.
 * Returns the best match based on key normalization + confidence.
 */
export async function matchMemory(
  db: SupabaseClient,
  options: {
    coupleId: number;
    groupId?: string;
    userId?: string;
    kind?: MemoryKind;
    key: string;
    minConfidence?: number;
  },
): Promise<MemoryMatch | null> {
  const normalizedKey = normalizeMemoryKey(options.key);
  const memories = await getMemories(db, {
    coupleId: options.coupleId,
    groupId: options.groupId,
    userId: options.userId,
    kind: options.kind,
  });

  if (memories.length === 0) return null;

  // Simple fuzzy match: exact key match or key contained in query
  const best = memories.find((m) => m.key === normalizedKey);

  if (best && best.confidence >= (options.minConfidence ?? 0.6)) {
    return { memory: best, matchScore: 1.0 };
  }

  return null;
}

/**
 * Match merchant text against merchant_rule memories.
 * Returns the best matching memory or null.
 */
export async function matchMerchantRule(
  db: SupabaseClient,
  options: {
    coupleId: number;
    groupId?: string;
    userId?: string;
    merchant: string;
    minConfidence?: number;
  },
): Promise<MemoryMatch | null> {
  return matchMemory(db, {
    coupleId: options.coupleId,
    groupId: options.groupId,
    userId: options.userId,
    kind: "merchant_rule",
    key: options.merchant,
    minConfidence: options.minConfidence,
  });
}

/* ─── Update / Delete ─── */

export async function updateMemory(
  db: SupabaseClient,
  memoryId: string,
  updates: Partial<{
    value: Record<string, unknown>;
    confidence: number;
    scope: MemoryScope;
    expiresAt: string | null;
  }>,
): Promise<void> {
  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (updates.value !== undefined) payload.value = updates.value;
  if (updates.confidence !== undefined) payload.confidence = updates.confidence;
  if (updates.scope !== undefined) payload.scope = updates.scope;
  if ("expiresAt" in updates) {
    payload.expires_at = updates.expiresAt ?? null;
  }

  await db
    .from("assistant_memories")
    .update(payload)
    .eq("id", z.string().uuid().parse(memoryId));
}

export async function approveMemory(
  db: SupabaseClient,
  memoryId: string,
): Promise<void> {
  await db
    .from("assistant_memories")
    .update({
      approved_at: new Date().toISOString(),
      confidence: 1.0,
      updated_at: new Date().toISOString(),
    })
    .eq("id", z.string().uuid().parse(memoryId));
}

export async function deleteMemory(
  db: SupabaseClient,
  memoryId: string,
): Promise<void> {
  await db
    .from("assistant_memories")
    .update({
      expires_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", z.string().uuid().parse(memoryId));
}

/* ─── Balance Detection ─── */

export async function partnerWording(
  db: SupabaseClient,
  coupleId: number,
): Promise<{ his: string; her: string }> {
  const memories = await getMemories(db, {
    coupleId,
    kind: "wording_preference",
    limit: 5,
  });

  const wording = memories.find(
    (m) => m.key === "partner_labels",
  );

  if (wording?.value) {
    const v = wording.value as { his?: string; her?: string };
    return {
      his: v.his ?? "他",
      her: v.her ?? "她",
    };
  }

  return { his: "他", her: "她" };
}

/* ─── Helpers ─── */

function normalizeMemoryKey(key: string): string {
  return key
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .slice(0, 200);
}

function toMemory(row: z.infer<typeof memoryRowSchema>): AssistantMemory {
  return {
    id: row.id,
    couple_id: row.couple_id,
    group_id: row.group_id,
    user_id: row.user_id,
    scope: row.scope,
    kind: row.kind,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    source: row.source,
    approved_at: row.approved_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
