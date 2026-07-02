import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { splitBootstrapExpenses } from "./category-agent";
import { filterAgentExpenses, type AgentTimeRange } from "./ledger-agent";
import { searchExpenseRows } from "./phase4";
import { HttpError } from "./http-error";

export const ledgerVisibleExpenseSchema = z.object({
  id: z.string().uuid(),
  description: z.string(),
  merchant: z.string().nullable(),
  notes: z.string().nullable().optional(),
  tag: z.string(),
  amount_twd: z.coerce.number().int(),
  paid_by_user_id: z.string().uuid(),
  expense_date: z.string(),
  ledger: z.enum(["shared", "private"]),
  deleted_at: z.string().nullable().optional(),
});

export const ledgerVisibleExpenseQuerySchema = z.object({
  groupId: z.string().uuid(),
  userId: z.string().uuid(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  tag: z.string().optional(),
  member: z.enum(["me", "partner", "both"]).optional(),
  type: z.enum(["shared", "private", "all"]).optional().default("all"),
  limitPerLedger: z.number().int().min(1).max(2_000).default(500),
});

export type LedgerVisibleExpense = z.infer<typeof ledgerVisibleExpenseSchema>;

const SELECT_FIELDS =
  "id, description, merchant, notes, tag, amount_twd, paid_by_user_id, expense_date, ledger, deleted_at";

const EXPENSE_SELECT =
  "id, group_id, ledger, description, merchant, notes, tag, mirror_kind, mirror_source_expense_id, amount_twd, paid_by_user_id, created_by_user_id, expense_date, split_method, version, deleted_at, created_at, expense_splits(user_id, amount_twd), receipts(id, status)";

const userSchema = z.object({
  id: z.string().uuid(),
  couple_id: z.number().int(),
  line_user_id: z.string(),
  role: z.enum(["owner", "partner"]),
});
const groupSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  color: z.string(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
});
const splitSchema = z.object({
  user_id: z.string().uuid(),
  amount_twd: z.coerce.number().int(),
});
const receiptRowSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
});
const expenseSchema = z.object({
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
  receipts: z.array(receiptRowSchema).default([]),
});

export type AppUser = z.infer<typeof userSchema>;
export type AppExpense = z.infer<typeof expenseSchema>;

const expenseSearchParamsSchema = z.object({
  q: z.string().trim().max(100).optional().default(""),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  tag: z.string().trim().max(40).optional(),
  min: z.coerce.number().int().nonnegative().optional(),
  max: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

const categoryExpensesInputSchema = z.object({
  label: z.string().trim().min(1).max(40),
  range: z.enum(["this_month", "six_months", "all"]).default("this_month"),
  scope: z.enum(["shared", "private", "combined"]).default("shared"),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  offset: z.coerce.number().int().min(0).max(500).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const queryExpensesInputSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  tag: z.string().optional(),
  member: z.enum(["me", "partner", "both"]).optional(),
  type: z.enum(["shared", "private", "all"]).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  sort: z.enum(["date_desc", "amount_desc"]).optional(),
});

const recentExpensesInputSchema = z.object({
  limit: z.number().int().min(1).max(10).default(5),
  ledger: z.enum(["shared", "private", "all"]).default("all"),
});

const queryExpensesSummarySchema = z.object({
  total: z.number().int(),
  count: z.number().int(),
  average: z.number().int(),
  date_range: z
    .object({ from: z.string(), to: z.string() })
    .nullable(),
});

type QueryExpensesItem = {
  id: string;
  description: string;
  merchant: string | null;
  tag: string;
  amount: number;
  date: string;
  ledger: "shared" | "private";
};

const balanceRowSchema = z.object({
  user_id: z.string().uuid(),
  balance_twd: z.coerce.number().int(),
});

const balanceSummarySchema = z.object({
  my_balance: z.number().int(),
  partner_balance: z.number().int(),
  summary: z.string(),
});

const recurringItemSchema = z.object({
  description: z.string(),
  amount: z.number(),
  frequency: z.string(),
  next_run: z.string(),
  active: z.boolean(),
  tag: z.string(),
  ledger: z.enum(["shared", "private"]),
});

const recurringListResultSchema = z.object({
  items: z.array(recurringItemSchema),
});

const recentExpenseItemSchema = z.object({
  id: z.string().uuid(),
  description: z.string(),
  merchant: z.string().nullable(),
  tag: z.string(),
  amount_twd: z.number().int(),
  ledger: z.enum(["shared", "private"]),
  expense_date: z.string(),
  paid_by: z.enum(["self", "partner"]),
  version: z.number().int(),
});

const recentExpensesResultSchema = z.object({
  count: z.number().int(),
  items: z.array(recentExpenseItemSchema),
});

export type QueryExpensesInput = z.input<typeof queryExpensesInputSchema>;
export type QueryExpensesSummary = z.infer<typeof queryExpensesSummarySchema>;
export type { QueryExpensesItem };
export type BalanceSummary = z.infer<typeof balanceSummarySchema>;
export type RecurringListResult = z.infer<typeof recurringListResultSchema>;
export type RecurringItem = z.infer<typeof recurringItemSchema>;
export type RecentExpensesInput = z.input<typeof recentExpensesInputSchema>;
export type RecentExpensesResult = z.infer<typeof recentExpensesResultSchema>;
export type RecentExpenseItem = z.infer<typeof recentExpenseItemSchema>;

const RECENT_SELECT =
  "id, group_id, ledger, description, merchant, tag, amount_twd, paid_by_user_id, created_by_user_id, expense_date, version, deleted_at, created_at";

const RECURRING_SELECT =
  "id, description, amount_twd, frequency, next_run_date, active, tag, ledger";

export class LedgerQueryService {
  async queryExpenses(
    context: { db: SupabaseClient; groupId: string; userId: string },
    rawInput: QueryExpensesInput,
  ): Promise<
    | { summary: QueryExpensesSummary; items?: QueryExpensesItem[] }
    | { error: string }
  > {
    const input = queryExpensesInputSchema.parse(rawInput);
    const expenses = await this.listAccessibleExpenses(context.db, {
      groupId: context.groupId,
      userId: context.userId,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      tag: input.tag,
      member: input.member,
      type: input.type,
      limitPerLedger: 500,
    });
    const summary = summarizeExpenses(expenses);
    if (!input.limit) {
      return { summary };
    }
    const sorted =
      input.sort === "amount_desc"
        ? [...expenses].sort((a, b) => b.amount_twd - a.amount_twd)
        : [...expenses].sort((a, b) =>
            b.expense_date.localeCompare(a.expense_date),
          );
    const items = sorted.slice(0, input.limit).map((expense) => ({
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

  async balanceSummary(
    context: { db: SupabaseClient; groupId: string; userId: string },
  ): Promise<BalanceSummary | { error: string }> {
    const result = await context.db.rpc("group_balances", {
      p_group_id: context.groupId,
    });
    if (result.error) return { error: "balance lookup failed" };
    const balances = z.array(balanceRowSchema).parse(result.data);
    const me = balances.find((row) => row.user_id === context.userId);
    const partner = balances.find((row) => row.user_id !== context.userId);
    const myBalance = me?.balance_twd ?? 0;
    const partnerBalance = partner?.balance_twd ?? 0;
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

  async recentExpenses(
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

  async recurringList(
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

  async listAccessibleExpenses(
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

  async loadBootstrap(context: { db: SupabaseClient; user: AppUser }) {
    const { db, user } = context;
    const [usersResult, groupsResult, preferenceResult] = await Promise.all([
      db
        .from("users")
        .select("id, couple_id, line_user_id, role")
        .eq("couple_id", user.couple_id)
        .order("role"),
      db
        .from("groups")
        .select("id, name, color, archived_at, created_at")
        .eq("couple_id", user.couple_id)
        .order("created_at"),
      db
        .from("user_preferences")
        .select("active_group_id")
        .eq("user_id", user.id)
        .single(),
    ]);
    if (usersResult.error || groupsResult.error || preferenceResult.error)
      throw new Error("bootstrap lookup failed");
    const users = z.array(userSchema).parse(usersResult.data);
    const groups = z.array(groupSchema).parse(groupsResult.data);
    const activeGroupId = z
      .object({ active_group_id: z.string().uuid() })
      .parse(preferenceResult.data).active_group_id;
    if (!groups.some((group) => group.id === activeGroupId && !group.archived_at))
      throw new HttpError(409, "Active group unavailable");

    const month = taipeiToday().slice(0, 7);
    const sixMonthsAgo = shiftMonth(month, -5);
    const [
      sharedResult,
      privateResult,
      balancesResult,
      recurringResult,
      notificationsResult,
    ] = await Promise.all([
      db
        .from("expenses")
        .select(EXPENSE_SELECT)
        .eq("group_id", activeGroupId)
        .gte("expense_date", `${sixMonthsAgo}-01`)
        .order("expense_date", { ascending: false })
        .limit(300),
      db
        .from("expenses")
        .select(EXPENSE_SELECT)
        .eq("ledger", "private")
        .eq("created_by_user_id", user.id)
        .gte("expense_date", `${sixMonthsAgo}-01`)
        .order("expense_date", { ascending: false })
        .limit(300),
      db.rpc("group_balances", { p_group_id: activeGroupId }),
      db
        .from("recurring_expenses")
        .select(
          "id, group_id, ledger, description, tag, amount_twd, frequency, next_run_date, active",
        )
        .eq("couple_id", user.couple_id)
        .order("next_run_date"),
      db
        .from("notifications")
        .select(
          "id, group_id, kind, title, body, read_at, created_at, line_status",
        )
        .eq("recipient_user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    if (
      sharedResult.error ||
      privateResult.error ||
      balancesResult.error ||
      recurringResult.error ||
      notificationsResult.error
    ) {
      throw new Error("ledger lookup failed");
    }
    const expenses = z
      .array(expenseSchema)
      .parse([...(sharedResult.data ?? []), ...(privateResult.data ?? [])]);
    const { sharedExpenses, privateExpenses } = splitBootstrapExpenses(
      expenses,
      activeGroupId,
      user.id,
    );
    const activeShared = sharedExpenses.filter((expense) => !expense.deleted_at);
    const activePrivate = privateExpenses.filter((expense) => !expense.deleted_at);
    const balances = z
      .array(
        z.object({
          user_id: z.string().uuid(),
          balance_twd: z.coerce.number().int(),
        }),
      )
      .parse(balancesResult.data);
    return {
      today: taipeiToday(),
      month,
      user: publicUser(user, user.id),
      users: users.map((item) => publicUser(item, user.id)),
      groups,
      activeGroupId,
      expenses,
      sharedExpenses,
      privateExpenses,
      balances,
      recurring: recurringResult.data,
      notifications: notificationsResult.data,
      dashboard: buildDashboard(activeShared, month),
      privateDashboard: buildDashboard(activePrivate, month),
    };
  }

  async searchExpenses(
    context: { db: SupabaseClient; user: { id: string } },
    searchParams: URLSearchParams,
  ) {
    const parsed = expenseSearchParamsSchema.parse(
      Object.fromEntries(searchParams.entries()),
    );
    const groupId = await this.activeGroupId(context);
    const rows = await this.listAccessibleExpenses(context.db, {
      groupId,
      userId: context.user.id,
      limitPerLedger: 500,
    });
    const expenses = searchExpenseRows(rows, { ...parsed, tag: parsed.tag });
    return { expenses, count: expenses.length };
  }

  async categoryExpenses(
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
    const groupId = await this.activeGroupId(context);
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
          receipts: full?.receipts ?? [],
        };
      }),
    };
  }

  async checkExpenseInSettlements(
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
      .eq("couple_id", context.user.couple_id);
    const hasSettlements =
      !settlements.error && (settlements.count ?? 0) > 0;
    return {
      settled: hasSettlements,
      message: hasSettlements
        ? "此帳已包含在結清紀錄中，無法改為私人帳。請先復原該筆結清才能修改。"
        : "",
    };
  }

  private async activeGroupId(context: { db: SupabaseClient; user: { id: string } }) {
    const preference = await context.db
      .from("user_preferences")
      .select("active_group_id")
      .eq("user_id", context.user.id)
      .single();
    if (preference.error) throw new Error("active group lookup failed");
    return z.object({ active_group_id: z.string().uuid() }).parse(preference.data)
      .active_group_id;
  }
}

/* ─── Private Helpers ─── */

function summarizeExpenses(expenses: LedgerVisibleExpense[]): QueryExpensesSummary {
  const total = expenses.reduce((sum, expense) => sum + expense.amount_twd, 0);
  const dates = expenses
    .map((expense) => expense.expense_date)
    .sort();
  return queryExpensesSummarySchema.parse({
    total,
    count: expenses.length,
    average: expenses.length ? Math.round(total / expenses.length) : 0,
    date_range:
      dates.length > 0
        ? { from: dates[0]!, to: dates[dates.length - 1]! }
        : null,
  });
}

function buildDashboard(expenses: AppExpense[], month: string) {
  const trend = Array.from({ length: 6 }, (_, index) => ({
    month: shiftMonth(month, index - 5),
    totalTwd: 0,
  }));
  for (const expense of expenses) {
    const expenseMonth = expense.expense_date.slice(0, 7);
    const point = trend.find((item) => item.month === expenseMonth);
    if (point) point.totalTwd += expense.amount_twd;
  }
  const thisMonth = expenses.filter((expense) =>
    expense.expense_date.startsWith(month),
  );
  const categoryTotals: Record<string, number> = {};
  for (const expense of thisMonth) {
    const label = expense.tag;
    categoryTotals[label] = (categoryTotals[label] ?? 0) + expense.amount_twd;
  }
  return {
    monthlyTotalTwd: thisMonth.reduce((sum, expense) => sum + expense.amount_twd, 0),
    monthlyCount: thisMonth.length,
    categoryTotals,
    trend,
    recent: expenses.slice(0, 8),
  };
}

function publicUser(user: AppUser, requesterId: string) {
  return {
    id: user.id,
    role: user.role,
    label: user.id === requesterId ? "你" : "另一半",
  };
}

function toAgentExpense(expense: AppExpense) {
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

export function taipeiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function shiftMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year!, monthNumber! - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function expensesCsv(
  expenses: AppExpense[],
  users: Array<{ id: string; label: string }>,
): string {
  const rows = [
    [
      "日期",
      "帳本",
      "說明",
      "商家",
      "分類",
      "金額",
      "付款人",
      "分帳方式",
      "狀態",
    ],
  ];
  for (const expense of expenses)
    rows.push([
      expense.expense_date,
      expense.ledger === "shared" ? "共同" : "私人",
      expense.description,
      expense.merchant ?? "",
      expense.tag,
      String(expense.amount_twd),
      users.find((user) => user.id === expense.paid_by_user_id)?.label ?? "",
      splitLabel(expense.split_method),
      expense.deleted_at ? "已刪除" : "有效",
    ]);
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function splitLabel(method: "equal" | "exact" | "percentage"): string {
  return method === "equal"
    ? "平均分帳"
    : method === "exact"
      ? "指定金額"
      : "百分比分帳";
}
