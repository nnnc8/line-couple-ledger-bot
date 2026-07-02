import type { PendingActionService } from "./pending-action-service";
import type { ToolContext } from "./accountant-tools";

let pendingActionServiceInstance: PendingActionService | null = null;

export function registerPendingActionService(service: PendingActionService) {
  pendingActionServiceInstance = service;
}

function getService(): PendingActionService {
  if (!pendingActionServiceInstance) {
    throw new Error("PendingActionService has not been registered");
  }
  return pendingActionServiceInstance;
}

async function getPendingActionContext(ctx: ToolContext) {
  const userResult = await ctx.db
    .from("users")
    .select("id, couple_id, line_user_id, role")
    .eq("id", ctx.userId)
    .single();
  if (userResult.error || !userResult.data) {
    throw new Error("User lookup failed");
  }
  return { db: ctx.db, user: userResult.data };
}

export async function buildCreateExpenseAction(
  ctx: ToolContext,
  params: {
    ledger: "shared" | "private";
    description: string;
    amount_twd: number;
    tag?: string;
    paid_by: "self" | "partner";
    expense_date?: string;
    merchant?: string;
    notes?: string;
    split_method?: "equal" | "exact" | "percentage";
  },
) {
  const service = getService();
  const context = await getPendingActionContext(ctx);
  return service.buildCreateExpenseAction(context, {
    ledger: params.ledger,
    groupId: ctx.groupId,
    description: params.description,
    amountTwd: params.amount_twd,
    paidBy: params.paid_by,
    tag: params.tag,
    expenseDate: params.expense_date,
    merchant: params.merchant,
    notes: params.notes,
    splitMethod: params.split_method,
  });
}

export async function buildUpdateExpenseAction(
  ctx: ToolContext,
  expenseId: string,
  updates: {
    ledger?: "shared" | "private";
    tag?: string;
    description?: string;
    amount_twd?: number;
    paid_by?: "self" | "partner";
    expense_date?: string;
  },
) {
  const service = getService();
  const context = await getPendingActionContext(ctx);
  return service.buildUpdateExpenseAction(context, expenseId, {
    ledger: updates.ledger,
    tag: updates.tag,
    description: updates.description,
    amountTwd: updates.amount_twd,
    paidBy: updates.paid_by,
    expenseDate: updates.expense_date,
  });
}

export async function buildSettleAction(
  ctx: ToolContext,
  amountTwd: number,
) {
  const service = getService();
  const context = await getPendingActionContext(ctx);
  return service.buildSettleAction(context, ctx.groupId, amountTwd);
}
