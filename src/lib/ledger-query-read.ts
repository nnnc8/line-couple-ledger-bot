/**
 * ledger-query-read — read-side tool methods.
 *
 * Each function in this file is a plain exported function that
 * previously lived as a `LedgerQueryService` method. The class facade
 * in `ledger-query.ts` re-exposes them as methods without changing
 * the contract.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { loadGroupBalances } from "./balance-loader";
import {
  balanceSummarySchema,
  ledgerVisibleExpenseQuerySchema,
  ledgerVisibleExpenseSchema,
  queryExpensesInputSchema,
  RECENT_SELECT,
  RECURRING_SELECT,
  recentExpensesInputSchema,
  recentExpensesResultSchema,
  recurringItemSchema,
  recurringListResultSchema,
  SELECT_FIELDS,
  summarizeExpenses,
  type BalanceSummary,
  type LedgerVisibleExpense,
  type QueryExpensesInput,
  type QueryExpensesItem,
  type QueryExpensesSummary,
  type RecentExpensesInput,
  type RecentExpensesResult,
  type RecurringListResult,
} from "./ledger-query-core";

/**
 * Run a tool-style query. Returns either an aggregate summary alone
 * (no `limit`) or a summary + items (with `limit`, sorted by
 * `date_desc` or `amount_desc`).
 */
export async function queryExpenses(
  context: { db: SupabaseClient; groupId: string; userId: string },
  rawInput: QueryExpensesInput,
): Promise<
  | { summary: QueryExpensesSummary; items?: QueryExpensesItem[] }
  | { error: string }
> {
  const parsed = queryExpensesInputSchema.parse(rawInput);
  const expenses = await listAccessibleExpenses(context.db, {
    groupId: context.groupId,
    userId: context.userId,
    dateFrom: parsed.dateFrom,
    dateTo: parsed.dateTo,
    tag: parsed.tag,
    member: parsed.member,
    type: parsed.type,
    limitPerLedger: 500,
  });
  const summary = summarizeExpenses(expenses);
  if (!parsed.limit) {
    return { summary };
  }
  const sorted =
    parsed.sort === "amount_desc"
      ? [...expenses].sort((a, b) => b.amount_twd - a.amount_twd)
      : [...expenses].sort((a, b) =>
          b.expense_date.localeCompare(a.expense_date),
        );
  const items = sorted.slice(0, parsed.limit).map((expense) => ({
    id: expense.id,
    description: expense.description,
    merchant: expense.merchant,
    tag: expense.tag,
    amount: expense.amount_twd,
    date: expense.expense_date,
    ledger: expense.ledger,
  }));
  return { summary, items };
}

/**
 * "另一半欠你 NT$…", "你欠另一半 NT$…", or "已結清". Returns
 * `{ error: ... }` on balance lookup failure.
 */
export async function balanceSummary(
  context: { db: SupabaseClient; groupId: string; userId: string },
): Promise<BalanceSummary | { error: string }> {
  let balances: Array<{ userId: string; balanceTwd: number }>;
  try {
    balances = await loadGroupBalances(context.db, context.groupId);
  } catch {
    return { error: "balance lookup failed" };
  }
  const me = balances.find((row) => row.userId === context.userId);
  const partner = balances.find((row) => row.userId !== context.userId);
  const myBalance = me?.balanceTwd ?? 0;
  const partnerBalance = partner?.balanceTwd ?? 0;
  const summary =
    myBalance > 0
      ? `另一半欠你 NT$${myBalance}`
      : myBalance < 0
        ? `你欠另一半 NT$${Math.abs(myBalance)}`
        : "已結清";
  return balanceSummarySchema.parse({
    my_balance: myBalance,
    partner_balance: partnerBalance,
    summary,
  });
}

/**
 * Recent shared + private expenses (de-duped, sorted by created_at
 * desc, mirror rows excluded).
 */
export async function recentExpenses(
  context: { db: SupabaseClient; groupId: string; userId: string },
  rawInput: RecentExpensesInput,
): Promise<RecentExpensesResult> {
  const input = recentExpensesInputSchema.parse(rawInput);
  const queries: Promise<{ data: unknown[] | null; error: unknown }>[] = [];

  if (input.ledger !== "private") {
    queries.push(
      context.db
        .from("expenses")
        .select(RECENT_SELECT)
        .eq("group_id", context.groupId)
        .is("mirror_kind", null)
        .order("created_at", { ascending: false })
        .limit(input.limit) as unknown as Promise<{
        data: unknown[] | null;
        error: unknown;
      }>,
    );
  }

  if (input.ledger !== "shared") {
    queries.push(
      context.db
        .from("expenses")
        .select(RECENT_SELECT)
        .eq("ledger", "private")
        .eq("created_by_user_id", context.userId)
        .is("mirror_kind", null)
        .order("created_at", { ascending: false })
        .limit(input.limit) as unknown as Promise<{
        data: unknown[] | null;
        error: unknown;
      }>,
    );
  }

  const results = await Promise.all(queries);
  const rows = results.flatMap((result) =>
    result.error ? [] : (result.data as Array<Record<string, unknown>>),
  );

  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    const id = String(row.id);
    const deletedAt = row.deleted_at as string | null | undefined;
    if (!id || deletedAt || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const sorted = unique
    .sort((a, b) => {
      const left = String(a.created_at ?? "");
      const right = String(b.created_at ?? "");
      if (right === left) return 0;
      return right.localeCompare(left);
    })
    .slice(0, input.limit);

  const items = sorted.map((row) => ({
    id: String(row.id),
    description: String(row.description ?? ""),
    merchant: (row.merchant as string | null) ?? null,
    tag: String(row.tag ?? ""),
    amount_twd: Number(row.amount_twd ?? 0),
    ledger: row.ledger === "private" ? "private" : "shared",
    expense_date: String(row.expense_date ?? ""),
    paid_by:
      String(row.paid_by_user_id ?? "") === context.userId ? "self" : "partner",
    version: Number(row.version ?? 0),
  }));

  return recentExpensesResultSchema.parse({
    count: items.length,
    items,
  });
}

/** Couple-scoped recurring list mapped to the tool contract. */
export async function recurringList(
  context: { db: SupabaseClient; coupleId: number },
): Promise<RecurringListResult | { error: string }> {
  const result = await context.db
    .from("recurring_expenses")
    .select(RECURRING_SELECT)
    .eq("couple_id", context.coupleId)
    .order("next_run_date");
  if (result.error) return { error: "recurring lookup failed" };
  const items = (result.data ?? []).map((row) => ({
    description: String(row.description ?? ""),
    amount: Number(row.amount_twd ?? 0),
    frequency: String(row.frequency ?? ""),
    next_run: String(row.next_run_date ?? ""),
    active: Boolean(row.active),
    tag: String(row.tag ?? ""),
    ledger: row.ledger === "private" ? "private" : "shared",
  }));
  return recurringListResultSchema.parse({ items });
}

/**
 * Shared + private expenses visible to the requesting user, filtered
 * by date / tag / member / type. Mirror rows are excluded. Used by
 * the tool path (query_expenses, recent, search).
 */
export async function listAccessibleExpenses(
  db: SupabaseClient,
  input: z.input<typeof ledgerVisibleExpenseQuerySchema>,
): Promise<LedgerVisibleExpense[]> {
  const query = ledgerVisibleExpenseQuerySchema.parse(input);
  const queries: Promise<{ data: unknown[] | null; error: unknown }>[] = [];

  if (query.type !== "private") {
    let shared = db
      .from("expenses")
      .select(SELECT_FIELDS)
      .eq("group_id", query.groupId)
      .is("deleted_at", null)
      .is("mirror_kind", null);
    if (query.dateFrom) shared = shared.gte("expense_date", query.dateFrom);
    if (query.dateTo) shared = shared.lt("expense_date", query.dateTo);
    if (query.tag) shared = shared.eq("tag", query.tag);
    if (query.member === "me") shared = shared.eq("paid_by_user_id", query.userId);
    else if (query.member === "partner")
      shared = shared.neq("paid_by_user_id", query.userId);
    shared = shared.order("expense_date", { ascending: false }).limit(query.limitPerLedger);
    queries.push(
      shared as unknown as Promise<{ data: unknown[] | null; error: unknown }>,
    );
  }

  if (query.type !== "shared") {
    let privateLedger = db
      .from("expenses")
      .select(SELECT_FIELDS)
      .eq("ledger", "private")
      .eq("created_by_user_id", query.userId)
      .is("deleted_at", null)
      .is("mirror_kind", null);
    if (query.dateFrom) privateLedger = privateLedger.gte("expense_date", query.dateFrom);
    if (query.dateTo) privateLedger = privateLedger.lt("expense_date", query.dateTo);
    if (query.tag) privateLedger = privateLedger.eq("tag", query.tag);
    privateLedger = privateLedger
      .order("expense_date", { ascending: false })
      .limit(query.limitPerLedger);
    queries.push(
      privateLedger as unknown as Promise<{ data: unknown[] | null; error: unknown }>,
    );
  }

  const results = await Promise.all(queries);
  return results.flatMap((result) =>
    result.error ? [] : z.array(ledgerVisibleExpenseSchema).parse(result.data ?? []),
  );
}
