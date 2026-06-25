/**
 * Read-only tools for the agentic accountant.
 * All tools only query data — they never write to the DB.
 * The agent loop calls these based on Gemini function-calling decisions.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { type FunctionDeclaration, Type } from "@google/genai";

import { categories } from "./ledger";
import {
  detectDuplicateAgentExpenses,
  type AgentExpense,
} from "./ledger-agent";

/* ─── Shared types ─── */

export interface ToolContext {
  db: SupabaseClient;
  groupId: string;
  userId: string;
  coupleId: number;
}

interface ExpenseSummary {
  total: number;
  count: number;
  average: number;
  date_range: { from: string; to: string } | null;
}

/* ─── Tool parameter schemas ─── */

const queryExpensesParams = z.object({
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  category: z.string().optional(),
  category_label: z.string().optional(),
  member: z.enum(["me", "partner", "both"]).optional(),
  type: z.enum(["shared", "private", "all"]).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  sort: z.enum(["date_desc", "amount_desc"]).optional(),
});

const categoryBreakdownParams = z.object({
  date_from: z.string(),
  date_to: z.string(),
  group_by: z.enum(["category", "category_label"]).default("category_label"),
});

const comparePeriodParams = z.object({
  period_a: z.object({ from: z.string(), to: z.string() }),
  period_b: z.object({ from: z.string(), to: z.string() }),
  breakdown: z
    .enum(["category", "category_label", "total"])
    .default("total"),
});

const anomaliesParams = z.object({
  date_from: z.string().optional(),
  date_to: z.string().optional(),
});

const categoryTrendParams = z.object({
  category_label: z.string(),
  months: z.number().int().min(1).max(24).default(3),
});

const predictMonthEndParams = z.object({
  category_label: z.string().optional(),
});

/* ─── Tool declarations for Gemini function calling ─── */

export const toolDeclarations: FunctionDeclaration[] = [
  {
    name: "query_expenses",
    description:
      "自由查帳。沒有指定 limit 時只回傳聚合摘要（total/count/average），有 limit 才回傳明細（最多 20 筆）。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        date_from: {
          type: Type.STRING,
          description: "起始日期 YYYY-MM-DD（含）",
        },
        date_to: {
          type: Type.STRING,
          description: "結束日期 YYYY-MM-DD（不含）",
        },
        category: { type: Type.STRING, description: "大分類 enum" },
        category_label: {
          type: Type.STRING,
          description: "細分類 label",
        },
        member: {
          type: Type.STRING,
          description: "篩選付款人：me / partner / both",
          enum: ["me", "partner", "both"],
        },
        type: {
          type: Type.STRING,
          description: "shared / private / all",
          enum: ["shared", "private", "all"],
        },
        limit: {
          type: Type.INTEGER,
          description: "回傳明細筆數上限（1-20）。不指定則只回聚合。",
        },
        sort: {
          type: Type.STRING,
          description: "排序：date_desc / amount_desc",
          enum: ["date_desc", "amount_desc"],
        },
      },
    },
  },
  {
    name: "get_balance_summary",
    description: "查詢目前誰欠誰多少，含 breakdown。",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_category_breakdown",
    description: "某段時間內的分類佔比。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        date_from: { type: Type.STRING, description: "起始日 YYYY-MM-DD" },
        date_to: { type: Type.STRING, description: "結束日 YYYY-MM-DD" },
        group_by: {
          type: Type.STRING,
          description: "category 或 category_label",
          enum: ["category", "category_label"],
        },
      },
      required: ["date_from", "date_to"],
    },
  },
  {
    name: "compare_period",
    description: "比較兩段時間的支出（可按分類拆解）。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        period_a: {
          type: Type.OBJECT,
          properties: {
            from: { type: Type.STRING },
            to: { type: Type.STRING },
          },
          required: ["from", "to"],
        },
        period_b: {
          type: Type.OBJECT,
          properties: {
            from: { type: Type.STRING },
            to: { type: Type.STRING },
          },
          required: ["from", "to"],
        },
        breakdown: {
          type: Type.STRING,
          enum: ["category", "category_label", "total"],
        },
      },
      required: ["period_a", "period_b"],
    },
  },
  {
    name: "get_budget_status",
    description: "取得當月預算使用狀態。",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_recurring_list",
    description: "列出所有固定/週期支出。",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_anomalies",
    description: "找異常或重複候選支出（同日同額同描述）。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        date_from: { type: Type.STRING },
        date_to: { type: Type.STRING },
      },
    },
  },
  {
    name: "get_category_trend",
    description: "某個分類標籤最近幾個月的趨勢（每月金額）。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        category_label: {
          type: Type.STRING,
          description: "要查的分類標籤名稱",
        },
        months: {
          type: Type.INTEGER,
          description: "回溯幾個月（1-24）",
        },
      },
      required: ["category_label"],
    },
  },
  {
    name: "predict_month_end",
    description:
      "用線性外推預測本月底總花費。可指定 category_label 只預測單一分類。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        category_label: {
          type: Type.STRING,
          description: "不傳就預測全部總支出",
        },
      },
    },
  },
];

/* ─── Tool implementations ─── */

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  switch (name) {
    case "query_expenses":
      return queryExpenses(queryExpensesParams.parse(args), ctx);
    case "get_balance_summary":
      return getBalanceSummary(ctx);
    case "get_category_breakdown":
      return getCategoryBreakdown(categoryBreakdownParams.parse(args), ctx);
    case "compare_period":
      return comparePeriod(comparePeriodParams.parse(args), ctx);
    case "get_budget_status":
      return getBudgetStatus(ctx);
    case "get_recurring_list":
      return getRecurringList(ctx);
    case "get_anomalies":
      return getAnomalies(anomaliesParams.parse(args), ctx);
    case "get_category_trend":
      return getCategoryTrend(categoryTrendParams.parse(args), ctx);
    case "predict_month_end":
      return predictMonthEnd(predictMonthEndParams.parse(args), ctx);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/* ─── query_expenses ─── */

async function queryExpenses(
  params: z.infer<typeof queryExpensesParams>,
  ctx: ToolContext,
) {
  const expenses = await loadFilteredExpenses(ctx, {
    dateFrom: params.date_from,
    dateTo: params.date_to,
    category: params.category,
    categoryLabel: params.category_label,
    member: params.member,
    type: params.type,
  });

  const summary = summarize(expenses);

  // No limit → aggregation only (prevents context window explosion)
  if (!params.limit) {
    return { summary };
  }

  const sorted =
    params.sort === "amount_desc"
      ? [...expenses].sort((a, b) => b.amount_twd - a.amount_twd)
      : [...expenses].sort((a, b) =>
          b.expense_date.localeCompare(a.expense_date),
        );

  return {
    summary,
    items: sorted.slice(0, params.limit).map(briefExpense),
  };
}

/* ─── get_balance_summary ─── */

async function getBalanceSummary(ctx: ToolContext) {
  const result = await ctx.db.rpc("group_balances", {
    p_group_id: ctx.groupId,
  });
  if (result.error) return { error: "balance lookup failed" };
  const balances = z
    .array(
      z.object({
        user_id: z.string().uuid(),
        balance_twd: z.coerce.number().int(),
      }),
    )
    .parse(result.data);
  const me = balances.find((b) => b.user_id === ctx.userId);
  const partner = balances.find((b) => b.user_id !== ctx.userId);
  return {
    my_balance: me?.balance_twd ?? 0,
    partner_balance: partner?.balance_twd ?? 0,
    summary:
      (me?.balance_twd ?? 0) > 0
        ? `另一半欠你 NT$${me!.balance_twd}`
        : (me?.balance_twd ?? 0) < 0
          ? `你欠另一半 NT$${Math.abs(me!.balance_twd)}`
          : "已結清",
  };
}

/* ─── get_category_breakdown ─── */

async function getCategoryBreakdown(
  params: z.infer<typeof categoryBreakdownParams>,
  ctx: ToolContext,
) {
  const expenses = await loadFilteredExpenses(ctx, {
    dateFrom: params.date_from,
    dateTo: params.date_to,
  });
  const totals = new Map<string, { total: number; count: number }>();
  for (const e of expenses) {
    const key =
      params.group_by === "category" ? e.category : e.category_label;
    const current = totals.get(key) ?? { total: 0, count: 0 };
    current.total += e.amount_twd;
    current.count += 1;
    totals.set(key, current);
  }
  const grand = expenses.reduce((sum, e) => sum + e.amount_twd, 0);
  return {
    total: grand,
    count: expenses.length,
    breakdown: [...totals.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 15)
      .map(([label, data]) => ({
        label,
        total: data.total,
        count: data.count,
        percent: grand ? Math.round((data.total / grand) * 100) : 0,
      })),
  };
}

/* ─── compare_period ─── */

async function comparePeriod(
  params: z.infer<typeof comparePeriodParams>,
  ctx: ToolContext,
) {
  const [expA, expB] = await Promise.all([
    loadFilteredExpenses(ctx, {
      dateFrom: params.period_a.from,
      dateTo: params.period_a.to,
    }),
    loadFilteredExpenses(ctx, {
      dateFrom: params.period_b.from,
      dateTo: params.period_b.to,
    }),
  ]);

  if (params.breakdown === "total") {
    const totalA = expA.reduce((s, e) => s + e.amount_twd, 0);
    const totalB = expB.reduce((s, e) => s + e.amount_twd, 0);
    return {
      period_a: { total: totalA, count: expA.length },
      period_b: { total: totalB, count: expB.length },
      change_percent: totalB
        ? Math.round(((totalA - totalB) / totalB) * 100)
        : null,
    };
  }

  const key = params.breakdown;
  const aMap = breakdownByKey(expA, key);
  const bMap = breakdownByKey(expB, key);
  const allKeys = new Set([...aMap.keys(), ...bMap.keys()]);
  const comparison = [...allKeys]
    .map((label) => ({
      label,
      period_a: aMap.get(label) ?? 0,
      period_b: bMap.get(label) ?? 0,
      change: (aMap.get(label) ?? 0) - (bMap.get(label) ?? 0),
    }))
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, 10);

  return { comparison };
}

/* ─── get_budget_status ─── */

async function getBudgetStatus(ctx: ToolContext) {
  const today = taipeiToday();
  const month = today.slice(0, 7);
  const [budgets, expenses] = await Promise.all([
    ctx.db
      .from("budgets")
      .select("category, limit_twd")
      .eq("group_id", ctx.groupId)
      .eq("month", `${month}-01`),
    ctx.db
      .from("expenses")
      .select("category, amount_twd")
      .eq("group_id", ctx.groupId)
      .is("deleted_at", null)
      .gte("expense_date", `${month}-01`)
      .lt("expense_date", `${shiftMonth(month, 1)}-01`),
  ]);
  if (budgets.error || expenses.error) return { error: "budget lookup failed" };
  return {
    month,
    budgets: (budgets.data ?? []).map((b) => {
      const spent = (expenses.data ?? [])
        .filter((e) => !b.category || e.category === b.category)
        .reduce((sum, e) => sum + Number(e.amount_twd), 0);
      return {
        category: b.category ?? "total",
        limit: Number(b.limit_twd),
        spent,
        percent: Math.round((spent / Number(b.limit_twd)) * 100),
        remaining: Number(b.limit_twd) - spent,
      };
    }),
  };
}

/* ─── get_recurring_list ─── */

async function getRecurringList(ctx: ToolContext) {
  const result = await ctx.db
    .from("recurring_expenses")
    .select(
      "id, description, amount_twd, frequency, next_run_date, active, category, ledger",
    )
    .eq("couple_id", ctx.coupleId)
    .order("next_run_date");
  if (result.error) return { error: "recurring lookup failed" };
  return {
    items: (result.data ?? []).map((r) => ({
      description: r.description,
      amount: Number(r.amount_twd),
      frequency: r.frequency,
      next_run: r.next_run_date,
      active: r.active,
      category: r.category,
      ledger: r.ledger,
    })),
  };
}

/* ─── get_anomalies ─── */

async function getAnomalies(
  params: z.infer<typeof anomaliesParams>,
  ctx: ToolContext,
) {
  const expenses = await loadFilteredExpenses(ctx, {
    dateFrom: params.date_from,
    dateTo: params.date_to,
  });
  const duplicates = detectDuplicateAgentExpenses(
    expenses as unknown as AgentExpense[],
  );
  return {
    duplicate_groups: duplicates.slice(0, 5).map((group) =>
      group.map((e) => ({
        id: e.id,
        description: e.description,
        amount: e.amount_twd,
        date: e.expense_date,
      })),
    ),
    total_groups: duplicates.length,
  };
}

/* ─── get_category_trend ─── */

async function getCategoryTrend(
  params: z.infer<typeof categoryTrendParams>,
  ctx: ToolContext,
) {
  const today = taipeiToday();
  const currentMonth = today.slice(0, 7);
  const months: string[] = [];
  for (let i = params.months - 1; i >= 0; i--) {
    months.push(shiftMonth(currentMonth, -i));
  }
  const startDate = `${months[0]}-01`;
  const endDate = `${shiftMonth(currentMonth, 1)}-01`;

  const expenses = await loadFilteredExpenses(ctx, {
    dateFrom: startDate,
    dateTo: endDate,
    categoryLabel: params.category_label,
  });

  const trend = months.map((m) => {
    const monthExpenses = expenses.filter((e) =>
      e.expense_date.startsWith(`${m}-`),
    );
    return {
      month: m,
      total: monthExpenses.reduce((s, e) => s + e.amount_twd, 0),
      count: monthExpenses.length,
    };
  });

  return { category_label: params.category_label, trend };
}

/* ─── predict_month_end ─── */

async function predictMonthEnd(
  params: z.infer<typeof predictMonthEndParams>,
  ctx: ToolContext,
) {
  const today = taipeiToday();
  const month = today.slice(0, 7);
  const daysElapsed = Number(today.slice(8, 10));
  const daysTotal = new Date(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)),
    0,
  ).getDate();

  if (daysElapsed < 4) {
    return {
      message: "月初資料不足，無法預測",
      days_elapsed: daysElapsed,
      days_total: daysTotal,
    };
  }

  const expenses = await loadFilteredExpenses(ctx, {
    dateFrom: `${month}-01`,
    dateTo: `${shiftMonth(month, 1)}-01`,
    categoryLabel: params.category_label,
  });

  const spentSoFar = expenses.reduce((s, e) => s + e.amount_twd, 0);
  const projectedTotal = Math.round((spentSoFar / daysElapsed) * daysTotal);

  // Look up budget if available
  let budget: number | undefined;
  if (params.category_label) {
    // Try matching by category enum
    const cat = (categories as readonly string[]).includes(
      params.category_label,
    )
      ? params.category_label
      : null;
    if (cat) {
      const b = await ctx.db
        .from("budgets")
        .select("limit_twd")
        .eq("group_id", ctx.groupId)
        .eq("month", `${month}-01`)
        .eq("category", cat)
        .maybeSingle();
      if (!b.error && b.data) budget = Number(b.data.limit_twd);
    }
  } else {
    const b = await ctx.db
      .from("budgets")
      .select("limit_twd")
      .eq("group_id", ctx.groupId)
      .eq("month", `${month}-01`)
      .is("category", null)
      .maybeSingle();
    if (!b.error && b.data) budget = Number(b.data.limit_twd);
  }

  return {
    days_elapsed: daysElapsed,
    days_total: daysTotal,
    spent_so_far: spentSoFar,
    projected_total: projectedTotal,
    ...(budget !== undefined
      ? {
          budget,
          projected_overrun: projectedTotal - budget,
        }
      : {}),
  };
}

/* ─── Helpers ─── */

interface FilterOpts {
  dateFrom?: string;
  dateTo?: string;
  category?: string;
  categoryLabel?: string;
  member?: "me" | "partner" | "both";
  type?: "shared" | "private" | "all";
}

const expenseQuerySchema = z.object({
  id: z.string().uuid(),
  description: z.string(),
  merchant: z.string().nullable(),
  category: z.string(),
  category_label: z.string(),
  amount_twd: z.coerce.number().int(),
  paid_by_user_id: z.string().uuid(),
  expense_date: z.string(),
  ledger: z.enum(["shared", "private"]),
});

type ToolExpense = z.infer<typeof expenseQuerySchema>;

async function loadFilteredExpenses(
  ctx: ToolContext,
  opts: FilterOpts,
): Promise<ToolExpense[]> {
  const queries: Promise<{ data: unknown[] | null; error: unknown }>[] = [];
  const ledgerType = opts.type ?? "all";

  if (ledgerType !== "private") {
    let q = ctx.db
      .from("expenses")
      .select(
        "id, description, merchant, category, category_label, amount_twd, paid_by_user_id, expense_date, ledger",
      )
      .eq("group_id", ctx.groupId)
      .is("deleted_at", null)
      .is("mirror_kind", null);
    if (opts.dateFrom) q = q.gte("expense_date", opts.dateFrom);
    if (opts.dateTo) q = q.lt("expense_date", opts.dateTo);
    if (opts.category) q = q.eq("category", opts.category);
    if (opts.member === "me") q = q.eq("paid_by_user_id", ctx.userId);
    else if (opts.member === "partner")
      q = q.neq("paid_by_user_id", ctx.userId);
    q = q.order("expense_date", { ascending: false }).limit(500);
    queries.push(q as unknown as Promise<{ data: unknown[] | null; error: unknown }>);
  }

  if (ledgerType !== "shared") {
    let q = ctx.db
      .from("expenses")
      .select(
        "id, description, merchant, category, category_label, amount_twd, paid_by_user_id, expense_date, ledger",
      )
      .eq("ledger", "private")
      .eq("created_by_user_id", ctx.userId)
      .is("deleted_at", null)
      .is("mirror_kind", null);
    if (opts.dateFrom) q = q.gte("expense_date", opts.dateFrom);
    if (opts.dateTo) q = q.lt("expense_date", opts.dateTo);
    if (opts.category) q = q.eq("category", opts.category);
    q = q.order("expense_date", { ascending: false }).limit(500);
    queries.push(q as unknown as Promise<{ data: unknown[] | null; error: unknown }>);
  }

  const results = await Promise.all(queries);
  const rows = results.flatMap((r) =>
    r.error ? [] : z.array(expenseQuerySchema).parse(r.data ?? []),
  );

  // Client-side filter for category_label (can't do case-insensitive ilike easily)
  if (opts.categoryLabel) {
    const target = opts.categoryLabel.toLowerCase();
    return rows.filter((e) => e.category_label.toLowerCase().includes(target));
  }

  return rows;
}

function summarize(expenses: ToolExpense[]): ExpenseSummary {
  const total = expenses.reduce((s, e) => s + e.amount_twd, 0);
  const dates = expenses.map((e) => e.expense_date).sort();
  return {
    total,
    count: expenses.length,
    average: expenses.length ? Math.round(total / expenses.length) : 0,
    date_range:
      dates.length > 0
        ? { from: dates[0]!, to: dates[dates.length - 1]! }
        : null,
  };
}

function briefExpense(e: ToolExpense) {
  return {
    id: e.id,
    description: e.description,
    merchant: e.merchant,
    category_label: e.category_label,
    amount: e.amount_twd,
    date: e.expense_date,
    ledger: e.ledger,
  };
}

function breakdownByKey(
  expenses: ToolExpense[],
  key: "category" | "category_label",
) {
  const map = new Map<string, number>();
  for (const e of expenses) {
    const label = key === "category" ? e.category : e.category_label;
    map.set(label, (map.get(label) ?? 0) + e.amount_twd);
  }
  return map;
}

function taipeiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function shiftMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year!, monthNumber! - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
