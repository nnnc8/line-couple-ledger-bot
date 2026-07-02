/**
 * accountant-loaders — shared infrastructure for the accountant
 * modules.
 *
 * Owns:
 *   - the zod row schemas (`expenseSchema`, `accountantReportRowSchema`,
 *     `userRowSchema`, `groupRowSchema`, `splitSchema`)
 *   - the canonical `EXPENSE_SELECT` and `accountantReportSelect()`
 *     column lists
 *   - the read-only DB helpers: `activeGroupId`, `loadAgentExpenses`,
 *     `loadAccountantSnapshot`
 *   - the row-shape converters `toAccountantExpense`, `toAgentExpense`
 *   - a few pure date/aggregation helpers used across analytics and
 *     reports
 *
 * Why this file exists: every other accountant module needed either
 * the same row schema, the same select column list, or the same
 * snapshot loader. Centralizing them keeps analytics / agent / reports
 * focused on their own logic.
 */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ServerContext } from "./server-runtime";
import type { AccountantExpense } from "./accountant";
import { buildAccountantSnapshot } from "./accountant";
import { loadGroupBalances } from "./balance-loader";
import { ledgerQueryService } from "./services";
import { shiftMonth, taipeiToday } from "./ledger-shared";
import type { AgentExpense } from "./ledger-agent";
import type { LedgerVisibleExpense } from "./ledger-query";

export const EXPENSE_SELECT =
  "id, group_id, ledger, description, merchant, notes, tag, mirror_kind, mirror_source_expense_id, amount_twd, paid_by_user_id, created_by_user_id, expense_date, split_method, version, deleted_at, created_at, expense_splits(user_id, amount_twd)";

export const splitSchema = z.object({
  user_id: z.string().uuid(),
  amount_twd: z.coerce.number().int(),
});

export const userRowSchema = z.object({
  id: z.string().uuid(),
  couple_id: z.number().int(),
  line_user_id: z.string(),
  role: z.enum(["owner", "partner"]),
});

export const groupRowSchema = z.object({
  id: z.string().uuid(),
  couple_id: z.coerce.number().int(),
});

export const expenseSchema = z.object({
  id: z.string().uuid(),
  group_id: z.string().uuid().nullable(),
  ledger: z.enum(["shared", "private"]),
  description: z.string(),
  merchant: z.string().nullable(),
  notes: z.string().nullable(),
  tag: z.string(),
  mirror_kind: z.enum(["shared_share"]).nullable().default(null),
  mirror_source_expense_id: z.string().uuid().nullable().default(null),
  amount_twd: z.coerce.number().int(),
  paid_by_user_id: z.string().uuid(),
  created_by_user_id: z.string().uuid(),
  expense_date: z.string(),
  split_method: z.enum(["equal", "exact", "percentage"]),
  version: z.number().int(),
  deleted_at: z.string().nullable(),
  created_at: z.string(),
  expense_splits: z.array(splitSchema),
});

export const accountantReportRowSchema = z.object({
  id: z.string().uuid(),
  group_id: z.string().uuid().nullable(),
  owner_user_id: z.string().uuid().nullable(),
  report_type: z.enum(["manual_question", "monthly_health", "cleanup_review"]),
  scope: z.enum(["shared", "private", "combined"]),
  month: z.string(),
  question: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  facts: z.unknown(),
  findings: z.unknown(),
  suggestions: z.unknown(),
  source: z.enum(["llm", "fallback"]),
  created_at: z.string(),
});

export function accountantReportSelect() {
  return "id, group_id, owner_user_id, report_type, scope, month, question, title, summary, facts, findings, suggestions, source, created_at";
}

export async function activeGroupId(context: ServerContext) {
  const preference = await context.db
    .from("user_preferences")
    .select("active_group_id")
    .eq("user_id", context.user.id)
    .single();
  if (preference.error) throw new Error("active group lookup failed");
  return z.object({ active_group_id: z.string().uuid() }).parse(preference.data)
    .active_group_id;
}

export async function loadAgentExpenses(
  context: ServerContext,
  groupId: string,
): Promise<AgentExpense[]> {
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
    throw new Error("agent expense lookup failed");
  }
  return z
    .array(expenseSchema)
    .parse([...(sharedResult.data ?? []), ...(privateResult.data ?? [])])
    .map(toAgentExpense);
}

export async function loadAccountantSnapshot(
  context: ServerContext,
  scope: "shared" | "private" | "combined",
  month: string,
  groupIdOverride?: string,
) {
  const groupId = groupIdOverride ?? (await activeGroupId(context));
  const start = `${month}-01`;
  const end = `${shiftMonth(month, 1)}-01`;
  const startPrev = `${shiftMonth(month, -1)}-01`;
  const endPrev = `${month}-01`;

  const queries = [];
  if (scope !== "private") {
    queries.push(
      context.db
        .from("expenses")
        .select(EXPENSE_SELECT)
        .eq("group_id", groupId)
        .gte("expense_date", start)
        .lt("expense_date", end)
        .order("expense_date", { ascending: false }),
    );
  }
  if (scope !== "shared") {
    queries.push(
      context.db
        .from("expenses")
        .select(EXPENSE_SELECT)
        .eq("ledger", "private")
        .eq("created_by_user_id", context.user.id)
        .gte("expense_date", start)
        .lt("expense_date", end)
        .order("expense_date", { ascending: false }),
    );
  }

  const prevSharedQuery =
    scope !== "private"
      ? context.db
          .from("expenses")
          .select("amount_twd")
          .eq("group_id", groupId)
          .is("deleted_at", null)
          .gte("expense_date", startPrev)
          .lt("expense_date", endPrev)
      : Promise.resolve({ data: [] as { amount_twd: number }[], error: null });

  const prevPrivateQuery =
    scope !== "shared"
      ? context.db
          .from("expenses")
          .select("amount_twd")
          .eq("ledger", "private")
          .eq("created_by_user_id", context.user.id)
          .is("deleted_at", null)
          .gte("expense_date", startPrev)
          .lt("expense_date", endPrev)
      : Promise.resolve({ data: [] as { amount_twd: number }[], error: null });

  const [balances, prevSharedRes, prevPrivateRes, ...expenseResults] = await Promise.all([
    loadGroupBalances(context.db, groupId)
      .then((data) => ({ data, error: null as null }))
      .catch((error: unknown) => ({
        data: null as Array<{ userId: string; balanceTwd: number }> | null,
        error: error instanceof Error ? error : new Error(String(error)),
      })),
    prevSharedQuery,
    prevPrivateQuery,
    ...queries,
  ]);
  if (
    balances.error ||
    prevSharedRes.error ||
    prevPrivateRes.error ||
    expenseResults.some((result) => result.error)
  ) {
    throw new Error("accountant snapshot lookup failed");
  }

  const prevSharedTotal =
    prevSharedRes.data?.reduce((sum, expense) => sum + expense.amount_twd, 0) ?? 0;
  const prevPrivateTotal =
    prevPrivateRes.data?.reduce((sum, expense) => sum + expense.amount_twd, 0) ?? 0;
  const previousMonthTotalTwd = prevSharedTotal + prevPrivateTotal;

  const expenses = z
    .array(expenseSchema)
    .parse(expenseResults.flatMap((result) => result.data ?? []))
    .map(toAccountantExpense);
  return buildAccountantSnapshot({
    activeGroupId: groupId,
    balances: (balances.data ?? []).map((row) => ({
      user_id: row.userId,
      balance_twd: row.balanceTwd,
    })),
    expenses,
    month,
    scope,
    userId: context.user.id,
    previousMonthTotalTwd,
  });
}

export function toAccountantExpense(
  expense: z.infer<typeof expenseSchema>,
): AccountantExpense {
  return {
    id: expense.id,
    group_id: expense.group_id,
    ledger: expense.ledger,
    description: expense.description,
    merchant: expense.merchant,
    notes: expense.notes,
    tag: expense.tag,
    amount_twd: expense.amount_twd,
    paid_by_user_id: expense.paid_by_user_id,
    created_by_user_id: expense.created_by_user_id,
    expense_date: expense.expense_date,
    split_method: expense.split_method,
    version: expense.version,
    deleted_at: expense.deleted_at,
    expense_splits: expense.expense_splits,
  };
}

export function toAgentExpense(
  expense: z.infer<typeof expenseSchema>,
): AgentExpense {
  return {
    id: expense.id,
    group_id: expense.group_id,
    ledger: expense.ledger,
    description: expense.description,
    merchant: expense.merchant,
    tag: expense.tag,
    mirror_kind: expense.mirror_kind,
    mirror_source_expense_id: expense.mirror_source_expense_id,
    amount_twd: expense.amount_twd,
    paid_by_user_id: expense.paid_by_user_id,
    created_by_user_id: expense.created_by_user_id,
    expense_date: expense.expense_date,
    version: expense.version,
    deleted_at: expense.deleted_at,
  };
}

/** Sum expenses grouped by their `tag`. Shared between analytics tools. */
export function breakdownByKey(expenses: LedgerVisibleExpense[]) {
  const map = new Map<string, number>();
  for (const e of expenses) {
    const label = e.tag;
    map.set(label, (map.get(label) ?? 0) + e.amount_twd);
  }
  return map;
}

/**
 * Re-exports of date helpers. They live in `ledger-shared` for the rest
 * of the codebase, but the accountant tools historically inlined local
 * copies. Keeping the re-exports here means analytics / agent / reports
 * only have to depend on this loader file.
 */
export { shiftMonth, taipeiToday };

/** Minimal `listToolExpenses` shim — analytics-only, not part of the
 * shared loader API. Kept here because both analytics and tests reach
 * for it and it depends on `ledgerQueryService`. */
export async function listToolExpenses(
  context: { db: SupabaseClient; groupId: string; userId: string },
  filters: {
    dateFrom?: string;
    dateTo?: string;
    tag?: string;
    type?: "shared" | "private" | "all";
    limitPerLedger?: number;
  },
) {
  return ledgerQueryService.listAccessibleExpenses(context.db, {
    groupId: context.groupId,
    userId: context.userId,
    ...filters,
  });
}
