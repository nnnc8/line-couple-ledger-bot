import { type PoolClient } from "pg";
import { type PendingActionPlan, type ActionResult } from "./pending-action-service";

export class TransactionStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionStaleError";
  }
}

async function insertMulti(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: Array<Record<string, any>>
) {
  if (rows.length === 0) return;
  const placeholders: string[] = [];
  const values: any[] = [];
  let index = 1;
  for (const row of rows) {
    const rowPlaceholders: string[] = [];
    for (const col of columns) {
      rowPlaceholders.push(`$${index++}`);
      values.push(row[col]);
    }
    placeholders.push(`(${rowPlaceholders.join(", ")})`);
  }
  const queryText = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders.join(", ")}`;
  await client.query(queryText, values);
}

export async function applyPendingActionPlanTx(
  client: PoolClient,
  actionId: string,
  requestedByUserId: string,
  plan: PendingActionPlan,
  nowIso: string
): Promise<ActionResult> {
  // 1. SELECT FOR UPDATE to lock the row
  const actionRes = await client.query(
    `SELECT status, expires_at, action_type 
     FROM public.pending_actions 
     WHERE id = $1 AND requested_by_user_id = $2 
     FOR UPDATE`,
    [actionId, requestedByUserId]
  );

  if (actionRes.rowCount === 0) {
    return { result: "not_found", action_type: null };
  }

  const actionRow = actionRes.rows[0]!;
  const actionType = actionRow.action_type;

  // 2. Re-check status and expiry
  if (actionRow.status !== "pending") {
    return { result: "already_done", action_type: actionType };
  }

  if (actionRow.expires_at <= nowIso) {
    await client.query(
      `UPDATE public.pending_actions 
       SET status = 'expired', processed_at = $1 
       WHERE id = $2`,
      [nowIso, actionId]
    );
    return { result: "expired", action_type: actionType };
  }

  // 3. Execute plan segments
  try {
    // insert_expenses
    if (plan.insert_expenses && plan.insert_expenses.length > 0) {
      const columns = [
        "id", "couple_id", "group_id", "ledger", "description", "merchant", "notes", "tag",
        "amount_twd", "paid_by_user_id", "created_by_user_id", "expense_date", "split_method",
        "source_action_id"
      ];
      const rows = plan.insert_expenses.map((row) => ({
        id: row.id,
        couple_id: row.couple_id,
        group_id: row.group_id ? String(row.group_id) : null,
        ledger: row.ledger,
        description: row.description,
        merchant: row.merchant ? String(row.merchant) : null,
        notes: row.notes ? String(row.notes) : null,
        tag: row.tag,
        amount_twd: row.amount_twd,
        paid_by_user_id: row.paid_by_user_id,
        created_by_user_id: row.created_by_user_id,
        expense_date: row.expense_date,
        split_method: row.split_method || "equal",
        source_action_id: row.source_action_id
      }));
      await insertMulti(client, "public.expenses", columns, rows);
    }

    // update_expenses
    if (plan.update_expenses && plan.update_expenses.length > 0) {
      for (const item of plan.update_expenses) {
        let queryText = `
          UPDATE public.expenses
          SET
            group_id = $1,
            ledger = $2,
            description = $3,
            merchant = $4,
            notes = $5,
            tag = $6,
            amount_twd = $7,
            paid_by_user_id = $8,
            expense_date = $9,
            split_method = $10,
        `;
        const params: any[] = [
          item.group_id ? String(item.group_id) : null,
          item.ledger,
          item.description,
          item.merchant ? String(item.merchant) : null,
          item.notes ? String(item.notes) : null,
          item.tag,
          item.amount_twd,
          item.paid_by_user_id,
          item.expense_date,
          item.split_method || "equal",
        ];
        let paramIndex = 11;

        if ("deleted_at" in item) {
          queryText += ` deleted_at = $${paramIndex++},`;
          params.push(item.deleted_at ? String(item.deleted_at) : null);
        }
        if ("deleted_by_user_id" in item) {
          queryText += ` deleted_by_user_id = $${paramIndex++},`;
          params.push(item.deleted_by_user_id ? String(item.deleted_by_user_id) : null);
        }

        queryText += `
            version = version + 1,
            updated_at = NOW()
          WHERE id = $${paramIndex++}
            AND couple_id = $${paramIndex++}
            AND version = $${paramIndex++}
        `;
        params.push(item.id, item.couple_id, item.expected_version);

        const res = await client.query(queryText, params);
        if (res.rowCount === 0) {
          throw new TransactionStaleError("Update stale: version mismatch or row not found");
        }
      }
    }

    // delete_expense_splits
    if (plan.delete_expense_splits && plan.delete_expense_splits.length > 0) {
      await client.query(
        `DELETE FROM public.expense_splits WHERE expense_id = ANY($1::uuid[])`,
        [plan.delete_expense_splits]
      );
    }

    // insert_expense_splits
    if (plan.insert_expense_splits && plan.insert_expense_splits.length > 0) {
      const columns = ["expense_id", "user_id", "amount_twd"];
      const rows = plan.insert_expense_splits.map((row) => ({
        expense_id: row.expense_id,
        user_id: row.user_id,
        amount_twd: row.amount_twd
      }));
      await insertMulti(client, "public.expense_splits", columns, rows);
    }

    // update_receipts
    if (plan.update_receipts && plan.update_receipts.length > 0) {
      for (const item of plan.update_receipts) {
        const res = await client.query(
          `UPDATE public.receipts
           SET expense_id = $1, group_id = $2, updated_at = NOW()
           WHERE id = $3`,
          [
            item.expense_id ? String(item.expense_id) : null,
            item.group_id ? String(item.group_id) : null,
            item.id,
          ]
        );
        if (res.rowCount === 0) {
          throw new TransactionStaleError("Receipt update stale: id not found");
        }
      }
    }

    // soft_delete_receipts_by_expense
    if (plan.soft_delete_receipts_by_expense && plan.soft_delete_receipts_by_expense.length > 0) {
      await client.query(
        `UPDATE public.receipts
         SET deleted_at = NOW(), updated_at = NOW()
         WHERE expense_id = ANY($1::uuid[])`,
        [plan.soft_delete_receipts_by_expense]
      );
    }

    // restore_receipts_by_expense
    if (plan.restore_receipts_by_expense && plan.restore_receipts_by_expense.length > 0) {
      await client.query(
        `UPDATE public.receipts
         SET deleted_at = NULL, updated_at = NOW()
         WHERE expense_id = ANY($1::uuid[])`,
        [plan.restore_receipts_by_expense]
      );
    }

    // insert_settlements
    if (plan.insert_settlements && plan.insert_settlements.length > 0) {
      const columns = [
        "id", "couple_id", "group_id", "from_user_id", "to_user_id", "amount_twd", "source_action_id"
      ];
      const rows = plan.insert_settlements.map((row) => ({
        id: row.id,
        couple_id: row.couple_id,
        group_id: row.group_id ? String(row.group_id) : null,
        from_user_id: row.from_user_id,
        to_user_id: row.to_user_id,
        amount_twd: row.amount_twd,
        source_action_id: row.source_action_id
      }));
      await insertMulti(client, "public.settlements", columns, rows);
    }

    // insert_activities
    if (plan.insert_activities && plan.insert_activities.length > 0) {
      const columns = [
        "couple_id", "group_id", "actor_user_id", "entity_type", "entity_id", "action",
        "before_state", "after_state"
      ];
      const rows = plan.insert_activities.map((row) => ({
        couple_id: row.couple_id,
        group_id: row.group_id ? String(row.group_id) : null,
        actor_user_id: row.actor_user_id,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        action: row.action,
        before_state: row.before_state ?? null,
        after_state: row.after_state ?? null
      }));
      await insertMulti(client, "public.activity_events", columns, rows);
    }

    // insert_notifications
    if (plan.insert_notifications && plan.insert_notifications.length > 0) {
      const columns = [
        "recipient_user_id", "group_id", "kind", "title", "body", "entity_type", "entity_id", "dedupe_key"
      ];
      const rows = plan.insert_notifications.map((row) => ({
        recipient_user_id: row.recipient_user_id,
        group_id: row.group_id ? String(row.group_id) : null,
        kind: row.kind,
        title: row.title,
        body: row.body,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        dedupe_key: row.dedupe_key
      }));
      await insertMulti(client, "public.notifications", columns, rows);
    }

    // 4. Update pending_actions status
    await client.query(
      `UPDATE public.pending_actions 
       SET status = 'confirmed', processed_at = NOW() 
       WHERE id = $1`,
      [actionId]
    );

    // 5. Return success result
    return {
      result: "confirmed",
      action_type: actionType,
      created_count: plan.insert_expenses?.length ?? 0
    };
  } catch (err: any) {
    if (err instanceof TransactionStaleError) {
      throw err;
    }
    const staleCodes = ["23503", "23505", "23514", "22003", "22P02"];
    if (err && staleCodes.includes(err.code)) {
      throw new TransactionStaleError(`Database constraint violation: ${err.message}`);
    }
    throw err;
  }
}
