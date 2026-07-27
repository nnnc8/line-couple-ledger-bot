import { z } from "zod";
import {
  type PendingActionContext,
  pendingUserRowSchema,
  pendingExpenseRowSchema,
  pendingGroupRowSchema,
  StaleActionError,
} from "./pending-action-types";
import { parseOptionalUuid } from "./pending-action-utils";

export async function loadCoupleUsers(context: PendingActionContext) {
  const result = await context.db
    .from("users")
    .select("id, couple_id, line_user_id, role")
    .eq("couple_id", context.user.couple_id)
    .order("role");
  if (result.error) throw new Error("users lookup failed");
  return z.array(pendingUserRowSchema).parse(result.data ?? []);
}

export async function loadExpense(
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

export async function resolveSharedGroupId(
  context: PendingActionContext,
  payloadGroupId: unknown,
  actionGroupId: string | null,
) {
  const requestedGroupId =
    parseOptionalUuid(payloadGroupId) ??
    actionGroupId ??
    (await activeGroupId(context));
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

export async function activeGroupId(context: PendingActionContext) {
  const result = await context.db
    .from("user_preferences")
    .select("active_group_id")
    .eq("user_id", context.user.id)
    .single();
  if (result.error) throw new StaleActionError("active group missing");
  return z.object({ active_group_id: z.string().uuid() }).parse(result.data)
    .active_group_id;
}

export async function hasActiveSettlementInGroup(
  context: PendingActionContext,
  groupId: string,
) {
  const result = await context.db
    .from("settlements")
    .select("id", { count: "exact", head: true })
    .eq("couple_id", context.user.couple_id)
    .eq("group_id", groupId)
    .is("voided_at", null);
  if (result.error) throw new Error("settlement lookup failed");
  return (result.count ?? 0) > 0;
}
