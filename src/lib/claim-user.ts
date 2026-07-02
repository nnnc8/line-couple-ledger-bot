/**
 * claimUser — TS replacement for the legacy public.claim_user(text) RPC.
 *
 * Behavior contract (preserved exactly from the SQL function):
 *   - line_user_id already exists                  -> "already_joined" + role
 *   - couple already has 2 users                   -> "full"
 *   - first user to claim                          -> "joined" + "owner"
 *   - second user to claim                         -> "joined" + "partner"
 *
 * Race-safety: the DB enforces UNIQUE(line_user_id) and UNIQUE(couple_id,
 * role). We rely on those constraints instead of a `lock table`; on a 23505
 * unique_violation we re-classify the result deterministically.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export type ClaimResult =
  | { result: "joined"; role: "owner" | "partner" }
  | { result: "already_joined"; role: "owner" | "partner" }
  | { result: "full" };

const userRowSchema = z.object({
  id: z.string().uuid(),
  couple_id: z.number().int(),
  line_user_id: z.string(),
  role: z.enum(["owner", "partner"]),
});

const coupleIdSchema = z.number().int().positive();

function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return Boolean(error && error.code === "23505");
}

export async function claimUser(
  db: SupabaseClient,
  lineUserId: string,
): Promise<ClaimResult> {
  if (typeof lineUserId !== "string" || lineUserId.length < 1 || lineUserId.length > 100) {
    throw new Error("invalid line user id");
  }

  // 1. Already joined?
  const existingRes = await db
    .from("users")
    .select("id, couple_id, line_user_id, role")
    .eq("line_user_id", lineUserId)
    .maybeSingle();
  if (existingRes.error) throw new Error("claim_user lookup failed");
  const existing = existingRes.data ? userRowSchema.parse(existingRes.data) : null;
  if (existing) {
    return { result: "already_joined", role: existing.role };
  }

  // 2. Couple full? (caller contract: single couple with id 1)
  const countRes = await db
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("couple_id", 1);
  if (countRes.error) throw new Error("claim_user count failed");
  const count = countRes.count ?? 0;
  if (count >= 2) return { result: "full" };

  const role: "owner" | "partner" = count === 0 ? "owner" : "partner";

  // 3. Insert. The (couple_id default 1, role) unique index + line_user_id
  //    unique constraint are the actual race guard. We re-classify on 23505.
  const insertRes = await db
    .from("users")
    .insert({ line_user_id: lineUserId, role, couple_id: coupleIdSchema.parse(1) })
    .select("id, couple_id, line_user_id, role")
    .single();
  if (!insertRes.error && insertRes.data) {
    return { result: "joined", role: userRowSchema.parse(insertRes.data).role };
  }
  if (!isUniqueViolation(insertRes.error)) {
    throw new Error("claim_user insert failed");
  }

  // 4. Race: another writer inserted first. Re-resolve deterministically.
  const recheck = await db
    .from("users")
    .select("id, couple_id, line_user_id, role")
    .eq("line_user_id", lineUserId)
    .maybeSingle();
  if (recheck.error) throw new Error("claim_user re-lookup failed");
  if (recheck.data) {
    return { result: "already_joined", role: userRowSchema.parse(recheck.data).role };
  }
  // The unique violation was on (couple_id, role) — couple now has 2 members.
  return { result: "full" };
}
