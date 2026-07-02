import { type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { type ServerContext } from "./server-runtime";
import { queuePartnerNotifications, deliverNotifications as deliverNotificationMessages } from "./notification-service";
import { type AppExpense, expensesCsv as queryExpensesCsv } from "./ledger-query";
import { HttpError } from "./http-error";

export async function requireGroup(context: ServerContext, groupId: string | null) {
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

export async function appendActivity(
  context: ServerContext,
  entityType: "group" | "recurring",
  entityId: string,
  action: "create" | "update" | "delete" | "restore" | "archive" | "settle",
  groupId: string | null,
  beforeState: unknown,
  afterState: unknown,
) {
  const result = await context.db.from("activity_events").insert({
    couple_id: context.user.couple_id,
    group_id: groupId,
    actor_user_id: context.user.id,
    entity_type: entityType,
    entity_id: entityId,
    action,
    before_state: beforeState,
    after_state: afterState,
  });
  if (result.error) throw new Error("activity insert failed");
}

export async function notifyPartner(
  context: ServerContext,
  kind: "recurring",
  title: string,
  body: string,
  groupId: string | null,
  entityType: string,
  entityId: string,
) {
  return queuePartnerNotifications(context, {
    kind,
    title,
    body,
    groupId,
    entityType,
    entityId,
  });
}

export function taipeiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function shiftMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year!, monthNumber! - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function deliverNotifications(context: ServerContext) {
  return deliverNotificationMessages(context);
}

export function expensesCsv(
  expenses: AppExpense[],
  users: Array<{ id: string; label: string }>,
): string {
  return queryExpensesCsv(expenses, users);
}


