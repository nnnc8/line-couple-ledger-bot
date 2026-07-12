/**
 * export-service — CSV export with filtering options.
 *
 * Supports period (month or all) and ledger (shared/private/all) filtering.
 * Reuses the existing `expensesCsv` formatter for consistent output format.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { expensesCsv } from "./ledger-query";
import type { AppExpense } from "./ledger-query";

export interface ExportOptions {
  period?: string;
  ledger?: "shared" | "private" | "all";
  groupId?: string;
}

export async function exportCsv(
  ctx: { db: SupabaseClient; coupleId: number; userId: string },
  options: ExportOptions,
): Promise<string> {
  const { data: users } = await ctx.db
    .from("users")
    .select("id, role, line_user_id")
    .eq("couple_id", ctx.coupleId);

  const userLabels = (users ?? []).map((u) => ({
    id: u.id,
    label: u.role === "owner" ? "你" : "另一半",
  }));

  let query = ctx.db
    .from("expenses")
    .select("*")
    .eq("couple_id", ctx.coupleId)
    .is("deleted_at", null)
    .order("expense_date", { ascending: false })
    .limit(2000);

  if (options.ledger && options.ledger !== "all") {
    query = query.eq("ledger", options.ledger);
  }

  if (options.groupId) {
    query = query.eq("group_id", options.groupId);
  }

  const result = await query;
  let expenses = result.data;
  const { error } = result;

  if (error || !expenses) {
    return "\uFEFF日期,帳本,說明,金額\r\n";
  }

  if (options.period && options.period !== "all") {
    const [year, month] = options.period.split("-");
    if (year && month) {
      const startDate = `${options.period}-01`;
      const endMonth = Number(month) === 12 ? 1 : Number(month) + 1;
      const endYear = Number(month) === 12 ? Number(year) + 1 : Number(year);
      const endDate = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;
      expenses = expenses.filter((e) => {
        return e.expense_date >= startDate && e.expense_date < endDate;
      });
    }
  }

  const appExpenses = expenses.map((e) => ({
    id: e.id,
    group_id: e.group_id,
    ledger: e.ledger,
    description: e.description,
    merchant: e.merchant,
    notes: e.notes,
    tag: e.tag,
    amount_twd: e.amount_twd,
    paid_by_user_id: e.paid_by_user_id,
    created_by_user_id: e.created_by_user_id,
    expense_date: e.expense_date,
    split_method: e.split_method,
    version: e.version,
    deleted_at: e.deleted_at,
  })) as unknown as AppExpense[];

  return expensesCsv(appExpenses, userLabels);
}
