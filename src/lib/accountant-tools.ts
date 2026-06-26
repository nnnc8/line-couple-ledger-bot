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

const recordExpenseParams = z.object({
  description: z.string().min(1).max(200),
  amount_twd: z.number().int().positive(),
  category: z.string().optional(),
  category_label: z.string().optional(),
  paid_by: z.enum(["self", "partner"]),
  ledger: z.enum(["shared", "private"]).default("shared"),
  split_method: z.enum(["equal", "exact", "percentage"]).default("equal"),
  expense_date: z.string().optional(),
  merchant: z.string().optional(),
  notes: z.string().optional(),
});

const settleDebtParams = z.object({
  amount_twd: z.number().int().positive(),
  note: z.string().optional(),
});

const setBudgetParams = z.object({
  category: z.string().nullable().optional(),
  category_label: z.string().optional(),
  limit_twd: z.number().int().positive(),
});

const analyzeSpendingParams = z.object({
  date_from: z.string().optional(),
  date_to: z.string().optional(),
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
  /* ─── Write tools (create pending actions) ─── */
  {
    name: "record_expense",
    description:
      "記帳。建立一筆待確認的支出。使用者需要在 LINE 上點選確認才會正式寫入。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        description: {
          type: Type.STRING,
          description: "支出說明，例如「晚餐」、「全聯超市」",
        },
        amount_twd: {
          type: Type.INTEGER,
          description: "金額（新台幣整數）",
        },
        category: {
          type: Type.STRING,
          description:
            "大分類：food / transport / shopping / entertainment / housing / utilities / health / education / travel / other",
        },
        category_label: {
          type: Type.STRING,
          description: "細分類標籤，例如「外食」、「油資」",
        },
        paid_by: {
          type: Type.STRING,
          description: "誰付的：self / partner",
          enum: ["self", "partner"],
        },
        ledger: {
          type: Type.STRING,
          description: "shared（共同帳）或 private（私人帳）",
          enum: ["shared", "private"],
        },
        split_method: {
          type: Type.STRING,
          description: "分帳方式：equal（平均）/ exact（指定金額）/ percentage",
          enum: ["equal", "exact", "percentage"],
        },
        expense_date: {
          type: Type.STRING,
          description: "支出日期 YYYY-MM-DD，預設今天",
        },
        merchant: {
          type: Type.STRING,
          description: "商家名稱（選填）",
        },
        notes: {
          type: Type.STRING,
          description: "備註（選填）",
        },
      },
      required: ["description", "amount_twd", "paid_by"],
    },
  },
  {
    name: "settle_debt",
    description:
      "建議或建立結清。產生一筆待確認的結清 action。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        amount_twd: {
          type: Type.INTEGER,
          description: "結清金額（新台幣整數）",
        },
        note: {
          type: Type.STRING,
          description: "備註（選填）",
        },
      },
      required: ["amount_twd"],
    },
  },
  {
    name: "set_budget",
    description:
      "設定月預算。產生一筆待確認的預算 action。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: {
          type: Type.STRING,
          description:
            "大分類，或 null 表示群組總預算",
        },
        category_label: {
          type: Type.STRING,
          description: "細分類標籤（選填）",
        },
        limit_twd: {
          type: Type.INTEGER,
          description: "預算上限（新台幣整數）",
        },
      },
      required: ["limit_twd"],
    },
  },
  {
    name: "analyze_spending",
    description:
      "深度分析支出。回傳分類佔比、趨勢、預算狀態、異常偵測等綜合分析。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        date_from: {
          type: Type.STRING,
          description: "起始日期 YYYY-MM-DD（預設本月1號）",
        },
        date_to: {
          type: Type.STRING,
          description: "結束日期 YYYY-MM-DD（預設今天）",
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
    case "record_expense":
      return recordExpense(recordExpenseParams.parse(args), ctx);
    case "settle_debt":
      return settleDebt(settleDebtParams.parse(args), ctx);
    case "set_budget":
      return setBudget(setBudgetParams.parse(args), ctx);
    case "analyze_spending":
      return analyzeSpending(analyzeSpendingParams.parse(args), ctx);
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

/* ─── record_expense ─── */

async function recordExpense(
  params: z.infer<typeof recordExpenseParams>,
  ctx: ToolContext,
) {
  const today = taipeiToday();
  const expenseDate = params.expense_date || today;

  // Look up partner user id
  const { data: partnerRow } = await ctx.db
    .from("group_members")
    .select("user_id")
    .eq("group_id", ctx.groupId)
    .neq("user_id", ctx.userId)
    .single();

  const partnerId = partnerRow?.user_id as string | undefined;

  const paidBy = params.paid_by === "self" ? ctx.userId : partnerId;
  if (!paidBy) return { error: "找不到對方用戶" };

  // Build expense row for pending action
  const expenseRow = {
    group_id: ctx.groupId,
    ledger: params.ledger,
    description: params.description,
    merchant: params.merchant ?? null,
    notes: params.notes ?? null,
    category: params.category ?? "other",
    category_label: params.category_label ?? null,
    amount_twd: params.amount_twd,
    paid_by_user_id: paidBy,
    created_by_user_id: ctx.userId,
    expense_date: expenseDate,
    split_method: params.split_method,
  };

  // Build pending action
  const action = {
    type: "create_expense" as const,
    groupId: ctx.groupId,
    userId: ctx.userId,
    expense: expenseRow,
    splits:
      params.split_method === "equal"
        ? [
            { user_id: ctx.userId, amount_twd: Math.ceil(params.amount_twd / 2) },
            { user_id: partnerId!, amount_twd: Math.floor(params.amount_twd / 2) },
          ]
        : undefined,
  };

  return {
    pending_action: action,
    message: `已為您建立一筆 ${params.ledger === "private" ? "私人" : "共同"}帳支出：${params.description} NT$${params.amount_twd}（${params.paid_by === "self" ? "你付的" : "對方付的"}），請確認。`,
  };
}

/* ─── settle_debt ─── */

async function settleDebt(
  params: z.infer<typeof settleDebtParams>,
  ctx: ToolContext,
) {
  // Get current balance
  const result = await ctx.db.rpc("group_balances", {
    p_group_id: ctx.groupId,
  });
  if (result.error) return { error: "查詢餘額失敗" };

  const balances = z
    .array(z.object({ user_id: z.string(), balance_twd: z.number() }))
    .parse(result.data ?? []);

  const mine = balances.find((b) => b.user_id === ctx.userId)?.balance_twd ?? 0;

  if (mine >= 0) {
    return {
      message: `目前你不需要結清（你的餘額為 NT$${mine}）。對方欠你 NT$${Math.abs(mine)}。`,
    };
  }

  const maxSettle = Math.abs(mine);
  if (params.amount_twd > maxSettle) {
    return {
      error: `結清金額 NT$${params.amount_twd} 超過你欠的 NT$${maxSettle}，請調整。`,
    };
  }

  const action = {
    type: "settle" as const,
    groupId: ctx.groupId,
    userId: ctx.userId,
    amountTwd: params.amount_twd,
  };

  return {
    pending_action: action,
    message: `已為您建立結清：你欠另一半 NT$${params.amount_twd}，請確認。`,
  };
}

/* ─── set_budget ─── */

async function setBudget(
  params: z.infer<typeof setBudgetParams>,
  ctx: ToolContext,
) {
  const action = {
    type: "set_budget" as const,
    groupId: ctx.groupId,
    userId: ctx.userId,
    category: params.category ?? null,
    categoryLabel: params.category_label ?? null,
    limitTwd: params.limit_twd,
  };

  const label = params.category_label ?? params.category ?? "群組總預算";
  return {
    pending_action: action,
    message: `已為您設定「${label}」月預算 NT$${params.limit_twd}，請確認。`,
  };
}

/* ─── analyze_spending ─── */

async function analyzeSpending(
  params: z.infer<typeof analyzeSpendingParams>,
  ctx: ToolContext,
) {
  const today = taipeiToday();
  const monthStart = today.slice(0, 7) + "-01";
  const dateFrom = params.date_from ?? monthStart;
  const dateTo = params.date_to ?? today;

  // Gather all data in parallel
  const [expenses, balanceResult, budgetResult, anomalies] = await Promise.all([
    loadFilteredExpenses(ctx, { dateFrom, dateTo, type: "shared" }),
    ctx.db.rpc("group_balances", { p_group_id: ctx.groupId }),
    ctx.db
      .from("budgets")
      .select("*")
      .eq("group_id", ctx.groupId)
      .is("category", null)
      .single(),
    detectDuplicateAgentExpenses(
      await loadFilteredExpenses(ctx, { dateFrom, dateTo, type: "shared" }).then(
        (expenses) =>
          expenses.map((e) => ({
            ...e,
            group_id: ctx.groupId,
            created_by_user_id: ctx.userId,
            version: 1,
            deleted_at: null,
          })) as AgentExpense[],
      ),
    ),
  ]);

  const total = expenses.reduce((s, e) => s + e.amount_twd, 0);
  const byCategory = breakdownByKey(expenses, "category_label");

  const topCategories = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, amount]) => ({
      label,
      amount,
      percent: total > 0 ? Math.round((amount / total) * 100) : 0,
    }));

  const budgetData = budgetResult.data as { limit_twd: number } | null;
  const budgetUsage = budgetData
    ? {
        limit: budgetData.limit_twd,
        spent: total,
        percent: Math.round((total / budgetData.limit_twd) * 100),
        remaining: Math.max(0, budgetData.limit_twd - total),
      }
    : null;

  // Daily average and projection
  const daysElapsed = Math.max(
    1,
    Math.floor(
      (new Date(dateTo).getTime() - new Date(dateFrom).getTime()) /
        (1000 * 60 * 60 * 24),
    ) + 1,
  );
  const daysInMonth = new Date(
    new Date(dateFrom).getFullYear(),
    new Date(dateFrom).getMonth() + 1,
    0,
  ).getDate();
  const dailyAvg = Math.round(total / daysElapsed);
  const projected = dailyAvg * daysInMonth;

  return {
    period: { from: dateFrom, to: dateTo },
    total,
    transaction_count: expenses.length,
    daily_average: dailyAvg,
    projected_month_end: projected,
    top_categories: topCategories,
    budget_usage: budgetUsage,
    anomalies: anomalies.length > 0 ? anomalies.slice(0, 3) : undefined,
    balance: !balanceResult.error
      ? (balanceResult.data as Array<{ user_id: string; balance_twd: number }>)
      : undefined,
  };
}
