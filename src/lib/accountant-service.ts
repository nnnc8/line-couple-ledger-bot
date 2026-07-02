import { randomUUID } from "node:crypto";

import { generateObject } from "ai";
import type { ServerContext } from "./server-runtime";
import { z } from "zod";

import {
  accountantLlmReportSchema,
  accountantReportFromLlm,
  buildAccountantSnapshot,
  fallbackAccountantReport,
  type AccountantExpense,
  type AccountantReport,
} from "./accountant";
import {
  agentRangeLabel,
  aggregateAgentExpenses,
  batchCategoryUpdateSchema,
  detectDuplicateAgentExpenses,
  filterAgentExpenses,
  parseAgentRequest,
  rankCategoryLabels,
  safeBatchCategoryUpdates,
  suggestCategoryCleanup,
  type AgentExpense,
  type AgentScope,
  type AgentTimeRange,
} from "./ledger-agent";
import { getModel } from "./model-provider";
import { HttpError } from "./http-error";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LedgerVisibleExpense } from "./ledger-query";
import { ledgerQueryService } from "./services";

const MODEL = "gemini-3.1-flash-lite";
const EXPENSE_SELECT =
  "id, group_id, ledger, description, merchant, notes, tag, mirror_kind, mirror_source_expense_id, amount_twd, paid_by_user_id, created_by_user_id, expense_date, split_method, version, deleted_at, created_at, expense_splits(user_id, amount_twd), receipts(id, status)";

const splitSchema = z.object({
  user_id: z.string().uuid(),
  amount_twd: z.coerce.number().int(),
});

const receiptRowSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
});

const userRowSchema = z.object({
  id: z.string().uuid(),
  couple_id: z.number().int(),
  line_user_id: z.string(),
  role: z.enum(["owner", "partner"]),
});

const groupRowSchema = z.object({
  id: z.string().uuid(),
  couple_id: z.coerce.number().int(),
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

const accountantReportRowSchema = z.object({
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

const agentLlmAnswerSchema = z
  .object({
    answer: z.string().trim().min(1).max(1_800),
    facts: z
      .object({
        totalTwd: z.number().int().min(0),
        transactionCount: z.number().int().min(0),
        topCategoryLabel: z.string().trim().min(1).max(40).nullable(),
        topCategoryTotalTwd: z.number().int().min(0).nullable(),
      })
      .strict(),
  })
  .strict();

const accountantAskInputSchema = z.object({
  question: z.string().trim().min(1).max(500),
  scope: z.enum(["shared", "private", "combined"]).default("combined"),
});

const agentRunInputSchema = z.object({
  message: z.string().trim().min(1).max(500),
  scope: z.enum(["shared", "private", "combined"]).optional(),
});

const categoryAnalyticsInputSchema = z.object({
  range: z.enum(["this_month", "six_months", "all"]).catch("this_month"),
  scope: z.enum(["shared", "private", "combined"]).catch("shared"),
});

const categoryCleanupInputSchema = z.object({
  updates: z.array(batchCategoryUpdateSchema).min(1).max(50),
});

type CleanupActionInput = {
  actionType: string;
  groupId: string | null;
  payload: Record<string, unknown>;
  sourceEventId: string;
  idempotencyKey?: string;
};

export type AccountantToolContext = {
  db: SupabaseClient;
  groupId: string;
  userId: string;
  coupleId: number;
};

export class AccountantService {
  private async listToolExpenses(
    context: AccountantToolContext,
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

  private toToolAgentExpense(
    expense: LedgerVisibleExpense,
    context: AccountantToolContext,
  ): AgentExpense {
    return {
      id: expense.id,
      group_id: expense.ledger === "private" ? null : context.groupId,
      ledger: expense.ledger,
      description: expense.description,
      merchant: expense.merchant,
      tag: expense.tag,
      mirror_kind: null,
      mirror_source_expense_id: null,
      amount_twd: expense.amount_twd,
      paid_by_user_id: expense.paid_by_user_id,
      created_by_user_id: context.userId,
      expense_date: expense.expense_date,
      version: 1,
      deleted_at: null,
    };
  }

  async categoryBreakdown(
    context: AccountantToolContext,
    params: { dateFrom: string; dateTo: string },
  ) {
    const expenses = await this.listToolExpenses(context, {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      limitPerLedger: 500,
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

  async comparePeriods(
    context: AccountantToolContext,
    params: {
      periodA: { from: string; to: string };
      periodB: { from: string; to: string };
    },
  ) {
    const [expA, expB] = await Promise.all([
      this.listToolExpenses(context, {
        dateFrom: params.periodA.from,
        dateTo: params.periodA.to,
        limitPerLedger: 500,
      }),
      this.listToolExpenses(context, {
        dateFrom: params.periodB.from,
        dateTo: params.periodB.to,
        limitPerLedger: 500,
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

  async anomalies(
    context: AccountantToolContext,
    params: { dateFrom?: string; dateTo?: string },
  ) {
    const expenses = await this.listToolExpenses(context, {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      limitPerLedger: 500,
    });
    const agentExpenses = expenses.map((e) => this.toToolAgentExpense(e, context));
    const duplicates = detectDuplicateAgentExpenses(agentExpenses);
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

  async categoryTrend(
    context: AccountantToolContext,
    params: { tag: string; months: number },
  ) {
    const today = taipeiToday();
    const currentMonth = today.slice(0, 7);
    const months: string[] = [];
    for (let i = params.months - 1; i >= 0; i--) {
      months.push(shiftMonth(currentMonth, -i));
    }
    const startDate = `${months[0]}-01`;
    const endDate = `${shiftMonth(currentMonth, 1)}-01`;

    const expenses = await this.listToolExpenses(context, {
      dateFrom: startDate,
      dateTo: endDate,
      tag: params.tag,
      limitPerLedger: 500,
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

  async predictMonthEnd(
    context: AccountantToolContext,
    params: { tag?: string },
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

    const expenses = await this.listToolExpenses(context, {
      dateFrom: `${month}-01`,
      dateTo: `${shiftMonth(month, 1)}-01`,
      tag: params.tag,
      limitPerLedger: 500,
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

  async analyzeSpending(
    context: AccountantToolContext,
    params: { dateFrom?: string; dateTo?: string },
  ) {
    const today = taipeiToday();
    const monthStart = today.slice(0, 7) + "-01";
    const dateFrom = params.dateFrom ?? monthStart;
    const dateTo = params.dateTo ?? today;

    const [expenses, balanceResult] = await Promise.all([
      this.listToolExpenses(context, {
        dateFrom,
        dateTo,
        type: "shared",
        limitPerLedger: 500,
      }),
      context.db.rpc("group_balances", { p_group_id: context.groupId }),
    ]);

    const agentExpenses = expenses.map((e) => this.toToolAgentExpense(e, context));
    const anomalies = detectDuplicateAgentExpenses(agentExpenses);

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
  async ask(context: ServerContext, input: unknown) {
    const parsed = accountantAskInputSchema.parse(input);
    const run = await this.runAgent(context, {
      message: parsed.question,
      scope: parsed.scope,
    });
    return run.report;
  }

  async runAgent(context: ServerContext, input: unknown) {
    const parsed = agentRunInputSchema.parse(input);
    const request = parseAgentRequest(`會計師 ${parsed.message}`)!;
    const scope = parsed.scope ?? request.scope;
    const groupId = await activeGroupId(context);
    const allExpenses = await loadAgentExpenses(context, groupId);
    const expenses = filterAgentExpenses({
      activeGroupId: groupId,
      expenses: allExpenses,
      now: taipeiToday(),
      scope,
      timeRange: request.timeRange,
      userId: context.user.id,
    });
    const aggregate = aggregateAgentExpenses(expenses);
    const categories = rankCategoryLabels(expenses);
    const duplicates = detectDuplicateAgentExpenses(expenses);
    const cleanupUpdates = safeBatchCategoryUpdates(
      suggestCategoryCleanup(expenses),
      allExpenses,
      { activeGroupId: groupId, userId: context.user.id },
    ).slice(0, 20);
    const toolCalls: Array<Record<string, unknown>> = [
      {
        tool: "search_expenses",
        args: { scope, timeRange: request.timeRange },
        count: expenses.length,
      },
      { tool: "aggregate_expenses", result: aggregate },
      { tool: "rank_categories", result: categories.slice(0, 8) },
      {
        tool: "detect_duplicates",
        count: duplicates.length,
        result: duplicates.slice(0, 5).map((items) =>
          items.map((expense) => ({
            id: expense.id,
            description: expense.description,
            amountTwd: expense.amount_twd,
            date: expense.expense_date,
            version: expense.version,
          })),
        ),
      },
    ];
    if (cleanupUpdates.length) {
      toolCalls.push({
        tool: "suggest_category_cleanup",
        count: cleanupUpdates.length,
        result: cleanupUpdates,
      });
    }
    const fallbackAnswer = buildAgentAnswer({
      scope,
      timeRange: request.timeRange,
      aggregate,
      categories,
      duplicateCount: duplicates.length,
      cleanupCount: cleanupUpdates.length,
    });
    const answered = await answerWithGemini(
      {
        message: request.message,
        scope,
        timeRange: request.timeRange,
        aggregate,
        categories,
        duplicateCount: duplicates.length,
        cleanupCount: cleanupUpdates.length,
      },
      fallbackAnswer,
    );
    const answer = answered.answer;
    const suggestions = cleanupUpdates.length
      ? [
          {
            title: "整理其他分類",
            body: `找到 ${cleanupUpdates.length} 筆可以整理的分類，可直接批次更新。`,
            actionInput: {
              type: "batch_update_expenses",
              updates: cleanupUpdates,
            },
          },
        ]
      : [];
    const ownerUserId = scope === "shared" ? null : context.user.id;
    const reportGroupId = scope === "private" ? null : groupId;
    const savedReport = await context.db
      .from("accountant_reports")
      .insert({
        couple_id: context.user.couple_id,
        group_id: reportGroupId,
        owner_user_id: ownerUserId,
        report_type: "manual_question",
        scope,
        month: `${taipeiToday().slice(0, 7)}-01`,
        question: request.message,
        title: `AI 會計師 · ${agentRangeLabel(request.timeRange)}`,
        summary: answer,
        facts: {
          ...aggregate,
          scope,
          timeRange: request.timeRange,
          topCategoryLabel: categories[0]?.label ?? null,
          otherLabelTotalTwd:
            categories.find((item) => item.label === "其他" || item.label === "other")
              ?.totalTwd ?? 0,
        },
        findings: buildAgentFindings(categories, duplicates.length),
        suggestions,
        source: answered.source,
        dedupe_key: `agent:${randomUUID()}`,
      })
      .select(accountantReportSelect())
      .single();
    if (savedReport.error) throw new Error("agent report save failed");
    const report = accountantReportRowSchema.parse(savedReport.data);
    const run = await context.db
      .from("agent_runs")
      .insert({
        couple_id: context.user.couple_id,
        user_id: context.user.id,
        group_id: reportGroupId,
        report_id: report.id,
        scope,
        time_range: request.timeRange,
        message: request.message,
        answer,
        tool_calls: toolCalls,
        suggestions,
      })
      .select("id")
      .single();
    if (run.error) throw new Error("agent run save failed");
    return {
      answer,
      reportId: report.id,
      toolCalls,
      suggestions,
      report,
    };
  }

  async categoryAnalytics(context: ServerContext, params: URLSearchParams) {
    const parsed = categoryAnalyticsInputSchema.parse({
      range: params.get("range") ?? undefined,
      scope: params.get("scope") ?? undefined,
    });
    const groupId = await activeGroupId(context);
    const allExpenses = await loadAgentExpenses(context, groupId);
    const timeRange: AgentTimeRange =
      parsed.range === "six_months" ? "last_3_months" : parsed.range;
    const expenses = filterAgentExpenses({
      activeGroupId: groupId,
      expenses: allExpenses,
      now: taipeiToday(),
      scope: parsed.scope,
      timeRange: parsed.range === "six_months" ? "all" : timeRange,
      userId: context.user.id,
    }).filter((expense) =>
      parsed.range === "six_months"
        ? expense.expense_date >= `${shiftMonth(taipeiToday().slice(0, 7), -5)}-01`
        : true,
    );
    const categories = rankCategoryLabels(expenses);
    const totalTwd = categories.reduce((total, item) => total + item.totalTwd, 0);
    return {
      range: parsed.range,
      scope: parsed.scope,
      totalTwd,
      count: expenses.length,
      categories: categories.map((item) => ({
        ...item,
        percent: totalTwd ? Math.round((item.totalTwd / totalTwd) * 100) : 0,
      })),
    };
  }

  async suggestCategoryUpdates(context: ServerContext, input: unknown) {
    const parsed = categoryAnalyticsInputSchema.parse(input);
    const groupId = await activeGroupId(context);
    const allExpenses = await loadAgentExpenses(context, groupId);
    const expenses = filterAgentExpenses({
      activeGroupId: groupId,
      expenses: allExpenses,
      now: taipeiToday(),
      scope: parsed.scope === "combined" ? "shared" : parsed.scope,
      timeRange:
        parsed.range === "all"
          ? "all"
          : parsed.range === "six_months"
            ? "all"
            : "this_month",
      userId: context.user.id,
    }).filter((expense) =>
      parsed.range === "six_months"
        ? expense.expense_date >= `${shiftMonth(taipeiToday().slice(0, 7), -5)}-01`
        : true,
    );
    const rawUpdates = [];
    for (const expense of expenses.slice(0, 50)) {
      if (expense.tag !== "其他" && expense.tag !== "other") continue;
      rawUpdates.push({
        expenseId: expense.id,
        expectedVersion: expense.version,
        tag: "其他",
      });
    }
    const updates = safeBatchCategoryUpdates(rawUpdates, allExpenses, {
      activeGroupId: groupId,
      userId: context.user.id,
    });
    return { updates };
  }

  async createCategoryCleanup(
    context: ServerContext,
    input: unknown,
    idempotencyKey: string | undefined,
    executePendingAction: (input: CleanupActionInput) => Promise<unknown>,
  ) {
    const parsed = categoryCleanupInputSchema.parse(input);
    const groupId = await activeGroupId(context);
    const expenses = await loadAgentExpenses(context, groupId);
    const updates = safeBatchCategoryUpdates(parsed.updates, expenses, {
      activeGroupId: groupId,
      userId: context.user.id,
    });
    if (!updates.length) throw new HttpError(400, "沒有可套用的分類整理");
    const payloadUpdates = updates.map((update) => ({
      expense_id: update.expenseId,
      expected_version: update.expectedVersion,
      tag: update.tag,
    }));
    return executePendingAction({
      actionType: "batch_update_expenses",
      groupId,
      payload: { updates: payloadUpdates },
      sourceEventId: `liff:category:${randomUUID()}`,
      idempotencyKey,
    });
  }

  async listReports(context: ServerContext) {
    const groupId = await activeGroupId(context);
    const [shared, own] = await Promise.all([
      context.db
        .from("accountant_reports")
        .select(accountantReportSelect())
        .eq("couple_id", context.user.couple_id)
        .eq("group_id", groupId)
        .is("owner_user_id", null)
        .order("created_at", { ascending: false })
        .limit(20),
      context.db
        .from("accountant_reports")
        .select(accountantReportSelect())
        .eq("couple_id", context.user.couple_id)
        .eq("owner_user_id", context.user.id)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    if (shared.error || own.error) {
      throw new Error("accountant reports lookup failed");
    }
    return z
      .array(accountantReportRowSchema)
      .parse([...(shared.data ?? []), ...(own.data ?? [])])
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, 30);
  }

  async generateReport(
    context: ServerContext,
    input: {
      question: string;
      scope: "shared" | "private" | "combined";
      month: string;
      reportType: "manual_question" | "monthly_health" | "cleanup_review";
      groupId?: string;
    },
  ) {
    const snapshot = await loadAccountantSnapshot(
      context,
      input.scope,
      input.month,
      input.groupId,
    );
    let report: AccountantReport = fallbackAccountantReport(
      snapshot,
      input.question,
      input.reportType,
    );
    try {
      const response = await generateObject({
        model: getModel(MODEL),
        system:
          "你是台灣情侶帳本的會計師。只能根據提供的 snapshot 分析。facts 必須逐字等於 snapshot.facts；不能自行改金額、改權限或假設不存在的帳務。可給建議，建議中的改帳動作會直接執行。你只能根據提供的 snapshot 資料中出現的 merchant 或 description 進行字面推論，絕對禁止憑空捏造 snapshot 中沒有明確指出的具體事件、活動或情境（例如捏造出去某個商圈逛街、參加某種生日聚會、出遊等）。如果資料中沒有明確的商家或備註，僅能說明『主要來自大額支出』，不得虛構原因！",
        messages: [
          {
            role: "user",
            content: JSON.stringify(accountantPrompt(input.question, snapshot)),
          },
        ],
        temperature: 0.2,
        schema: accountantLlmReportSchema,
      });
      report = accountantReportFromLlm(response.object, snapshot);
    } catch {
      report = fallbackAccountantReport(snapshot, input.question, input.reportType);
    }

    const ownerUserId = input.scope === "shared" ? null : context.user.id;
    const groupId = input.scope === "private" ? null : snapshot.activeGroupId;
    const dedupeKey =
      input.reportType === "monthly_health"
        ? `accountant:${context.user.couple_id}:${groupId ?? ownerUserId}:${input.scope}:${input.month}`
        : `accountant:manual:${randomUUID()}`;
    const saved = await context.db
      .from("accountant_reports")
      .upsert(
        {
          couple_id: context.user.couple_id,
          group_id: groupId,
          owner_user_id: ownerUserId,
          report_type: report.reportType,
          scope: report.scope,
          month: `${input.month}-01`,
          question: input.question,
          title: report.title,
          summary: report.summary,
          facts: report.facts,
          findings: report.findings,
          suggestions: report.suggestions,
          source: report.source,
          dedupe_key: dedupeKey,
        },
        { onConflict: "dedupe_key" },
      )
      .select(accountantReportSelect())
      .single();
    if (saved.error) throw new Error("accountant report save failed");
    return accountantReportRowSchema.parse(saved.data);
  }

  async generateMonthlyReports(
    env: ServerContext["env"],
    db: ServerContext["db"],
    month: string,
  ) {
    const [usersResult, groupsResult] = await Promise.all([
      db.from("users").select("id, couple_id, line_user_id, role").order("role"),
      db.from("groups").select("id, couple_id").is("archived_at", null),
    ]);
    if (usersResult.error || groupsResult.error) return 0;
    const users = z.array(userRowSchema).parse(usersResult.data ?? []);
    const groups = z.array(groupRowSchema).parse(groupsResult.data ?? []);
    let count = 0;

    for (const group of groups) {
      const user = users.find((item) => item.couple_id === group.couple_id);
      if (!user) continue;
      try {
        const report = await this.generateReport({ env, db, user }, {
          question: `${month} 共同帳月報`,
          scope: "shared",
          month,
          reportType: "monthly_health",
          groupId: group.id,
        });
        count += 1;
        for (const recipient of users.filter((item) => item.couple_id === user.couple_id)) {
          await db.from("notifications").upsert(
            {
              recipient_user_id: recipient.id,
              group_id: group.id,
              kind: "accountant",
              title: "AI 會計師月報",
              body: `${report.title}\n${env.APP_URL}/?tab=accountant`,
              entity_type: "accountant_report",
              entity_id: report.id,
              dedupe_key: `accountant-report:${report.id}:user:${recipient.id}`,
            },
            { onConflict: "dedupe_key", ignoreDuplicates: true },
          );
        }
      } catch {
        /* keep cron best-effort */
      }
    }

    for (const user of users) {
      try {
        const report = await this.generateReport({ env, db, user }, {
          question: `${month} 私人帳月報`,
          scope: "private",
          month,
          reportType: "monthly_health",
        });
        count += 1;
        await db.from("notifications").upsert(
          {
            recipient_user_id: user.id,
            group_id: null,
            kind: "accountant",
            title: "AI 私人帳月報",
            body: `${report.title}\n${env.APP_URL}/?tab=accountant`,
            entity_type: "accountant_report",
            entity_id: report.id,
            dedupe_key: `accountant-report:${report.id}:user:${user.id}`,
          },
          { onConflict: "dedupe_key", ignoreDuplicates: true },
        );
      } catch {
        /* keep cron best-effort */
      }
    }

    return count;
  }
}

async function loadAccountantSnapshot(
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
    context.db.rpc("group_balances", { p_group_id: groupId }),
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
    balances: z
      .array(z.object({ user_id: z.string().uuid(), balance_twd: z.coerce.number().int() }))
      .parse(balances.data),
    expenses,
    month,
    scope,
    userId: context.user.id,
    previousMonthTotalTwd,
  });
}

async function loadAgentExpenses(
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

async function activeGroupId(context: ServerContext) {
  const preference = await context.db
    .from("user_preferences")
    .select("active_group_id")
    .eq("user_id", context.user.id)
    .single();
  if (preference.error) throw new Error("active group lookup failed");
  return z.object({ active_group_id: z.string().uuid() }).parse(preference.data)
    .active_group_id;
}

function accountantPrompt(
  question: string,
  snapshot: Awaited<ReturnType<typeof loadAccountantSnapshot>>,
) {
  return {
    question,
    facts: snapshot.facts,
    categoryTotals: snapshot.categoryTotals,
    duplicateCandidates: snapshot.duplicateCandidates.map((items) =>
      items.map((expense) => ({
        id: expense.id,
        description: expense.description,
        amountTwd: expense.amount_twd,
        date: expense.expense_date,
        version: expense.version,
      })),
    ),
    expenses: snapshot.expenses.slice(0, 60).map((expense) => ({
      id: expense.id,
      ledger: expense.ledger,
      description: expense.description,
      merchant: expense.merchant,
      tag: expense.tag,
      amountTwd: expense.amount_twd,
      date: expense.expense_date,
      splitMethod: expense.split_method,
      version: expense.version,
    })),
  };
}

function toAccountantExpense(expense: z.infer<typeof expenseSchema>): AccountantExpense {
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

function toAgentExpense(expense: z.infer<typeof expenseSchema>): AgentExpense {
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

async function answerWithGemini(
  input: {
    message: string;
    scope: AgentScope;
    timeRange: AgentTimeRange;
    aggregate: ReturnType<typeof aggregateAgentExpenses>;
    categories: ReturnType<typeof rankCategoryLabels>;
    duplicateCount: number;
    cleanupCount: number;
  },
  fallbackAnswer: string,
): Promise<{ answer: string; source: "llm" | "fallback" }> {
  const expectedFacts = {
    totalTwd: input.aggregate.totalTwd,
    transactionCount: input.aggregate.transactionCount,
    topCategoryLabel: input.categories[0]?.label ?? null,
    topCategoryTotalTwd: input.categories[0]?.totalTwd ?? null,
  };
  try {
    const response = await generateObject({
      model: getModel(MODEL),
      system:
        "你是帳務專用 AI 會計師的回覆層。只能根據提供的工具結果回答；不能新增金額、不能假設不存在的帳務、不能要求使用者打開 LIFF 才知道答案。facts 必須逐字等於輸入 facts。若有操作建議，只能描述可直接執行的動作，不要提確認流程。",
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            question: input.message,
            scope: input.scope,
            timeRange: input.timeRange,
            facts: expectedFacts,
            aggregate: input.aggregate,
            categoryRanking: input.categories.slice(0, 10),
            duplicateCount: input.duplicateCount,
            cleanupCount: input.cleanupCount,
          }),
        },
      ],
      temperature: 0.2,
      schema: agentLlmAnswerSchema,
    });
    const parsed = response.object;
    if (
      parsed.facts.totalTwd !== expectedFacts.totalTwd ||
      parsed.facts.transactionCount !== expectedFacts.transactionCount ||
      parsed.facts.topCategoryLabel !== expectedFacts.topCategoryLabel ||
      parsed.facts.topCategoryTotalTwd !== expectedFacts.topCategoryTotalTwd
    ) {
      return { answer: fallbackAnswer, source: "fallback" };
    }
    return { answer: parsed.answer, source: "llm" };
  } catch {
    return { answer: fallbackAnswer, source: "fallback" };
  }
}

function buildAgentAnswer(input: {
  scope: AgentScope;
  timeRange: AgentTimeRange;
  aggregate: ReturnType<typeof aggregateAgentExpenses>;
  categories: ReturnType<typeof rankCategoryLabels>;
  duplicateCount: number;
  cleanupCount: number;
}) {
  const range = agentRangeLabel(input.timeRange);
  const scope =
    input.scope === "shared"
      ? "共同帳"
      : input.scope === "private"
        ? "私人帳"
        : "合併帳";
  const top = input.categories[0];
  const ranking = input.categories
    .slice(0, 5)
    .map((item, index) => `${index + 1}. ${item.label} NT$${item.totalTwd}（${item.count}筆）`)
    .join("\n");
  const parts = [
    `${range}${scope}共 ${input.aggregate.transactionCount} 筆，總額 NT$${input.aggregate.totalTwd}。`,
  ];
  if (top) parts.push(`花最多的是「${top.label}」NT$${top.totalTwd}。`);
  if (ranking) parts.push(`分類排行：\n${ranking}`);
  if (input.duplicateCount) {
    parts.push(`另外找到 ${input.duplicateCount} 組疑似重複支出，可到 LIFF 檢查。`);
  }
  if (input.cleanupCount) {
    parts.push(`有 ${input.cleanupCount} 筆「其他」可以整理成更細分類，LIFF 可直接批次套用。`);
  }
  return parts.join("\n");
}

function buildAgentFindings(
  categories: ReturnType<typeof rankCategoryLabels>,
  duplicateCount: number,
) {
  const findings = [];
  const top = categories[0];
  if (top) {
    findings.push({
      severity: "info",
      title: "最大支出分類",
      body: `${top.label} 是目前最高分類，共 ${top.count} 筆。`,
      amountTwd: top.totalTwd,
    });
  }
  const other = categories.find(
    (item) => item.label === "其他" || item.label === "other",
  );
  if (other) {
    findings.push({
      severity: "warning",
      title: "其他分類仍需整理",
      body: "建議使用分類整理，把其他拆成高鐵、外食、咖啡、日用品等實際分類。",
      amountTwd: other.totalTwd,
    });
  }
  if (duplicateCount) {
    findings.push({
      severity: "warning",
      title: "疑似重複支出",
      body: `找到 ${duplicateCount} 組同日同額同描述的支出。`,
      amountTwd: null,
    });
  }
  return findings.slice(0, 8);
}

function accountantReportSelect() {
  return "id, group_id, owner_user_id, report_type, scope, month, question, title, summary, facts, findings, suggestions, source, created_at";
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

function breakdownByKey(expenses: LedgerVisibleExpense[]) {
  const map = new Map<string, number>();
  for (const e of expenses) {
    const label = e.tag;
    map.set(label, (map.get(label) ?? 0) + e.amount_twd);
  }
  return map;
}
