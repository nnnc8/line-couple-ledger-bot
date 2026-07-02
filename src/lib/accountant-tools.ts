import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { type FunctionDeclaration, Type } from "@google/genai";
import { buildCreateExpenseAction, buildSettleAction } from "./pending-action-builders";
import { HttpError } from "./http-error";

import { accountantService, ledgerQueryService } from "./services";

export interface ToolContext {
  db: SupabaseClient;
  groupId: string;
  userId: string;
  coupleId: number;
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
  return ledgerQueryService.queryExpenses(
    { db: ctx.db, groupId: ctx.groupId, userId: ctx.userId },
    {
      dateFrom: params.date_from,
      dateTo: params.date_to,
      tag: params.tag,
      member: params.member,
      type: params.type,
      limit: params.limit,
      sort: params.sort,
    },
  );
}

async function getBalanceSummary(ctx: ToolContext) {
  return ledgerQueryService.balanceSummary({
    db: ctx.db,
    groupId: ctx.groupId,
    userId: ctx.userId,
  });
}

async function getCategoryBreakdown(
  params: z.infer<typeof categoryBreakdownParams>,
  ctx: ToolContext,
) {
  return accountantService.categoryBreakdown(ctx, {
    dateFrom: params.date_from,
    dateTo: params.date_to,
  });
}

async function comparePeriod(
  params: z.infer<typeof comparePeriodParams>,
  ctx: ToolContext,
) {
  return accountantService.comparePeriods(ctx, {
    periodA: params.period_a,
    periodB: params.period_b,
  });
}

async function getRecurringList(ctx: ToolContext) {
  return ledgerQueryService.recurringList({
    db: ctx.db,
    coupleId: ctx.coupleId,
  });
}

async function getAnomalies(
  params: z.infer<typeof anomaliesParams>,
  ctx: ToolContext,
) {
  return accountantService.anomalies(ctx, {
    dateFrom: params.date_from,
    dateTo: params.date_to,
  });
}

async function getCategoryTrend(
  params: z.infer<typeof categoryTrendParams>,
  ctx: ToolContext,
) {
  return accountantService.categoryTrend(ctx, {
    tag: params.tag,
    months: params.months,
  });
}

async function predictMonthEnd(
  params: z.infer<typeof predictMonthEndParams>,
  ctx: ToolContext,
) {
  return accountantService.predictMonthEnd(ctx, {
    tag: params.tag,
  });
}

async function recordExpense(
  params: z.infer<typeof recordExpenseParams>,
  ctx: ToolContext,
) {
  try {
    const action = await buildCreateExpenseAction(ctx, params);
    return {
      pending_action: action,
      message: `已為您記下一筆 ${params.ledger === "private" ? "私人" : "共同"}帳支出：${params.description} NT$${params.amount_twd}（${params.paid_by === "self" ? "你付的" : "對方付的"}）。`,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "建立支出失敗",
    };
  }
}

async function settleDebt(
  params: z.infer<typeof settleDebtParams>,
  ctx: ToolContext,
) {
  try {
    const action = await buildSettleAction(ctx, params.amount_twd);
    return {
      pending_action: action,
      message: `已為您建立結清：你欠另一半 NT$${params.amount_twd}。`,
    };
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.message.includes("不需要結清")) {
        return { message: error.message };
      }
      return { error: error.message };
    }
    return {
      error: error instanceof Error ? error.message : "建立結清失敗",
    };
  }
}

async function analyzeSpending(
  params: z.infer<typeof analyzeSpendingParams>,
  ctx: ToolContext,
) {
  return accountantService.analyzeSpending(ctx, {
    dateFrom: params.date_from,
    dateTo: params.date_to,
  });
}
