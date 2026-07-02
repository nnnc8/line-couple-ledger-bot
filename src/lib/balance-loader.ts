/**
 * loadGroupBalances — single typed entry point for the group_balances RPC.
 *
 * Why this exists: every previous call site called `db.rpc("group_balances",
 * { p_group_id })` and then re-parsed the rows locally, with slightly
 * different schemas and slightly different error messages. That made it
 * trivially easy to add a call site that forgot to handle the empty case
 * or to mis-parse a numeric column. Centralizing it makes the contract
 * one place to maintain, and lets us swap to a different SQL surface later
 * without touching consumers.
 *
 * The underlying `public.group_balances(uuid)` function is preserved as-is
 * for now; this helper only consolidates the call pattern.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export interface GroupBalanceRow {
  userId: string;
  balanceTwd: number;
}

const rpcRowSchema = z.object({
  user_id: z.string(),
  balance_twd: z.coerce.number().int(),
});

const rpcRowArraySchema = z.array(rpcRowSchema);

export async function loadGroupBalances(
  db: SupabaseClient,
  groupId: string,
): Promise<GroupBalanceRow[]> {
  if (!groupId) {
    throw new Error("loadGroupBalances: groupId is required");
  }
  const result = await db.rpc("group_balances", { p_group_id: groupId });
  if (result.error) {
    throw new Error("balance lookup failed");
  }
  return rpcRowArraySchema
    .parse(result.data ?? [])
    .map((row) => ({ userId: row.user_id, balanceTwd: row.balance_twd }));
}
