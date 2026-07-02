import { z } from "zod";

import { splitEqual, splitExact, splitPercentage } from "./ledger";

export const ledgerExpenseInputSchema = z.object({
  ledger: z.enum(["shared", "private"]),
  groupId: z.string().uuid().nullable(),
  description: z.string().trim().min(1).max(100),
  merchant: z.string().trim().max(100).nullable().default(null),
  notes: z.string().trim().max(500).nullable().default(null),
  tag: z.string().trim().min(1).max(40),
  amountTwd: z.number().int().positive().max(100_000_000),
  paidBy: z.enum(["self", "partner"]),
  expenseDate: z.iso.date(),
  splitMethod: z.enum(["equal", "exact", "percentage"]),
  selfValue: z.number().min(0).nullable().default(null),
  partnerValue: z.number().min(0).nullable().default(null),
});

export const createExpenseCommandSchema = z.object({
  type: z.literal("create_expense"),
  expense: ledgerExpenseInputSchema,
});

export const batchCreateExpensesCommandSchema = z.object({
  type: z.literal("batch_create_expenses"),
  expenses: z.array(ledgerExpenseInputSchema).min(1).max(50),
});

export const updateExpenseCommandSchema = z.object({
  type: z.literal("update_expense"),
  expenseId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  expense: ledgerExpenseInputSchema,
});

export const deleteExpenseCommandSchema = z.object({
  type: z.literal("delete_expense"),
  expenseId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});

export const restoreExpenseCommandSchema = z.object({
  type: z.literal("restore_expense"),
  expenseId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});

export const createSettlementCommandSchema = z.object({
  type: z.literal("settle"),
  groupId: z.string().uuid(),
  amountTwd: z.number().int().positive().max(100_000_000),
});

export const pendingLedgerCommandSchema = z.discriminatedUnion("type", [
  createExpenseCommandSchema,
  batchCreateExpensesCommandSchema,
  updateExpenseCommandSchema,
  deleteExpenseCommandSchema,
  restoreExpenseCommandSchema,
  createSettlementCommandSchema,
]);

export const pendingActionEnvelopeSchema = z.object({
  kind: z.literal("ledger_command"),
  version: z.literal(1),
  command: pendingLedgerCommandSchema,
  metadata: z.object({
    source: z.string().trim().min(1).max(40),
    actorUserId: z.string(),
    idempotencyKey: z.string().trim().min(1).max(100).nullable().default(null),
  }),
}).passthrough();

export type LedgerExpenseInput = z.infer<typeof ledgerExpenseInputSchema>;
export type CreateExpenseCommand = z.infer<typeof createExpenseCommandSchema>;
export type BatchCreateExpensesCommand = z.infer<
  typeof batchCreateExpensesCommandSchema
>;
export type UpdateExpenseCommand = z.infer<typeof updateExpenseCommandSchema>;
export type DeleteExpenseCommand = z.infer<typeof deleteExpenseCommandSchema>;
export type RestoreExpenseCommand = z.infer<typeof restoreExpenseCommandSchema>;
export type CreateSettlementCommand = z.infer<
  typeof createSettlementCommandSchema
>;
export type PendingLedgerCommand = z.infer<typeof pendingLedgerCommandSchema>;
export type PendingActionEnvelope = z.infer<typeof pendingActionEnvelopeSchema>;
export type PendingActionStoredPayload = Record<string, unknown>;

export interface LedgerDraftContext {
  actorUserId: string;
  partnerUserId?: string | null;
}

export interface LedgerExpenseDraft {
  groupId: string | null;
  ledger: "shared" | "private";
  description: string;
  merchant: string | null;
  notes: string | null;
  tag: string;
  amountTwd: number;
  paidByUserId: string;
  expenseDate: string;
  splitMethod: "equal" | "exact" | "percentage";
  splits: Record<string, number>;
}

export interface LedgerBalanceRow {
  userId: string;
  balanceTwd: number;
}

export interface LedgerSettlementDraft {
  groupId: string;
  fromUserId: string;
  toUserId: string;
  amountTwd: number;
  expectedBalanceTwd: number;
}

export interface PendingActionExpenseRow {
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
}

export class LedgerCommandService {
  createPendingActionEnvelope(
    command: PendingLedgerCommand,
    metadata: PendingActionEnvelope["metadata"],
    legacyPayload: Record<string, unknown> = {},
  ) {
    return pendingActionEnvelopeSchema.parse({
      kind: "ledger_command",
      version: 1,
      command,
      metadata,
      ...legacyPayload,
    });
  }

  buildExpenseDraft(
    expense: LedgerExpenseInput,
    context: LedgerDraftContext,
  ): LedgerExpenseDraft {
    if (expense.ledger === "shared" && !expense.groupId) {
      throw new Error("請選擇群組");
    }
    if (expense.ledger === "private" && expense.paidBy !== "self") {
      throw new Error("私人支出只能由本人付款");
    }
    if (expense.ledger === "shared" && !context.partnerUserId) {
      throw new Error("找不到對方用戶");
    }

    const paidByUserId =
      expense.ledger === "private"
        ? context.actorUserId
        : expense.paidBy === "self"
          ? context.actorUserId
          : context.partnerUserId!;

    let splits: Record<string, number>;
    if (expense.ledger === "private") {
      splits = { [context.actorUserId]: expense.amountTwd };
    } else if (expense.splitMethod === "equal") {
      splits = splitEqual(
        expense.amountTwd,
        paidByUserId,
        paidByUserId === context.actorUserId
          ? context.partnerUserId!
          : context.actorUserId,
      );
    } else if (expense.splitMethod === "exact") {
      splits = splitExact(expense.amountTwd, {
        [context.actorUserId]: expense.selfValue ?? -1,
        [context.partnerUserId!]: expense.partnerValue ?? -1,
      });
    } else {
      splits = splitPercentage(expense.amountTwd, paidByUserId, {
        [context.actorUserId]: expense.selfValue ?? -1,
        [context.partnerUserId!]: expense.partnerValue ?? -1,
      });
    }

    return {
      groupId: expense.ledger === "private" ? null : expense.groupId,
      ledger: expense.ledger,
      description: expense.description,
      merchant: expense.merchant,
      notes: expense.notes,
      tag: expense.tag,
      amountTwd: expense.amountTwd,
      paidByUserId,
      expenseDate: expense.expenseDate,
      splitMethod: expense.splitMethod,
      splits,
    };
  }

  buildSettlementDraft(
    command: CreateSettlementCommand,
    input: {
      balances: LedgerBalanceRow[];
      actorUserId?: string;
    },
  ): LedgerSettlementDraft {
    const debtor = input.balances.find((item) => item.balanceTwd < 0);
    const creditor = input.balances.find((item) => item.balanceTwd > 0);
    if (!debtor || !creditor) {
      throw new Error("目前沒有可結清的欠款");
    }
    if (input.actorUserId && debtor.userId !== input.actorUserId) {
      const mine =
        input.balances.find((item) => item.userId === input.actorUserId)
          ?.balanceTwd ?? 0;
      throw new Error(
        `目前你不需要結清（你的餘額為 NT$${mine}）。對方欠你 NT$${Math.abs(mine)}。`,
      );
    }
    if (command.amountTwd > Math.abs(debtor.balanceTwd)) {
      throw new Error("結清金額超過目前欠款");
    }
    return {
      groupId: command.groupId,
      fromUserId: debtor.userId,
      toUserId: creditor.userId,
      amountTwd: command.amountTwd,
      expectedBalanceTwd: debtor.balanceTwd,
    };
  }
}

export function expenseDraftToPendingActionExpense(
  draft: LedgerExpenseDraft,
  createdByUserId: string,
): PendingActionExpenseRow {
  return {
    group_id: draft.groupId,
    ledger: draft.ledger,
    description: draft.description,
    merchant: draft.merchant,
    notes: draft.notes,
    tag: draft.tag,
    amount_twd: draft.amountTwd,
    paid_by_user_id: draft.paidByUserId,
    created_by_user_id: createdByUserId,
    expense_date: draft.expenseDate,
    split_method: draft.splitMethod,
  };
}

// ponytail: keep this adapter until the RPC flow is gone.
export function expenseDraftToLegacyPayload(draft: LedgerExpenseDraft) {
  return {
    group_id: draft.groupId,
    ledger: draft.ledger,
    description: draft.description,
    merchant: draft.merchant,
    notes: draft.notes,
    tag: draft.tag,
    amount_twd: draft.amountTwd,
    paid_by_user_id: draft.paidByUserId,
    expense_date: draft.expenseDate,
    split_method: draft.splitMethod,
    splits: draft.splits,
    receipt_id: null,
  };
}

export function settlementDraftToLegacyPayload(draft: LedgerSettlementDraft) {
  return {
    group_id: draft.groupId,
    from_user_id: draft.fromUserId,
    to_user_id: draft.toUserId,
    amount_twd: draft.amountTwd,
    expected_balance_twd: draft.expectedBalanceTwd,
  };
}

export function pendingActionCommandFromPayload(
  payload: Record<string, unknown>,
): PendingLedgerCommand | null {
  const parsed = pendingActionEnvelopeSchema.safeParse(payload);
  return parsed.success ? parsed.data.command : null;
}

export function pendingActionEnvelopeMetaFromPayload(
  payload: Record<string, unknown>,
): PendingActionEnvelope["metadata"] | null {
  const parsed = pendingActionEnvelopeSchema.safeParse(payload);
  return parsed.success ? parsed.data.metadata : null;
}
