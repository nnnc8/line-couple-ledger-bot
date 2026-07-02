import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  type PendingActionContext,
  type PendingActionPlan,
  pendingActionRowSchema,
  pendingUserRowSchema,
  pendingExpenseRowSchema,
  pendingSettlementRowSchema,
  StaleActionError,
} from "./pending-action-types";
import {
  loadCoupleUsers,
  loadExpense,
  resolveSharedGroupId,
  hasAnySettlement,
} from "./pending-action-loaders";
import {
  parsePositiveMoney,
  parseDescription,
  parseOptionalText,
  parseSplitMethod,
  normalizePendingTag,
  splitEntries,
  normalizeActionSplits,
} from "./pending-action-utils";
import { calculateBalances, type LedgerExpense, type Settlement } from "./ledger";

export async function buildConfirmPlan(
  context: PendingActionContext,
  action: z.infer<typeof pendingActionRowSchema>,
): Promise<PendingActionPlan> {
  if (action.action_type === "create_expense") {
    return buildCreateExpensePlan(context, action, action.payload);
  }
  if (action.action_type === "update_expense") {
    return buildUpdateExpensePlan(context, action);
  }
  if (action.action_type === "delete_expense") {
    return buildDeleteRestorePlan(context, action, "delete");
  }
  if (action.action_type === "restore_expense") {
    return buildDeleteRestorePlan(context, action, "restore");
  }
  if (action.action_type === "settle") {
    return buildSettlementPlan(context, action);
  }
  if (action.action_type === "batch_create_expenses") {
    return buildBatchCreatePlan(context, action);
  }
  if (action.action_type === "batch_update_expenses") {
    return buildBatchUpdatePlan(context, action);
  }
  throw new StaleActionError("unsupported action");
}

export async function buildCreateExpensePlan(
  context: PendingActionContext,
  action: z.infer<typeof pendingActionRowSchema>,
  payload: Record<string, unknown>,
): Promise<PendingActionPlan> {
  const users = await loadCoupleUsers(context);
  const item = await planExpenseInsert(context, action, payload, users);
  return {
    insert_expenses: [item.expense],
    insert_expense_splits: item.splits,
    insert_activities: [item.activity],
    ...(item.notification ? { insert_notifications: [item.notification] } : {}),
  };
}

export async function buildUpdateExpensePlan(
  context: PendingActionContext,
  action: z.infer<typeof pendingActionRowSchema>,
): Promise<PendingActionPlan> {
  const expenseId = z.string().uuid().parse(action.payload.expense_id);
  const expectedVersion = z.coerce
    .number()
    .int()
    .positive()
    .parse(action.payload.expected_version);
  const users = await loadCoupleUsers(context);
  const current = await loadExpense(context, expenseId);
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
    (await hasAnySettlement(context))
  ) {
    throw new StaleActionError("shared settlement already exists");
  }
  const groupId =
    nextLedger === "private"
      ? null
      : await resolveSharedGroupId(
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
  const splits = resolveSplits(
    action.payload.splits,
    amountTwd,
    nextLedger,
    paidByUserId,
    users,
    context.user.id,
  );
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
    ...(buildSharedExpenseNotification(
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
            buildSharedExpenseNotification(
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

export async function buildDeleteRestorePlan(
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
  const current = await loadExpense(context, expenseId);
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
    current.group_id === null ? [] : await loadCoupleUsers(context);
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
    ...(buildSharedExpenseNotification(
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
            buildSharedExpenseNotification(
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

export async function buildSettlementPlan(
  context: PendingActionContext,
  action: z.infer<typeof pendingActionRowSchema>,
): Promise<PendingActionPlan> {
  const groupId = await resolveSharedGroupId(
    context,
    action.payload.group_id,
    action.group_id,
  );
  const users = await loadCoupleUsers(context);
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
  const balances = await loadComputedGroupBalances(context, groupId);
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
    ...(buildSharedExpenseNotification(
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
            buildSharedExpenseNotification(
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

export async function buildBatchCreatePlan(
  context: PendingActionContext,
  action: z.infer<typeof pendingActionRowSchema>,
): Promise<PendingActionPlan> {
  const items = z.array(z.record(z.string(), z.unknown())).min(1).max(50).parse(
    action.payload.items,
  );
  const users = await loadCoupleUsers(context);
  const insertExpenses: Array<Record<string, unknown>> = [];
  const insertExpenseSplits: Array<Record<string, unknown>> = [];
  const insertActivities: Array<Record<string, unknown>> = [];
  const plan: PendingActionPlan = {
    insert_expenses: insertExpenses,
    insert_expense_splits: insertExpenseSplits,
    insert_activities: insertActivities,
  };
  let notificationGroupId: string | null = null;
  for (const payload of items) {
    const item = await planExpenseInsert(context, action, payload, users);
    insertExpenses.push(item.expense);
    insertExpenseSplits.push(...item.splits);
    insertActivities.push(item.activity);
    notificationGroupId ??= item.expense.group_id as string | null;
  }
  if (!insertExpenses.length) {
    throw new StaleActionError("empty batch");
  }
  const notification = buildSharedExpenseNotification(
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

export async function buildBatchUpdatePlan(
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
  const users = await loadCoupleUsers(context);
  const updateExpenses: Array<Record<string, unknown>> = [];
  const insertActivities: Array<Record<string, unknown>> = [];
  const plan: PendingActionPlan = {
    update_expenses: updateExpenses,
    insert_activities: insertActivities,
  };
  for (const update of updates) {
    const current = await loadExpense(context, update.expense_id);
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
  const notification = buildSharedExpenseNotification(
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

export async function planExpenseInsert(
  context: PendingActionContext,
  action: z.infer<typeof pendingActionRowSchema>,
  payload: Record<string, unknown>,
  users: Array<z.infer<typeof pendingUserRowSchema>>,
) {
  const ledger = z.enum(["shared", "private"]).parse(payload.ledger);
  const groupId =
    ledger === "private"
      ? null
      : await resolveSharedGroupId(context, payload.group_id, action.group_id);
  const amountTwd = parsePositiveMoney(payload.amount_twd);
  const paidByUserId = z.string().parse(payload.paid_by_user_id);
  if (!users.some((user) => user.id === paidByUserId)) {
    throw new StaleActionError("payer is not in couple");
  }
  if (ledger === "private" && paidByUserId !== context.user.id) {
    throw new StaleActionError("private payer mismatch");
  }
  const expenseId = randomUUID();
  const splits = resolveSplits(
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
    activity: {
      couple_id: context.user.couple_id,
      group_id: groupId,
      actor_user_id: context.user.id,
      entity_type: "expense",
      entity_id: expenseId,
      action: "create",
      after_state: expense,
    },
    notification: buildSharedExpenseNotification(
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

export function buildSharedExpenseNotification(
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

export async function loadComputedGroupBalances(
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

function resolveSplits(
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
