import { z } from "zod";

export const parsedIntentBaseSchema = z
  .object({
    intent: z.enum([
      "record_expense",
      "balance",
      "shared_monthly",
      "private_monthly",
      "delete_last",
      "settle",
      "help",
      "unknown",
    ]),
    description: z.string().trim().min(1).max(100).nullable(),
    amountTwd: z.number().int().positive().max(100_000_000).nullable(),
    ledger: z.enum(["shared", "private"]).nullable(),
    paidBy: z.enum(["self", "partner"]).nullable(),
    expenseDate: z.iso.date().nullable(),
    tag: z.string().trim().min(1).max(40).nullable(),
  })
  .strict();

export const parsedExpenseItemSchema = z
  .object({
    description: z.string().trim().min(1).max(100),
    amountTwd: z.number().int().positive().max(100_000_000),
    ledger: z.enum(["shared", "private"]),
    paidBy: z.enum(["self", "partner"]),
    expenseDate: z.iso.date(),
    tag: z.string().trim().min(1).max(40),
  })
  .strict();

export const textParseSchema = z.discriminatedUnion("intent", [
  z
    .object({
      intent: z.literal("record_expenses"),
      groupName: z.string().trim().min(1).max(40).nullable().default(null),
      expenses: z.array(parsedExpenseItemSchema).min(1).max(5),
    })
    .strict(),
  parsedIntentBaseSchema.extend({
    groupName: z.string().trim().min(1).max(40).nullable().default(null),
  }),
]);

export const parsedIntentSchema = parsedIntentBaseSchema.superRefine(
  (value, context) => {
    if (value.intent !== "record_expense") return;
    for (const field of [
      "description",
      "amountTwd",
      "ledger",
      "paidBy",
      "expenseDate",
      "tag",
    ] as const) {
      if (value[field] === null) {
        context.addIssue({
          code: "custom",
          message: `${field} is required for an expense`,
          path: [field],
        });
      }
    }
  },
);

export const geminiIntentJsonSchema = Object.fromEntries(
  Object.entries(z.toJSONSchema(parsedIntentBaseSchema)).filter(
    ([key]) => key !== "$schema",
  ),
);
export const geminiTextParseJsonSchema = Object.fromEntries(
  Object.entries(z.toJSONSchema(textParseSchema)).filter(
    ([key]) => key !== "$schema",
  ),
);
export const geminiTextParseSchema = geminiTextParseJsonSchema;

export type ParsedIntent = z.infer<typeof parsedIntentSchema>;
export type ParsedExpenseItem = z.infer<typeof parsedExpenseItemSchema>;
export type TextParseResult = z.infer<typeof textParseSchema>;
export type LedgerType = "shared" | "private";
export type SplitMethod = "equal" | "exact" | "percentage";
export type RecurringFrequency = "weekly" | "monthly" | "yearly";

export interface CategoryLearningEntry {
  tag: string;
  description: string;
  merchant?: string | null;
}

const receiptLineItemSchema = z
  .object({
    merchant: z.string().trim().min(1).max(100).nullable(),
    expenseDate: z.iso.date().nullable(),
    amountTwd: z.number().int().positive().max(100_000_000).nullable(),
    description: z.string().trim().min(1).max(100).nullable().default(null),
  })
  .strict();

export const receiptExtractionSchema = z
  .object({
    merchant: z.string().trim().min(1).max(100).nullable(),
    expenseDate: z.iso.date().nullable(),
    amountTwd: z.number().int().positive().max(100_000_000).nullable(),
    confidence: z.number().min(0).max(1),
    items: z.array(receiptLineItemSchema).max(20).default([]),
  })
  .strict();

export const geminiReceiptJsonSchema = Object.fromEntries(
  Object.entries(z.toJSONSchema(receiptExtractionSchema)).filter(
    ([key]) => key !== "$schema",
  ),
);

export interface LedgerExpense {
  id: string;
  ledger: LedgerType;
  amountTwd: number;
  paidByUserId: string;
  createdByUserId: string;
  expenseDate: string;
  deleted: boolean;
  splits: Record<string, number>;
}

export interface Settlement {
  fromUserId: string;
  toUserId: string;
  amountTwd: number;
}

export function splitEqual(
  amountTwd: number,
  paidByUserId: string,
  partnerUserId: string,
): Record<string, number> {
  if (!Number.isSafeInteger(amountTwd) || amountTwd <= 0) {
    throw new Error("amountTwd must be a positive integer");
  }
  if (paidByUserId === partnerUserId) {
    throw new Error("participants must be different");
  }
  return {
    [paidByUserId]: Math.ceil(amountTwd / 2),
    [partnerUserId]: Math.floor(amountTwd / 2),
  };
}

export function splitExact(
  amountTwd: number,
  shares: Record<string, number>,
): Record<string, number> {
  assertAmount(amountTwd);
  const entries = Object.entries(shares);
  if (
    entries.length < 1 ||
    entries.some(([, share]) => !Number.isSafeInteger(share) || share < 0) ||
    entries.reduce((sum, [, share]) => sum + share, 0) !== amountTwd
  ) {
    throw new Error("exact shares must be non-negative integers summing to amountTwd");
  }
  return { ...shares };
}

export function splitPercentage(
  amountTwd: number,
  paidByUserId: string,
  percentages: Record<string, number>,
): Record<string, number> {
  assertAmount(amountTwd);
  const entries = Object.entries(percentages).map(([userId, percentage]) => ({
    userId,
    basisPoints: Math.round(percentage * 100),
  }));
  if (
    entries.length < 1 ||
    entries.some(({ basisPoints }) => basisPoints < 0 || basisPoints > 10_000) ||
    entries.reduce((sum, { basisPoints }) => sum + basisPoints, 0) !== 10_000
  ) {
    throw new Error("percentages must have at most two decimals and sum to 100");
  }

  const shares = Object.fromEntries(
    entries.map(({ userId, basisPoints }) => [
      userId,
      Math.floor((amountTwd * basisPoints) / 10_000),
    ]),
  );
  let remainder = amountTwd - Object.values(shares).reduce((sum, share) => sum + share, 0);
  const order = entries.sort((left, right) => {
    const leftRemainder = (amountTwd * left.basisPoints) % 10_000;
    const rightRemainder = (amountTwd * right.basisPoints) % 10_000;
    return (
      rightRemainder - leftRemainder ||
      Number(right.userId === paidByUserId) - Number(left.userId === paidByUserId) ||
      left.userId.localeCompare(right.userId)
    );
  });
  for (let index = 0; remainder > 0; index = (index + 1) % order.length) {
    shares[order[index]!.userId]! += 1;
    remainder -= 1;
  }
  return shares;
}

export function learnCategoryFromHistory(
  current: CategoryLearningEntry,
  history: CategoryLearningEntry[],
): string {
  if (current.tag && current.tag !== "其他") return current.tag;
  const currentMerchant = normalizeCategoryText(current.merchant);
  const currentDescription = normalizeCategoryText(current.description);
  if (!currentMerchant && !currentDescription) return "其他";

  const scores = new Map<
    string,
    { score: number; matches: number; firstIndex: number }
  >();
  history.forEach((entry, index) => {
    if (!entry.tag || entry.tag === "其他") return;
    const score =
      categoryMatchScore(
        currentMerchant,
        normalizeCategoryText(entry.merchant),
        4,
        2,
      ) +
      categoryMatchScore(
        currentDescription,
        normalizeCategoryText(entry.description),
        3,
        1,
      );
    if (score <= 0) return;

    const existing = scores.get(entry.tag) ?? {
      score: 0,
      matches: 0,
      firstIndex: index,
    };
    scores.set(entry.tag, {
      score: existing.score + score,
      matches: existing.matches + 1,
      firstIndex: Math.min(existing.firstIndex, index),
    });
  });

  let best: [string, { score: number; matches: number; firstIndex: number }] | null =
    null;
  for (const entry of scores.entries()) {
    if (
      !best ||
      entry[1].score > best[1].score ||
      (entry[1].score === best[1].score && entry[1].matches > best[1].matches) ||
      (entry[1].score === best[1].score &&
        entry[1].matches === best[1].matches &&
        entry[1].firstIndex < best[1].firstIndex)
    ) {
      best = entry;
    }
  }
  return best?.[0] ?? "其他";
}

export function nextRecurringDate(
  currentDate: string,
  frequency: RecurringFrequency,
  anchorDay?: number,
): string {
  z.iso.date().parse(currentDate);
  const [year, month, day] = currentDate.split("-").map(Number) as [number, number, number];
  const desiredDay = anchorDay ?? day;
  if (frequency === "weekly") {
    const next = new Date(Date.UTC(year, month - 1, day + 7));
    return formatUtcDate(next);
  }
  const targetYear = frequency === "yearly" ? year + 1 : year + Math.floor(month / 12);
  const targetMonth = frequency === "yearly" ? month : (month % 12) + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return formatUtcDate(
    new Date(Date.UTC(targetYear, targetMonth - 1, Math.min(desiredDay, lastDay))),
  );
}

function assertAmount(amountTwd: number): void {
  if (!Number.isSafeInteger(amountTwd) || amountTwd <= 0) {
    throw new Error("amountTwd must be a positive integer");
  }
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function categoryMatchScore(
  current: string,
  historical: string,
  exactScore: number,
  relatedScore: number,
): number {
  if (!current || !historical) return 0;
  if (current === historical) return exactScore;
  if (
    current.length >= 3 &&
    historical.length >= 3 &&
    (current.includes(historical) || historical.includes(current))
  ) {
    return relatedScore;
  }
  return 0;
}

function normalizeCategoryText(value?: string | null): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

export function calculateBalances(
  expenses: LedgerExpense[],
  settlements: Settlement[],
): Record<string, number> {
  const balances: Record<string, number> = {};
  const add = (userId: string, amountTwd: number) => {
    balances[userId] = (balances[userId] ?? 0) + amountTwd;
  };

  for (const expense of expenses) {
    if (expense.deleted || expense.ledger !== "shared") continue;
    add(expense.paidByUserId, expense.amountTwd);
    for (const [userId, amountTwd] of Object.entries(expense.splits)) {
      add(userId, -amountTwd);
    }
  }
  for (const settlement of settlements) {
    add(settlement.fromUserId, settlement.amountTwd);
    add(settlement.toUserId, -settlement.amountTwd);
  }
  return balances;
}

export function monthlySummary(
  expenses: LedgerExpense[],
  ledger: LedgerType,
  requesterUserId: string,
  month: string,
): { count: number; totalTwd: number } {
  const visible = expenses.filter(
    (expense) =>
      !expense.deleted &&
      expense.ledger === ledger &&
      expense.expenseDate.startsWith(`${month}-`) &&
      (ledger === "shared" || expense.createdByUserId === requesterUserId),
  );
  return {
    count: visible.length,
    totalTwd: visible.reduce((total, expense) => total + expense.amountTwd, 0),
  };
}
