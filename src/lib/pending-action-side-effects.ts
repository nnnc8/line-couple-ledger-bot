import { z } from "zod";
import type { PendingActionContext } from "./pending-action-types";
import { pendingActionCommandFromPayload } from "./ledger-core";
import { cleanCategoryLabel } from "./pending-action-utils";

export async function applyConfirmedActionSideEffects(
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
