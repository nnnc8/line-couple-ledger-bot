import { type PoolClient } from "pg";
import { z } from "zod";
import { type PendingActionPlan, type ActionResult } from "./pending-action-service";
import {
  applyLedgerActionTx,
  LedgerActionStaleError,
  lockGroupLedgers,
  type PendingLedgerActionRow,
} from "./pending-action-ledger-tx";

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
  rows: Array<Record<string, unknown>>
) {
  if (rows.length === 0) return;
  const placeholders: string[] = [];
  const values: unknown[] = [];
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
    `SELECT id::text, couple_id, group_id::text, requested_by_user_id::text,
            status, expires_at, action_type, payload, request_fingerprint
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
    const result =
      actionRow.status === "expired"
        ? "expired"
        : actionRow.status === "cancelled"
          ? "cancelled"
          : "already_done";
    return { result, action_type: actionType };
  }

  const expiresAt =
    actionRow.expires_at instanceof Date
      ? actionRow.expires_at.toISOString()
      : String(actionRow.expires_at);
  if (expiresAt <= nowIso) {
    await client.query(
      `UPDATE public.pending_actions 
       SET status = 'expired', processed_at = $1 
       WHERE id = $2`,
      [nowIso, actionId]
    );
    return { result: "expired", action_type: actionType };
  }

  if (plan.expected_request_fingerprint) {
    const lockedFingerprint =
      typeof actionRow.request_fingerprint === "string"
        ? actionRow.request_fingerprint
        : null;
    if (
      lockedFingerprint &&
      lockedFingerprint !== plan.expected_request_fingerprint
    ) {
      throw new TransactionStaleError("Pending action changed before confirmation");
    }
  }

  // 3. Execute plan segments
  try {
    const groupIds = plan.lock_group_ids ?? [];
    const coupleId = Number(actionRow.couple_id);
    if (groupIds.length > 0 && !Number.isInteger(coupleId)) {
      throw new TransactionStaleError("Invalid action couple");
    }
    const lockedGroups = await lockGroupLedgers(
      client,
      coupleId,
      groupIds,
    );
    for (const groupId of plan.active_group_ids ?? []) {
      if (lockedGroups.get(groupId)?.archived_at) {
        throw new TransactionStaleError("Group archived");
      }
    }
    const settlementGuardGroupId =
      plan.reject_shared_to_private_if_settled_group_id;
    if (settlementGuardGroupId) {
      if (!lockedGroups.has(settlementGuardGroupId)) {
        throw new TransactionStaleError(
          "Shared-to-private guard requires the source group lock",
        );
      }
      const settlement = await client.query(
        `SELECT 1
           FROM public.settlements
          WHERE couple_id = $1
            AND group_id = $2::uuid
            AND voided_at IS NULL
          LIMIT 1`,
        [coupleId, settlementGuardGroupId],
      );
      if (settlement.rowCount && settlement.rowCount > 0) {
        throw new TransactionStaleError(
          "Shared settlement already exists in the locked group",
        );
      }
    }
    let effectivePlan = plan;
    let ledgerResult: Partial<ActionResult> = {};
    if (plan.ledger_action) {
      const dynamic = await applyLedgerActionTx(
        client,
        actionRow as PendingLedgerActionRow,
        lockedGroups,
        requestedByUserId,
        nowIso,
      );
      effectivePlan = {
        ...plan,
        ...dynamic.plan,
      };
      ledgerResult = dynamic.result;
    }
    // insert_expenses
    if (effectivePlan.insert_expenses && effectivePlan.insert_expenses.length > 0) {
      const columns = [
        "id", "couple_id", "group_id", "ledger", "description", "merchant", "notes", "tag",
        "amount_twd", "paid_by_user_id", "created_by_user_id", "expense_date", "split_method",
        "source_action_id"
      ];
      const rows = effectivePlan.insert_expenses.map((row) => ({
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
    if (effectivePlan.update_expenses && effectivePlan.update_expenses.length > 0) {
      for (const item of effectivePlan.update_expenses) {
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
        const params: unknown[] = [
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
    if (effectivePlan.delete_expense_splits && effectivePlan.delete_expense_splits.length > 0) {
      await client.query(
        `DELETE FROM public.expense_splits WHERE expense_id = ANY($1::uuid[])`,
        [effectivePlan.delete_expense_splits]
      );
    }

    // insert_expense_splits
    if (effectivePlan.insert_expense_splits && effectivePlan.insert_expense_splits.length > 0) {
      const columns = ["expense_id", "user_id", "amount_twd"];
      const rows = effectivePlan.insert_expense_splits.map((row) => ({
        expense_id: row.expense_id,
        user_id: row.user_id,
        amount_twd: row.amount_twd
      }));
      await insertMulti(client, "public.expense_splits", columns, rows);
    }



    // insert_settlements
    if (effectivePlan.insert_settlements && effectivePlan.insert_settlements.length > 0) {
      const columns = [
        "id", "couple_id", "group_id", "from_user_id", "to_user_id", "amount_twd", "source_action_id",
        "intent", "occurred_on", "notes"
      ];
      const rows = effectivePlan.insert_settlements.map((row) => ({
        id: row.id,
        couple_id: row.couple_id,
        group_id: row.group_id ? String(row.group_id) : null,
        from_user_id: row.from_user_id,
        to_user_id: row.to_user_id,
        amount_twd: row.amount_twd,
        source_action_id: row.source_action_id,
        intent: row.intent ?? "settle",
        occurred_on: row.occurred_on ?? new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Taipei",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(nowIso)),
        notes: row.notes ?? null,
      }));
      await insertMulti(client, "public.settlements", columns, rows);
    }

    // insert_activities
    if (effectivePlan.insert_activities && effectivePlan.insert_activities.length > 0) {
      const columns = [
        "couple_id", "group_id", "actor_user_id", "entity_type", "entity_id", "action",
        "before_state", "after_state"
      ];
      const rows = effectivePlan.insert_activities.map((row) => ({
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
    if (effectivePlan.insert_notifications && effectivePlan.insert_notifications.length > 0) {
      const columns = [
        "recipient_user_id", "group_id", "kind", "title", "body", "entity_type", "entity_id", "dedupe_key"
      ];
      const rows = effectivePlan.insert_notifications.map((row) => ({
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
      created_count: effectivePlan.insert_expenses?.length ?? 0,
      ...ledgerResult,
    };
  } catch (err: unknown) {
    if (err instanceof TransactionStaleError) {
      throw err;
    }
    if (err instanceof LedgerActionStaleError || err instanceof z.ZodError) {
      throw new TransactionStaleError(err.message);
    }
    const staleCodes = ["23503", "23505", "23514", "22003", "22P02"];
    const code =
      err && typeof err === "object" && "code" in err && typeof err.code === "string"
        ? err.code
        : null;
    if (code && staleCodes.includes(code)) {
      const message = err && typeof err === "object" && "message" in err && typeof err.message === "string"
        ? err.message
        : "unknown database error";
      throw new TransactionStaleError(`Database constraint violation: ${message}`);
    }
    throw err;
  }
}
