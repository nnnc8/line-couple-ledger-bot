import { z } from "zod";

import { type Category } from "./ledger";

export const agentScopes = ["shared", "private", "combined"] as const;
export const agentTimeRanges = [
  "this_month",
  "last_month",
  "last_3_months",
  "this_year",
  "all",
] as const;

export type AgentScope = (typeof agentScopes)[number];
export type AgentTimeRange = (typeof agentTimeRanges)[number];

export interface AgentExpense {
  id: string;
  group_id: string | null;
  ledger: "shared" | "private";
  description: string;
  merchant: string | null;
  category: Category;
  category_label: string;
  mirror_kind?: "shared_share" | null;
  mirror_source_expense_id?: string | null;
  amount_twd: number;
  paid_by_user_id: string;
  created_by_user_id: string;
  expense_date: string;
  version: number;
  deleted_at: string | null;
}

export interface AgentRequest {
  message: string;
  scope: AgentScope;
  timeRange: AgentTimeRange;
}

export interface CategoryRank {
  label: string;
  totalTwd: number;
  count: number;
}

export interface BatchCategoryUpdate {
  expenseId: string;
  expectedVersion: number;
  categoryLabel: string;
}

export const batchCategoryUpdateSchema = z
  .object({
    expenseId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    categoryLabel: z.string().trim().min(1).max(40),
  })
  .strict();

export function parseAgentRequest(text: string): AgentRequest | null {
  const command = text.trim();
  const match = command.match(/^(會計師|分析)\s*(.*)$/);
  const message = (match ? match[2] : command).trim();
  const safeMessage = (message || "幫我整理帳務").slice(0, 500);
  return {
    message: safeMessage,
    scope: /私人/.test(safeMessage)
      ? "private"
      : /共同/.test(safeMessage)
        ? "shared"
        : "combined",
    timeRange: parseTimeRange(safeMessage),
  };
}

export function filterAgentExpenses(input: {
  activeGroupId: string;
  expenses: AgentExpense[];
  now: string;
  scope: AgentScope;
  timeRange: AgentTimeRange;
  userId: string;
}): AgentExpense[] {
  const bounds = dateBounds(input.timeRange, input.now);
  return input.expenses.filter((expense) => {
    if (expense.deleted_at) return false;
    if (bounds && (expense.expense_date < bounds.start || expense.expense_date >= bounds.end))
      return false;
    if (
      input.scope !== "private" &&
      expense.ledger === "shared" &&
      expense.group_id === input.activeGroupId
    )
      return true;
    return (
      input.scope !== "shared" &&
      expense.ledger === "private" &&
      expense.created_by_user_id === input.userId
    );
  });
}

export function rankCategoryLabels(expenses: AgentExpense[]): CategoryRank[] {
  const totals = new Map<string, CategoryRank>();
  for (const expense of expenses) {
    const label = normalizeLabel(expense.category_label || expense.category);
    const current = totals.get(label) ?? { label, totalTwd: 0, count: 0 };
    current.totalTwd += expense.amount_twd;
    current.count += 1;
    totals.set(label, current);
  }
  return [...totals.values()].sort(
    (left, right) =>
      right.totalTwd - left.totalTwd ||
      right.count - left.count ||
      left.label.localeCompare(right.label, "zh-Hant"),
  );
}

export function safeBatchCategoryUpdates(
  rawUpdates: unknown[],
  expenses: AgentExpense[],
  options: { activeGroupId: string; userId: string },
): BatchCategoryUpdate[] {
  const byId = new Map(expenses.map((expense) => [expense.id, expense]));
  const seen = new Set<string>();
  const updates: BatchCategoryUpdate[] = [];
  for (const raw of rawUpdates) {
    const parsed = batchCategoryUpdateSchema.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data.expenseId)) continue;
    const expense = byId.get(parsed.data.expenseId);
    if (
      !expense ||
      expense.deleted_at ||
      expense.mirror_kind ||
      expense.version !== parsed.data.expectedVersion ||
      !canAccessExpense(expense, options)
    ) {
      continue;
    }
    seen.add(expense.id);
    updates.push({
      expenseId: expense.id,
      expectedVersion: expense.version,
      categoryLabel: normalizeLabel(parsed.data.categoryLabel),
    });
  }
  return updates;
}

export function aggregateAgentExpenses(expenses: AgentExpense[]) {
  return {
    totalTwd: expenses.reduce((total, expense) => total + expense.amount_twd, 0),
    transactionCount: expenses.length,
    sharedTotalTwd: expenses
      .filter((expense) => expense.ledger === "shared")
      .reduce((total, expense) => total + expense.amount_twd, 0),
    privateTotalTwd: expenses
      .filter((expense) => expense.ledger === "private")
      .reduce((total, expense) => total + expense.amount_twd, 0),
  };
}

export function detectDuplicateAgentExpenses(expenses: AgentExpense[]) {
  const groups = new Map<string, AgentExpense[]>();
  for (const expense of expenses) {
    const key = [
      expense.ledger,
      expense.expense_date,
      expense.amount_twd,
      normalizeComparable(expense.merchant || expense.description),
    ].join("|");
    groups.set(key, [...(groups.get(key) ?? []), expense]);
  }
  return [...groups.values()].filter((items) => items.length > 1);
}

export function suggestCategoryCleanup(expenses: AgentExpense[]) {
  const learned = buildLabelHistory(expenses);
  const updates: BatchCategoryUpdate[] = [];
  for (const expense of expenses) {
    const current = normalizeLabel(expense.category_label || expense.category);
    if (current !== "其他" && current !== "other") continue;
    const suggested = suggestLabel(expense, learned);
    if (!suggested || suggested === current) continue;
    updates.push({
      expenseId: expense.id,
      expectedVersion: expense.version,
      categoryLabel: suggested,
    });
  }
  return updates;
}

export function agentRangeLabel(range: AgentTimeRange): string {
  return {
    this_month: "本月",
    last_month: "上月",
    last_3_months: "近三個月",
    this_year: "今年",
    all: "全歷史",
  }[range];
}

function parseTimeRange(message: string): AgentTimeRange {
  if (/本月|這月|這個月|當月/.test(message)) return "this_month";
  if (/上月|上個月/.test(message)) return "last_month";
  if (/近三個月|最近三個月|三個月/.test(message)) return "last_3_months";
  if (/今年|本年|這一年/.test(message)) return "this_year";
  if (/歷史以來|全部|所有|最高|最多|總共|以來|一直以來|整體/.test(message))
    return "all";
  return "all";
}

function dateBounds(
  range: AgentTimeRange,
  now: string,
): { start: string; end: string } | null {
  if (range === "all") return null;
  const month = now.slice(0, 7);
  if (range === "this_month")
    return { start: `${month}-01`, end: `${shiftMonth(month, 1)}-01` };
  if (range === "last_month") {
    const last = shiftMonth(month, -1);
    return { start: `${last}-01`, end: `${month}-01` };
  }
  if (range === "last_3_months")
    return { start: `${shiftMonth(month, -2)}-01`, end: `${shiftMonth(month, 1)}-01` };
  return { start: `${now.slice(0, 4)}-01-01`, end: `${Number(now.slice(0, 4)) + 1}-01-01` };
}

function shiftMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year!, monthNumber! - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function canAccessExpense(
  expense: AgentExpense,
  options: { activeGroupId: string; userId: string },
) {
  return (
    (expense.ledger === "shared" && expense.group_id === options.activeGroupId) ||
    (expense.ledger === "private" && expense.created_by_user_id === options.userId)
  );
}

function buildLabelHistory(expenses: AgentExpense[]) {
  return expenses
    .map((expense) => ({
      label: normalizeLabel(expense.category_label || expense.category),
      tokens: [
        normalizeComparable(expense.merchant),
        normalizeComparable(expense.description),
      ].filter(Boolean),
    }))
    .filter((entry) => entry.label !== "其他" && entry.label !== "other");
}

function suggestLabel(
  expense: AgentExpense,
  history: Array<{ label: string; tokens: string[] }>,
) {
  const tokens = [
    normalizeComparable(expense.merchant),
    normalizeComparable(expense.description),
  ].filter(Boolean);
  if (!tokens.length) return fallbackLabel(expense);
  const scores = new Map<string, number>();
  for (const entry of history) {
    let score = 0;
    for (const token of tokens) {
      if (entry.tokens.includes(token)) score += 4;
      else if (
        token.length >= 2 &&
        entry.tokens.some((historical) => historical.includes(token) || token.includes(historical))
      ) {
        score += 2;
      }
    }
    if (score > 0) scores.set(entry.label, (scores.get(entry.label) ?? 0) + score);
  }
  let best: [string, number] | null = null;
  for (const entry of scores.entries()) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best?.[0] ?? fallbackLabel(expense);
}

function fallbackLabel(expense: AgentExpense) {
  if (expense.category !== "other") return expense.category;
  const source = expense.merchant || expense.description;
  return normalizeLabel(source.replace(/\d+/g, "").slice(0, 40)) || "其他";
}

function normalizeLabel(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 40);
}

function normalizeComparable(value?: string | null) {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}
