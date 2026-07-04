import { randomUUID } from "node:crypto";
import { HttpError } from "./http-error";
import type { ServerContext } from "./server-runtime";
import {
  categoryAnalyticsInputSchema,
  categoryCleanupInputSchema,
  type CleanupActionInput,
} from "./accountant-agent-contracts";
import {
  activeGroupId,
  loadAgentExpenses,
  taipeiToday,
  shiftMonth,
} from "./accountant-loaders";
import {
  filterAgentExpenses,
  rankCategoryLabels,
  safeBatchCategoryUpdates,
  type AgentTimeRange,
} from "./ledger-agent";

async function loadAndFilterExpenses(
  context: ServerContext,
  options: {
    scope: "shared" | "private" | "combined";
    range: "this_month" | "six_months" | "all";
    normalizeScopeCombined?: boolean;
  },
) {
  const groupId = await activeGroupId(context);
  const allExpenses = await loadAgentExpenses(context, groupId);

  const normalizedScope =
    options.normalizeScopeCombined && options.scope === "combined"
      ? "shared"
      : options.scope;

  let timeRange: AgentTimeRange;
  if (options.range === "six_months") {
    timeRange = "all";
  } else {
    timeRange = options.range;
  }

  let expenses = filterAgentExpenses({
    activeGroupId: groupId,
    expenses: allExpenses,
    now: taipeiToday(),
    scope: normalizedScope,
    timeRange,
    userId: context.user.id,
  });

  if (options.range === "six_months") {
    const sixMonthsAgo = `${shiftMonth(taipeiToday().slice(0, 7), -5)}-01`;
    expenses = expenses.filter((expense) => expense.expense_date >= sixMonthsAgo);
  }

  return { groupId, allExpenses, expenses };
}

export async function categoryAnalytics(context: ServerContext, params: URLSearchParams) {
  const parsed = categoryAnalyticsInputSchema.parse({
    range: params.get("range") ?? undefined,
    scope: params.get("scope") ?? undefined,
  });

  const { expenses } = await loadAndFilterExpenses(context, {
    scope: parsed.scope,
    range: parsed.range,
  });

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

  const { groupId, allExpenses, expenses } = await loadAndFilterExpenses(context, {
    scope: parsed.scope,
    range: parsed.range,
    normalizeScopeCombined: true,
  });

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
