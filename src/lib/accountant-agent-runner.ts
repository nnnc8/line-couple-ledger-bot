import { randomUUID } from "node:crypto";
import type { ServerContext } from "./server-runtime";
import {
  accountantAskInputSchema,
  agentRunInputSchema,
} from "./accountant-agent-contracts";
import {
  agentRangeLabel,
  aggregateAgentExpenses,
  detectDuplicateAgentExpenses,
  filterAgentExpenses,
  parseAgentRequest,
  rankCategoryLabels,
  safeBatchCategoryUpdates,
  suggestCategoryCleanup,
} from "./ledger-agent";
import {
  activeGroupId,
  accountantReportRowSchema,
  accountantReportSelect,
  loadAgentExpenses,
  taipeiToday,
} from "./accountant-loaders";
import {
  answerWithGemini,
  buildAgentAnswer,
  buildAgentFindings,
} from "./accountant-agent-answer";

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
