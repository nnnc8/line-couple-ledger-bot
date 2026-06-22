import { z } from "zod";

export const categories = [
  "food",
  "transport",
  "groceries",
  "household",
  "entertainment",
  "shopping",
  "medical",
  "travel",
  "other",
] as const;

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
    category: z.enum(categories).nullable(),
  })
  .strict();

export const parsedIntentSchema = parsedIntentBaseSchema.superRefine(
  (value, context) => {
    if (value.intent !== "record_expense") return;
    for (const field of [
      "description",
      "amountTwd",
      "ledger",
      "paidBy",
      "expenseDate",
      "category",
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

export type ParsedIntent = z.infer<typeof parsedIntentSchema>;
export type LedgerType = "shared" | "private";

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
