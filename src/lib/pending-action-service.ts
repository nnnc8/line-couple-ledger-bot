import { randomUUID } from "node:crypto";
import { taipeiToday } from "./ledger-shared";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { batchCategoryUpdateSchema } from "./ledger-agent";
import { calculateBalances, type LedgerExpense, type Settlement } from "./ledger";
import {
  LedgerCommandService,
  batchCreateExpensesCommandSchema,
  createExpenseCommandSchema,
  createSettlementCommandSchema,
  deleteExpenseCommandSchema,
  expenseDraftToLegacyPayload,
  ledgerExpenseInputSchema,
  pendingActionCommandFromPayload,
  restoreExpenseCommandSchema,
  settlementDraftToLegacyPayload,
  updateExpenseCommandSchema,
} from "./ledger-core";
import { HttpError } from "./http-error";

export const actionInputSchema = z.discriminatedUnion("type", [
  createExpenseCommandSchema,
  batchCreateExpensesCommandSchema,
  updateExpenseCommandSchema,
  deleteExpenseCommandSchema,
  restoreExpenseCommandSchema,
  createSettlementCommandSchema,
  z.object({
    type: z.literal("batch_update_expenses"),
    updates: z.array(batchCategoryUpdateSchema).min(1).max(50),
  }),
]);

export const actionResultSchema = z.object({
  result: z.enum([
    "confirmed",
    "cancelled",
    "expired",
    "stale",
    "not_found",
    "already_done",
  ]),
  action_type: z.string().nullable().optional(),
  created_count: z.number().int().optional(),
});

export const pendingRetargetInputSchema = z.object({
  ledger: z.literal("private"),
  tag: z.literal("交通"),
});

export type ActionInput = z.infer<typeof actionInputSchema>;
export type ActionResult = z.infer<typeof actionResultSchema>;
export type PendingRetargetInput = z.infer<typeof pendingRetargetInputSchema>;
export type CreateExpenseActionInput = Extract<
  z.infer<typeof actionInputSchema>,
  { type: "create_expense" }
>;

export interface PendingActionContext {
  db: SupabaseClient;
  user: {
    id: string;
    couple_id: number;
    line_user_id: string;
    role: "owner" | "partner";
  };
  env?: unknown;
}

interface PendingActionInsertInput {
  actionType: string;
  groupId: string | null;
  payload: Record<string, unknown>;
  sourceEventId: string;
  idempotencyKey?: string | null;
}

const pendingActionRowSchema = z.object({
  id: z.string(),
  couple_id: z.number().int(),
  group_id: z.string().nullable(),
  action_type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "confirmed", "cancelled", "expired"]),
  expires_at: z.string(),
});

const pendingUserRowSchema = z.object({
  id: z.string(),
  couple_id: z.number().int(),
  line_user_id: z.string(),
  role: z.enum(["owner", "partner"]),
});

const pendingGroupRowSchema = z.object({
  id: z.string(),
});

const pendingReceiptRowSchema = z.object({
  id: z.string(),
});

const pendingExpenseRowSchema = z.object({
  id: z.string(),
  couple_id: z.number().int(),
  group_id: z.string().nullable(),
  ledger: z.enum(["shared", "private"]),
  description: z.string(),
  merchant: z.string().nullable(),
  notes: z.string().nullable(),
  tag: z.string(),
  amount_twd: z.number().int(),
  paid_by_user_id: z.string(),
  created_by_user_id: z.string(),
  expense_date: z.string(),
  split_method: z.enum(["equal", "exact", "percentage"]),
  version: z.number().int(),
  deleted_at: z.string().nullable(),
  deleted_by_user_id: z.string().nullable().optional(),
  mirror_kind: z.enum(["shared_share"]).nullable().optional().default(null),
  expense_splits: z
    .array(
      z.object({
        user_id: z.string(),
        amount_twd: z.number().int(),
      }),
    )
    .default([]),
});

const pendingSettlementRowSchema = z.object({
  from_user_id: z.string(),
  to_user_id: z.string(),
  amount_twd: z.number().int(),
});

interface PendingActionPlan {
  insert_expenses?: Array<Record<string, unknown>>;
  update_expenses?: Array<Record<string, unknown>>;
  delete_expense_splits?: string[];
  insert_expense_splits?: Array<Record<string, unknown>>;
  update_receipts?: Array<Record<string, unknown>>;
  soft_delete_receipts_by_expense?: string[];
  restore_receipts_by_expense?: string[];
  insert_settlements?: Array<Record<string, unknown>>;
  insert_activities?: Array<Record<string, unknown>>;
  insert_notifications?: Array<Record<string, unknown>>;
}

class StaleActionError extends Error {}

export class PendingActionService {
  private readonly actionSeconds: number;
  private readonly ledgerCommandService: LedgerCommandService;
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
      const update = await context.db
        .from("pending_actions")
        .update({
          group_id: null,
          payload,
        })
        .eq("id", action.id)
        .eq("status", "pending");
      if (!update.error) {
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
    if (action.error) throw new HttpError(404, "找不到收據草稿");
    const row = z
      .object({
        id: z.string(),
        action_type: z.string(),
        payload: z.record(z.string(), z.unknown()),
      })
      .parse(action.data);
    if (!["create_expense", "batch_create_expenses"].includes(row.action_type)) {
      throw new HttpError(400, "這個收據草稿不能改帳本");
    }
    const payload = this.retargetPayload(row.payload, context.user.id, parsed);
    const update = await context.db
      .from("pending_actions")
      .update({ group_id: null, payload })
      .eq("id", row.id)
      .eq("status", "pending");
    if (update.error) throw new Error("pending action update failed");
    return {
      count: Array.isArray(payload.items) ? payload.items.length : 1,
      actionId: row.id,
    };
  }

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
        expires_at: new Date(Date.now() + this.actionSeconds * 1_000).toISOString(),
      })
      .select("id")
      .single();
    if (!insert.error) {
      return z.object({ id: z.string() }).parse(insert.data).id;
    }
    if (input.idempotencyKey) {
      const existing = await context.db
        .from("pending_actions")
        .select("id")
        .eq("idempotency_key", input.idempotencyKey)
        .single();
      if (!existing.error) {
        return z.object({ id: z.string() }).parse(existing.data).id;
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
    throw new HttpError(409, actionResultErrorMessage(result));
  }

  async proposeBatchCreateExpenses(
    context: PendingActionContext,
    inputs: CreateExpenseActionInput[],
    idempotencyKey?: string,
  ) {
    const parsed = z.array(createExpenseCommandSchema).min(1).max(50).parse(inputs);
    const users = await this.loadCoupleUsers(context);
    const partner = users.find((user) => user.id !== context.user.id);
    if (!partner) throw new HttpError(409, "請先讓另一半加入");

    const drafts = [];
    let groupId: string | null = null;
    for (const input of parsed) {
      const expense =
        input.expense.ledger === "shared"
          ? {
              ...input.expense,
              groupId: await this.resolveSharedGroupId(
                context,
                input.expense.groupId,
                null,
              ),
            }
          : input.expense;
      const draft = this.ledgerCommandService.buildExpenseDraft(expense, {
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
    return this.execute(context, {
      actionType: "batch_create_expenses",
      groupId: mixedGroups ? null : groupId,
      payload: this.buildStoredPayload(
        {
          type: "batch_create_expenses",
          expenses: parsed.map((input) => input.expense),
        },
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

  async proposeSettlement(
    context: PendingActionContext,
    input: z.infer<typeof createSettlementCommandSchema>,
    metadata?: { source?: string; idempotencyKey?: string | null },
  ) {
    const parsed = createSettlementCommandSchema.parse(input);
    const groupId = await this.resolveSharedGroupId(
      context,
      parsed.groupId,
      parsed.groupId,
    );
    const balances = await this.loadSettlementBalanceRows(context, groupId);
    const draft = this.ledgerCommandService.buildSettlementDraft({
      ...parsed,
      groupId,
    }, {
      balances,
      actorUserId: context.user.id,
    });
    const source = metadata?.source ?? "liff";
    return this.execute(context, {
      actionType: "settle",
      groupId: draft.groupId,
      payload: this.buildStoredPayload(
        parsed,
        settlementDraftToLegacyPayload(draft),
        {
          source,
          actorUserId: context.user.id,
          idempotencyKey: metadata?.idempotencyKey ?? null,
        },
      ),
      sourceEventId: `${source}:${randomUUID()}`,
      idempotencyKey: metadata?.idempotencyKey ?? null,
    });
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
      return { result: "already_done", action_type: action.action_type };
    }
    if (action.expires_at <= new Date().toISOString()) {
      await this.updatePendingActionStatus(context, id, "expired");
      return { result: "expired", action_type: action.action_type };
    }
    if (!confirm) {
      await this.updatePendingActionStatus(context, id, "cancelled");
      return { result: "cancelled", action_type: action.action_type };
    }

    let plan: PendingActionPlan;
    try {
      plan = await this.buildConfirmPlan(context, action);
    } catch (error) {
      if (error instanceof StaleActionError || error instanceof z.ZodError) {
        return { result: "stale", action_type: action.action_type };
      }
      throw error;
    }

    const result = await context.db.rpc("apply_pending_action_plan", {
      p_action_id: id,
      p_plan: plan,
    });
    if (result.error) {
      console.error("[CONFIRM_ACTION] result.error:", JSON.stringify(result.error));
      throw new Error("confirm action failed");
    }
    const value = actionResultSchema.parse({
      ...(typeof result.data === "object" && result.data ? result.data : {}),
      ...(action.action_type === "batch_create_expenses"
        ? { created_count: plan.insert_expenses?.length ?? 0 }
        : {}),
    });
    if (value.result === "confirmed") {
      if (["create_expense", "update_expense"].includes(action.action_type)) {
        await this.applyConfirmedActionSideEffects(context, id);
      }
      if (this.onConfirmed) await this.onConfirmed(context);
    }
    return value;
  }

  private async updatePendingActionStatus(
    context: PendingActionContext,
    actionId: string,
    status: "cancelled" | "expired",
  ) {
    const result = await context.db
      .from("pending_actions")
      .update({
        status,
        processed_at: new Date().toISOString(),
      })
      .eq("id", actionId)
      .eq("requested_by_user_id", context.user.id);
    if (result.error) throw new Error("pending action status update failed");
  }

  private async buildConfirmPlan(
    context: PendingActionContext,
    action: z.infer<typeof pendingActionRowSchema>,
  ): Promise<PendingActionPlan> {
    if (action.action_type === "create_expense") {
      return this.buildCreateExpensePlan(context, action, action.payload);
    }
    if (action.action_type === "update_expense") {
      return this.buildUpdateExpensePlan(context, action);
    }
    if (action.action_type === "delete_expense") {
      return this.buildDeleteRestorePlan(context, action, "delete");
    }
    if (action.action_type === "restore_expense") {
      return this.buildDeleteRestorePlan(context, action, "restore");
    }
    if (action.action_type === "settle") {
      return this.buildSettlementPlan(context, action);
    }
    if (action.action_type === "batch_create_expenses") {
      return this.buildBatchCreatePlan(context, action);
    }
    if (action.action_type === "batch_update_expenses") {
      return this.buildBatchUpdatePlan(context, action);
    }
    throw new StaleActionError("unsupported action");
  }

  private async buildCreateExpensePlan(
    context: PendingActionContext,
    action: z.infer<typeof pendingActionRowSchema>,
    payload: Record<string, unknown>,
  ): Promise<PendingActionPlan> {
    const users = await this.loadCoupleUsers(context);
    const item = await this.planExpenseInsert(context, action, payload, users);
    return {
      insert_expenses: [item.expense],
      insert_expense_splits: item.splits,
      ...(item.receiptUpdates.length
        ? { update_receipts: item.receiptUpdates }
        : {}),
      insert_activities: [item.activity],
      ...(item.notification ? { insert_notifications: [item.notification] } : {}),
    };
  }

  private async buildUpdateExpensePlan(
    context: PendingActionContext,
    action: z.infer<typeof pendingActionRowSchema>,
  ): Promise<PendingActionPlan> {
    const expenseId = z.string().uuid().parse(action.payload.expense_id);
    const expectedVersion = z.coerce
      .number()
      .int()
      .positive()
      .parse(action.payload.expected_version);
    const users = await this.loadCoupleUsers(context);
    const current = await this.loadExpense(context, expenseId);
    if (current.deleted_at || current.version !== expectedVersion || current.mirror_kind) {
      throw new StaleActionError("stale expense");
    }
    if (
      current.ledger === "private" &&
      current.created_by_user_id !== context.user.id
    ) {
      throw new StaleActionError("private ownership mismatch");
    }
    const nextLedger = z.enum(["shared", "private"]).parse(action.payload.ledger);
    if (
      current.ledger === "shared" &&
      nextLedger === "private" &&
      (await this.hasAnySettlement(context))
    ) {
      throw new StaleActionError("shared settlement already exists");
    }
    const groupId =
      nextLedger === "private"
        ? null
        : await this.resolveSharedGroupId(
            context,
            action.payload.group_id,
            action.group_id,
          );
    const amountTwd = parsePositiveMoney(action.payload.amount_twd);
    const paidByUserId = z.string().parse(action.payload.paid_by_user_id);
    if (!users.some((user) => user.id === paidByUserId)) {
      throw new StaleActionError("payer is not in couple");
    }
    if (nextLedger === "private" && paidByUserId !== context.user.id) {
      throw new StaleActionError("private payer mismatch");
    }
    const splits = this.resolveSplits(
      action.payload.splits,
      amountTwd,
      nextLedger,
      paidByUserId,
      users,
      context.user.id,
    );
    const receiptId = parseOptionalUuid(action.payload.receipt_id);
    if (receiptId) {
      await this.validateReceipt(context, receiptId, expenseId);
    }
    const tag = normalizePendingTag(action.payload.tag);
    const afterRow = {
      id: current.id,
      couple_id: context.user.couple_id,
      group_id: groupId,
      ledger: nextLedger,
      description: parseDescription(action.payload.description),
      merchant: parseOptionalText(action.payload.merchant, 100),
      notes: parseOptionalText(action.payload.notes, 500),
      tag,
      amount_twd: amountTwd,
      paid_by_user_id: paidByUserId,
      expense_date: z.iso.date().parse(action.payload.expense_date),
      split_method: parseSplitMethod(action.payload.split_method),
      expected_version: current.version,
      deleted_at: current.deleted_at,
      deleted_by_user_id: current.deleted_by_user_id ?? null,
    };
    return {
      update_expenses: [afterRow],
      delete_expense_splits: [current.id],
      insert_expense_splits: splitEntries(current.id, splits),
      ...(receiptId
        ? {
            update_receipts: [
              {
                id: receiptId,
                expense_id: current.id,
                group_id: groupId,
              },
            ],
          }
        : {}),
      insert_activities: [
        {
          couple_id: context.user.couple_id,
          group_id: groupId,
          actor_user_id: context.user.id,
          entity_type: "expense",
          entity_id: current.id,
          action: "update",
          before_state: current,
          after_state: { ...afterRow, version: current.version + 1 },
        },
      ],
      ...(this.buildSharedExpenseNotification(
        users,
        context.user.id,
        groupId,
        "共同帳本已更新",
        "另一半更新了一筆支出",
        "expense",
        current.id,
        `action:${action.id}`,
      )
        ? {
            insert_notifications: [
              this.buildSharedExpenseNotification(
                users,
                context.user.id,
                groupId,
                "共同帳本已更新",
                "另一半更新了一筆支出",
                "expense",
                current.id,
                `action:${action.id}`,
              )!,
            ],
          }
        : {}),
    };
  }

  private async buildDeleteRestorePlan(
    context: PendingActionContext,
    action: z.infer<typeof pendingActionRowSchema>,
    mode: "delete" | "restore",
  ): Promise<PendingActionPlan> {
    const expenseId = z.string().parse(action.payload.expense_id);
    const expectedVersion = z.coerce
      .number()
      .int()
      .positive()
      .parse(action.payload.expected_version);
    const current = await this.loadExpense(context, expenseId);
    if (current.version !== expectedVersion || current.mirror_kind) {
      throw new StaleActionError("stale expense");
    }
    if (
      current.ledger === "private" &&
      current.created_by_user_id !== context.user.id
    ) {
      throw new StaleActionError("private ownership mismatch");
    }
    const deletedAt =
      mode === "delete"
        ? new Date().toISOString()
        : null;
    if (mode === "delete" && current.deleted_at) {
      throw new StaleActionError("already deleted");
    }
    if (
      mode === "restore" &&
      (!current.deleted_at ||
        new Date(current.deleted_at).getTime() <=
          Date.now() - 30 * 24 * 60 * 60 * 1_000)
    ) {
      throw new StaleActionError("restore window expired");
    }
    const users =
      current.group_id === null ? [] : await this.loadCoupleUsers(context);
    const afterRow = {
      id: current.id,
      couple_id: context.user.couple_id,
      group_id: current.group_id,
      ledger: current.ledger,
      description: current.description,
      merchant: current.merchant,
      notes: current.notes,
      tag: current.tag,
      amount_twd: current.amount_twd,
      paid_by_user_id: current.paid_by_user_id,
      expense_date: current.expense_date,
      split_method: current.split_method,
      expected_version: current.version,
      deleted_at: deletedAt,
      deleted_by_user_id: mode === "delete" ? context.user.id : null,
    };
    return {
      update_expenses: [afterRow],
      ...(mode === "delete"
        ? { soft_delete_receipts_by_expense: [current.id] }
        : { restore_receipts_by_expense: [current.id] }),
      insert_activities: [
        {
          couple_id: context.user.couple_id,
          group_id: current.group_id,
          actor_user_id: context.user.id,
          entity_type: "expense",
          entity_id: current.id,
          action: mode,
          before_state: current,
          after_state: { ...afterRow, version: current.version + 1 },
        },
      ],
      ...(this.buildSharedExpenseNotification(
        users,
        context.user.id,
        current.group_id,
        "共同帳本已更新",
        "另一半更新了一筆支出",
        "expense",
        current.id,
        `action:${action.id}`,
      )
        ? {
            insert_notifications: [
              this.buildSharedExpenseNotification(
                users,
                context.user.id,
                current.group_id,
                "共同帳本已更新",
                "另一半更新了一筆支出",
                "expense",
                current.id,
                `action:${action.id}`,
              )!,
            ],
          }
        : {}),
    };
  }

  private async buildSettlementPlan(
    context: PendingActionContext,
    action: z.infer<typeof pendingActionRowSchema>,
  ): Promise<PendingActionPlan> {
    const groupId = await this.resolveSharedGroupId(
      context,
      action.payload.group_id,
      action.group_id,
    );
    const users = await this.loadCoupleUsers(context);
    const fromUserId = z.string().parse(action.payload.from_user_id);
    const toUserId = z.string().parse(action.payload.to_user_id);
    const amountTwd = parsePositiveMoney(action.payload.amount_twd);
    const expectedBalance =
      action.payload.expected_balance_twd === undefined
        ? null
        : z.coerce.number().int().parse(action.payload.expected_balance_twd);
    if (
      fromUserId === toUserId ||
      !users.some((user) => user.id === fromUserId) ||
      !users.some((user) => user.id === toUserId)
    ) {
      throw new StaleActionError("invalid settlement users");
    }
    const balances = await this.loadGroupBalances(context, groupId);
    const currentBalance = balances[fromUserId] ?? 0;
    const targetBalance = balances[toUserId] ?? 0;
    if (
      currentBalance >= 0 ||
      targetBalance !== -currentBalance ||
      amountTwd > Math.abs(currentBalance) ||
      (expectedBalance !== null && currentBalance !== expectedBalance)
    ) {
      throw new StaleActionError("stale settlement");
    }
    return {
      insert_settlements: [
        {
          id: randomUUID(),
          couple_id: context.user.couple_id,
          group_id: groupId,
          from_user_id: fromUserId,
          to_user_id: toUserId,
          amount_twd: amountTwd,
          source_action_id: action.id,
        },
      ],
      insert_activities: [
        {
          couple_id: context.user.couple_id,
          group_id: groupId,
          actor_user_id: context.user.id,
          entity_type: "settlement",
          entity_id: action.id,
          action: "settle",
          after_state: {
            from_user_id: fromUserId,
            to_user_id: toUserId,
            amount_twd: amountTwd,
          },
        },
      ],
      ...(this.buildSharedExpenseNotification(
        users,
        context.user.id,
        groupId,
        "帳務已結清",
        "另一半新增了一筆結清紀錄",
        "settlement",
        action.id,
        `action:${action.id}`,
      )
        ? {
            insert_notifications: [
              this.buildSharedExpenseNotification(
                users,
                context.user.id,
                groupId,
                "帳務已結清",
                "另一半新增了一筆結清紀錄",
                "settlement",
                action.id,
                `action:${action.id}`,
              )!,
            ],
          }
        : {}),
    };
  }

  private async buildBatchCreatePlan(
    context: PendingActionContext,
    action: z.infer<typeof pendingActionRowSchema>,
  ): Promise<PendingActionPlan> {
    const items = z.array(z.record(z.string(), z.unknown())).min(1).max(50).parse(
      action.payload.items,
    );
    const users = await this.loadCoupleUsers(context);
    const insertExpenses: Array<Record<string, unknown>> = [];
    const insertExpenseSplits: Array<Record<string, unknown>> = [];
    const updateReceipts: Array<Record<string, unknown>> = [];
    const insertActivities: Array<Record<string, unknown>> = [];
    const plan: PendingActionPlan = {
      insert_expenses: insertExpenses,
      insert_expense_splits: insertExpenseSplits,
      update_receipts: updateReceipts,
      insert_activities: insertActivities,
    };
    let notificationGroupId: string | null = null;
    for (const payload of items) {
      const item = await this.planExpenseInsert(context, action, payload, users);
      insertExpenses.push(item.expense);
      insertExpenseSplits.push(...item.splits);
      updateReceipts.push(...item.receiptUpdates);
      insertActivities.push(item.activity);
      notificationGroupId ??= item.expense.group_id as string | null;
    }
    if (!insertExpenses.length) {
      throw new StaleActionError("empty batch");
    }
    if (!updateReceipts.length) delete plan.update_receipts;
    const notification = this.buildSharedExpenseNotification(
      users,
      context.user.id,
      notificationGroupId,
      "共同帳本已更新",
      "另一半新增了一批支出",
      "expense",
      action.id,
      `batch-create:${action.id}`,
    );
    if (notification) {
      plan.insert_notifications = [notification];
    }
    return plan;
  }

  private async buildBatchUpdatePlan(
    context: PendingActionContext,
    action: z.infer<typeof pendingActionRowSchema>,
  ): Promise<PendingActionPlan> {
    const updates = z
      .array(
        z.object({
          expense_id: z.string().uuid(),
          expected_version: z.coerce.number().int().positive(),
          tag: z.string().trim().min(1).max(40).optional(),
          category_label: z.string().trim().min(1).max(40).optional(),
        }),
      )
      .parse(action.payload.updates);
    const users = await this.loadCoupleUsers(context);
    const updateExpenses: Array<Record<string, unknown>> = [];
    const insertActivities: Array<Record<string, unknown>> = [];
    const plan: PendingActionPlan = {
      update_expenses: updateExpenses,
      insert_activities: insertActivities,
    };
    for (const update of updates) {
      const current = await this.loadExpense(context, update.expense_id);
      if (
        current.deleted_at ||
        current.version !== update.expected_version ||
        current.mirror_kind
      ) {
        throw new StaleActionError("stale expense");
      }
      if (
        current.ledger === "private" &&
        current.created_by_user_id !== context.user.id
      ) {
        throw new StaleActionError("private ownership mismatch");
      }
      if (
        current.ledger === "shared" &&
        current.group_id !== action.group_id
      ) {
        throw new StaleActionError("group mismatch");
      }
      const tag = normalizePendingTag(update.tag ?? update.category_label);
      const afterRow = {
        id: current.id,
        couple_id: context.user.couple_id,
        group_id: current.group_id,
        ledger: current.ledger,
        description: current.description,
        merchant: current.merchant,
        notes: current.notes,
        tag,
        amount_twd: current.amount_twd,
        paid_by_user_id: current.paid_by_user_id,
        expense_date: current.expense_date,
        split_method: current.split_method,
        expected_version: current.version,
        deleted_at: current.deleted_at,
        deleted_by_user_id: current.deleted_by_user_id ?? null,
      };
      updateExpenses.push(afterRow);
      insertActivities.push({
        couple_id: context.user.couple_id,
        group_id: current.group_id,
        actor_user_id: context.user.id,
        entity_type: "expense",
        entity_id: current.id,
        action: "update",
        before_state: current,
        after_state: { ...afterRow, version: current.version + 1 },
      });
    }
    if (!updateExpenses.length) {
      throw new StaleActionError("empty batch");
    }
    const notification = this.buildSharedExpenseNotification(
      users,
      context.user.id,
      action.group_id,
      "分類整理已套用",
      "另一半套用了一批分類整理",
      "expense",
      action.id,
      `batch-category:${action.id}`,
    );
    if (notification) {
      plan.insert_notifications = [notification];
    }
    return plan;
  }

  private async planExpenseInsert(
    context: PendingActionContext,
    action: z.infer<typeof pendingActionRowSchema>,
    payload: Record<string, unknown>,
    users: Array<z.infer<typeof pendingUserRowSchema>>,
  ) {
    const ledger = z.enum(["shared", "private"]).parse(payload.ledger);
    const groupId =
      ledger === "private"
        ? null
        : await this.resolveSharedGroupId(context, payload.group_id, action.group_id);
    const amountTwd = parsePositiveMoney(payload.amount_twd);
    const paidByUserId = z.string().parse(payload.paid_by_user_id);
    if (!users.some((user) => user.id === paidByUserId)) {
      throw new StaleActionError("payer is not in couple");
    }
    if (ledger === "private" && paidByUserId !== context.user.id) {
      throw new StaleActionError("private payer mismatch");
    }
    const receiptId = parseOptionalUuid(payload.receipt_id);
    if (receiptId) {
      await this.validateReceipt(context, receiptId, null);
    }
    const expenseId = randomUUID();
    const splits = this.resolveSplits(
      payload.splits,
      amountTwd,
      ledger,
      paidByUserId,
      users,
      context.user.id,
    );
    const expense = {
      id: expenseId,
      couple_id: context.user.couple_id,
      group_id: groupId,
      ledger,
      description: parseDescription(payload.description),
      merchant: parseOptionalText(payload.merchant, 100),
      notes: parseOptionalText(payload.notes, 500),
      tag: normalizePendingTag(payload.tag),
      amount_twd: amountTwd,
      paid_by_user_id: paidByUserId,
      created_by_user_id: context.user.id,
      expense_date: z.iso.date().parse(payload.expense_date),
      split_method: parseSplitMethod(payload.split_method),
      source_action_id: action.id,
    };
    return {
      expense,
      splits: splitEntries(expenseId, splits),
      receiptUpdates: receiptId
        ? [
            {
              id: receiptId,
              expense_id: expenseId,
              group_id: groupId,
            },
          ]
        : [],
      activity: {
        couple_id: context.user.couple_id,
        group_id: groupId,
        actor_user_id: context.user.id,
        entity_type: "expense",
        entity_id: expenseId,
        action: "create",
        after_state: expense,
      },
      notification: this.buildSharedExpenseNotification(
        users,
        context.user.id,
        groupId,
        "共同帳本已更新",
        "另一半更新了一筆支出",
        "expense",
        expenseId,
        `action:${action.id}`,
      ),
    };
  }

  private async loadCoupleUsers(context: PendingActionContext) {
    const result = await context.db
      .from("users")
      .select("id, couple_id, line_user_id, role")
      .eq("couple_id", context.user.couple_id)
      .order("role");
    if (result.error) throw new Error("users lookup failed");
    return z.array(pendingUserRowSchema).parse(result.data ?? []);
  }

  private async loadExpense(
    context: PendingActionContext,
    expenseId: string,
  ): Promise<z.infer<typeof pendingExpenseRowSchema>> {
    const result = await context.db
      .from("expenses")
      .select(
        "id, couple_id, group_id, ledger, description, merchant, notes, tag, amount_twd, paid_by_user_id, created_by_user_id, expense_date, split_method, version, deleted_at, deleted_by_user_id, mirror_kind, expense_splits(user_id, amount_twd)",
      )
      .eq("id", expenseId)
      .eq("couple_id", context.user.couple_id)
      .single();
    if (result.error) throw new StaleActionError("expense lookup failed");
    return pendingExpenseRowSchema.parse(result.data);
  }

  private async resolveSharedGroupId(
    context: PendingActionContext,
    payloadGroupId: unknown,
    actionGroupId: string | null,
  ) {
    const requestedGroupId =
      parseOptionalUuid(payloadGroupId) ??
      actionGroupId ??
      (await this.activeGroupId(context));
    const result = await context.db
      .from("groups")
      .select("id")
      .eq("id", requestedGroupId)
      .eq("couple_id", context.user.couple_id)
      .is("archived_at", null)
      .single();
    if (result.error) throw new StaleActionError("group not found");
    return pendingGroupRowSchema.parse(result.data).id;
  }

  private async activeGroupId(context: PendingActionContext) {
    const result = await context.db
      .from("user_preferences")
      .select("active_group_id")
      .eq("user_id", context.user.id)
      .single();
    if (result.error) throw new StaleActionError("active group missing");
    return z.object({ active_group_id: z.string().uuid() }).parse(result.data)
      .active_group_id;
  }

  private async validateReceipt(
    context: PendingActionContext,
    receiptId: string,
    expenseId: string | null,
  ) {
    const result = await context.db
      .from("receipts")
      .select("id")
      .eq("id", receiptId)
      .eq("owner_user_id", context.user.id)
      .eq("status", "ready")
      .or(
        expenseId
          ? `expense_id.is.null,expense_id.eq.${expenseId}`
          : "expense_id.is.null",
      )
      .single();
    if (result.error) throw new StaleActionError("receipt is no longer valid");
    return pendingReceiptRowSchema.parse(result.data);
  }

  private resolveSplits(
    rawSplits: unknown,
    amountTwd: number,
    ledger: "shared" | "private",
    paidByUserId: string,
    users: Array<z.infer<typeof pendingUserRowSchema>>,
    requesterId: string,
  ) {
    const splits = normalizeActionSplits(rawSplits);
    if (ledger === "private") {
      return { [requesterId]: amountTwd };
    }
    if (splits) {
      const total = Object.values(splits).reduce((sum, value) => sum + value, 0);
      if (
        total !== amountTwd ||
        Object.keys(splits).length !== 2 ||
        Object.entries(splits).some(
          ([userId, value]) =>
            value < 0 || !users.some((user) => user.id === userId),
        )
      ) {
        throw new StaleActionError("invalid splits");
      }
      return splits;
    }
    const otherUserId = users.find((user) => user.id !== paidByUserId)?.id;
    if (!otherUserId) throw new StaleActionError("missing partner");
    return {
      [paidByUserId]: Math.ceil(amountTwd / 2),
      [otherUserId]: Math.floor(amountTwd / 2),
    };
  }

  private async hasAnySettlement(context: PendingActionContext) {
    const result = await context.db
      .from("settlements")
      .select("id", { count: "exact", head: true })
      .eq("couple_id", context.user.couple_id);
    if (result.error) throw new Error("settlement lookup failed");
    return (result.count ?? 0) > 0;
  }

  private async loadSettlementBalanceRows(
    context: PendingActionContext,
    groupId: string,
  ) {
    const result = await context.db.rpc("group_balances", {
      p_group_id: groupId,
    });
    if (result.error) throw new Error("balance lookup failed");
    return z
      .array(
        z.object({
          user_id: z.string(),
          balance_twd: z.coerce.number().int(),
        }),
      )
      .parse(result.data)
      .map((item) => ({
        userId: item.user_id,
        balanceTwd: item.balance_twd,
      }));
  }

  private async loadGroupBalances(
    context: PendingActionContext,
    groupId: string,
  ): Promise<Record<string, number>> {
    const [expensesResult, settlementsResult] = await Promise.all([
      context.db
        .from("expenses")
        .select(
          "id, ledger, amount_twd, paid_by_user_id, created_by_user_id, expense_date, deleted_at, expense_splits(user_id, amount_twd)",
        )
        .eq("couple_id", context.user.couple_id)
        .eq("group_id", groupId)
        .eq("ledger", "shared"),
      context.db
        .from("settlements")
        .select("from_user_id, to_user_id, amount_twd")
        .eq("couple_id", context.user.couple_id)
        .eq("group_id", groupId),
    ]);
    if (expensesResult.error || settlementsResult.error) {
      throw new Error("group balance lookup failed");
    }
    const expenses = z
      .array(
        z.object({
          id: z.string().uuid(),
          ledger: z.literal("shared"),
          amount_twd: z.number().int(),
          paid_by_user_id: z.string().uuid(),
          created_by_user_id: z.string().uuid(),
          expense_date: z.string(),
          deleted_at: z.string().nullable(),
          expense_splits: z.array(
            z.object({
              user_id: z.string().uuid(),
              amount_twd: z.number().int(),
            }),
          ),
        }),
      )
      .parse(expensesResult.data ?? [])
      .map<LedgerExpense>((row) => ({
        id: row.id,
        ledger: "shared",
        amountTwd: row.amount_twd,
        paidByUserId: row.paid_by_user_id,
        createdByUserId: row.created_by_user_id,
        expenseDate: row.expense_date,
        deleted: Boolean(row.deleted_at),
        splits: Object.fromEntries(
          row.expense_splits.map((split) => [split.user_id, split.amount_twd]),
        ),
      }));
    const settlements = z
      .array(pendingSettlementRowSchema)
      .parse(settlementsResult.data ?? [])
      .map<Settlement>((row) => ({
        fromUserId: row.from_user_id,
        toUserId: row.to_user_id,
        amountTwd: row.amount_twd,
      }));
    return calculateBalances(expenses, settlements);
  }

  private buildSharedExpenseNotification(
    users: Array<z.infer<typeof pendingUserRowSchema>>,
    actorUserId: string,
    groupId: string | null,
    title: string,
    body: string,
    entityType: string,
    entityId: string,
    dedupePrefix: string,
  ) {
    if (!groupId) return null;
    const targetUser = users.find((user) => user.id !== actorUserId);
    if (!targetUser) return null;
    return {
      recipient_user_id: targetUser.id,
      group_id: groupId,
      kind: entityType === "settlement" ? "settlement" : "expense",
      title,
      body,
      entity_type: entityType,
      entity_id: entityId,
      dedupe_key: `${dedupePrefix}:user:${targetUser.id}`,
    };
  }

  async proposeAction(
    context: PendingActionContext,
    input: unknown,
    metadata?: { source?: string; idempotencyKey?: string | null },
  ) {
    const parsed = actionInputSchema.parse(input);
    if (parsed.type === "batch_create_expenses") {
      return this.proposeBatchCreateExpenses(
        context,
        parsed.expenses.map((expense) => ({ type: "create_expense", expense })),
        metadata?.idempotencyKey ?? undefined,
      );
    }
    if (parsed.type === "batch_update_expenses") {
      return this.execute(context, {
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
      return this.proposeCreateExpenseHelper(context, parsed.expense, { source, idempotencyKey });
    }
    if (parsed.type === "update_expense") {
      return this.proposeUpdateExpenseHelper(
        context,
        parsed.expenseId,
        parsed.expectedVersion,
        parsed.expense,
        { source, idempotencyKey },
      );
    }
    if (parsed.type === "delete_expense") {
      return this.proposeDeleteExpenseHelper(context, parsed.expenseId, parsed.expectedVersion, { source, idempotencyKey });
    }
    if (parsed.type === "restore_expense") {
      return this.proposeRestoreExpenseHelper(context, parsed.expenseId, parsed.expectedVersion, { source, idempotencyKey });
    }
    if (parsed.type === "settle") {
      return this.proposeSettlement(context, parsed, { source, idempotencyKey });
    }
    throw new HttpError(400, "不支援的操作");
  }

  async proposeCreateExpenseHelper(
    context: PendingActionContext,
    expenseInput: z.infer<typeof ledgerExpenseInputSchema>,
    metadata: { source: string; idempotencyKey?: string | null },
  ) {
    const users = await this.loadCoupleUsers(context);
    const partner = users.find((user) => user.id !== context.user.id);
    if (!partner) throw new HttpError(409, "請先讓另一半加入");

    if (expenseInput.ledger === "shared") {
      await this.requireGroup(context, expenseInput.groupId);
    }
    const draft = this.ledgerCommandService.buildExpenseDraft(expenseInput, {
      actorUserId: context.user.id,
      partnerUserId: partner.id,
    });
    const groupId = draft.groupId;
    const payload = expenseDraftToLegacyPayload(draft);

    const storedPayload = this.buildStoredPayload(
      { type: "create_expense", expense: expenseInput },
      payload,
      {
        source: metadata.source,
        actorUserId: context.user.id,
        idempotencyKey: metadata.idempotencyKey,
      },
    );
    return this.execute(context, {
      actionType: "create_expense",
      groupId,
      payload: storedPayload,
      sourceEventId: `${metadata.source}:${randomUUID()}`,
      idempotencyKey: metadata.idempotencyKey,
    });
  }

  async proposeUpdateExpenseHelper(
    context: PendingActionContext,
    expenseId: string,
    expectedVersion: number,
    expenseInput: z.infer<typeof ledgerExpenseInputSchema>,
    metadata: { source: string; idempotencyKey?: string | null },
  ) {
    const users = await this.loadCoupleUsers(context);
    const partner = users.find((user) => user.id !== context.user.id);
    if (!partner) throw new HttpError(409, "請先讓另一半加入");

    if (expenseInput.ledger === "shared") {
      await this.requireGroup(context, expenseInput.groupId);
    }
    await this.assertEditableExpense(context, expenseId);
    if (expenseInput.ledger === "private") {
      const check = await this.checkExpenseInSettlements(context, expenseId);
      if (check.settled) {
        throw new HttpError(409, check.message);
      }
    }

    const draft = this.ledgerCommandService.buildExpenseDraft(expenseInput, {
      actorUserId: context.user.id,
      partnerUserId: partner.id,
    });
    const groupId = draft.groupId;
    const payload = expenseDraftToLegacyPayload(draft);
    Object.assign(payload, {
      expense_id: expenseId,
      expected_version: expectedVersion,
    });

    const storedPayload = this.buildStoredPayload(
      {
        type: "update_expense",
        expenseId,
        expectedVersion,
        expense: expenseInput,
      },
      payload,
      {
        source: metadata.source,
        actorUserId: context.user.id,
        idempotencyKey: metadata.idempotencyKey,
      },
    );
    return this.execute(context, {
      actionType: "update_expense",
      groupId,
      payload: storedPayload,
      sourceEventId: `${metadata.source}:${randomUUID()}`,
      idempotencyKey: metadata.idempotencyKey,
    });
  }

  async proposeDeleteExpenseHelper(
    context: PendingActionContext,
    expenseId: string,
    expectedVersion: number,
    metadata: { source: string; idempotencyKey?: string | null },
  ) {
    const expense = await this.loadExpenseForProposal(context, expenseId);
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
    const storedPayload = this.buildStoredPayload(
      { type: "delete_expense", expenseId, expectedVersion },
      payload,
      {
        source: metadata.source,
        actorUserId: context.user.id,
        idempotencyKey: metadata.idempotencyKey,
      },
    );
    return this.execute(context, {
      actionType: "delete_expense",
      groupId: expense.group_id,
      payload: storedPayload,
      sourceEventId: `${metadata.source}:${randomUUID()}`,
      idempotencyKey: metadata.idempotencyKey,
    });
  }

  async proposeRestoreExpenseHelper(
    context: PendingActionContext,
    expenseId: string,
    expectedVersion: number,
    metadata: { source: string; idempotencyKey?: string | null },
  ) {
    const expense = await this.loadExpenseForProposal(context, expenseId);
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
    const storedPayload = this.buildStoredPayload(
      { type: "restore_expense", expenseId, expectedVersion },
      payload,
      {
        source: metadata.source,
        actorUserId: context.user.id,
        idempotencyKey: metadata.idempotencyKey,
      },
    );
    return this.execute(context, {
      actionType: "restore_expense",
      groupId: expense.group_id,
      payload: storedPayload,
      sourceEventId: `${metadata.source}:${randomUUID()}`,
      idempotencyKey: metadata.idempotencyKey,
    });
  }

  private async loadExpenseForProposal(
    context: PendingActionContext,
    expenseId: string,
  ) {
    const expenseResult = await context.db
      .from("expenses")
      .select(
        "id, group_id, ledger, description, amount_twd, version, deleted_at, created_by_user_id, mirror_kind",
      )
      .eq("id", expenseId)
      .eq("couple_id", context.user.couple_id)
      .single();
    if (expenseResult.error) throw new HttpError(404, "找不到支出");
    return z
      .object({
        id: z.string().uuid(),
        group_id: z.string().uuid().nullable(),
        ledger: z.enum(["shared", "private"]),
        description: z.string(),
        amount_twd: z.coerce.number().int(),
        version: z.number().int(),
        deleted_at: z.string().nullable(),
        created_by_user_id: z.string().uuid(),
        mirror_kind: z.enum(["shared_share"]).nullable().default(null),
      })
      .parse(expenseResult.data);
  }

  private async requireGroup(context: PendingActionContext, groupId: string | null) {
    if (!groupId) throw new HttpError(400, "請選擇群組");
    const result = await context.db
      .from("groups")
      .select("id, name")
      .eq("id", groupId)
      .eq("couple_id", context.user.couple_id)
      .is("archived_at", null)
      .single();
    if (result.error) throw new HttpError(404, "群組不存在或已封存");
    return z
      .object({ id: z.string().uuid(), name: z.string() })
      .parse(result.data);
  }

  private async checkExpenseInSettlements(
    context: PendingActionContext,
    expenseId: string,
  ): Promise<{ settled: boolean; message: string }> {
    const expense = await context.db
      .from("expenses")
      .select("id, group_id, ledger")
      .eq("id", z.string().parse(expenseId))
      .eq("couple_id", context.user.couple_id)
      .single();
    if (expense.error) throw new HttpError(404, "找不到支出");
    if (expense.data.ledger !== "shared") {
      return { settled: false, message: "" };
    }
    const settlements = await context.db
      .from("settlements")
      .select("id", { count: "exact", head: true })
      .eq("couple_id", context.user.couple_id);
    const hasSettlements =
      !settlements.error && (settlements.count ?? 0) > 0;
    return {
      settled: hasSettlements,
      message: hasSettlements
        ? "此帳已包含在結清紀錄中，無法改為私人帳。請先復原該筆結清才能修改。"
        : "",
    };
  }

  private async assertEditableExpense(context: PendingActionContext, expenseId: string) {
    const result = await context.db
      .from("expenses")
      .select("id, ledger, created_by_user_id, mirror_kind")
      .eq("id", expenseId)
      .eq("couple_id", context.user.couple_id)
      .single();
    if (result.error) throw new HttpError(404, "找不到支出");
    const expense = z
      .object({
        ledger: z.enum(["shared", "private"]),
        created_by_user_id: z.string().uuid(),
        mirror_kind: z.enum(["shared_share"]).nullable().default(null),
      })
      .parse(result.data);
    if (expense.mirror_kind)
      throw new HttpError(403, "共同分攤紀錄請修改來源共同帳");
    if (expense.ledger === "private" && expense.created_by_user_id !== context.user.id)
      throw new HttpError(403, "無權操作私人支出");
  }

  async normalizeCreateExpenseInput(
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
      const users = await this.loadCoupleUsers(context);
      const partner = users.find((user) => user.id !== context.user.id);
      selfValue = splits[context.user.id] ?? null;
      partnerValue = partner ? (splits[partner.id] ?? null) : null;
    }

    const paidBy = expenseInput.paid_by_user_id === context.user.id ? ("self" as const) : ("partner" as const);

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
      receiptId: null,
    };
  }

  async normalizeUpdateExpenseInput(
    context: PendingActionContext,
    expenseId: string,
    updates: any,
    groupIdInput: string | null | undefined,
  ) {
    const current = await this.loadExpense(context, expenseId);
    const nextLedger = updates.ledger ?? current.ledger;
    const groupId = nextLedger === "private" ? null : (current.group_id ?? groupIdInput ?? null);
    const amountTwd = updates.amount_twd ?? current.amount_twd;
    const paidByUserId = updates.paid_by_user_id ?? current.paid_by_user_id;

    const selfSplit = current.expense_splits.find((split) => split.user_id === context.user.id)?.amount_twd ?? 0;
    const partnerSplit = current.expense_splits.find((split) => split.user_id !== context.user.id)?.amount_twd ?? 0;

    let selfValue: number | null = null;
    let partnerValue: number | null = null;
    if (current.split_method !== "equal" && nextLedger !== "private") {
      selfValue = current.split_method === "percentage" ? Math.round((selfSplit / current.amount_twd) * 10000) / 100 : selfSplit;
      partnerValue = current.split_method === "percentage" ? Math.round((partnerSplit / current.amount_twd) * 10000) / 100 : partnerSplit;
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
        paidBy: paidByUserId === context.user.id ? ("self" as const) : ("partner" as const),
        expenseDate: updates.expense_date ?? current.expense_date,
        splitMethod: current.split_method,
        selfValue,
        partnerValue,
        receiptId: null,
      },
      current,
    };
  }

  async buildCreateExpenseAction(
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
    const today = taipeiToday();
    const expenseDate = params.expenseDate || today;
    const users = await this.loadCoupleUsers(context);
    const partner = users.find((u) => u.id !== context.user.id);
    if (params.ledger === "shared" && !partner) {
      throw new HttpError(409, "找不到對方用戶");
    }

    const partnerId = partner?.id ?? null;
    const splits = params.ledger === "private"
      ? { [context.user.id]: params.amountTwd }
      : {
          [context.user.id]: params.paidBy === "self" ? Math.ceil(params.amountTwd / 2) : params.amountTwd - Math.ceil(params.amountTwd / 2),
          [partnerId!]: params.paidBy === "self" ? params.amountTwd - Math.ceil(params.amountTwd / 2) : Math.ceil(params.amountTwd / 2),
        };

    const expense = {
      group_id: params.ledger === "private" ? null : params.groupId,
      ledger: params.ledger,
      description: params.description,
      merchant: params.merchant ?? null,
      notes: params.notes ?? null,
      tag: params.tag ?? "其他",
      amount_twd: params.amountTwd,
      paid_by_user_id: params.paidBy === "self" ? context.user.id : partnerId!,
      expense_date: expenseDate,
      split_method: params.splitMethod ?? "equal",
    };

    return {
      type: "create_expense" as const,
      groupId: params.groupId,
      userId: context.user.id,
      expense,
      splits,
    };
  }

  async buildUpdateExpenseAction(
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
    const expense = await this.loadExpense(context, expenseId);
    const users = await this.loadCoupleUsers(context);
    const partner = users.find((u) => u.id !== context.user.id);

    const mappedUpdates: Record<string, unknown> = {};
    if (updates.ledger) mappedUpdates.ledger = updates.ledger;
    if (updates.tag) mappedUpdates.tag = updates.tag;
    if (updates.description) mappedUpdates.description = updates.description;
    if (updates.amountTwd) mappedUpdates.amount_twd = updates.amountTwd;
    if (updates.expenseDate) mappedUpdates.expense_date = updates.expenseDate;
    if (updates.paidBy) {
      mappedUpdates.paid_by_user_id = updates.paidBy === "self"
        ? context.user.id
        : partner?.id ?? context.user.id;
    }

    return {
      type: "update_expense" as const,
      expenseId,
      expectedVersion: expense.version,
      groupId: expense.group_id,
      userId: context.user.id,
      updates: mappedUpdates,
    };
  }

  async buildSettleAction(
    context: PendingActionContext,
    groupId: string,
    amountTwd: number,
  ) {
    const balances = await this.loadSettlementBalanceRows(context, groupId);
    const me = balances.find((b) => b.userId === context.user.id);
    const myBalance = me?.balanceTwd ?? 0;

    if (myBalance >= 0) {
      throw new HttpError(400, "目前你不需要結清（沒有欠對方錢）。");
    }

    const debt = Math.abs(myBalance);
    if (amountTwd > debt) {
      throw new HttpError(400, `結清金額 NT$${amountTwd} 大於未結清金額 NT$${debt}。`);
    }

    return {
      type: "settle" as const,
      groupId,
      userId: context.user.id,
      amountTwd,
    };
  }

  async executeAgentAction(
    context: PendingActionContext,
    action: Record<string, unknown>,
  ) {
    const type = typeof action.type === "string" ? action.type : "";

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

      const standardInput = await this.normalizeCreateExpenseInput(
        context,
        expenseInput,
        action.splits,
        action.groupId ? String(action.groupId) : null,
      );

      return this.proposeCreateExpenseHelper(context, standardInput, { source: "line" });
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

      const { standardInput } = await this.normalizeUpdateExpenseInput(
        context,
        input.expenseId,
        input.updates,
        input.groupId,
      );

      return this.proposeUpdateExpenseHelper(
        context,
        input.expenseId,
        input.expectedVersion,
        standardInput,
        { source: "line" },
      );
    }

    if (type === "settle") {
      const input = createSettlementCommandSchema.parse({
        type: "settle",
        groupId: action.groupId,
        amountTwd: action.amountTwd,
      });
      return this.proposeSettlement(
        context,
        {
          type: "settle",
          groupId: input.groupId,
          amountTwd: input.amountTwd,
        },
        { source: "line", idempotencyKey: null },
      );
    }

    throw new Error(`unsupported agent action: ${type}`);
  }

  async applyConfirmedActionSideEffects(
    context: PendingActionContext,
    actionId: string,
  ) {
    const result = await context.db
      .from("pending_actions")
      .select("action_type, payload, group_id")
      .eq("id", actionId)
      .eq("couple_id", context.user.couple_id)
      .single();
    if (result.error) return;
    const row = z
      .object({
        action_type: z.string(),
        payload: z.record(z.string(), z.unknown()),
        group_id: z.string().uuid().nullable().optional(),
      })
      .parse(result.data);
    const command = pendingActionCommandFromPayload(row.payload);
    const tag =
      typeof row.payload.tag === "string"
        ? row.payload.tag
        : command?.type === "create_expense" || command?.type === "update_expense"
          ? command.expense.tag
          : null;

    if (!["create_expense", "update_expense"].includes(row.action_type) || !tag) {
      return;
    }
    const label = cleanCategoryLabel(tag);
    if (!label) return;
    const base = context.db
      .from("expenses")
      .update({ tag: label })
      .eq("couple_id", context.user.couple_id);
    const expenseId =
      typeof row.payload.expense_id === "string" ? row.payload.expense_id : null;
    const update = expenseId
      ? await base.eq("id", expenseId)
      : await base.eq("source_action_id", actionId);
    if (update.error) throw new Error("tag side effect failed");
  }
}

function actionResultErrorMessage(result: ActionResult): string {
  switch (result.result) {
    case "stale":
      return "帳目已變動，請重新操作。";
    case "expired":
      return "操作已過期，請重新再試。";
    case "cancelled":
      return "操作已取消。";
    case "not_found":
      return "找不到這個操作。";
    case "already_done":
      return "這個操作已處理。";
    default:
      return "暫時無法處理";
  }
}

function parsePositiveMoney(value: unknown) {
  return z.coerce.number().int().positive().max(100_000_000).parse(value);
}

function parseDescription(value: unknown) {
  return z.string().trim().min(1).max(100).parse(value);
}

function parseOptionalText(value: unknown, maxLength: number) {
  if (value === null || value === undefined || value === "") return null;
  return z.string().trim().max(maxLength).parse(value);
}

function parseOptionalUuid(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return z.string().parse(value);
}

function parseSplitMethod(value: unknown) {
  return z.enum(["equal", "exact", "percentage"]).catch("equal").parse(value);
}

function normalizePendingTag(value: unknown) {
  const parsed =
    typeof value === "string" && value.trim().length
      ? value.trim()
      : "其他";
  return parsed.slice(0, 40);
}

function splitEntries(expenseId: string, splits: Record<string, number>) {
  return Object.entries(splits).map(([userId, amountTwd]) => ({
    expense_id: expenseId,
    user_id: userId,
    amount_twd: amountTwd,
  }));
}

function normalizeActionSplits(value: unknown): Record<string, number> | undefined {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const userId =
          "user_id" in item && typeof item.user_id === "string" ? item.user_id : null;
        const amount =
          "amount_twd" in item && typeof item.amount_twd === "number"
            ? item.amount_twd
            : null;
        return userId && Number.isSafeInteger(amount) ? [[userId, amount]] : [];
      }),
    );
  }
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(([, amount]) => Number.isSafeInteger(amount)),
  ) as Record<string, number>;
}

function cleanCategoryLabel(value: string) {
  return value
    .normalize("NFKC")
    .replace(/nt\$?/gi, "")
    .replace(/[0-9,]+/g, "")
    .replace(/我付|你付|他付|她付|付款|付|元|塊/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 40);
}
