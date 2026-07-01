import { type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { type ServerContext, type AppUser } from "./server-runtime";
import { receiptExtractionSchema } from "./ledger";
import { ledgerExpenseInputSchema } from "./ledger-core";
import { type CreateExpenseActionInput, type PendingRetargetInput } from "./pending-action-service";
import { queuePartnerNotifications, deliverNotifications as deliverNotificationMessages } from "./notification-service";
import { type AppExpense, expensesCsv as queryExpensesCsv } from "./ledger-query";
import { HttpError } from "./http-error";

export function receiptExpenseInputs(input: {
  activeGroupId: string;
  receiptId: string;
  today: string;
  extraction: z.infer<typeof receiptExtractionSchema>;
}): CreateExpenseActionInput[] {
  const items = input.extraction.items.length
    ? input.extraction.items
    : [
        {
          merchant: input.extraction.merchant,
          description: input.extraction.merchant,
          expenseDate: input.extraction.expenseDate,
          amountTwd: input.extraction.amountTwd,
        },
      ];
  const validItems = items.flatMap((item) => {
    const amountTwd = item.amountTwd;
    return Number.isSafeInteger(amountTwd) && amountTwd !== null && amountTwd > 0
      ? [{ ...item, amountTwd }]
      : [];
  });
  const receiptId = validItems.length === 1 ? input.receiptId : null;
  return validItems.map((item) => {
    const merchant = item.merchant ?? input.extraction.merchant ?? null;
    const description = item.description ?? merchant ?? "收據支出";
    const text = `${merchant ?? ""} ${description}`.toLowerCase();
    const isTransport =
      /^(enq|emf|ewx)-\d+/i.test(merchant ?? description) ||
      /停車|車資|行程|旅程|搭車|高鐵|台鐵|捷運|公車|客運|uber|taxi|計程車/i.test(text);
    return {
      type: "create_expense",
      expense: {
        ledger: "shared",
        groupId: input.activeGroupId,
        description,
        merchant,
        notes: "由 LINE 圖片辨識建立",
        tag: isTransport
          ? /停車/.test(text)
            ? "停車費"
            : "車資"
          : "其他",
        amountTwd: item.amountTwd,
        paidBy: "self",
        expenseDate: item.expenseDate ?? input.extraction.expenseDate ?? input.today,
        splitMethod: "equal",
        selfValue: null,
        partnerValue: null,
        receiptId,
      },
    };
  });
}

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

export function batchCreatePayloadFromActions(actions: CreateExpenseActionInput[]) {
  return { items: actions.map((action) => action.expense) };
}
