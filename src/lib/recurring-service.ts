import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { nextRecurringDate } from "./ledger";
import {
  LedgerCommandService,
  ledgerExpenseInputSchema,
} from "./ledger-core";
import { HttpError } from "./http-error";

const recurringInputSchema = ledgerExpenseInputSchema.extend({
  id: z.string().uuid().nullable().default(null),
  frequency: z.enum(["weekly", "monthly", "yearly"]),
  nextRunDate: z.iso.date(),
  endDate: z.iso.date().nullable().default(null),
  active: z.boolean().default(true),
});

const recurringDeleteSchema = z.object({
  operation: z.literal("delete"),
  id: z.string().uuid(),
});

const recurringToggleSchema = z.object({
  operation: z.literal("toggle"),
  id: z.string().uuid(),
  active: z.boolean(),
});

const partnerRowSchema = z.object({
  id: z.string().uuid(),
});

const recurringDeleteRowSchema = z.object({
  id: z.string().uuid(),
  group_id: z.string().uuid().nullable(),
  description: z.string(),
});

const recurringToggleRowSchema = z.object({
  id: z.string().uuid(),
  group_id: z.string().uuid().nullable(),
  active: z.boolean(),
});

const recurringRunUserSchema = z.object({
  id: z.string().uuid(),
  couple_id: z.number().int(),
  line_user_id: z.string(),
  role: z.enum(["owner", "partner"]),
});

const recurringRunRowSchema = z.object({
  id: z.string().uuid(),
  group_id: z.string().uuid().nullable(),
  created_by_user_id: z.string().uuid(),
  paid_by_user_id: z.string().uuid(),
  ledger: z.enum(["shared", "private"]),
  description: z.string(),
  amount_twd: z.coerce.number().int(),
  tag: z.string(),
  split_method: z.enum(["equal", "exact", "percentage"]),
  splits: z.record(z.string(), z.coerce.number().int()),
  next_run_date: z.iso.date(),
  frequency: z.enum(["weekly", "monthly", "yearly"]),
  anchor_day: z.coerce.number().int(),
  end_date: z.iso.date().nullable(),
});

export class RecurringService {
  private readonly ledgerCommandService: LedgerCommandService;

  constructor(input?: { ledgerCommandService?: LedgerCommandService }) {
    this.ledgerCommandService =
      input?.ledgerCommandService ?? new LedgerCommandService();
  }

  async save(
    context: {
      db: SupabaseClient;
      user: {
        id: string;
        couple_id: number;
      };
      requireGroup: (groupId: string | null) => Promise<unknown>;
      appendActivity: (
        entityId: string,
        action: "create" | "update" | "delete",
        groupId: string | null,
        beforeState: unknown,
        afterState: unknown,
      ) => Promise<void>;
      notifyPartner: (
        title: string,
        body: string,
        groupId: string | null,
        entityId: string,
      ) => Promise<void>;
      deliverNotifications: () => Promise<void>;
    },
    input: unknown,
  ): Promise<{ ok: true }> {
    const deleteOp = recurringDeleteSchema.safeParse(input);
    if (deleteOp.success) {
      return this.deleteRecurring(context, deleteOp.data.id);
    }

    const toggleOp = recurringToggleSchema.safeParse(input);
    if (toggleOp.success) {
      return this.toggleRecurring(context, toggleOp.data.id, toggleOp.data.active);
    }

    const parsed = recurringInputSchema.parse(input);
    return this.upsertRecurring(context, parsed);
  }

  async runDue<Env>(context: {
    env: Env;
    db: SupabaseClient;
    today: string;
    executePendingAction: (
      context: {
        env: Env;
        db: SupabaseClient;
        user: z.infer<typeof recurringRunUserSchema>;
      },
      input: {
        actionType: string;
        groupId: string | null;
        payload: Record<string, unknown>;
        sourceEventId: string;
        idempotencyKey: string;
      },
    ) => Promise<unknown>;
    logError?: (recurringId: string, error: unknown) => void;
  }) {
    const due = await context.db
      .from("recurring_expenses")
      .select("*")
      .eq("active", true)
      .lte("next_run_date", context.today);
    if (due.error) throw new Error("recurring lookup failed");

    let drafts = 0;
    for (const rawRow of due.data ?? []) {
      const row = recurringRunRowSchema.parse(rawRow);
      const source = `recurring:${row.id}:${row.next_run_date}`;
      const requesterResult = await context.db
        .from("users")
        .select("id, couple_id, line_user_id, role")
        .eq("id", row.created_by_user_id)
        .single();
      const requester = recurringRunUserSchema.safeParse(requesterResult.data);
      if (requesterResult.error || !requester.success) continue;

      try {
        await context.executePendingAction(
          { env: context.env, db: context.db, user: requester.data },
          {
            actionType: "create_expense",
            groupId: row.group_id,
            payload: {
              group_id: row.group_id,
              ledger: row.ledger,
              description: row.description,
              amount_twd: row.amount_twd,
              paid_by_user_id: row.paid_by_user_id,
              expense_date: row.next_run_date,
              tag: row.tag,
              split_method: row.split_method,
              splits: row.splits,
            },
            sourceEventId: source,
            idempotencyKey: source,
          },
        );
        drafts += 1;
      } catch (error) {
        context.logError?.(row.id, error);
        continue;
      }

      const next = nextRecurringDate(
        row.next_run_date,
        row.frequency,
        row.anchor_day,
      );
      await context.db
        .from("recurring_expenses")
        .update({
          next_run_date: next,
          active: !row.end_date || next <= row.end_date,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      await context.db.from("notifications").upsert(
        {
          recipient_user_id: row.created_by_user_id,
          group_id: row.group_id,
          kind: "recurring",
          title: "週期支出已自動入帳",
          body: `${row.description} NT$${row.amount_twd}`,
          entity_type: "recurring",
          entity_id: row.id,
          dedupe_key: source,
        },
        { onConflict: "dedupe_key", ignoreDuplicates: true },
      );
    }

    return drafts;
  }

  private async deleteRecurring(
    context: {
      db: SupabaseClient;
      user: { id: string; couple_id: number };
      appendActivity: (
        entityId: string,
        action: "delete",
        groupId: string | null,
        beforeState: unknown,
        afterState: unknown,
      ) => Promise<void>;
      notifyPartner: (
        title: string,
        body: string,
        groupId: string | null,
        entityId: string,
      ) => Promise<void>;
      deliverNotifications: () => Promise<void>;
    },
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

  private async toggleRecurring(
    context: {
      db: SupabaseClient;
      user: { id: string; couple_id: number };
      appendActivity: (
        entityId: string,
        action: "update",
        groupId: string | null,
        beforeState: unknown,
        afterState: unknown,
      ) => Promise<void>;
      notifyPartner: (
        title: string,
        body: string,
        groupId: string | null,
        entityId: string,
      ) => Promise<void>;
      deliverNotifications: () => Promise<void>;
    },
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

  private async upsertRecurring(
    context: {
      db: SupabaseClient;
      user: { id: string; couple_id: number };
      requireGroup: (groupId: string | null) => Promise<unknown>;
      appendActivity: (
        entityId: string,
        action: "create" | "update",
        groupId: string | null,
        beforeState: unknown,
        afterState: unknown,
      ) => Promise<void>;
      notifyPartner: (
        title: string,
        body: string,
        groupId: string | null,
        entityId: string,
      ) => Promise<void>;
      deliverNotifications: () => Promise<void>;
    },
    parsed: z.infer<typeof recurringInputSchema>,
  ): Promise<{ ok: true }> {
    const partner = await this.loadPartner(context.db, context.user);
    if (parsed.ledger === "shared") {
      await context.requireGroup(parsed.groupId);
    }

    const draft = this.ledgerCommandService.buildExpenseDraft(parsed, {
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

  private async loadPartner(
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
}
