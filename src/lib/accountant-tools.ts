import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { type FunctionDeclaration, Type } from "@google/genai";

import {
  detectDuplicateAgentExpenses,
  type AgentExpense,
} from "./ledger-agent";

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

const queryExpensesParams = z.object({
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  tag: z.string().optional(),
  member: z.enum(["me", "partner", "both"]).optional(),
  type: z.enum(["shared", "private", "all"]).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  sort: z.enum(["date_desc", "amount_desc"]).optional(),
});

const categoryBreakdownParams = z.object({
  date_from: z.string(),
  date_to: z.string(),
});

const comparePeriodParams = z.object({
  period_a: z.object({ from: z.string(), to: z.string() }),
  period_b: z.object({ from: z.string(), to: z.string() }),
});

const anomaliesParams = z.object({
  date_from: z.string().optional(),
  date_to: z.string().optional(),
});

const categoryTrendParams = z.object({
  tag: z.string(),
  months: z.number().int().min(1).max(24).default(3),
});

const predictMonthEndParams = z.object({
  tag: z.string().optional(),
});

const recordExpenseParams = z.object({
  description: z.string().min(1).max(200),
  amount_twd: z.number().int().positive(),
  tag: z.string().min(1).max(40).optional(),
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

const analyzeSpendingParams = z.object({
  date_from: z.string().optional(),
  date_to: z.string().optional(),
});

export const toolDeclarations: FunctionDeclaration[] = [
  {
    name: "query_expenses",
    description:
      "自由查帳。沒有指定 limit 時只回傳聚合摘要（total/count/average），有 limit 才回傳明細（最多 20 筆）。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        date_from: { type: Type.STRING, description: "起始日期 YYYY-MM-DD（含）" },
        date_to: { type: Type.STRING, description: "結束日期 YYYY-MM-DD（不含）" },
        tag: { type: Type.STRING, description: "篩選標籤" },
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
    description: "某段時間內的標籤佔比。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        date_from: { type: Type.STRING, description: "起始日 YYYY-MM-DD" },
        date_to: { type: Type.STRING, description: "結束日 YYYY-MM-DD" },
      },
      required: ["date_from", "date_to"],
    },
  },
  {
    name: "compare_period",
    description: "比較兩段時間的支出（可按標籤拆解）。",
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
      },
      required: ["period_a", "period_b"],
    },
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
    description: "某個標籤最近幾個月的趨勢（每月金額）。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        tag: {
          type: Type.STRING,
          description: "要查的標籤名稱",
        },
        months: {
          type: Type.INTEGER,
          description: "回溯幾個月（1-24）",
        },
      },
      required: ["tag"],
    },
  },
  {
    name: "predict_month_end",
    description:
      "用線性外推預測本月底總花費。可指定 tag 只預測單一標籤。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        tag: {
          type: Type.STRING,
          description: "不傳就預測全部總支出",
        },
      },
    },
  },
  {
    name: "record_expense",
    description:
      "記帳。直接寫入一筆支出，不需使用者再按確認。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        description: { type: Type.STRING, description: "支出說明" },
        amount_twd: { type: Type.INTEGER, description: "金額（新台幣整數）" },
        tag: { type: Type.STRING, description: "自由標籤，例如「外食」、「油資」" },
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
        expense_date: { type: Type.STRING, description: "支出日期 YYYY-MM-DD，預設今天" },
        merchant: { type: Type.STRING, description: "商家名稱（選填）" },
        notes: { type: Type.STRING, description: "備註（選填）" },
      },
      required: ["description", "amount_twd", "paid_by"],
    },
  },
  {
    name: "settle_debt",
    description:
      "建立結清紀錄。直接寫入，不需使用者再按確認。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        amount_twd: { type: Type.INTEGER, description: "結清金額（新台幣整數）" },
        note: { type: Type.STRING, description: "備註（選填）" },
      },
      required: ["amount_twd"],
    },
  },
  {
    name: "analyze_spending",
    description:
      "深度分析支出。回傳標籤佔比、趨勢、異常偵測等綜合分析。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        date_from: { type: Type.STRING, description: "起始日期 YYYY-MM-DD（預設本月1號）" },
        date_to: { type: Type.STRING, description: "結束日期 YYYY-MM-DD（預設今天）" },
      },
    },
  },
];

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
    case "analyze_spending":
      return analyzeSpending(analyzeSpendingParams.parse(args), ctx);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function queryExpenses(
  params: z.infer<typeof queryExpensesParams>,
  ctx: ToolContext,
) {
  const expenses = await loadFilteredExpenses(ctx, {
    dateFrom: params.date_from,
    dateTo: params.date_to,
    tag: params.tag,
    member: params.member,
    type: params.type,
  });

  const summary = summarize(expenses);

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
    const key = e.tag;
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

  const totalA = expA.reduce((s, e) => s + e.amount_twd, 0);
  const totalB = expB.reduce((s, e) => s + e.amount_twd, 0);

  const aMap = breakdownByKey(expA);
  const bMap = breakdownByKey(expB);
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

  return {
    period_a: { total: totalA, count: expA.length },
    period_b: { total: totalB, count: expB.length },
    change_percent: totalB
      ? Math.round(((totalA - totalB) / totalB) * 100)
      : null,
    comparison,
  };
}

async function getRecurringList(ctx: ToolContext) {
  const result = await ctx.db
    .from("recurring_expenses")
    .select(
      "id, description, amount_twd, frequency, next_run_date, active, tag, ledger",
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
      tag: r.tag,
      ledger: r.ledger,
    })),
  };
}

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
    tag: params.tag,
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

  return { tag: params.tag, trend };
}

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
    tag: params.tag,
  });

  const spentSoFar = expenses.reduce((s, e) => s + e.amount_twd, 0);
  const projectedTotal = Math.round((spentSoFar / daysElapsed) * daysTotal);

  return {
    days_elapsed: daysElapsed,
    days_total: daysTotal,
    spent_so_far: spentSoFar,
    projected_total: projectedTotal,
  };
}

interface FilterOpts {
  dateFrom?: string;
  dateTo?: string;
  tag?: string;
  member?: "me" | "partner" | "both";
  type?: "shared" | "private" | "all";
}

const expenseQuerySchema = z.object({
  id: z.string().uuid(),
  description: z.string(),
  merchant: z.string().nullable(),
  tag: z.string(),
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
        "id, description, merchant, tag, amount_twd, paid_by_user_id, expense_date, ledger",
      )
      .eq("group_id", ctx.groupId)
      .is("deleted_at", null)
      .is("mirror_kind", null);
    if (opts.dateFrom) q = q.gte("expense_date", opts.dateFrom);
    if (opts.dateTo) q = q.lt("expense_date", opts.dateTo);
    if (opts.tag) q = q.eq("tag", opts.tag);
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
        "id, description, merchant, tag, amount_twd, paid_by_user_id, expense_date, ledger",
      )
      .eq("ledger", "private")
      .eq("created_by_user_id", ctx.userId)
      .is("deleted_at", null)
      .is("mirror_kind", null);
    if (opts.dateFrom) q = q.gte("expense_date", opts.dateFrom);
    if (opts.dateTo) q = q.lt("expense_date", opts.dateTo);
    if (opts.tag) q = q.eq("tag", opts.tag);
    q = q.order("expense_date", { ascending: false }).limit(500);
    queries.push(q as unknown as Promise<{ data: unknown[] | null; error: unknown }>);
  }

  const results = await Promise.all(queries);
  const rows = results.flatMap((r) =>
    r.error ? [] : z.array(expenseQuerySchema).parse(r.data ?? []),
  );

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
    tag: e.tag,
    amount: e.amount_twd,
    date: e.expense_date,
    ledger: e.ledger,
  };
}

function breakdownByKey(expenses: ToolExpense[]) {
  const map = new Map<string, number>();
  for (const e of expenses) {
    const label = e.tag;
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

async function recordExpense(
  params: z.infer<typeof recordExpenseParams>,
  ctx: ToolContext,
) {
  const today = taipeiToday();
  const expenseDate = params.expense_date || today;

  const { data: partnerRow } = await ctx.db
    .from("group_members")
    .select("user_id")
    .eq("group_id", ctx.groupId)
    .neq("user_id", ctx.userId)
    .single();

  const partnerId = partnerRow?.user_id as string | undefined;

  const paidBy = params.paid_by === "self" ? ctx.userId : partnerId;
  if (!paidBy) return { error: "找不到對方用戶" };

  const expenseRow = {
    group_id: ctx.groupId,
    ledger: params.ledger,
    description: params.description,
    merchant: params.merchant ?? null,
    notes: params.notes ?? null,
    tag: params.tag ?? "其他",
    amount_twd: params.amount_twd,
    paid_by_user_id: paidBy,
    created_by_user_id: ctx.userId,
    expense_date: expenseDate,
    split_method: params.split_method,
  };

  const splits =
    params.ledger === "private"
      ? undefined
      : params.split_method === "equal"
        ? (() => {
            if (!partnerId) return undefined;
            return [
              { user_id: ctx.userId, amount_twd: Math.ceil(params.amount_twd / 2) },
              { user_id: partnerId, amount_twd: Math.floor(params.amount_twd / 2) },
            ];
          })()
        : undefined;

  const action = {
    type: "create_expense" as const,
    groupId: ctx.groupId,
    userId: ctx.userId,
    expense: expenseRow,
    splits,
  };

  return {
    pending_action: action,
    message: `已為您建立一筆 ${params.ledger === "private" ? "私人" : "共同"}帳支出：${params.description} NT$${params.amount_twd}（${params.paid_by === "self" ? "你付的" : "對方付的"}），請確認。`,
  };
}

async function settleDebt(
  params: z.infer<typeof settleDebtParams>,
  ctx: ToolContext,
) {
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

async function analyzeSpending(
  params: z.infer<typeof analyzeSpendingParams>,
  ctx: ToolContext,
) {
  const today = taipeiToday();
  const monthStart = today.slice(0, 7) + "-01";
  const dateFrom = params.date_from ?? monthStart;
  const dateTo = params.date_to ?? today;

  const [expenses, balanceResult, anomalies] = await Promise.all([
    loadFilteredExpenses(ctx, { dateFrom, dateTo, type: "shared" }),
    ctx.db.rpc("group_balances", { p_group_id: ctx.groupId }),
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
  const byTag = breakdownByKey(expenses);

  const topTags = [...byTag.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, amount]) => ({
      label,
      amount,
      percent: total > 0 ? Math.round((amount / total) * 100) : 0,
    }));

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
    top_tags: topTags,
    anomalies: anomalies.length > 0 ? anomalies.slice(0, 3) : undefined,
    balance: !balanceResult.error
      ? (balanceResult.data as Array<{ user_id: string; balance_twd: number }>)
      : undefined,
  };
}
