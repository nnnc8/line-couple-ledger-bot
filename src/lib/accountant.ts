import { z } from "zod";

export const accountantScopes = ["shared", "private", "combined"] as const;
export const reportTypes = [
  "manual_question",
  "monthly_health",
  "cleanup_review",
] as const;

export type AccountantScope = (typeof accountantScopes)[number];
export type AccountantReportType = (typeof reportTypes)[number];

export interface AccountantExpense {
  id: string;
  group_id: string | null;
  ledger: "shared" | "private";
  description: string;
  merchant: string | null;
  notes: string | null;
  tag: string;
  amount_twd: number;
  paid_by_user_id: string;
  created_by_user_id: string;
  expense_date: string;
  split_method: "equal" | "exact" | "percentage";
  version: number;
  deleted_at: string | null;
  expense_splits: Array<{ user_id: string; amount_twd: number }>;
}

export interface AccountantSnapshot {
  activeGroupId: string;
  userId: string;
  facts: AccountantFacts;
  categoryTotals: Record<string, number>;
  duplicateCandidates: AccountantExpense[][];
  expenses: AccountantExpense[];
}

export const accountantFactsSchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    scope: z.enum(accountantScopes),
    sharedTotalTwd: z.number().int().min(0),
    privateTotalTwd: z.number().int().min(0),
    totalTwd: z.number().int().min(0),
    transactionCount: z.number().int().min(0),
    balanceTwd: z.number().int(),
    previousMonthTotalTwd: z.number().int().min(0).default(0),
  })
  .strict();

export type AccountantFacts = z.infer<typeof accountantFactsSchema>;

const findingSchema = z
  .object({
    severity: z.enum(["info", "warning", "danger"]),
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(500),
    amountTwd: z.number().int().min(0).nullable().default(null),
  })
  .strict();

export const rawSuggestionActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("settle"),
      amountTwd: z.number().int().positive().max(100_000_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("delete_expense"),
      expenseId: z.string().uuid(),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("update_expense"),
      expenseId: z.string().uuid(),
      expectedVersion: z.number().int().positive(),
      tag: z.string().trim().min(1).max(40).nullable().default(null),
      description: z.string().trim().min(1).max(100).nullable().default(null),
      amountTwd: z.number().int().positive().max(100_000_000).nullable().default(null),
      expenseDate: z.iso.date().nullable().default(null),
    })
    .strict(),
]);

export type RawSuggestionAction = z.infer<typeof rawSuggestionActionSchema>;

export const accountantLlmReportSchema = z
  .object({
    reportType: z.enum(reportTypes),
    scope: z.enum(accountantScopes),
    title: z.string().trim().min(1).max(80),
    summary: z.string().trim().min(1).max(1_000),
    facts: accountantFactsSchema,
    findings: z.array(findingSchema).max(8),
    suggestions: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(80),
            body: z.string().trim().min(1).max(500),
            action: rawSuggestionActionSchema,
          })
          .strict(),
      )
      .max(6),
  })
  .strict();

export type AccountantLlmReport = z.infer<typeof accountantLlmReportSchema>;

export const geminiAccountantJsonSchema = Object.fromEntries(
  Object.entries(z.toJSONSchema(accountantLlmReportSchema)).filter(
    ([key]) => key !== "$schema",
  ),
);

export interface AccountantReport {
  reportType: AccountantReportType;
  scope: AccountantScope;
  title: string;
  summary: string;
  facts: AccountantFacts;
  findings: z.infer<typeof findingSchema>[];
  suggestions: Array<{
    title: string;
    body: string;
    actionInput: unknown | null;
  }>;
  source: "llm" | "fallback";
}

export function parseAccountantCommand(
  text: string,
): { question: string; scope: AccountantScope } | null {
  const match = text.trim().match(/^(會計師|分析)\s*(.*)$/);
  if (!match) return null;
  const question = (match[2]?.trim() || "幫我做本月帳務健檢").slice(0, 500);
  const scope: AccountantScope = /私人/.test(question)
    ? "private"
    : /共同/.test(question)
      ? "shared"
      : "combined";
  return { question, scope };
}

export function buildAccountantSnapshot(input: {
  activeGroupId: string;
  balances: Array<{ user_id: string; balance_twd: number }>;
  expenses: AccountantExpense[];
  month: string;
  scope: AccountantScope;
  userId: string;
  previousMonthTotalTwd?: number;
}): AccountantSnapshot {
  const expenses = input.expenses.filter(
    (expense) =>
      !expense.deleted_at &&
      expense.expense_date.startsWith(`${input.month}-`) &&
      ((input.scope !== "private" &&
        expense.ledger === "shared" &&
        expense.group_id === input.activeGroupId) ||
        (input.scope !== "shared" &&
          expense.ledger === "private" &&
          expense.created_by_user_id === input.userId)),
  );
  const sharedTotalTwd = sum(
    expenses.filter((expense) => expense.ledger === "shared"),
  );
  const privateTotalTwd = sum(
    expenses.filter((expense) => expense.ledger === "private"),
  );
  const categoryTotals: Record<string, number> = {};
  for (const expense of expenses) {
    const tag = expense.tag || "其他";
    categoryTotals[tag] = (categoryTotals[tag] ?? 0) + expense.amount_twd;
  }
  const totalTwd = sharedTotalTwd + privateTotalTwd;
  return {
    activeGroupId: input.activeGroupId,
    userId: input.userId,
    facts: {
      month: input.month,
      scope: input.scope,
      sharedTotalTwd,
      privateTotalTwd,
      totalTwd,
      transactionCount: expenses.length,
      balanceTwd:
        input.balances.find((balance) => balance.user_id === input.userId)
          ?.balance_twd ?? 0,
      previousMonthTotalTwd: input.previousMonthTotalTwd ?? 0,
    },
    categoryTotals,
    duplicateCandidates: duplicateExpenses(expenses),
    expenses: expenses.slice(0, 80),
  };
}

export function accountantFactsMatch(
  actual: AccountantFacts,
  expected: AccountantFacts,
): boolean {
  return (Object.keys(expected) as Array<keyof AccountantFacts>).every(
    (key) => actual[key] === expected[key],
  );
}

export function safeSuggestionAction(
  rawAction: unknown,
  snapshot: AccountantSnapshot,
): unknown | null {
  const parsed = rawSuggestionActionSchema.safeParse(rawAction);
  if (!parsed.success || parsed.data.type === "none") return null;
  if (parsed.data.type === "settle") {
    const owed = Math.abs(snapshot.facts.balanceTwd);
    if (!owed || parsed.data.amountTwd > owed) return null;
    return {
      type: "settle",
      groupId: snapshot.activeGroupId,
      amountTwd: parsed.data.amountTwd,
    };
  }
  const actionData = parsed.data;

  const expense = snapshot.expenses.find(
    (item) =>
      item.id === actionData.expenseId &&
      item.version === actionData.expectedVersion &&
      !item.deleted_at,
  );
  if (!expense) return null;
  if (actionData.type === "delete_expense") {
    return {
      type: "delete_expense",
      expenseId: expense.id,
      expectedVersion: expense.version,
    };
  }

  const nextAmount = actionData.amountTwd ?? expense.amount_twd;
  if (nextAmount !== expense.amount_twd && expense.split_method !== "equal")
    return null;
  const values = splitValues(expense, nextAmount, snapshot.userId);
  return {
    type: "update_expense",
    expenseId: expense.id,
    expectedVersion: expense.version,
    expense: {
      ledger: expense.ledger,
      groupId: expense.ledger === "shared" ? expense.group_id : null,
      description: actionData.description ?? expense.description,
      merchant: expense.merchant,
      notes: expense.notes,
      tag: actionData.tag ?? expense.tag,
      amountTwd: nextAmount,
      paidBy: expense.paid_by_user_id === snapshot.userId ? "self" : "partner",
      expenseDate: actionData.expenseDate ?? expense.expense_date,
      splitMethod: expense.split_method,
      selfValue: values.selfValue,
      partnerValue: values.partnerValue,
      receiptId: null,
    },
  };
}

export function accountantReportFromLlm(
  llm: AccountantLlmReport,
  snapshot: AccountantSnapshot,
): AccountantReport {
  if (!accountantFactsMatch(llm.facts, snapshot.facts)) {
    return fallbackAccountantReport(snapshot, "帳務健檢", llm.reportType);
  }
  return {
    reportType: llm.reportType,
    scope: llm.scope,
    title: llm.title,
    summary: llm.summary,
    facts: snapshot.facts,
    findings: llm.findings,
    suggestions: llm.suggestions.map((suggestion) => ({
      title: suggestion.title,
      body: suggestion.body,
      actionInput: safeSuggestionAction(suggestion.action, snapshot),
    })),
    source: "llm",
  };
}

export function fallbackAccountantReport(
  snapshot: AccountantSnapshot,
  question: string,
  reportType: AccountantReportType = "manual_question",
): AccountantReport {
  const findings: AccountantReport["findings"] = [];
  if (snapshot.duplicateCandidates.length) {
    findings.push({
      severity: "warning",
      title: "可能有重複支出",
      body: `找到 ${snapshot.duplicateCandidates.length} 組同日同額支出。`,
      amountTwd: snapshot.duplicateCandidates[0]?.[0]?.amount_twd ?? null,
    });
  }
  const settle = safeSuggestionAction(
    { type: "settle", amountTwd: Math.abs(snapshot.facts.balanceTwd) },
    snapshot,
  );
  return {
    reportType,
    scope: snapshot.facts.scope,
    title: reportType === "monthly_health" ? `${snapshot.facts.month} 月報` : "AI 會計師回覆",
    summary: `${question}：${scopeName(snapshot.facts.scope)}本月共 ${snapshot.facts.transactionCount} 筆，總額 NT$${snapshot.facts.totalTwd}。`,
    facts: snapshot.facts,
    findings,
    suggestions: settle
      ? [
        {
          title: "可結清目前餘額",
          body: `目前差額 NT$${Math.abs(snapshot.facts.balanceTwd)}，可直接建立結清。`,
          actionInput: settle,
        },
      ]
      : [],
    source: "fallback",
  };
}

function sum(expenses: AccountantExpense[]): number {
  return expenses.reduce((total, expense) => total + expense.amount_twd, 0);
}

function duplicateExpenses(expenses: AccountantExpense[]) {
  const groups = new Map<string, AccountantExpense[]>();
  for (const expense of expenses) {
    const key = [
      expense.ledger,
      expense.expense_date,
      expense.amount_twd,
      (expense.merchant || expense.description).trim().toLowerCase(),
    ].join("|");
    groups.set(key, [...(groups.get(key) ?? []), expense]);
  }
  return [...groups.values()].filter((items) => items.length > 1);
}

function splitValues(
  expense: AccountantExpense,
  nextAmount: number,
  userId: string,
): { selfValue: number | null; partnerValue: number | null } {
  if (expense.ledger === "private") return { selfValue: null, partnerValue: null };
  if (expense.split_method === "equal")
    return { selfValue: null, partnerValue: null };
  const mine =
    expense.expense_splits.find((split) => split.user_id === userId)
      ?.amount_twd ?? 0;
  const theirs =
    expense.expense_splits.find((split) => split.user_id !== userId)
      ?.amount_twd ?? 0;
  if (expense.split_method === "exact")
    return { selfValue: mine, partnerValue: theirs };
  const percent = (value: number) =>
    Math.round((value / nextAmount) * 10_000) / 100;
  return { selfValue: percent(mine), partnerValue: percent(theirs) };
}

function scopeName(scope: AccountantScope): string {
  return scope === "shared" ? "共同帳" : scope === "private" ? "私人帳" : "合併帳";
}
