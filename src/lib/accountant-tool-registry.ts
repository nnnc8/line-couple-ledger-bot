import { type FunctionDeclaration, Type } from "@google/genai";
import { z } from "zod";
import { buildCreateExpenseAction, buildSettleAction } from "./pending-action-builders";
import {
  classifyExpenseCategory,
  type CategoryClassificationGenerator,
} from "./category-agent";
import { isChineseCategoryTag, normalizeCategoryTag } from "./category-tags";
import { HttpError } from "./http-error";
import { accountantService, ledgerQueryService } from "./services";
import type { ToolContext } from "./accountant-tools";
import { convertToTwd, isSupportedCurrency, type Currency } from "./currency-service";

export interface AccountantToolDef {
  name: string;
  description: string;
  geminiParameters: FunctionDeclaration["parameters"];
  zodSchema: z.ZodTypeAny;
  executor: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<unknown>;
}

// ─── Zod Schemas (Canonical Source) ───

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
  currency: z.string().optional(),
  original_amount: z.number().positive().optional(),
});

const settleDebtParams = z.object({
  amount_twd: z.number().int().positive(),
  note: z.string().optional(),
});

const analyzeSpendingParams = z.object({
  date_from: z.string().optional(),
  date_to: z.string().optional(),
});

// ─── Executor Functions ───

async function executeQueryExpenses(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  const params = queryExpensesParams.parse(args);
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

async function executeGetBalanceSummary(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  return ledgerQueryService.balanceSummary({
    db: ctx.db,
    groupId: ctx.groupId,
    userId: ctx.userId,
  });
}

async function executeGetCategoryBreakdown(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  const params = categoryBreakdownParams.parse(args);
  return accountantService.categoryBreakdown(ctx, {
    dateFrom: params.date_from,
    dateTo: params.date_to,
  });
}

async function executeComparePeriod(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  const params = comparePeriodParams.parse(args);
  return accountantService.comparePeriods(ctx, {
    periodA: params.period_a,
    periodB: params.period_b,
  });
}

async function executeGetRecurringList(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  return ledgerQueryService.recurringList({
    db: ctx.db,
    coupleId: ctx.coupleId,
  });
}

async function executeGetAnomalies(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  const params = anomaliesParams.parse(args);
  return accountantService.anomalies(ctx, {
    dateFrom: params.date_from,
    dateTo: params.date_to,
  });
}

async function executeGetCategoryTrend(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  const params = categoryTrendParams.parse(args);
  return accountantService.categoryTrend(ctx, {
    tag: params.tag,
    months: params.months,
  });
}

async function executePredictMonthEnd(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  const params = predictMonthEndParams.parse(args);
  return accountantService.predictMonthEnd(ctx, {
    tag: params.tag,
  });
}

async function executeRecordExpense(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  const params = recordExpenseParams.parse(args);
  try {
    const tag = await resolveExpenseTag(params, ctx);
    let amountTwd = params.amount_twd;
    let originalAmount: number | undefined;
    let currency = "TWD";

    if (params.currency && params.currency !== "TWD") {
      if (!isSupportedCurrency(params.currency)) {
        return { error: `不支援的幣別：${params.currency}` };
      }
      const rawAmount = params.original_amount ?? params.amount_twd;
      const { twdAmount } = await convertToTwd(rawAmount, params.currency as Currency);
      amountTwd = twdAmount;
      originalAmount = rawAmount;
      currency = params.currency;
    }

    const actionParams = {
      ...params,
      tag,
      amount_twd: amountTwd,
      ...(originalAmount !== undefined ? { original_amount: originalAmount, currency } : {}),
    };

    const action = await buildCreateExpenseAction(ctx, actionParams);

    // Look up group name for reply
    let groupLabel = "";
    if (params.ledger !== "private" && ctx.groupId) {
      const { data: groupRow } = await ctx.db
        .from("groups")
        .select("name")
        .eq("id", ctx.groupId)
        .single();
      if (groupRow?.name) {
        groupLabel = `｜${groupRow.name}`;
      }
    }

    const currencyNote = currency !== "TWD" && originalAmount !== undefined
      ? `（原幣 ${currency} ${originalAmount} → NT$${amountTwd}）`
      : "";

    return {
      pending_action: action,
      message: `已為您記下一筆${params.ledger === "private" ? "私人" : "共同"}帳支出：${params.description} NT$${amountTwd}${currencyNote}（${params.paid_by === "self" ? "你付的" : "對方付的"}）${groupLabel}。`,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "建立支出失敗",
    };
  }
}

async function resolveExpenseTag(
  params: z.infer<typeof recordExpenseParams>,
  ctx: ToolContext,
): Promise<string> {
  const suppliedTag = normalizeCategoryTag(params.tag);
  if (suppliedTag && isChineseCategoryTag(suppliedTag)) return suppliedTag;

  const categoryContext = await loadCategoryContext(ctx, params.ledger);
  const generator = ctx.context?.categoryClassificationGenerator;
  const classification = await classifyExpenseCategory(
    {
      description: params.description,
      merchant: params.merchant ?? null,
      groupName: categoryContext.groupName,
      fallbackTag: suppliedTag ?? "其他",
      history: categoryContext.history,
    },
    typeof generator === "function"
      ? (generator as CategoryClassificationGenerator)
      : undefined,
  );
  const classifiedTag = normalizeCategoryTag(classification.tag);
  return classifiedTag && isChineseCategoryTag(classifiedTag)
    ? classifiedTag
    : "其他";
}

async function loadCategoryContext(
  ctx: ToolContext,
  ledger: "shared" | "private",
): Promise<{
  groupName: string | null;
  history: Array<{
    tag: string;
    description: string;
    merchant: string | null;
  }>;
}> {
  const groupNamePromise = ledger === "private"
    ? Promise.resolve(null)
    : (async () => {
        try {
          const result = await ctx.db
            .from("groups")
            .select("name")
            .eq("id", ctx.groupId)
            .single();
          return typeof result.data?.name === "string" ? result.data.name : null;
        } catch {
          return null;
        }
      })();

  const historyPromise = (async () => {
    try {
      let query = ctx.db
        .from("expenses")
        .select("tag, description, merchant")
        .eq("couple_id", ctx.coupleId)
        .is("deleted_at", null)
        .order("expense_date", { ascending: false })
        .limit(100);
      query = ledger === "private"
        ? query.eq("created_by_user_id", ctx.userId)
        : query.eq("group_id", ctx.groupId).eq("ledger", "shared");
      const result = await query;
      const parsed = z
        .array(
          z.object({
            tag: z.string(),
            description: z.string(),
            merchant: z.string().nullable().optional(),
          }),
        )
        .safeParse(result.data ?? []);
      if (!parsed.success) return [];
      return parsed.data
        .filter((entry) => normalizeCategoryTag(entry.tag) !== null)
        .slice(0, 30)
        .map((entry) => ({
          tag: normalizeCategoryTag(entry.tag)!,
          description: entry.description,
          merchant: entry.merchant ?? null,
        }));
    } catch {
      return [];
    }
  })();

  const [groupName, history] = await Promise.all([groupNamePromise, historyPromise]);
  return { groupName, history };
}

async function executeSettleDebt(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  const params = settleDebtParams.parse(args);
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

async function executeAnalyzeSpending(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  const params = analyzeSpendingParams.parse(args);
  return accountantService.analyzeSpending(ctx, {
    dateFrom: params.date_from,
    dateTo: params.date_to,
  });
}

// ─── Registry Definition ───

export const ACCOUNTANT_TOOLS: AccountantToolDef[] = [
  {
    name: "query_expenses",
    description: "自由查帳。沒有指定 limit 時只回傳聚合摘要（total/count/average），有 limit 才回傳明細（最多 20 筆）。",
    geminiParameters: {
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
    zodSchema: queryExpensesParams,
    executor: executeQueryExpenses,
  },
  {
    name: "get_balance_summary",
    description: "查詢目前誰欠誰多少，含 breakdown。",
    geminiParameters: { type: Type.OBJECT, properties: {} },
    zodSchema: z.object({}),
    executor: executeGetBalanceSummary,
  },
  {
    name: "get_category_breakdown",
    description: "某段時間內的標籤佔比。",
    geminiParameters: {
      type: Type.OBJECT,
      properties: {
        date_from: { type: Type.STRING, description: "起始日 YYYY-MM-DD" },
        date_to: { type: Type.STRING, description: "結束日 YYYY-MM-DD" },
      },
      required: ["date_from", "date_to"],
    },
    zodSchema: categoryBreakdownParams,
    executor: executeGetCategoryBreakdown,
  },
  {
    name: "compare_period",
    description: "比較兩段時間的支出（可按標籤拆解）。",
    geminiParameters: {
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
    zodSchema: comparePeriodParams,
    executor: executeComparePeriod,
  },
  {
    name: "get_recurring_list",
    description: "列出所有固定/週期支出。",
    geminiParameters: { type: Type.OBJECT, properties: {} },
    zodSchema: z.object({}),
    executor: executeGetRecurringList,
  },
  {
    name: "get_anomalies",
    description: "找異常或重複候選支出（同日同額同描述）。",
    geminiParameters: {
      type: Type.OBJECT,
      properties: {
        date_from: { type: Type.STRING },
        date_to: { type: Type.STRING },
      },
    },
    zodSchema: anomaliesParams,
    executor: executeGetAnomalies,
  },
  {
    name: "get_category_trend",
    description: "某個標籤最近幾個月的趨勢（每月金額）。",
    geminiParameters: {
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
    zodSchema: categoryTrendParams,
    executor: executeGetCategoryTrend,
  },
  {
    name: "predict_month_end",
    description: "用線性外推預測本月底總花費。可指定 tag 只預測單一標籤。",
    geminiParameters: {
      type: Type.OBJECT,
      properties: {
        tag: {
          type: Type.STRING,
          description: "不傳就預測全部總支出",
        },
      },
    },
    zodSchema: predictMonthEndParams,
    executor: executePredictMonthEnd,
  },
  {
    name: "record_expense",
    description: "記帳。直接寫入一筆支出，不需使用者再按確認。",
    geminiParameters: {
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
        currency: { type: Type.STRING, description: "幣別代碼（TWD/USD/JPY/EUR/KRW/THB），預設 TWD" },
        original_amount: { type: Type.INTEGER, description: "原幣金額（非 TWD 時填入）" },
      },
      required: ["description", "amount_twd", "paid_by"],
    },
    zodSchema: recordExpenseParams,
    executor: executeRecordExpense,
  },
  {
    name: "settle_debt",
    description: "建立結清紀錄。直接寫入，不需使用者再按確認。",
    geminiParameters: {
      type: Type.OBJECT,
      properties: {
        amount_twd: { type: Type.INTEGER, description: "結清金額（新台幣整數）" },
        note: { type: Type.STRING, description: "備註（選填）" },
      },
      required: ["amount_twd"],
    },
    zodSchema: settleDebtParams,
    executor: executeSettleDebt,
  },
  {
    name: "analyze_spending",
    description: "深度分析支出。回傳標籤佔比、趨勢、異常偵測等綜合分析。",
    geminiParameters: {
      type: Type.OBJECT,
      properties: {
        date_from: { type: Type.STRING, description: "起始日期 YYYY-MM-DD（預設本月1號）" },
        date_to: { type: Type.STRING, description: "結束日期 YYYY-MM-DD（預設今天）" },
      },
    },
    zodSchema: analyzeSpendingParams,
    executor: executeAnalyzeSpending,
  },
];

const TOOL_BY_NAME = new Map(ACCOUNTANT_TOOLS.map((t) => [t.name, t]));

export const ACCOUNTANT_TOOL_NAMES: readonly string[] = ACCOUNTANT_TOOLS.map(
  (t) => t.name,
);

export function getAccountantTool(name: string): AccountantToolDef {
  const def = TOOL_BY_NAME.get(name);
  if (!def) {
    throw new Error(`Unknown accountant tool: ${name}`);
  }
  return def;
}

export function findAccountantTool(name: string): AccountantToolDef | undefined {
  return TOOL_BY_NAME.get(name);
}

export function accountantToolDeclarations(): FunctionDeclaration[] {
  return ACCOUNTANT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.geminiParameters,
  }));
}

export async function dispatchAccountantTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const tool = findAccountantTool(name);
  if (!tool) {
    return { error: `Unknown tool: ${name}` };
  }
  return tool.executor(args, ctx);
}
