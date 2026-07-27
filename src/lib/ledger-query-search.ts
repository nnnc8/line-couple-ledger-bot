/**
 * ledger-query-search — phase-4 free-text search, category drilldown,
 * and the proposal-side guard that checks settlement conflicts.
 *
 * `searchExpenses` and `categoryExpenses` resolve the active group
 * first and then run the corresponding query. `checkExpenseInSettlements`
 * and `activeGroupId` are read-only helpers used by both the search
 * path and the proposal flow.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { HttpError } from "./http-error";
import { searchExpenseRows } from "./expense-search";
import { filterAgentExpenses, type AgentTimeRange } from "./ledger-agent";
import { shiftMonth, taipeiToday } from "./ledger-shared";
import {
  categoryExpensesInputSchema,
  expenseSchema,
  expenseSearchParamsSchema,
  EXPENSE_SELECT,
  toAgentExpense,
} from "./ledger-query-core";
import { listAccessibleExpenses } from "./ledger-query-read";

/** Reads the active group id from `user_preferences`. */
export async function activeGroupId(context: {
  db: SupabaseClient;
  user: { id: string };
}) {
  const preference = await context.db
    .from("user_preferences")
    .select("active_group_id")
    .eq("user_id", context.user.id)
    .single();
  if (preference.error) throw new Error("active group lookup failed");
  return z.object({ active_group_id: z.string().uuid() }).parse(preference.data)
    .active_group_id;
}

/**
 * Free-text + range search over the active group's expenses.
 * First resolves `activeGroupId`, then calls
 * `listAccessibleExpenses` and runs `searchExpenseRows` on the rows.
 */
export async function searchExpenses(
  context: { db: SupabaseClient; user: { id: string } },
  searchParams: URLSearchParams,
) {
  const parsed = expenseSearchParamsSchema.parse(
    Object.fromEntries(searchParams.entries()),
  );
  const groupId = await activeGroupId(context);
  const rows = await listAccessibleExpenses(context.db, {
    groupId,
    userId: context.user.id,
    limitPerLedger: 500,
  });
  const expenses = searchExpenseRows(rows, { ...parsed, tag: parsed.tag });
  return { expenses, count: expenses.length };
}

/**
 * Category drilldown. Loads up to 2,000 shared + 2,000 private
 * expenses for the active group, applies the requested range / scope
 * filter, then slices the matching rows by tag + pagination.
 */
export async function categoryExpenses(
  context: { db: SupabaseClient; user: { id: string } },
  params: URLSearchParams,
) {
  const parsed = categoryExpensesInputSchema.parse({
    label: params.get("label") ?? undefined,
    range: params.get("range") ?? undefined,
    scope: params.get("scope") ?? undefined,
    month: params.get("month") ?? undefined,
    offset: params.get("offset") ?? undefined,
    limit: params.get("limit") ?? undefined,
  });
  const groupId = await activeGroupId(context);
  const [sharedResult, privateResult] = await Promise.all([
    context.db
      .from("expenses")
      .select(EXPENSE_SELECT)
      .eq("group_id", groupId)
      .order("expense_date", { ascending: false })
      .limit(2_000),
    context.db
      .from("expenses")
      .select(EXPENSE_SELECT)
      .eq("ledger", "private")
      .eq("created_by_user_id", context.user.id)
      .order("expense_date", { ascending: false })
      .limit(2_000),
  ]);
  if (sharedResult.error || privateResult.error) {
    throw new Error("category expense lookup failed");
  }
  const allExpenses = z
    .array(expenseSchema)
    .parse([...(sharedResult.data ?? []), ...(privateResult.data ?? [])]);
  const timeRange: AgentTimeRange =
    parsed.range === "six_months" ? "last_3_months" : parsed.range;
  let expenses = filterAgentExpenses({
    activeGroupId: groupId,
    expenses: allExpenses.map(toAgentExpense),
    now: taipeiToday(),
    scope: parsed.scope,
    timeRange: parsed.range === "six_months" ? "all" : timeRange,
    userId: context.user.id,
  }).filter((expense) =>
    parsed.range === "six_months"
      ? expense.expense_date >= `${shiftMonth(taipeiToday().slice(0, 7), -5)}-01`
      : true,
  );
  if (parsed.month) {
    expenses = expenses.filter((expense) =>
      expense.expense_date.startsWith(parsed.month!),
    );
  }
  const label = parsed.label;
  const expenseById = new Map(allExpenses.map((expense) => [expense.id, expense]));
  const filtered = expenses
    .filter((expense) => expense.tag === label)
    .sort((left, right) => {
      const amountDiff = right.amount_twd - left.amount_twd;
      return amountDiff || right.expense_date.localeCompare(left.expense_date);
    });
  const slice = filtered.slice(parsed.offset, parsed.offset + parsed.limit);
  return {
    label,
    total: filtered.length,
    offset: parsed.offset,
    limit: parsed.limit,
    expenses: slice.map((expense) => {
      const full = expenseById.get(expense.id);
      return {
        id: expense.id,
        description: expense.description,
        merchant: expense.merchant,
        amount_twd: expense.amount_twd,
        expense_date: expense.expense_date,
        tag: expense.tag,
        paid_by_user_id: expense.paid_by_user_id,
        version: expense.version,
      };
    }),
  };
}

/**
 * For a shared expense, refuse any change that would convert it to
 * private while an active settlement exists in its group. Private expenses return
 * `{ settled: false }`.
 */
export async function checkExpenseInSettlements(
  context: { db: SupabaseClient; user: { couple_id: number } },
  expenseId: string,
): Promise<{ settled: boolean; message: string }> {
  const expense = await context.db
    .from("expenses")
    .select("id, group_id, ledger")
    .eq("id", z.string().uuid().parse(expenseId))
    .eq("couple_id", context.user.couple_id)
    .single();
  if (expense.error) throw new HttpError(404, "找不到支出");
  if (expense.data.ledger !== "shared") {
    return { settled: false, message: "" };
  }
  const settlements = await context.db
    .from("settlements")
    .select("id", { count: "exact", head: true })
    .eq("couple_id", context.user.couple_id)
    .eq("group_id", expense.data.group_id)
    .is("voided_at", null);
  const hasSettlements =
    !settlements.error && (settlements.count ?? 0) > 0;
  return {
    settled: hasSettlements,
    message: hasSettlements
      ? "此帳已包含在結清紀錄中，且該紀錄仍有效，無法改為私人帳。請先撤銷該筆結清才能修改。"
      : "",
  };
}
