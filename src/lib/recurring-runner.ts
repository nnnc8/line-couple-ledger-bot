import { nextRecurringDate } from "./ledger";
import {
  recurringRunRowSchema,
  recurringRunUserSchema,
  type RecurringRunContext,
} from "./recurring-types";

export const recurringRunnerHandler = {
  runDueRecurring: async <Env>(
    context: RecurringRunContext<Env>,
  ): Promise<number> => {
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
};
