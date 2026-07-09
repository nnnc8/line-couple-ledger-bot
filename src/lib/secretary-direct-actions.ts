/**
 * secretary-direct-actions — direct DB mutations for private expenses.
 *
 * Private expenses only affect the user's own money, so they can be
 * updated or deleted directly without the pending-action confirmation
 * flow required for shared expenses.
 *
 * Prerequisites for any direct action:
 *   - expense.ledger === 'private'
 *   - expense.created_by_user_id === ctx.userId
 *   - expense.deleted_at === null
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolContext } from "./accountant-tools";

interface ExpenseOwnershipRow {
  id: string;
  ledger: string;
  created_by_user_id: string;
  deleted_at: string | null;
  description: string;
  version: number;
}

async function checkPrivateOwnership(
  db: SupabaseClient,
  expenseId: string,
  userId: string,
): Promise<ExpenseOwnershipRow | null> {
  const { data, error } = await db
    .from("expenses")
    .select("id, ledger, created_by_user_id, deleted_at, description, version")
    .eq("id", expenseId)
    .single();

  if (error || !data) return null;
  const row = data as ExpenseOwnershipRow;
  if (row.ledger !== "private") return null;
  if (row.created_by_user_id !== userId) return null;
  if (row.deleted_at !== null) return null;
  return row;
}

async function findPartnerUserId(
  db: SupabaseClient,
  coupleId: number,
  userId: string,
): Promise<string | null> {
  const { data } = await db
    .from("users")
    .select("id")
    .eq("couple_id", coupleId)
    .neq("id", userId)
    .maybeSingle();
  return data?.id ?? null;
}

export async function executeDirectUpdate(
  ctx: ToolContext,
  expenseId: string,
  updates: {
    tag?: string;
    description?: string;
    amount_twd?: number;
    paid_by?: "self" | "partner";
    expense_date?: string;
  },
): Promise<{ result: "done"; message: string } | { error: string }> {
  const row = await checkPrivateOwnership(ctx.db, expenseId, ctx.userId);
  if (!row) {
    return { error: "找不到這筆私人支出，或你沒有權限直接修改。" };
  }

  const updateData: Record<string, unknown> = {};
  if (updates.tag !== undefined) updateData.tag = updates.tag;
  if (updates.description !== undefined) updateData.description = updates.description;
  if (updates.amount_twd !== undefined) updateData.amount_twd = updates.amount_twd;
  if (updates.expense_date !== undefined) updateData.expense_date = updates.expense_date;
  if (updates.paid_by !== undefined) {
    if (updates.paid_by === "self") {
      updateData.paid_by_user_id = ctx.userId;
    } else {
      const partnerId = await findPartnerUserId(ctx.db, ctx.coupleId, ctx.userId);
      updateData.paid_by_user_id = partnerId ?? ctx.userId;
    }
  }

  if (Object.keys(updateData).length === 0) {
    return { error: "沒有可修改的欄位。" };
  }

  updateData.version = row.version + 1;
  updateData.updated_at = new Date().toISOString();

  const { error: updateError } = await ctx.db
    .from("expenses")
    .update(updateData)
    .eq("id", expenseId)
    .eq("version", row.version);

  if (updateError) {
    return { error: "修改失敗，請稍後再試。" };
  }

  const changedFields = Object.keys(updates)
    .map((k) => fieldLabel(k))
    .filter(Boolean)
    .join("、");

  return {
    result: "done",
    message: `已直接修改：${row.description}（${changedFields}）。`,
  };
}

export async function executeDirectDelete(
  ctx: ToolContext,
  expenseId: string,
): Promise<{ result: "done"; message: string } | { error: string }> {
  const row = await checkPrivateOwnership(ctx.db, expenseId, ctx.userId);
  if (!row) {
    return { error: "找不到這筆私人支出，或你沒有權限直接刪除。" };
  }

  const { error: deleteError } = await ctx.db
    .from("expenses")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by_user_id: ctx.userId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", expenseId)
    .eq("version", row.version)
    .is("deleted_at", null);

  if (deleteError) {
    return { error: "刪除失敗，請稍後再試。" };
  }

  return {
    result: "done",
    message: `已刪除：${row.description}。`,
  };
}

function fieldLabel(key: string): string {
  const map: Record<string, string> = {
    ledger: "帳本類型",
    tag: "標籤",
    description: "說明",
    amount_twd: "金額",
    paid_by: "付款人",
    expense_date: "日期",
  };
  return map[key] ?? key;
}
