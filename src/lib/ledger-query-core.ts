/**
 * ledger-query-core — shared row schemas, select column lists, public
 * types, and small row-shape helpers for the read-side modules.
 *
 * Before this file existed, every read-side module (`-read`,
 * `-bootstrap`, `-search`) needed its own copy of the row schemas,
 * select column lists, public types, and the `buildDashboard` /
 * `publicUser` / `toAgentExpense` helpers. That made the read-side
 * modules brittle: a row-shape change had to be applied in three
 * places, and the three drifted.
 *
 * Now `LedgerVisibleExpense` / `AppUser` / `AppExpense` and the
 * helper row-shapes are defined exactly once. The other read-side
 * modules import what they need from here.
 */
import { z } from "zod";

/* -------------------------------------------------------------------------
 * Public types
 * ------------------------------------------------------------------------- */

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

export const userSchema = z.object({
  id: z.string().uuid(),
  couple_id: z.number().int(),
  line_user_id: z.string(),
  role: z.enum(["owner", "partner"]),
});

export const groupSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  color: z.string(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
});

export const splitSchema = z.object({
  user_id: z.string().uuid(),
  amount_twd: z.coerce.number().int(),
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

export type AppUser = z.infer<typeof userSchema>;
export type AppExpense = z.infer<typeof expenseSchema>;

/* -------------------------------------------------------------------------
 * Select column lists
 * ------------------------------------------------------------------------- */

export const SELECT_FIELDS =
  "id, description, merchant, notes, tag, amount_twd, paid_by_user_id, expense_date, ledger, deleted_at";

export const EXPENSE_SELECT =
  "id, group_id, ledger, description, merchant, notes, tag, mirror_kind, mirror_source_expense_id, amount_twd, paid_by_user_id, created_by_user_id, expense_date, split_method, version, deleted_at, created_at, expense_splits(user_id, amount_twd)";

export const RECENT_SELECT =
  "id, group_id, ledger, description, merchant, tag, amount_twd, paid_by_user_id, created_by_user_id, expense_date, version, deleted_at, created_at";

export const RECURRING_SELECT =
  "id, description, amount_twd, frequency, next_run_date, active, tag, ledger";

/* -------------------------------------------------------------------------
 * Input / output schemas
 * ------------------------------------------------------------------------- */

export const expenseSearchParamsSchema = z.object({
  q: z.string().trim().max(100).optional().default(""),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  tag: z.string().trim().max(40).optional(),
  min: z.coerce.number().int().nonnegative().optional(),
  max: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

export const categoryExpensesInputSchema = z.object({
  label: z.string().trim().min(1).max(40),
  range: z.enum(["this_month", "six_months", "all"]).default("this_month"),
  scope: z.enum(["shared", "private", "combined"]).default("shared"),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  offset: z.coerce.number().int().min(0).max(500).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const queryExpensesInputSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  tag: z.string().optional(),
  member: z.enum(["me", "partner", "both"]).optional(),
  type: z.enum(["shared", "private", "all"]).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  sort: z.enum(["date_desc", "amount_desc"]).optional(),
});

export const recentExpensesInputSchema = z.object({
  limit: z.number().int().min(1).max(10).default(5),
  ledger: z.enum(["shared", "private", "all"]).default("all"),
});

export const queryExpensesSummarySchema = z.object({
  total: z.number().int(),
  count: z.number().int(),
  average: z.number().int(),
  date_range: z
    .object({ from: z.string(), to: z.string() })
    .nullable(),
});

export type QueryExpensesItem = {
  id: string;
  description: string;
  merchant: string | null;
  tag: string;
  amount: number;
  date: string;
  ledger: "shared" | "private";
};

export const balanceSummarySchema = z.object({
  my_balance: z.number().int(),
  partner_balance: z.number().int(),
  summary: z.string(),
});

export const recurringItemSchema = z.object({
  description: z.string(),
  amount: z.number(),
  frequency: z.string(),
  next_run: z.string(),
  active: z.boolean(),
  tag: z.string(),
  ledger: z.enum(["shared", "private"]),
});

export const recurringListResultSchema = z.object({
  items: z.array(recurringItemSchema),
});

export const recentExpenseItemSchema = z.object({
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

export const recentExpensesResultSchema = z.object({
  count: z.number().int(),
  items: z.array(recentExpenseItemSchema),
});

export type QueryExpensesInput = z.input<typeof queryExpensesInputSchema>;
export type QueryExpensesSummary = z.infer<typeof queryExpensesSummarySchema>;
export type BalanceSummary = z.infer<typeof balanceSummarySchema>;
export type RecurringListResult = z.infer<typeof recurringListResultSchema>;
export type RecurringItem = z.infer<typeof recurringItemSchema>;
export type RecentExpensesInput = z.input<typeof recentExpensesInputSchema>;
export type RecentExpensesResult = z.infer<typeof recentExpensesResultSchema>;
export type RecentExpenseItem = z.infer<typeof recentExpenseItemSchema>;

/* -------------------------------------------------------------------------
 * Small pure helpers
 * ------------------------------------------------------------------------- */

export function summarizeExpenses(
  expenses: LedgerVisibleExpense[],
): QueryExpensesSummary {
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

export function buildDashboard(expenses: AppExpense[], month: string) {
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

export function publicUser(user: AppUser, requesterId: string) {
  return {
    id: user.id,
    role: user.role,
    label: user.id === requesterId ? "你" : "另一半",
  };
}

export function toAgentExpense(expense: AppExpense) {
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

// Re-exported date helpers — these live in `ledger-shared` so the rest
// of the codebase has a single source of truth. The read-side modules
// import them from there directly.
import { shiftMonth } from "./ledger-shared";
