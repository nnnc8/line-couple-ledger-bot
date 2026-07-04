import { z } from "zod";
import { HttpError } from "./http-error";
import type { RecurringService } from "./recurring-service";
import {
  recurringInputSchema,
  recurringDeleteSchema,
  recurringToggleSchema,
  partnerRowSchema,
  recurringDeleteRowSchema,
  recurringToggleRowSchema,
  type RecurringSaveContext,
} from "./recurring-types";
import type { SupabaseClient } from "@supabase/supabase-js";

async function deleteRecurring(
  context: RecurringSaveContext,
  recurringId: string,
): Promise<{ ok: true }> {
  const beforeResult = await context.db
    .from("recurring_expenses")
    .select("id, group_id, description")
    .eq("id", recurringId)
    .eq("couple_id", context.user.couple_id)
    .single();
  if (beforeResult.error || !beforeResult.data) {
    throw new HttpError(404, "Not found");
  }
  const before = recurringDeleteRowSchema.parse(beforeResult.data);

  const result = await context.db
    .from("recurring_expenses")
    .delete()
    .eq("id", recurringId)
    .eq("couple_id", context.user.couple_id);
  if (result.error) throw new Error("recurring delete failed");

  await context.appendActivity(
    recurringId,
    "delete",
    before.group_id,
    before,
    null,
  );
  await context.notifyPartner(
    "週期支出已刪除",
    `已刪除週期支出：「${before.description}」`,
    before.group_id,
    recurringId,
  );
  await context.deliverNotifications();
  return { ok: true };
}

async function toggleRecurring(
  context: RecurringSaveContext,
  recurringId: string,
  active: boolean,
): Promise<{ ok: true }> {
  const beforeResult = await context.db
    .from("recurring_expenses")
    .select("id, group_id, active")
    .eq("id", recurringId)
    .eq("couple_id", context.user.couple_id)
    .single();
  if (beforeResult.error || !beforeResult.data) {
    throw new HttpError(404, "Not found");
  }
  const before = recurringToggleRowSchema.parse(beforeResult.data);

  const result = await context.db
    .from("recurring_expenses")
    .update({
      active,
      updated_at: new Date().toISOString(),
    })
    .eq("id", recurringId)
    .eq("couple_id", context.user.couple_id);
  if (result.error) throw new Error("recurring update failed");

  await context.appendActivity(
    recurringId,
    "update",
    before.group_id,
    before,
    { operation: "toggle", id: recurringId, active },
  );
  await context.notifyPartner(
    "週期支出已更新",
    active ? "已啟用週期支出" : "已停用週期支出",
    before.group_id,
    recurringId,
  );
  await context.deliverNotifications();
  return { ok: true };
}

async function upsertRecurring(
  service: RecurringService,
  context: RecurringSaveContext,
  parsed: z.infer<typeof recurringInputSchema>,
): Promise<{ ok: true }> {
  const partner = await loadPartner(context.db, context.user);
  if (parsed.ledger === "shared") {
    await context.requireGroup(parsed.groupId);
  }

  const draft = service.ledgerCommandService.buildExpenseDraft(parsed, {
    actorUserId: context.user.id,
    partnerUserId: partner.id,
  });
  const row = {
    couple_id: context.user.couple_id,
    group_id: draft.groupId,
    created_by_user_id: context.user.id,
    paid_by_user_id: draft.paidByUserId,
    ledger: parsed.ledger,
    description: parsed.description,
    tag: parsed.tag,
    amount_twd: parsed.amountTwd,
    split_method: parsed.splitMethod,
    splits: draft.splits,
    frequency: parsed.frequency,
    anchor_day: Number(parsed.nextRunDate.slice(8, 10)),
    next_run_date: parsed.nextRunDate,
    end_date: parsed.endDate,
    active: parsed.active,
    updated_at: new Date().toISOString(),
  };

  const result = parsed.id
    ? await context.db
        .from("recurring_expenses")
        .update(row)
        .eq("id", parsed.id)
        .eq("created_by_user_id", context.user.id)
        .select("id")
        .single()
    : await context.db
        .from("recurring_expenses")
        .insert(row)
        .select("id")
        .single();
  if (result.error) throw new Error("recurring save failed");

  const recurringId = String(result.data.id);
  await context.appendActivity(
    recurringId,
    parsed.id ? "update" : "create",
    draft.groupId,
    null,
    row,
  );
  await context.notifyPartner(
    "週期支出已更新",
    `${parsed.description} NT$${parsed.amountTwd}`,
    draft.groupId,
    recurringId,
  );
  await context.deliverNotifications();
  return { ok: true };
}

async function loadPartner(
  db: SupabaseClient,
  user: { id: string; couple_id: number },
) {
  const result = await db
    .from("users")
    .select("id")
    .eq("couple_id", user.couple_id)
    .neq("id", user.id)
    .maybeSingle();
  if (result.error) throw new Error("users lookup failed");
  if (!result.data) throw new HttpError(409, "請先讓另一半加入");
  return partnerRowSchema.parse(result.data);
}

export const recurringSaveHandler = {
  saveRecurring: async (
    service: RecurringService,
    context: RecurringSaveContext,
    input: unknown,
  ): Promise<{ ok: true }> => {
    const deleteOp = recurringDeleteSchema.safeParse(input);
    if (deleteOp.success) {
      return deleteRecurring(context, deleteOp.data.id);
    }

    const toggleOp = recurringToggleSchema.safeParse(input);
    if (toggleOp.success) {
      return toggleRecurring(context, toggleOp.data.id, toggleOp.data.active);
    }

    const parsed = recurringInputSchema.parse(input);
    return upsertRecurring(service, context, parsed);
  }
};
