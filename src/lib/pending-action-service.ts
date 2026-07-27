import { z } from "zod";

import { HttpError } from "./http-error";
import { withTx } from "./db/tx";
import { applyPendingActionPlanTx, TransactionStaleError } from "./pending-action-executor";
import {
  LedgerCommandService,
  pendingActionCommandFromPayload,
} from "./ledger-core";
import {
  type ActionInput,
  type ActionResult,
  type PendingRetargetInput,
  type CreateExpenseActionInput,
  type PendingActionContext,
  type PendingActionInsertInput,
  type PendingActionPlan,
  actionInputSchema,
  actionResultSchema,
  pendingRetargetInputSchema,
  pendingActionRowSchema,
  StaleActionError,
} from "./pending-action-types";
import { buildConfirmPlan } from "./pending-action-plans";
import { applyConfirmedActionSideEffects } from "./pending-action-side-effects";
import { actionResultErrorMessage } from "./pending-action-utils";
import { pendingActionRequestFingerprint } from "./pending-action-idempotency";
import {
  buildCreateExpenseAction,
  buildSettleAction,
  buildUpdateExpenseAction,
  executeAgentAction,
  normalizeCreateExpenseInput,
  normalizeUpdateExpenseInput,
} from "./pending-action-agent-actions";
import {
  proposeAction as proposeActionHelper,
  proposeBatchCreateExpenses,
  proposeCreateExpenseHelper,
  proposeCreateExpensePending as proposeCreateExpensePendingHelper,
  proposeDeleteExpenseHelper,
  proposeRestoreExpenseHelper,
  proposeSettlement as proposeSettlementHelper,
  proposeSettlementPending as proposeSettlementPendingHelper,
  proposeTransfer as proposeTransferHelper,
  proposeTransferPending as proposeTransferPendingHelper,
  proposeVoidSettlement as proposeVoidSettlementHelper,
  proposeUpdateExpenseHelper,
} from "./pending-action-proposals";

export {
  type ActionInput,
  type ActionResult,
  type PendingRetargetInput,
  type CreateExpenseActionInput,
  type PendingActionContext,
  type PendingActionPlan,
  actionInputSchema,
  actionResultSchema,
  pendingRetargetInputSchema,
};

/**
 * PendingActionService — thin orchestration facade.
 *
 * The class only owns the lifecycle concerns that need the long-lived
 * dependencies (LedgerCommandService, onConfirmed hook, action TTL).
 * All read-side checks live in `pending-action-guards`, all proposal
 * flows live in `pending-action-proposals`, and the legacy tool/LINE
 * adapter lives in `pending-action-agent-actions`. This file's public
 * methods are thin pass-throughs so callers, smoke harness, and tests
 * don't change.
 */
export class PendingActionService {
  private readonly actionSeconds: number;
  readonly ledgerCommandService: LedgerCommandService;
  private readonly onConfirmed?: (context: PendingActionContext) => Promise<void>;

  constructor(input?: {
    actionSeconds?: number;
    ledgerCommandService?: LedgerCommandService;
    deliverNotifications?: (context: PendingActionContext) => Promise<void>;
  }) {
    this.actionSeconds = input?.actionSeconds ?? 60 * 5;
    this.ledgerCommandService =
      input?.ledgerCommandService ?? new LedgerCommandService();
    this.onConfirmed = input?.deliverNotifications;
  }

  // -------------------------------------------------------------------------
  // Retargeting (receipt / line drafts → private ledger)
  // -------------------------------------------------------------------------
  retargetPayload(
    payload: Record<string, unknown>,
    userId: string,
    input: PendingRetargetInput,
  ): Record<string, unknown> {
    const command = pendingActionCommandFromPayload(payload);
    if (Array.isArray(payload.items)) {
      const items = payload.items.map((item) =>
        this.retargetPayload(
          z.record(z.string(), z.unknown()).parse(item),
          userId,
          input,
        ),
      );
      return {
        ...payload,
        ...(command?.type === "batch_create_expenses"
          ? {
              command: {
                ...command,
                expenses: command.expenses.map((expense) => ({
                  ...expense,
                  ledger: "private",
                  groupId: null,
                  paidBy: "self",
                  tag: input.tag,
                })),
              },
            }
          : {}),
        items,
      };
    }
    const rest = { ...payload };
    delete rest.splits;
    const next = {
      ...rest,
      ledger: input.ledger,
      group_id: null,
      paid_by_user_id: userId,
      tag: input.tag,
      split_method: "equal",
    };
    if (command?.type === "create_expense") {
      return {
        ...next,
        command: {
          ...command,
          expense: {
            ...command.expense,
            ledger: "private",
            groupId: null,
            paidBy: "self",
            tag: input.tag,
          },
        },
      };
    }
    return next;
  }

  async retargetActions(
    context: Pick<PendingActionContext, "db" | "user">,
    input: unknown,
  ) {
    const parsed = pendingRetargetInputSchema.parse(input);
    const rows = await context.db
      .from("pending_actions")
      .select("id, action_type, payload, idempotency_key")
      .eq("requested_by_user_id", context.user.id)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(30);
    if (rows.error) throw new Error("pending action lookup failed");
    const actions = z
      .array(
        z.object({
          id: z.string().uuid(),
          action_type: z.string(),
          payload: z.record(z.string(), z.unknown()),
          idempotency_key: z.string().nullable(),
        }),
      )
      .parse(rows.data ?? [])
      .filter(
        (row) =>
          ["create_expense", "batch_create_expenses"].includes(row.action_type) &&
          row.idempotency_key?.startsWith("receipt"),
      );
    let count = 0;
    const actionIds: string[] = [];
    for (const action of actions) {
      const payload = this.retargetPayload(action.payload, context.user.id, parsed);
      const requestFingerprint = pendingActionRequestFingerprint({
        actionType: action.action_type,
        groupId: null,
        payload,
      });
      const update = await context.db
        .from("pending_actions")
        .update({
          group_id: null,
          payload,
          request_fingerprint: requestFingerprint,
        })
        .eq("id", action.id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();
      if (update.error) throw new Error("pending action update failed");
      if (update.data) {
        count += Array.isArray(payload.items) ? payload.items.length : 1;
        actionIds.push(action.id);
      }
    }
    return { count, actionIds };
  }

  async retargetActionById(
    context: Pick<PendingActionContext, "db" | "user">,
    actionId: string,
    input: unknown,
  ) {
    const parsed = pendingRetargetInputSchema.parse(input);
    const action = await context.db
      .from("pending_actions")
      .select("id, action_type, payload")
      .eq("id", z.string().parse(actionId))
      .eq("requested_by_user_id", context.user.id)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .single();
    if (action.error) throw new HttpError(404, "找不到待確認草稿");
    const row = z
      .object({
        id: z.string(),
        action_type: z.string(),
        payload: z.record(z.string(), z.unknown()),
      })
      .parse(action.data);
    if (!["create_expense", "batch_create_expenses"].includes(row.action_type)) {
      throw new HttpError(400, "這個待確認草稿不能改帳本");
    }
    const payload = this.retargetPayload(row.payload, context.user.id, parsed);
    const requestFingerprint = pendingActionRequestFingerprint({
      actionType: row.action_type,
      groupId: null,
      payload,
    });
    const update = await context.db
      .from("pending_actions")
      .update({
        group_id: null,
        payload,
        request_fingerprint: requestFingerprint,
      })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (update.error) throw new Error("pending action update failed");
    if (!update.data) throw new HttpError(409, "待確認草稿已被處理，請重新整理");
    return {
      count: Array.isArray(payload.items) ? payload.items.length : 1,
      actionId: row.id,
    };
  }

  // -------------------------------------------------------------------------
  // Core write lifecycle
  // -------------------------------------------------------------------------
  buildStoredPayload(
    command: ActionInput,
    payload: Record<string, unknown>,
    metadata: {
      source: string;
      actorUserId: string;
      idempotencyKey?: string | null;
    },
  ) {
    if (command.type === "batch_update_expenses") return payload;
    return this.ledgerCommandService.createPendingActionEnvelope(
      command,
      {
        source: metadata.source,
        actorUserId: metadata.actorUserId,
        idempotencyKey: metadata.idempotencyKey ?? null,
      },
      payload,
    );
  }

  async insert(context: PendingActionContext, input: PendingActionInsertInput) {
    const requestFingerprint = pendingActionRequestFingerprint(input);
    if (input.idempotencyKey) {
      const prior = await context.db
        .from("pending_actions")
        .select("id, action_type, request_fingerprint")
        .eq("requested_by_user_id", context.user.id)
        .eq("action_type", input.actionType)
        .eq("idempotency_key", input.idempotencyKey)
        .maybeSingle();
      if (prior.data) {
        const row = z
          .object({
            id: z.string(),
            action_type: z.string(),
            request_fingerprint: z.string().nullable(),
          })
          .parse(prior.data);
        if (
          row.action_type === input.actionType &&
          row.request_fingerprint === requestFingerprint
        ) {
          return row.id;
        }
        throw new HttpError(409, "idempotency_conflict");
      }
    }
    const actionSeconds = ["transfer", "settle", "void_settlement"].includes(
      input.actionType,
    )
      ? 10 * 60
      : this.actionSeconds;
    const insert = await context.db
      .from("pending_actions")
      .insert({
        couple_id: context.user.couple_id,
        group_id: input.groupId,
        requested_by_user_id: context.user.id,
        action_type: input.actionType,
        payload: input.payload,
        source_event_id: input.sourceEventId,
        idempotency_key: input.idempotencyKey ?? null,
        request_fingerprint: requestFingerprint,
        expires_at: new Date(Date.now() + actionSeconds * 1_000).toISOString(),
      })
      .select("id")
      .single();
    if (!insert.error) {
      return z.object({ id: z.string() }).parse(insert.data).id;
    }
    if (input.idempotencyKey) {
      const existing = await context.db
        .from("pending_actions")
        .select("id, action_type, request_fingerprint")
        .eq("requested_by_user_id", context.user.id)
        .eq("action_type", input.actionType)
        .eq("idempotency_key", input.idempotencyKey)
        .maybeSingle();
      if (existing.data) {
        const row = z
          .object({
            id: z.string(),
            action_type: z.string(),
            request_fingerprint: z.string().nullable(),
          })
          .parse(existing.data);
        if (row.request_fingerprint === requestFingerprint) return row.id;
        throw new HttpError(409, "idempotency_conflict");
      }
    }
    throw new Error("pending action insert failed");
  }

  async execute(context: PendingActionContext, input: PendingActionInsertInput) {
    const actionId = await this.insert(context, input);
    const result = actionResultSchema.parse(
      await this.confirm(context, actionId, true),
    );
    if (result.result === "confirmed" || result.result === "already_done") {
      return result;
    }
    if (input.actionType === "void_settlement" && result.result === "stale") {
      throw new HttpError(409, "stale_action");
    }
    throw new HttpError(409, actionResultErrorMessage(result));
  }

  async confirm(
    context: PendingActionContext,
    actionId: string,
    confirm: boolean,
  ) {
    const id = z.string().parse(actionId);
    const actionResult = await context.db
      .from("pending_actions")
      .select("id, couple_id, group_id, action_type, payload, status, expires_at")
      .eq("id", id)
      .eq("requested_by_user_id", context.user.id)
      .maybeSingle();
    if (actionResult.error) throw new Error("pending action lookup failed");
    if (!actionResult.data) {
      return { result: "not_found", action_type: null };
    }
    const action = pendingActionRowSchema.parse(actionResult.data);
    if (action.status !== "pending") {
      const completedResult = {
        result:
          action.status === "expired"
            ? "expired"
            : action.status === "cancelled"
              ? "cancelled"
              : "already_done",
        action_type: action.action_type,
      } as const;
      if (
        action.status === "confirmed" &&
        ["create_expense", "update_expense"].includes(action.action_type)
      ) {
        // The ledger commit and this normalization used to be separated.
        // Replays repair a crash in that narrow post-commit window.
        await applyConfirmedActionSideEffects(context, id);
      }
      return completedResult;
    }
    if (action.expires_at <= new Date().toISOString()) {
      return this.updatePendingActionStatus(context, id, "expired");
    }
    if (!confirm) {
      return this.updatePendingActionStatus(context, id, "cancelled");
    }

    let plan: PendingActionPlan;
    try {
      plan = await buildConfirmPlan(context, action);
      plan.expected_request_fingerprint = pendingActionRequestFingerprint({
        actionType: action.action_type,
        groupId: action.group_id,
        payload: action.payload,
      });
    } catch (error) {
      if (error instanceof StaleActionError || error instanceof z.ZodError) {
        return { result: "stale", action_type: action.action_type };
      }
      throw error;
    }

    let value: ActionResult;
    try {
      value = await withTx(async (client) => {
        return await applyPendingActionPlanTx(
          client,
          id,
          context.user.id,
          plan,
          new Date().toISOString()
        );
      });
    } catch (error) {
      if (error instanceof TransactionStaleError) {
        value = { result: "stale", action_type: action.action_type };
      } else {
        console.error("[CONFIRM_ACTION] Transaction failed:", error);
        throw error;
      }
    }
    if (
      ["confirmed", "already_done"].includes(value.result) &&
      ["create_expense", "update_expense"].includes(action.action_type)
    ) {
      // Idempotent repair: if the process died after the ledger transaction
      // committed, a webhook replay must still finish tag normalization.
      await applyConfirmedActionSideEffects(context, id);
    }
    if (value.result === "confirmed") {
      if (this.onConfirmed) await this.onConfirmed(context);
    }
    return value;
  }

  private async updatePendingActionStatus(
    context: PendingActionContext,
    actionId: string,
    status: "cancelled" | "expired",
  ): Promise<ActionResult> {
    const result = await context.db
      .from("pending_actions")
      .update({
        status,
        processed_at: new Date().toISOString(),
      })
      .eq("id", actionId)
      .eq("requested_by_user_id", context.user.id)
      .eq("status", "pending")
      .select("status, action_type")
      .maybeSingle();
    if (result.error) throw new Error("pending action status update failed");
    if (result.data) {
      return {
        result: status,
        action_type: z.string().parse(result.data.action_type),
      };
    }

    const latest = await context.db
      .from("pending_actions")
      .select("status, action_type")
      .eq("id", actionId)
      .eq("requested_by_user_id", context.user.id)
      .maybeSingle();
    if (latest.error) throw new Error("pending action status reload failed");
    if (!latest.data) return { result: "not_found", action_type: null };
    const row = z.object({
      status: z.enum(["pending", "confirmed", "cancelled", "expired"]),
      action_type: z.string(),
    }).parse(latest.data);
    return {
      result:
        row.status === "confirmed"
          ? "already_done"
          : row.status === "pending"
            ? "stale"
            : row.status,
      action_type: row.action_type,
    };
  }

  // -------------------------------------------------------------------------
  // Thin delegation: proposals + agent actions + side effects
  // -------------------------------------------------------------------------
  proposeAction(
    context: PendingActionContext,
    input: unknown,
    metadata?: {
      source?: string;
      sourceEventId?: string;
      idempotencyKey?: string | null;
    },
  ) {
    return proposeActionHelper(this, context, input, metadata);
  }

  proposeBatchCreateExpenses(
    context: PendingActionContext,
    inputs: CreateExpenseActionInput[],
    idempotencyKey?: string,
  ) {
    return proposeBatchCreateExpenses(this, context, inputs, idempotencyKey);
  }

  proposeSettlement(
    context: PendingActionContext,
    input: Parameters<typeof proposeSettlementHelper>[2],
    metadata?: {
      source?: string;
      sourceEventId?: string;
      idempotencyKey?: string | null;
    },
  ) {
    return proposeSettlementHelper(this, context, input, metadata);
  }

  proposeSettlementPending(
    context: PendingActionContext,
    input: Parameters<typeof proposeSettlementHelper>[2],
    metadata: {
      source: string;
      sourceEventId: string;
      idempotencyKey: string;
    },
  ) {
    return proposeSettlementPendingHelper(this, context, input, metadata);
  }

  proposeTransfer(
    context: PendingActionContext,
    input: Parameters<typeof proposeTransferHelper>[2],
    metadata?: {
      source?: string;
      sourceEventId?: string;
      idempotencyKey?: string | null;
    },
  ) {
    return proposeTransferHelper(this, context, input, metadata);
  }

  proposeTransferPending(
    context: PendingActionContext,
    input: Parameters<typeof proposeTransferHelper>[2],
    metadata: {
      source: string;
      sourceEventId: string;
      idempotencyKey: string;
    },
  ) {
    return proposeTransferPendingHelper(this, context, input, metadata);
  }

  proposeVoidSettlement(
    context: PendingActionContext,
    input: Parameters<typeof proposeVoidSettlementHelper>[2],
    metadata?: {
      source?: string;
      sourceEventId?: string;
      idempotencyKey?: string | null;
    },
  ) {
    return proposeVoidSettlementHelper(this, context, input, metadata);
  }

  proposeCreateExpenseHelper(
    context: PendingActionContext,
    expenseInput: Parameters<typeof proposeCreateExpenseHelper>[2],
    metadata: {
      source: string;
      sourceEventId?: string;
      idempotencyKey?: string | null;
    },
  ) {
    return proposeCreateExpenseHelper(this, context, expenseInput, metadata);
  }

  proposeCreateExpensePending(
    context: PendingActionContext,
    expenseInput: Parameters<typeof proposeCreateExpenseHelper>[2],
    metadata: {
      source: string;
      sourceEventId: string;
      idempotencyKey: string;
    },
  ) {
    return proposeCreateExpensePendingHelper(
      this,
      context,
      expenseInput,
      metadata,
    );
  }

  proposeUpdateExpenseHelper(
    context: PendingActionContext,
    expenseId: string,
    expectedVersion: number,
    expenseInput: Parameters<typeof proposeUpdateExpenseHelper>[4],
    metadata: {
      source: string;
      sourceEventId?: string;
      idempotencyKey?: string | null;
    },
  ) {
    return proposeUpdateExpenseHelper(
      this,
      context,
      expenseId,
      expectedVersion,
      expenseInput,
      metadata,
    );
  }

  proposeDeleteExpenseHelper(
    context: PendingActionContext,
    expenseId: string,
    expectedVersion: number,
    metadata: {
      source: string;
      sourceEventId?: string;
      idempotencyKey?: string | null;
    },
  ) {
    return proposeDeleteExpenseHelper(
      this,
      context,
      expenseId,
      expectedVersion,
      metadata,
    );
  }

  proposeRestoreExpenseHelper(
    context: PendingActionContext,
    expenseId: string,
    expectedVersion: number,
    metadata: {
      source: string;
      sourceEventId?: string;
      idempotencyKey?: string | null;
    },
  ) {
    return proposeRestoreExpenseHelper(
      this,
      context,
      expenseId,
      expectedVersion,
      metadata,
    );
  }

  normalizeCreateExpenseInput(
    context: PendingActionContext,
    expenseInput: Parameters<typeof normalizeCreateExpenseInput>[1],
    splitsInput: Parameters<typeof normalizeCreateExpenseInput>[2],
    groupIdInput: string | null,
  ) {
    return normalizeCreateExpenseInput(
      context,
      expenseInput,
      splitsInput,
      groupIdInput,
    );
  }

  normalizeUpdateExpenseInput(
    context: PendingActionContext,
    expenseId: string,
    updates: Parameters<typeof normalizeUpdateExpenseInput>[2],
    groupIdInput: string | null | undefined,
  ) {
    return normalizeUpdateExpenseInput(
      context,
      expenseId,
      updates,
      groupIdInput,
    );
  }

  buildCreateExpenseAction(
    context: PendingActionContext,
    params: Parameters<typeof buildCreateExpenseAction>[2],
  ) {
    return buildCreateExpenseAction(this, context, params);
  }

  buildUpdateExpenseAction(
    context: PendingActionContext,
    expenseId: string,
    updates: Parameters<typeof buildUpdateExpenseAction>[3],
  ) {
    return buildUpdateExpenseAction(this, context, expenseId, updates);
  }

  buildSettleAction(
    context: PendingActionContext,
    groupId: string,
    amountTwd: number,
  ) {
    return buildSettleAction(this, context, groupId, amountTwd);
  }

  executeAgentAction(
    context: PendingActionContext,
    action: Record<string, unknown>,
    metadata?: {
      source?: string;
      sourceEventId?: string;
      idempotencyKey?: string | null;
    },
  ) {
    return executeAgentAction(this, context, action, metadata);
  }

  async applyConfirmedActionSideEffects(
    context: PendingActionContext,
    actionId: string,
  ) {
    return applyConfirmedActionSideEffects(context, actionId);
  }
}
