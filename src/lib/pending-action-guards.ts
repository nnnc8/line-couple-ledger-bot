/**
 * pending-action-guards — proposal-time read-side checks.
 *
 * These functions encapsulate "can this user do this?" against the
 * `pending_actions` lifecycle. They never write to `pending_actions`
 * or any ledger table; they only throw `HttpError` (or return parsed
 * data) so the proposal flow can short-circuit cleanly.
 *
 * Keeping them in their own file means a future change to "private
 * expense is editable by who" or "shared->private is allowed when"
 * touches one small file, not the main service.
 */
import { z } from "zod";

import { HttpError } from "./http-error";
import type { PendingActionContext } from "./pending-action-types";

const expenseForProposalSchema = z.object({
  id: z.string().uuid(),
  group_id: z.string().uuid().nullable(),
  ledger: z.enum(["shared", "private"]),
  description: z.string(),
  amount_twd: z.coerce.number().int(),
  version: z.number().int(),
  deleted_at: z.string().nullable(),
  created_by_user_id: z.string().uuid(),
  mirror_kind: z.enum(["shared_share"]).nullable().default(null),
});

const editableExpenseSchema = z.object({
  ledger: z.enum(["shared", "private"]),
  created_by_user_id: z.string().uuid(),
  mirror_kind: z.enum(["shared_share"]).nullable().default(null),
});

const groupSchema = z.object({ id: z.string().uuid(), name: z.string() });

/**
 * Load a single expense with the full shape the proposal guards need.
 * Throws 404 if the row is missing or belongs to a different couple.
 */
export async function loadExpenseForProposal(
  context: PendingActionContext,
  expenseId: string,
) {
  const result = await context.db
    .from("expenses")
    .select(
      "id, group_id, ledger, description, amount_twd, version, deleted_at, created_by_user_id, mirror_kind",
    )
    .eq("id", expenseId)
    .eq("couple_id", context.user.couple_id)
    .single();
  if (result.error) throw new HttpError(404, "找不到支出");
  return expenseForProposalSchema.parse(result.data);
}

/**
 * Verify a group exists, belongs to this couple, and is not archived.
 * Returns the parsed row so the caller can use the `name` if it wants.
 */
export async function requireGroup(
  context: PendingActionContext,
  groupId: string | null,
) {
  if (!groupId) throw new HttpError(400, "請選擇群組");
  const result = await context.db
    .from("groups")
    .select("id, name")
    .eq("id", groupId)
    .eq("couple_id", context.user.couple_id)
    .is("archived_at", null)
    .single();
  if (result.error) throw new HttpError(404, "群組不存在或已封存");
  return groupSchema.parse(result.data);
}

/**
 * For a shared->private conversion: if any settlement exists for this
 * couple, refuse. The settled picture would silently disagree with the
 * new private ledger, so the user must restore the settlement first.
 */
export async function checkExpenseInSettlements(
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

/**
 * Lightweight editability check for `update_expense`:
 *   - mirror expenses must be edited at the source
 *   - private expenses only by their creator
 * (Shared expenses have no extra ownership check beyond couple scoping.)
 */
export async function assertEditableExpense(
  context: PendingActionContext,
  expenseId: string,
) {
  const result = await context.db
    .from("expenses")
    .select("id, ledger, created_by_user_id, mirror_kind")
    .eq("id", expenseId)
    .eq("couple_id", context.user.couple_id)
    .single();
  if (result.error) throw new HttpError(404, "找不到支出");
  const expense = editableExpenseSchema.parse(result.data);
  if (expense.mirror_kind)
    throw new HttpError(403, "共同分攤紀錄請修改來源共同帳");
  if (expense.ledger === "private" && expense.created_by_user_id !== context.user.id)
    throw new HttpError(403, "無權操作私人支出");
}
