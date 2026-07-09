/**
 * pending-action-agent-actions — legacy tool/LINE payload → standard
 * command shape, plus thin `propose*` entry points.
 *
 * These functions own the conversion from a tool-call payload
 * (`{ type, expense, splits, paid_by_user_id, ... }` legacy shape) to
 * a `PendingActionService` standard input. They also build "action
 * previews" that the secretary / AI tools hand to the user before
 * confirmation.
 *
 * They depend on `PendingActionService` only for proposing the
 * resulting action and for the shared balance lookup.
 */
import { z } from "zod";

import { HttpError } from "./http-error";
import { taipeiToday } from "./ledger-shared";
import {
  createSettlementCommandSchema,
  expenseDraftToLegacyPayload,
} from "./ledger-core";
import { loadGroupBalances } from "./balance-loader";
import { loadCoupleUsers, loadExpense } from "./pending-action-loaders";
import { normalizeActionSplits } from "./pending-action-utils";
import type { PendingActionContext } from "./pending-action-types";
import {
  proposeCreateExpenseHelper,
  proposeDeleteExpenseHelper,
  proposeSettlement,
  proposeUpdateExpenseHelper,
} from "./pending-action-proposals";
import type { PendingActionService } from "./pending-action-service";

type ServiceForAgentActions = Pick<
  PendingActionService,
  "execute" | "buildStoredPayload"
> & {
  ledgerCommandService: PendingActionService["ledgerCommandService"];
};

// ---------------------------------------------------------------------------
// normalize: legacy tool expense shape → standard input shape
// ---------------------------------------------------------------------------
export async function normalizeCreateExpenseInput(
  context: PendingActionContext,
  expenseInput: any,
  splitsInput: any,
  groupIdInput: string | null,
) {
  const isPrivate = expenseInput.ledger === "private";
  const groupId = isPrivate ? null : (expenseInput.group_id ?? groupIdInput);

  const splits = normalizeActionSplits(splitsInput);
  let selfValue: number | null = null;
  let partnerValue: number | null = null;
  if (expenseInput.split_method !== "equal" && !isPrivate && splits) {
    const users = await loadCoupleUsers(context);
    const partner = users.find((user) => user.id !== context.user.id);
    selfValue = splits[context.user.id] ?? null;
    partnerValue = partner ? (splits[partner.id] ?? null) : null;
  }

  const paidBy =
    expenseInput.paid_by_user_id === context.user.id
      ? ("self" as const)
      : ("partner" as const);

  return {
    ledger: expenseInput.ledger,
    groupId,
    description: expenseInput.description,
    merchant: expenseInput.merchant ?? null,
    notes: expenseInput.notes ?? null,
    tag: expenseInput.tag,
    amountTwd: expenseInput.amount_twd,
    paidBy,
    expenseDate: expenseInput.expense_date,
    splitMethod: expenseInput.split_method,
    selfValue,
    partnerValue,
  };
}

export async function normalizeUpdateExpenseInput(
  context: PendingActionContext,
  expenseId: string,
  updates: any,
  groupIdInput: string | null | undefined,
) {
  const current = await loadExpense(context, expenseId);
  const nextLedger = updates.ledger ?? current.ledger;
  const groupId =
    nextLedger === "private"
      ? null
      : (current.group_id ?? groupIdInput ?? null);
  const amountTwd = updates.amount_twd ?? current.amount_twd;
  const paidByUserId = updates.paid_by_user_id ?? current.paid_by_user_id;

  const selfSplit =
    current.expense_splits.find((split) => split.user_id === context.user.id)
      ?.amount_twd ?? 0;
  const partnerSplit =
    current.expense_splits.find((split) => split.user_id !== context.user.id)
      ?.amount_twd ?? 0;

  let selfValue: number | null = null;
  let partnerValue: number | null = null;
  if (current.split_method !== "equal" && nextLedger !== "private") {
    selfValue =
      current.split_method === "percentage"
        ? Math.round((selfSplit / current.amount_twd) * 10000) / 100
        : selfSplit;
    partnerValue =
      current.split_method === "percentage"
        ? Math.round((partnerSplit / current.amount_twd) * 10000) / 100
        : partnerSplit;
  }

  return {
    standardInput: {
      ledger: nextLedger,
      groupId,
      description: updates.description ?? current.description,
      merchant: current.merchant,
      notes: current.notes,
      tag: updates.tag ?? current.tag,
      amountTwd,
      paidBy:
        paidByUserId === context.user.id
          ? ("self" as const)
          : ("partner" as const),
      expenseDate: updates.expense_date ?? current.expense_date,
      splitMethod: current.split_method,
      selfValue,
      partnerValue,
    },
    current,
  };
}

// ---------------------------------------------------------------------------
// build*: action-preview shapes for the secretary / AI tools
// ---------------------------------------------------------------------------
export async function buildCreateExpenseAction(
  service: ServiceForAgentActions,
  context: PendingActionContext,
  params: {
    ledger: "shared" | "private";
    groupId: string;
    description: string;
    amountTwd: number;
    paidBy: "self" | "partner";
    tag?: string;
    expenseDate?: string;
    merchant?: string | null;
    notes?: string | null;
    splitMethod?: "equal" | "exact" | "percentage";
  },
) {
  if (params.splitMethod === "exact" || params.splitMethod === "percentage") {
    throw new HttpError(400, "AI 記帳目前只支援平均分攤");
  }

  const users = await loadCoupleUsers(context);
  const partner = users.find((u) => u.id !== context.user.id);
  if (params.ledger === "shared" && !partner) {
    throw new HttpError(409, "找不到對方用戶");
  }
  const partnerUserId = partner?.id ?? null;

  const expenseInput = {
    ledger: params.ledger,
    groupId: params.ledger === "private" ? null : params.groupId,
    description: params.description,
    merchant: params.merchant ?? null,
    notes: params.notes ?? null,
    tag: params.tag || "其他",
    amountTwd: params.amountTwd,
    paidBy: params.paidBy,
    expenseDate: params.expenseDate || taipeiToday(),
    splitMethod: "equal" as const,
    selfValue: null,
    partnerValue: null,
  };

  const draft = service.ledgerCommandService.buildExpenseDraft(expenseInput, {
    actorUserId: context.user.id,
    partnerUserId,
  });

  const legacyPayload = expenseDraftToLegacyPayload(draft);
  const { splits, receipt_id, ...expenseFields } = legacyPayload;

  return {
    type: "create_expense" as const,
    groupId: draft.groupId,
    userId: context.user.id,
    expense: expenseFields,
    splits,
  };
}

export async function buildUpdateExpenseAction(
  service: ServiceForAgentActions,
  context: PendingActionContext,
  expenseId: string,
  updates: {
    ledger?: "shared" | "private";
    tag?: string;
    description?: string;
    amountTwd?: number;
    paidBy?: "self" | "partner";
    expenseDate?: string;
  },
) {
  const mapped: Record<string, any> = {};
  const ledger = updates.ledger;
  const tag = updates.tag;
  const description = updates.description;
  const amountTwd =
    updates.amountTwd !== undefined
      ? updates.amountTwd
      : (updates as any).amount_twd;
  const expenseDate =
    updates.expenseDate !== undefined
      ? updates.expenseDate
      : (updates as any).expense_date;
  const paidBy =
    updates.paidBy !== undefined ? updates.paidBy : (updates as any).paid_by;

  if (ledger !== undefined) mapped.ledger = ledger;
  if (tag !== undefined) mapped.tag = tag;
  if (description !== undefined) mapped.description = description;
  if (amountTwd !== undefined) mapped.amount_twd = amountTwd;
  if (expenseDate !== undefined) mapped.expense_date = expenseDate;
  if (paidBy !== undefined) {
    if (paidBy === "self") {
      mapped.paid_by_user_id = context.user.id;
    } else {
      const users = await loadCoupleUsers(context);
      const partner = users.find((u) => u.id !== context.user.id);
      mapped.paid_by_user_id = partner?.id ?? context.user.id;
    }
  }

  const { standardInput, current } = await normalizeUpdateExpenseInput(
    context,
    expenseId,
    mapped,
    undefined,
  );

  const users = await loadCoupleUsers(context);
  const partner = users.find((u) => u.id !== context.user.id);
  const partnerUserId = partner?.id ?? null;

  const draft = service.ledgerCommandService.buildExpenseDraft(standardInput, {
    actorUserId: context.user.id,
    partnerUserId,
  });

  const mappedUpdates: Record<string, unknown> = {};
  if (draft.ledger !== current.ledger) {
    mappedUpdates.ledger = draft.ledger;
  }
  if (draft.tag !== current.tag) {
    mappedUpdates.tag = draft.tag;
  }
  if (draft.description !== current.description) {
    mappedUpdates.description = draft.description;
  }
  if (draft.amountTwd !== current.amount_twd) {
    mappedUpdates.amount_twd = draft.amountTwd;
  }
  if (draft.paidByUserId !== current.paid_by_user_id) {
    mappedUpdates.paid_by_user_id = draft.paidByUserId;
  }
  if (draft.expenseDate !== current.expense_date) {
    mappedUpdates.expense_date = draft.expenseDate;
  }

  if (Object.keys(mappedUpdates).length === 0) {
    throw new HttpError(400, "沒有可修改的欄位");
  }

  return {
    type: "update_expense" as const,
    expenseId,
    expectedVersion: current.version,
    groupId: draft.groupId,
    userId: context.user.id,
    updates: mappedUpdates,
  };
}

export async function buildSettleAction(
  service: ServiceForAgentActions,
  context: PendingActionContext,
  groupId: string,
  amountTwd: number,
) {
  const balances = await loadGroupBalances(context.db, groupId);
  try {
    service.ledgerCommandService.buildSettlementDraft(
      { type: "settle", groupId, amountTwd },
      { balances, actorUserId: context.user.id },
    );
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "結清驗證失敗");
  }

  return {
    type: "settle" as const,
    groupId,
    userId: context.user.id,
    amountTwd,
  };
}

// ---------------------------------------------------------------------------
// executeAgentAction — top-level dispatcher for tool / LINE action shape
// ---------------------------------------------------------------------------
export async function executeAgentAction(
  service: ServiceForAgentActions,
  context: PendingActionContext,
  action: Record<string, unknown>,
  metadata?: {
    source?: string;
    sourceEventId?: string;
    idempotencyKey?: string | null;
  },
) {
  const type = typeof action.type === "string" ? action.type : "";
  const source = metadata?.source ?? "line";

  if (type === "create_expense") {
    const expenseInput = z
      .object({
        group_id: z.string().nullable(),
        ledger: z.enum(["shared", "private"]),
        description: z.string().trim().min(1).max(100),
        merchant: z.string().nullable().default(null),
        notes: z.string().nullable().default(null),
        tag: z.string().trim().min(1).max(40),
        amount_twd: z.number().int().positive().max(100_000_000),
        paid_by_user_id: z.string(),
        expense_date: z.iso.date(),
        split_method: z.enum(["equal", "exact", "percentage"]),
      })
      .parse(action.expense);

    const standardInput = await normalizeCreateExpenseInput(
      context,
      expenseInput,
      action.splits,
      action.groupId ? String(action.groupId) : null,
    );

    return proposeCreateExpenseHelper(service, context, standardInput, {
      source,
      sourceEventId: metadata?.sourceEventId,
      idempotencyKey: metadata?.idempotencyKey,
    });
  }

  if (type === "update_expense") {
    const input = z
      .object({
        expenseId: z.string(),
        expectedVersion: z.number().int().positive(),
        groupId: z.string().nullable().optional(),
        updates: z
          .object({
            ledger: z.enum(["shared", "private"]).optional(),
            tag: z.string().trim().min(1).max(40).optional(),
            description: z.string().trim().min(1).max(100).optional(),
            amount_twd: z.number().int().positive().max(100_000_000).optional(),
            paid_by_user_id: z.string().optional(),
            expense_date: z.iso.date().optional(),
          })
          .refine((updates) => Object.keys(updates).length > 0),
      })
      .parse(action);

    const { standardInput } = await normalizeUpdateExpenseInput(
      context,
      input.expenseId,
      input.updates,
      input.groupId,
    );

    return proposeUpdateExpenseHelper(
      service,
      context,
      input.expenseId,
      input.expectedVersion,
      standardInput,
      {
        source,
        sourceEventId: metadata?.sourceEventId,
        idempotencyKey: metadata?.idempotencyKey,
      },
    );
  }

  if (type === "settle") {
    const input = createSettlementCommandSchema.parse({
      type: "settle",
      groupId: action.groupId,
      amountTwd: action.amountTwd,
    });
    return proposeSettlement(
      service,
      context,
      { type: "settle", groupId: input.groupId, amountTwd: input.amountTwd },
      {
        source,
        sourceEventId: metadata?.sourceEventId,
        idempotencyKey: metadata?.idempotencyKey ?? null,
      },
    );
  }

  if (type === "delete_expense") {
    const input = z
      .object({
        expenseId: z.string(),
        expectedVersion: z.number().int().positive(),
      })
      .parse(action);

    return proposeDeleteExpenseHelper(
      service,
      context,
      input.expenseId,
      input.expectedVersion,
      {
        source,
        sourceEventId: metadata?.sourceEventId,
        idempotencyKey: metadata?.idempotencyKey,
      },
    );
  }

  throw new Error(`unsupported agent action: ${type}`);
}
