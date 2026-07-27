import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";

import {
  createSettlementCommandSchema,
  pendingActionCommandFromPayload,
  transferCommandSchema,
  type TransferDirection,
  voidSettlementCommandSchema,
} from "./ledger-core";
import type { ActionResult, PendingActionPlan } from "./pending-action-types";

export class LedgerActionStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerActionStaleError";
  }
}

export interface LockedGroupLedger {
  id: string;
  name: string;
  archived_at: string | null;
}

export interface PendingLedgerActionRow {
  id: string;
  couple_id: number;
  group_id: string | null;
  action_type: string;
  payload: Record<string, unknown>;
}

interface LedgerActionTxResult {
  plan: Pick<PendingActionPlan, "insert_activities" | "insert_notifications">;
  result: Pick<
    ActionResult,
    "settlement_id" | "settlement_version" | "balance"
  >;
}

const userRowSchema = z.object({ id: z.string().uuid() });

export async function lockGroupLedger(
  client: PoolClient,
  coupleId: number,
  groupId: string,
): Promise<LockedGroupLedger> {
  const result = await client.query(
    `SELECT id::text, name, archived_at
       FROM public.groups
      WHERE id = $1::uuid AND couple_id = $2
      FOR UPDATE`,
    [groupId, coupleId],
  );
  if (result.rowCount !== 1) {
    throw new LedgerActionStaleError("group unavailable");
  }
  return z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      archived_at: z.coerce.string().nullable(),
    })
    .parse(result.rows[0]);
}

export async function lockGroupLedgers(
  client: PoolClient,
  coupleId: number,
  groupIds: string[],
): Promise<Map<string, LockedGroupLedger>> {
  const groups = new Map<string, LockedGroupLedger>();
  for (const groupId of [...new Set(groupIds)].sort()) {
    groups.set(groupId, await lockGroupLedger(client, coupleId, groupId));
  }
  return groups;
}

async function loadCoupleUsers(
  client: PoolClient,
  coupleId: number,
  requesterId: string,
) {
  const result = await client.query(
    `SELECT id::text
       FROM public.users
      WHERE couple_id = $1
      ORDER BY role`,
    [coupleId],
  );
  const users = z.array(userRowSchema).parse(result.rows);
  const requester = users.find((user) => user.id === requesterId);
  const partner = users.find((user) => user.id !== requesterId);
  if (!requester || !partner || users.length !== 2) {
    throw new LedgerActionStaleError("couple users unavailable");
  }
  return { requester, partner };
}

async function loadBalanceMap(client: PoolClient, groupId: string) {
  const result = await client.query(
    `SELECT user_id::text, balance_twd
       FROM public.group_balances($1::uuid)`,
    [groupId],
  );
  const balances: Record<string, number> = {};
  for (const row of result.rows) {
    const userId = z.string().uuid().parse(row.user_id);
    const balance = Number(row.balance_twd);
    if (!Number.isSafeInteger(balance)) {
      throw new Error("group balance exceeds safe integer range");
    }
    balances[userId] = balance;
  }
  return balances;
}

function resolveUsers(
  direction: TransferDirection,
  requesterId: string,
  partnerId: string,
) {
  return direction === "me_to_partner"
    ? { fromUserId: requesterId, toUserId: partnerId }
    : { fromUserId: partnerId, toUserId: requesterId };
}

function actionNotification(
  action: PendingLedgerActionRow,
  partnerId: string,
  groupId: string,
  title: string,
  body: string,
  settlementId: string,
) {
  return {
    recipient_user_id: partnerId,
    group_id: groupId,
    kind: "settlement",
    title,
    body,
    entity_type: "settlement",
    entity_id: settlementId,
    dedupe_key: `action:${action.id}:user:${partnerId}`,
  };
}

function balanceResult(
  groupId: string,
  before: Record<string, number>,
  after: Record<string, number>,
) {
  return {
    group_id: groupId,
    before_by_user_id: before,
    after_by_user_id: after,
  };
}

function taipeiToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function applyTransferOrSettlement(
  client: PoolClient,
  action: PendingLedgerActionRow,
  groups: Map<string, LockedGroupLedger>,
  requestedByUserId: string,
): Promise<LedgerActionTxResult> {
  const stored = pendingActionCommandFromPayload(action.payload);
  const isTransfer = action.action_type === "transfer";
  const parsedCommand = isTransfer
    ? transferCommandSchema.parse(stored)
    : stored?.type === "settle"
      ? createSettlementCommandSchema.parse(stored)
      : createSettlementCommandSchema.parse({
          type: "settle",
          groupId: action.group_id ?? action.payload.group_id,
          direction: action.payload.direction,
          amountTwd: action.payload.amount_twd,
        });
  const legacyFullSettlement =
    parsedCommand.type === "settle" && parsedCommand.amountTwd === undefined;
  const command = legacyFullSettlement
    ? createSettlementCommandSchema.parse({
        ...parsedCommand,
        amountTwd: action.payload.amount_twd,
      })
    : parsedCommand;
  if (isTransfer !== (command.type === "transfer")) {
    throw new LedgerActionStaleError("action type mismatch");
  }
  if (command.groupId !== action.group_id || !groups.has(command.groupId)) {
    throw new LedgerActionStaleError("group mismatch");
  }
  const group = groups.get(command.groupId)!;
  if (group.archived_at) {
    throw new LedgerActionStaleError("group archived");
  }
  const { requester, partner } = await loadCoupleUsers(
    client,
    action.couple_id,
    requestedByUserId,
  );
  const direction = command.direction ?? "me_to_partner";
  const { fromUserId, toUserId } = resolveUsers(
    direction,
    requester.id,
    partner.id,
  );
  const before = await loadBalanceMap(client, command.groupId);
  const debt = -(before[fromUserId] ?? 0);
  const amountTwd =
    command.type === "settle"
      ? z.number().int().positive().parse(command.amountTwd)
      : command.amountTwd;
  const settleAll =
    command.type === "settle" &&
    (action.payload.settle_all === true || legacyFullSettlement);
  const expectedBalanceTwd = settleAll
    ? z.coerce.number().int().parse(action.payload.expected_balance_twd)
    : null;
  if (
    command.type === "settle" &&
    (debt <= 0 ||
      (before[toUserId] ?? 0) !== debt ||
      amountTwd > debt ||
      (settleAll &&
        ((before[fromUserId] ?? 0) !== expectedBalanceTwd || amountTwd !== debt)))
  ) {
    throw new LedgerActionStaleError("stale settlement balance");
  }
  const settlementId = randomUUID();
  const intent = command.type === "transfer" ? "transfer" : "settle";
  const occurredOn =
    command.type === "transfer" ? command.occurredOn : taipeiToday();
  const notes = command.type === "transfer" ? command.notes?.trim() || null : null;
  const inserted = await client.query(
    `INSERT INTO public.settlements (
       id, couple_id, group_id, from_user_id, to_user_id, amount_twd,
       source_action_id, intent, occurred_on, notes
     ) VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7::uuid, $8, $9::date, $10)
     RETURNING version`,
    [
      settlementId,
      action.couple_id,
      command.groupId,
      fromUserId,
      toUserId,
      amountTwd,
      action.id,
      intent,
      occurredOn,
      notes,
    ],
  );
  const version = z.coerce.number().int().positive().parse(inserted.rows[0]?.version);
  const after = await loadBalanceMap(client, command.groupId);
  const fullSettlement = intent === "settle" && amountTwd === debt;
  const title = fullSettlement ? `${group.name}帳務已結清` : "轉帳入帳";
  const body =
    direction === "partner_to_me"
      ? `另一半記錄你轉出 NT$${amountTwd.toLocaleString()}。若內容有誤，可以從轉帳流水撤銷。`
      : fullSettlement
        ? `${group.name}帳務已結清｜收到 NT$${amountTwd.toLocaleString()}`
        : `另一半記錄已轉給你 NT$${amountTwd.toLocaleString()}｜${group.name}`;
  const state = {
    direction,
    intent,
    from_user_id: fromUserId,
    to_user_id: toUserId,
    amount_twd: amountTwd,
    occurred_on: occurredOn,
    notes,
  };
  return {
    plan: {
      insert_activities: [
        {
          couple_id: action.couple_id,
          group_id: command.groupId,
          actor_user_id: requestedByUserId,
          entity_type: "settlement",
          entity_id: settlementId,
          action: intent === "settle" ? "settle" : "create",
          before_state: { ...state, balance_by_user_id: before },
          after_state: { ...state, version, balance_by_user_id: after },
        },
      ],
      insert_notifications: [
        actionNotification(
          action,
          partner.id,
          command.groupId,
          title,
          body,
          settlementId,
        ),
      ],
    },
    result: {
      settlement_id: settlementId,
      settlement_version: version,
      balance: balanceResult(command.groupId, before, after),
    },
  };
}

async function applyVoidSettlement(
  client: PoolClient,
  action: PendingLedgerActionRow,
  groups: Map<string, LockedGroupLedger>,
  requestedByUserId: string,
  nowIso: string,
): Promise<LedgerActionTxResult> {
  const command = voidSettlementCommandSchema.parse(
    pendingActionCommandFromPayload(action.payload),
  );
  const candidate = await client.query(
    `SELECT id::text, couple_id, group_id::text, from_user_id::text,
            to_user_id::text, amount_twd, intent, occurred_on::text, notes,
            voided_at, version
       FROM public.settlements
      WHERE id = $1::uuid AND couple_id = $2
      FOR UPDATE`,
    [command.settlementId, action.couple_id],
  );
  if (candidate.rowCount !== 1) {
    throw new LedgerActionStaleError("settlement unavailable");
  }
  const settlement = z
    .object({
      id: z.string().uuid(),
      couple_id: z.number().int(),
      group_id: z.string().uuid(),
      from_user_id: z.string().uuid(),
      to_user_id: z.string().uuid(),
      amount_twd: z.coerce.number().int().positive(),
      intent: z.enum(["settle", "transfer"]),
      occurred_on: z.iso.date(),
      notes: z.string().nullable(),
      voided_at: z.coerce.string().nullable(),
      version: z.number().int().positive(),
    })
    .parse(candidate.rows[0]);
  if (
    settlement.group_id !== action.group_id ||
    !groups.has(settlement.group_id) ||
    settlement.voided_at ||
    settlement.version !== command.expectedVersion
  ) {
    throw new LedgerActionStaleError("stale settlement version");
  }
  const { partner } = await loadCoupleUsers(
    client,
    action.couple_id,
    requestedByUserId,
  );
  const before = await loadBalanceMap(client, settlement.group_id);
  const updated = await client.query(
    `UPDATE public.settlements
        SET voided_at = $1::timestamptz,
            voided_by_user_id = $2::uuid,
            void_source_action_id = $3::uuid,
            version = version + 1
      WHERE id = $4::uuid
        AND couple_id = $5
        AND version = $6
        AND voided_at IS NULL
      RETURNING version`,
    [
      nowIso,
      requestedByUserId,
      action.id,
      settlement.id,
      action.couple_id,
      command.expectedVersion,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new LedgerActionStaleError("stale settlement version");
  }
  const version = z.coerce.number().int().positive().parse(updated.rows[0]?.version);
  const after = await loadBalanceMap(client, settlement.group_id);
  return {
    plan: {
      insert_activities: [
        {
          couple_id: action.couple_id,
          group_id: settlement.group_id,
          actor_user_id: requestedByUserId,
          entity_type: "settlement",
          entity_id: settlement.id,
          action: "delete",
          before_state: { ...settlement, balance_by_user_id: before },
          after_state: {
            ...settlement,
            version,
            voided_at: nowIso,
            voided_by_user_id: requestedByUserId,
            void_source_action_id: action.id,
            balance_by_user_id: after,
          },
        },
      ],
      insert_notifications: [
        actionNotification(
          action,
          partner.id,
          settlement.group_id,
          "轉帳紀錄已撤銷",
          `另一半撤銷一筆 NT$${settlement.amount_twd.toLocaleString()} 的轉帳紀錄。`,
          settlement.id,
        ),
      ],
    },
    result: {
      settlement_id: settlement.id,
      settlement_version: version,
      balance: balanceResult(settlement.group_id, before, after),
    },
  };
}

export async function applyLedgerActionTx(
  client: PoolClient,
  action: PendingLedgerActionRow,
  groups: Map<string, LockedGroupLedger>,
  requestedByUserId: string,
  nowIso: string,
): Promise<LedgerActionTxResult> {
  if (action.action_type === "transfer" || action.action_type === "settle") {
    return applyTransferOrSettlement(
      client,
      action,
      groups,
      requestedByUserId,
    );
  }
  if (action.action_type === "void_settlement") {
    return applyVoidSettlement(
      client,
      action,
      groups,
      requestedByUserId,
      nowIso,
    );
  }
  throw new LedgerActionStaleError("unsupported ledger action");
}
