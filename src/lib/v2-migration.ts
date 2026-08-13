import { createHash } from "node:crypto";

import {
  calculateLedgerBalance,
  type V2LedgerMemberSet,
  type V2SplitMethod,
  type V2Transaction,
} from "./v2-ledger";

export interface LegacyUserRow {
  id: string;
  couple_id: number;
  role: "owner" | "partner";
}

export interface LegacyGroupRow {
  id: string;
  couple_id: number;
  name: string;
  color: string;
  created_by_user_id: string | null;
  archived_at: string | null;
  created_at: string;
}

export interface LegacySplitRow {
  user_id: string;
  amount_twd: number | string;
}

export interface LegacyExpenseRow {
  id: string;
  couple_id: number;
  ledger: "shared" | "private";
  group_id: string | null;
  description: string;
  merchant?: string | null;
  notes?: string | null;
  tag: string;
  amount_twd: number | string;
  paid_by_user_id: string;
  created_by_user_id: string;
  expense_date: string;
  split_method: "equal" | "exact" | "percentage";
  deleted_at: string | null;
  version: number;
  created_at: string;
  mirror_kind?: "shared_share" | null;
  mirror_source_expense_id?: string | null;
  expense_splits: LegacySplitRow[];
}

export interface LegacySettlementRow {
  id: string;
  couple_id: number;
  group_id: string | null;
  from_user_id: string;
  to_user_id: string;
  amount_twd: number | string;
  intent: "settle" | "transfer";
  occurred_on: string;
  notes: string | null;
  voided_at: string | null;
  created_at: string;
  version: number;
}

export interface V2MigrationLedger {
  id: string;
  coupleId: number;
  name: string;
  color: string;
  createdByUserId: string;
  memberIds: [string, string];
  defaultWeights: [bigint, bigint];
  archived: boolean;
  createdAt: string;
  sourceGroupId: string;
}

export interface V2MigrationTransaction extends Omit<V2Transaction, "amountTwd" | "payments" | "shares"> {
  amountTwd: bigint;
  payments: { userId: string; amountTwd: bigint }[];
  shares: { userId: string; amountTwd: bigint }[];
  id: string;
  occurredOn: string;
  description: string;
  category: string | null;
  note: string | null;
  splitMethod: V2SplitMethod;
  version: number;
  createdAt: string;
  createdByUserId: string;
  sourceTable: "expenses" | "settlements";
  sourceId: string;
  legacyGroupId: string;
  voidedAt: string | null;
}

export interface V2MigrationMapEntry {
  sourceTable: "groups" | "expenses" | "settlements";
  sourceId: string;
  sourceGroupId: string | null;
  ledgerId: string | null;
  transactionId: string | null;
  mappingKind: "ledger" | "transaction" | "excluded_mirror" | "excluded_private" | "quarantine";
  sourceRowHash: string;
}

export interface V2MigrationQuarantine {
  sourceTable: string;
  sourceId: string;
  reason: string;
  payload: Record<string, unknown>;
}

export interface V2MigrationLedgerSummary {
  ledgerId: string;
  sourceGroupId: string;
  transactionCount: number;
  oldActiveTransactionCount: number;
  oldActiveAmountTwd: bigint;
  v2ActiveAmountTwd: bigint;
  oldBalance: Record<string, bigint>;
  v2Balance: Record<string, bigint>;
}

export interface V2MigrationPlan {
  coupleId: number;
  ledgers: V2MigrationLedger[];
  transactions: V2MigrationTransaction[];
  mappings: V2MigrationMapEntry[];
  quarantine: V2MigrationQuarantine[];
  summaries: V2MigrationLedgerSummary[];
  excludedPrivateExpenseIds: string[];
  excludedMirrorExpenseIds: string[];
}

export interface LegacySnapshot {
  coupleId: number;
  users: LegacyUserRow[];
  groups: LegacyGroupRow[];
  expenses: LegacyExpenseRow[];
  settlements: LegacySettlementRow[];
}

function parseAmount(value: number | string, label: string): bigint {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error(`${label} must be a non-negative integer`);
  const amount = BigInt(text);
  if (amount > 100_000_000_000n) throw new Error(`${label} exceeds supported TWD range`);
  return amount;
}

function positiveAmount(value: number | string, label: string): bigint {
  const amount = parseAmount(value, label);
  if (amount <= 0n) throw new Error(`${label} must be positive`);
  return amount;
}

function stableUuid(namespace: string, sourceId: string): string {
  const digest = createHash("sha1").update(`${namespace}:${sourceId}`).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function rowHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function quarantine(
  list: V2MigrationQuarantine[],
  sourceTable: string,
  sourceId: string,
  reason: string,
  payload: Record<string, unknown>,
): void {
  list.push({ sourceTable, sourceId, reason, payload });
}

function membersForCouple(users: LegacyUserRow[], coupleId: number): [string, string] | null {
  const members = users
    .filter((user) => user.couple_id === coupleId)
    .sort((left, right) => (left.role === "owner" ? -1 : 1) - (right.role === "owner" ? -1 : 1));
  if (members.length !== 2 || members[0]!.id === members[1]!.id) return null;
  return [members[0]!.id, members[1]!.id];
}

function memberScope(memberIds: [string, string], userId: string): boolean {
  return memberIds.includes(userId);
}

function assertConservation(
  amount: bigint,
  payments: { amountTwd: bigint }[],
  shares: { amountTwd: bigint }[],
): void {
  const paymentSum = payments.reduce((sum, payment) => sum + payment.amountTwd, 0n);
  const shareSum = shares.reduce((sum, share) => sum + share.amountTwd, 0n);
  if (paymentSum !== amount || shareSum !== amount) throw new Error("payments and shares do not conserve amount_twd");
}

export function buildV2MigrationPlan(snapshot: LegacySnapshot): V2MigrationPlan {
  const { coupleId } = snapshot;
  const members = membersForCouple(snapshot.users, coupleId);
  const ledgers: V2MigrationLedger[] = [];
  const transactions: V2MigrationTransaction[] = [];
  const mappings: V2MigrationMapEntry[] = [];
  const quarantineRows: V2MigrationQuarantine[] = [];
  const excludedPrivateExpenseIds: string[] = [];
  const excludedMirrorExpenseIds: string[] = [];
  const ledgerByGroup = new Map<string, V2MigrationLedger>();

  if (!members) {
    for (const group of snapshot.groups.filter((group) => group.couple_id === coupleId)) {
      quarantine(quarantineRows, "groups", group.id, "couple must contain exactly two members", group as unknown as Record<string, unknown>);
      mappings.push({
        sourceTable: "groups",
        sourceId: group.id,
        sourceGroupId: group.id,
        ledgerId: null,
        transactionId: null,
        mappingKind: "quarantine",
        sourceRowHash: rowHash(group),
      });
    }
  } else {
    for (const group of snapshot.groups.filter((group) => group.couple_id === coupleId)) {
      const ledger: V2MigrationLedger = {
        id: group.id,
        coupleId,
        name: group.name,
        color: group.color,
        createdByUserId: group.created_by_user_id ?? members[0],
        memberIds: [...members],
        defaultWeights: [1n, 1n],
        archived: Boolean(group.archived_at),
        createdAt: group.created_at,
        sourceGroupId: group.id,
      };
      ledgers.push(ledger);
      ledgerByGroup.set(group.id, ledger);
      mappings.push({
        sourceTable: "groups",
        sourceId: group.id,
        sourceGroupId: group.id,
        ledgerId: ledger.id,
        transactionId: null,
        mappingKind: "ledger",
        sourceRowHash: rowHash(group),
      });
    }
  }

  for (const expense of snapshot.expenses.filter((row) => row.couple_id === coupleId)) {
    if (expense.mirror_kind === "shared_share") {
      excludedMirrorExpenseIds.push(expense.id);
      mappings.push({
        sourceTable: "expenses",
        sourceId: expense.id,
        sourceGroupId: expense.group_id,
        ledgerId: expense.group_id ? ledgerByGroup.get(expense.group_id)?.id ?? null : null,
        transactionId: null,
        mappingKind: "excluded_mirror",
        sourceRowHash: rowHash(expense),
      });
      continue;
    }
    if (expense.ledger === "private" || !expense.group_id) {
      excludedPrivateExpenseIds.push(expense.id);
      mappings.push({
        sourceTable: "expenses",
        sourceId: expense.id,
        sourceGroupId: expense.group_id,
        ledgerId: null,
        transactionId: null,
        mappingKind: "excluded_private",
        sourceRowHash: rowHash(expense),
      });
      continue;
    }
    const ledger = ledgerByGroup.get(expense.group_id);
    if (!ledger) {
      quarantine(quarantineRows, "expenses", expense.id, "shared expense references unknown group", expense as unknown as Record<string, unknown>);
      mappings.push({ sourceTable: "expenses", sourceId: expense.id, sourceGroupId: expense.group_id, ledgerId: null, transactionId: null, mappingKind: "quarantine", sourceRowHash: rowHash(expense) });
      continue;
    }
    try {
      const amount = positiveAmount(expense.amount_twd, "expense amount_twd");
      if (!memberScope(ledger.memberIds, expense.paid_by_user_id) || !memberScope(ledger.memberIds, expense.created_by_user_id)) {
        throw new Error("expense actor is outside the ledger couple");
      }
      const shares = expense.expense_splits.map((split) => ({ userId: split.user_id, amountTwd: parseAmount(split.amount_twd, "share amount_twd") }));
      if (shares.length !== 2 || new Set(shares.map((share) => share.userId)).size !== 2 || shares.some((share) => !memberScope(ledger.memberIds, share.userId))) {
        throw new Error("shared expense must contain exactly two in-couple shares");
      }
      const payments = [{ userId: expense.paid_by_user_id, amountTwd: amount }];
      assertConservation(amount, payments, shares);
      const transaction: V2MigrationTransaction = {
        id: stableUuid("couple-ledger-v2:expense", expense.id),
        ledgerId: ledger.id,
        type: "expense",
        amountTwd: amount,
        payments,
        shares,
        status: expense.deleted_at ? "deleted" : "posted",
        occurredOn: expense.expense_date,
        description: expense.description,
        category: expense.tag || null,
        note: expense.notes ?? null,
        splitMethod: expense.split_method,
        sourceTable: "expenses",
        sourceId: expense.id,
        legacyGroupId: expense.group_id,
        voidedAt: null,
        version: expense.version,
        createdAt: expense.created_at,
        createdByUserId: expense.created_by_user_id,
      };
      transactions.push(transaction);
      mappings.push({ sourceTable: "expenses", sourceId: expense.id, sourceGroupId: expense.group_id, ledgerId: ledger.id, transactionId: transaction.id, mappingKind: "transaction", sourceRowHash: rowHash(expense) });
    } catch (error) {
      quarantine(quarantineRows, "expenses", expense.id, error instanceof Error ? error.message : "invalid expense", expense as unknown as Record<string, unknown>);
      mappings.push({ sourceTable: "expenses", sourceId: expense.id, sourceGroupId: expense.group_id, ledgerId: ledger.id, transactionId: null, mappingKind: "quarantine", sourceRowHash: rowHash(expense) });
    }
  }

  for (const settlement of snapshot.settlements.filter((row) => row.couple_id === coupleId)) {
    const ledger = settlement.group_id ? ledgerByGroup.get(settlement.group_id) : null;
    try {
      if (!ledger) throw new Error("settlement references unknown group");
      const amount = positiveAmount(settlement.amount_twd, "settlement amount_twd");
      if (settlement.from_user_id === settlement.to_user_id || !memberScope(ledger.memberIds, settlement.from_user_id) || !memberScope(ledger.memberIds, settlement.to_user_id)) {
        throw new Error("settlement participants must be the ledger's two members");
      }
      const transaction: V2MigrationTransaction = {
        id: stableUuid("couple-ledger-v2:settlement", settlement.id),
        ledgerId: ledger.id,
        type: "transfer",
        amountTwd: amount,
        payments: [{ userId: settlement.from_user_id, amountTwd: amount }],
        shares: [{ userId: settlement.to_user_id, amountTwd: amount }],
        status: settlement.voided_at ? "voided" : "posted",
        occurredOn: settlement.occurred_on,
        description: settlement.intent === "settle" ? "結清（V1）" : "轉帳（V1）",
        category: null,
        note: settlement.notes,
        splitMethod: "none",
        sourceTable: "settlements",
        sourceId: settlement.id,
        legacyGroupId: settlement.group_id!,
        voidedAt: settlement.voided_at,
        version: settlement.version,
        createdAt: settlement.created_at,
        createdByUserId: settlement.from_user_id,
      };
      transactions.push(transaction);
      mappings.push({ sourceTable: "settlements", sourceId: settlement.id, sourceGroupId: settlement.group_id, ledgerId: ledger.id, transactionId: transaction.id, mappingKind: "transaction", sourceRowHash: rowHash(settlement) });
    } catch (error) {
      quarantine(quarantineRows, "settlements", settlement.id, error instanceof Error ? error.message : "invalid settlement", settlement as unknown as Record<string, unknown>);
      mappings.push({ sourceTable: "settlements", sourceId: settlement.id, sourceGroupId: settlement.group_id, ledgerId: ledger?.id ?? null, transactionId: null, mappingKind: "quarantine", sourceRowHash: rowHash(settlement) });
    }
  }

  const summaries = ledgers.map((ledger) => {
    const ledgerTransactions = transactions.filter((transaction) => transaction.ledgerId === ledger.id);
    const oldActiveTransactions = ledgerTransactions.filter((transaction) => transaction.status === "posted");
    const oldActiveAmountTwd = oldActiveTransactions.reduce((sum, transaction) => sum + transaction.amountTwd, 0n);
    const v2ActiveAmountTwd = oldActiveAmountTwd;
    const membersForLedger: V2LedgerMemberSet = { ledgerId: ledger.id, memberIds: ledger.memberIds };
    const oldBalance = Object.fromEntries(ledger.memberIds.map((userId) => [userId, 0n]));
    for (const expense of snapshot.expenses.filter((row) =>
      row.couple_id === coupleId &&
      row.ledger === "shared" &&
      row.group_id === ledger.sourceGroupId &&
      row.mirror_kind !== "shared_share" &&
      !row.deleted_at,
    )) {
      try {
        const amount = positiveAmount(expense.amount_twd, "expense amount_twd");
        if (memberScope(ledger.memberIds, expense.paid_by_user_id)) {
          oldBalance[expense.paid_by_user_id]! += amount;
        }
        for (const split of expense.expense_splits) {
          if (memberScope(ledger.memberIds, split.user_id)) {
            oldBalance[split.user_id]! -= parseAmount(split.amount_twd, "share amount_twd");
          }
        }
      } catch {
        // The source row is already represented in quarantine. Keep the
        // reconciliation artifact readable so reviewers can inspect all
        // other ledgers instead of aborting the whole plan.
      }
    }
    for (const settlement of snapshot.settlements.filter((row) =>
      row.couple_id === coupleId &&
      row.group_id === ledger.sourceGroupId &&
      !row.voided_at,
    )) {
      try {
        const amount = positiveAmount(settlement.amount_twd, "settlement amount_twd");
        if (memberScope(ledger.memberIds, settlement.from_user_id)) oldBalance[settlement.from_user_id]! += amount;
        if (memberScope(ledger.memberIds, settlement.to_user_id)) oldBalance[settlement.to_user_id]! -= amount;
      } catch {
        // See the source-row quarantine note above.
      }
    }
    const v2Balance = calculateLedgerBalance(ledgerTransactions, membersForLedger);
    return {
      ledgerId: ledger.id,
      sourceGroupId: ledger.sourceGroupId,
      transactionCount: ledgerTransactions.length,
      oldActiveTransactionCount: oldActiveTransactions.length,
      oldActiveAmountTwd,
      v2ActiveAmountTwd,
      oldBalance,
      v2Balance,
    };
  });

  return {
    coupleId,
    ledgers,
    transactions,
    mappings,
    quarantine: quarantineRows,
    summaries,
    excludedPrivateExpenseIds,
    excludedMirrorExpenseIds,
  };
}

export function migrationPlanDigest(plan: V2MigrationPlan): string {
  return rowHash({
    coupleId: plan.coupleId,
    ledgers: plan.ledgers,
    transactions: plan.transactions,
    mappings: plan.mappings,
    quarantine: plan.quarantine,
  });
}
