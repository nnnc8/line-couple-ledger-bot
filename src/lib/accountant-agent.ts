/**
 * accountant-agent — AI agent flow + category cleanup.
 *
 * The "agent" half of the accountant service: a user's free-form
 * question gets parsed into a scope + time range, the relevant
 * expenses are loaded, several analytics tools run, an LLM (or a
 * deterministic fallback) writes the final answer, and the
 * conversation is persisted into `accountant_reports` + `agent_runs`.
 *
 * `categoryAnalytics` / `suggestCategoryUpdates` /
 * `createCategoryCleanup` are the read/write/clean trio the LIFF uses
 * to manage the "其他" / "other" tag pile-up.
 */
import { randomUUID } from "node:crypto";

import { generateObject } from "ai";
import { z } from "zod";

import { HttpError } from "./http-error";
import {
  type AccountantScope,
  type AccountantReportType,
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
  type AgentScope,
  type AgentTimeRange,
} from "./ledger-agent";
import { getModel } from "./model-provider";
import {
  activeGroupId,
  accountantReportRowSchema,
  accountantReportSelect,
  loadAgentExpenses,
  shiftMonth,
  taipeiToday,
} from "./accountant-loaders";
import type { ServerContext } from "./server-runtime";

const MODEL = "gemini-3.1-flash-lite";

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

export const accountantAskInputSchema = z.object({
  question: z.string().trim().min(1).max(500),
  scope: z.enum(["shared", "private", "combined"]).default("combined"),
});

export const agentRunInputSchema = z.object({
  message: z.string().trim().min(1).max(500),
  scope: z.enum(["shared", "private", "combined"]).optional(),
});

export const categoryAnalyticsInputSchema = z.object({
  range: z.enum(["this_month", "six_months", "all"]).catch("this_month"),
  scope: z.enum(["shared", "private", "combined"]).catch("shared"),
});

export const categoryCleanupInputSchema = z.object({
  updates: z.array(batchCategoryUpdateSchema).min(1).max(50),
});

/**
 * Shape of the action the agent wants the user to commit through the
 * pending-action service. Kept as a structural alias of
 * `PendingActionInsertInput` so the route can pass it straight to
 * `pendingActionService.execute(context, action)`.
 */
export type CleanupActionInput = {
  actionType: string;
  groupId: string | null;
  payload: Record<string, unknown>;
  sourceEventId: string;
  idempotencyKey?: string;
};

// ---------------------------------------------------------------------------
// ask / runAgent
// ---------------------------------------------------------------------------
export async function ask(context: ServerContext, input: unknown) {
  const parsed = accountantAskInputSchema.parse(input);
  const run = await runAgent(context, {
    message: parsed.question,
    scope: parsed.scope,
  });
  return run.report;
}

export async function runAgent(context: ServerContext, input: unknown) {
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

// ---------------------------------------------------------------------------
// category analytics / suggestions / cleanup
// ---------------------------------------------------------------------------
export async function categoryAnalytics(context: ServerContext, params: URLSearchParams) {
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

export async function suggestCategoryUpdates(context: ServerContext, input: unknown) {
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

export async function createCategoryCleanup(
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

// ---------------------------------------------------------------------------
// private helpers (LLM + answer formatting)
// ---------------------------------------------------------------------------
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

// re-exports for tests / external callers that previously reached into
// the old accountant-service.ts
export type { AccountantScope, AccountantReportType };
