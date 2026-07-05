/**
 * pending-action-proposals — proposal flow as plain functions.
 *
 * Each function in this file does the full "given a user intent, build
 * the right pending_actions row and run it through the service" cycle.
 * They depend on `PendingActionService` only for its `execute`,
 * `buildStoredPayload`, and balance lookup seams; everything else
 * (command construction, validation, payload shape) is local.
 *
 * The class on `pending-action-service.ts` re-exports these as
 * thin public methods, so external callers don't change.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { HttpError } from "./http-error";
import {
  type ActionInput,
  type CreateExpenseActionInput,
  type PendingActionContext,
} from "./pending-action-types";
import {
  createExpenseCommandSchema,
  createSettlementCommandSchema,
  expenseDraftToLegacyPayload,
  ledgerExpenseInputSchema,
  settlementDraftToLegacyPayload,
} from "./ledger-core";
import {
  loadCoupleUsers,
  resolveSharedGroupId,
} from "./pending-action-loaders";
import { loadGroupBalances } from "./balance-loader";
import { actionInputSchema } from "./pending-action-types";
import {
  assertEditableExpense,
  checkExpenseInSettlements,
  loadExpenseForProposal,
  requireGroup,
} from "./pending-action-guards";
import type { PendingActionService } from "./pending-action-service";

type ServiceForProposals = Pick<
  PendingActionService,
  "execute" | "buildStoredPayload"
> & {
  ledgerCommandService: PendingActionService["ledgerCommandService"];
};

interface ProposalMetadata {
  source: string;
  idempotencyKey?: string | null;
  sourceEventId?: string;
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------
export async function proposeAction(
  service: ServiceForProposals,
  context: PendingActionContext,
  input: unknown,
  metadata?: { source?: string; idempotencyKey?: string | null },
) {
  const parsed = actionInputSchema.parse(input);
  if (parsed.type === "batch_create_expenses") {
    return proposeBatchCreateExpenses(
      service,
      context,
      parsed.expenses.map((expense) => ({ type: "create_expense", expense })),
      metadata?.idempotencyKey ?? undefined,
    );
  }
  if (parsed.type === "batch_update_expenses") {
    return service.execute(context, {
      actionType: "batch_update_expenses",
      groupId: null,
      payload: { updates: parsed.updates },
      sourceEventId: `cleanup:${randomUUID()}`,
      idempotencyKey: metadata?.idempotencyKey,
    });
  }

  const source = metadata?.source ?? "liff";
  const idempotencyKey = metadata?.idempotencyKey ?? undefined;

  if (parsed.type === "create_expense") {
    return proposeCreateExpenseHelper(service, context, parsed.expense, { source, idempotencyKey });
  }
  if (parsed.type === "update_expense") {
    return proposeUpdateExpenseHelper(
      service,
      context,
      parsed.expenseId,
      parsed.expectedVersion,
      parsed.expense,
      { source, idempotencyKey },
    );
  }
  if (parsed.type === "delete_expense") {
    return proposeDeleteExpenseHelper(
      service,
      context,
      parsed.expenseId,
      parsed.expectedVersion,
      { source, idempotencyKey },
    );
  }
  if (parsed.type === "restore_expense") {
    return proposeRestoreExpenseHelper(
      service,
      context,
      parsed.expenseId,
      parsed.expectedVersion,
      { source, idempotencyKey },
    );
  }
  if (parsed.type === "settle") {
    return proposeSettlement(service, context, parsed, { source, idempotencyKey });
  }
  throw new HttpError(400, "不支援的操作");
}

// ---------------------------------------------------------------------------
// create_expense
// ---------------------------------------------------------------------------
export async function proposeCreateExpenseHelper(
  service: ServiceForProposals,
  context: PendingActionContext,
  expenseInput: z.infer<typeof ledgerExpenseInputSchema>,
  metadata: ProposalMetadata,
) {
  const users = await loadCoupleUsers(context);
  const partner = users.find((user) => user.id !== context.user.id);
  if (!partner) throw new HttpError(409, "請先讓另一半加入");

  if (expenseInput.ledger === "shared") {
    await requireGroup(context, expenseInput.groupId);
  }
  const draft = service.ledgerCommandService.buildExpenseDraft(expenseInput, {
    actorUserId: context.user.id,
    partnerUserId: partner.id,
  });
  const groupId = draft.groupId;
  const payload = expenseDraftToLegacyPayload(draft);

  const storedPayload = service.buildStoredPayload(
    { type: "create_expense", expense: expenseInput } as ActionInput,
    payload,
    {
      source: metadata.source,
      actorUserId: context.user.id,
      idempotencyKey: metadata.idempotencyKey,
    },
  );
  return service.execute(context, {
    actionType: "create_expense",
    groupId,
    payload: storedPayload,
    sourceEventId: metadata.sourceEventId ?? `${metadata.source}:${randomUUID()}`,
    idempotencyKey: metadata.idempotencyKey,
  });
}

// ---------------------------------------------------------------------------
// update_expense
// ---------------------------------------------------------------------------
export async function proposeUpdateExpenseHelper(
  service: ServiceForProposals,
  context: PendingActionContext,
  expenseId: string,
  expectedVersion: number,
  expenseInput: z.infer<typeof ledgerExpenseInputSchema>,
  metadata: ProposalMetadata,
) {
  const users = await loadCoupleUsers(context);
  const partner = users.find((user) => user.id !== context.user.id);
  if (!partner) throw new HttpError(409, "請先讓另一半加入");

  if (expenseInput.ledger === "shared") {
    await requireGroup(context, expenseInput.groupId);
  }
  await assertEditableExpense(context, expenseId);
  if (expenseInput.ledger === "private") {
    const check = await checkExpenseInSettlements(context, expenseId);
    if (check.settled) {
      throw new HttpError(409, check.message);
    }
  }

  const draft = service.ledgerCommandService.buildExpenseDraft(expenseInput, {
    actorUserId: context.user.id,
    partnerUserId: partner.id,
  });
  const groupId = draft.groupId;
  const payload = expenseDraftToLegacyPayload(draft);
  Object.assign(payload, {
    expense_id: expenseId,
    expected_version: expectedVersion,
  });

  const storedPayload = service.buildStoredPayload(
    {
      type: "update_expense",
      expenseId,
      expectedVersion,
      expense: expenseInput,
    } as ActionInput,
    payload,
    {
      source: metadata.source,
      actorUserId: context.user.id,
      idempotencyKey: metadata.idempotencyKey,
    },
  );
  return service.execute(context, {
    actionType: "update_expense",
    groupId,
    payload: storedPayload,
    sourceEventId: metadata.sourceEventId ?? `${metadata.source}:${randomUUID()}`,
    idempotencyKey: metadata.idempotencyKey,
  });
}

// ---------------------------------------------------------------------------
// delete_expense / restore_expense
// ---------------------------------------------------------------------------
export async function proposeDeleteExpenseHelper(
  service: ServiceForProposals,
  context: PendingActionContext,
  expenseId: string,
  expectedVersion: number,
  metadata: ProposalMetadata,
) {
  const expense = await loadExpenseForProposal(context, expenseId);
  if (expense.mirror_kind) {
    throw new HttpError(403, "共同分攤紀錄請修改來源共同帳");
  }
  if (
    expense.ledger === "private" &&
    expense.created_by_user_id !== context.user.id
  ) {
    throw new HttpError(403, "無權操作私人支出");
  }
  if (expense.version !== expectedVersion) {
    throw new HttpError(409, "帳目已被修改，請重新整理");
  }

  const payload = { expense_id: expense.id, expected_version: expense.version };
  const storedPayload = service.buildStoredPayload(
    { type: "delete_expense", expenseId, expectedVersion } as ActionInput,
    payload,
    {
      source: metadata.source,
      actorUserId: context.user.id,
      idempotencyKey: metadata.idempotencyKey,
    },
  );
  return service.execute(context, {
    actionType: "delete_expense",
    groupId: expense.group_id,
    payload: storedPayload,
    sourceEventId: metadata.sourceEventId ?? `${metadata.source}:${randomUUID()}`,
    idempotencyKey: metadata.idempotencyKey,
  });
}

export async function proposeRestoreExpenseHelper(
  service: ServiceForProposals,
  context: PendingActionContext,
  expenseId: string,
  expectedVersion: number,
  metadata: ProposalMetadata,
) {
  const expense = await loadExpenseForProposal(context, expenseId);
  if (expense.mirror_kind) {
    throw new HttpError(403, "共同分攤紀錄請修改來源共同帳");
  }
  if (
    expense.ledger === "private" &&
    expense.created_by_user_id !== context.user.id
  ) {
    throw new HttpError(403, "無權操作私人支出");
  }
  if (expense.version !== expectedVersion) {
    throw new HttpError(409, "帳目已被修改，請重新整理");
  }

  const payload = { expense_id: expense.id, expected_version: expense.version };
  const storedPayload = service.buildStoredPayload(
    { type: "restore_expense", expenseId, expectedVersion } as ActionInput,
    payload,
    {
      source: metadata.source,
      actorUserId: context.user.id,
      idempotencyKey: metadata.idempotencyKey,
    },
  );
  return service.execute(context, {
    actionType: "restore_expense",
    groupId: expense.group_id,
    payload: storedPayload,
    sourceEventId: metadata.sourceEventId ?? `${metadata.source}:${randomUUID()}`,
    idempotencyKey: metadata.idempotencyKey,
  });
}

// ---------------------------------------------------------------------------
// batch_create_expenses
// ---------------------------------------------------------------------------
export async function proposeBatchCreateExpenses(
  service: ServiceForProposals,
  context: PendingActionContext,
  inputs: CreateExpenseActionInput[],
  idempotencyKey?: string,
) {
  const parsed = z.array(createExpenseCommandSchema).min(1).max(50).parse(inputs);
  const users = await loadCoupleUsers(context);
  const partner = users.find((user) => user.id !== context.user.id);
  if (!partner) throw new HttpError(409, "請先讓另一半加入");

  const drafts = [];
  let groupId: string | null = null;
  for (const input of parsed) {
    const expense =
      input.expense.ledger === "shared"
        ? {
            ...input.expense,
            groupId: await resolveSharedGroupId(
              context,
              input.expense.groupId,
              null,
            ),
          }
        : input.expense;
    const draft = service.ledgerCommandService.buildExpenseDraft(expense, {
      actorUserId: context.user.id,
      partnerUserId: partner.id,
    });
    drafts.push(draft);
    groupId = groupId === null ? draft.groupId : groupId;
  }
  const mixedGroups = drafts.some((draft) => draft.groupId !== groupId);
  const payload = {
    items: drafts.map((draft) => expenseDraftToLegacyPayload(draft)),
  };
  return service.execute(context, {
    actionType: "batch_create_expenses",
    groupId: mixedGroups ? null : groupId,
    payload: service.buildStoredPayload(
      {
        type: "batch_create_expenses",
        expenses: parsed.map((input) => input.expense),
      } as ActionInput,
      payload,
      {
        source: "batch",
        actorUserId: context.user.id,
        idempotencyKey,
      },
    ),
    sourceEventId: `batch:${randomUUID()}`,
    idempotencyKey,
  });
}

// ---------------------------------------------------------------------------
// settle
// ---------------------------------------------------------------------------
export async function proposeSettlement(
  service: ServiceForProposals,
  context: PendingActionContext,
  input: z.infer<typeof createSettlementCommandSchema>,
  metadata?: {
    source?: string;
    sourceEventId?: string;
    idempotencyKey?: string | null;
  },
) {
  const parsed = createSettlementCommandSchema.parse(input);
  const groupId = await resolveSharedGroupId(
    context,
    parsed.groupId,
    parsed.groupId,
  );
  const balances = await loadGroupBalances(context.db, groupId);
  const draft = service.ledgerCommandService.buildSettlementDraft(
    { ...parsed, groupId },
    {
      balances,
      actorUserId: context.user.id,
    },
  );
  const source = metadata?.source ?? "liff";
  return service.execute(context, {
    actionType: "settle",
    groupId: draft.groupId,
    payload: service.buildStoredPayload(
      parsed,
      settlementDraftToLegacyPayload(draft),
      {
        source,
        actorUserId: context.user.id,
        idempotencyKey: metadata?.idempotencyKey ?? null,
      },
    ),
    sourceEventId: metadata?.sourceEventId ?? `${source}:${randomUUID()}`,
    idempotencyKey: metadata?.idempotencyKey,
  });
}
