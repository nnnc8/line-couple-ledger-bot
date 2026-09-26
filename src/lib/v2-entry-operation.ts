import { ApiError } from "./api";
import { validateV2Transaction } from "./v2-ledger";
import { normalizeTransactionDraft, type EntryCommand, type TransactionDraft } from "./v2-transaction-draft";
import type { V2CreateTransactionResult, V2LedgerBootstrap, V2LedgerTransaction } from "./types";

export const ENTRY_RECOVERY_KEY = "v2.entry-operation.v1";
export type WriteOutcome = "idle" | "submitting" | "unknown" | "committed" | "rejected";
export type ReadFreshness = "initialLoading" | "ready" | "refreshing" | "failed";
export type CommitProof = {
  transaction: V2LedgerTransaction;
  replacedTransactionId?: string;
  originalVersion?: number;
  ledgerVersion?: number;
  snapshot?: V2CreateTransactionResult;
};
type CreateBody = EntryCommand & { idempotencyKey: string };
type ReplaceBody = { action: "replace"; expectedVersion: number; replacement: EntryCommand; idempotencyKey: string };
export type EntryOperation = {
  schemaVersion: 1;
  actorUserId: string;
  coupleId: number;
  ledgerId: string;
  operationType: "create" | "replace";
  endpoint: string;
  idempotencyKey: string;
  body: CreateBody | ReplaceBody;
  submittedAt: string;
  phase: "submitting" | "unknown" | "committed";
  hadUnknown: boolean;
  proof?: CommitProof;
};
export type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const positiveVersion = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const amount = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
const keysOnly = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

export function commandOf(operation: EntryOperation): EntryCommand {
  if ("replacement" in operation.body) return operation.body.replacement;
  const body = operation.body;
  return { type: body.type, amountTwd: body.amountTwd, occurredOn: body.occurredOn, description: body.description,
    category: body.category, categoryId: body.categoryId, note: body.note, splitMethod: body.splitMethod, payments: body.payments, shares: body.shares };
}
export function resourceId(operation: EntryOperation): string | undefined {
  return operation.operationType === "replace" ? operation.endpoint.split("/")[5] : undefined;
}

export function freezeOperation(draft: TransactionDraft, key: string, submittedAt: string): EntryOperation {
  const command = normalizeTransactionDraft(draft);
  const body = draft.operationType === "replace"
    ? { action: "replace" as const, expectedVersion: draft.expectedVersion!, replacement: command, idempotencyKey: key }
    : { ...command, idempotencyKey: key };
  return immutable({
    schemaVersion: 1, actorUserId: draft.actorUserId, coupleId: draft.coupleId, ledgerId: draft.ledgerId,
    operationType: draft.operationType,
    endpoint: draft.operationType === "replace" ? `/api/app/v2/transactions/${draft.transactionId}/mutate` : `/api/app/v2/ledgers/${draft.ledgerId}/transactions`,
    idempotencyKey: key, body, submittedAt, phase: "submitting", hadUnknown: false,
  });
}

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function participantAmounts(value: unknown): value is EntryCommand["payments"] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 2 && value.every(part => object(part)
    && keysOnly(part, ["userId", "amountTwd"]) && uuid(part.userId) && amount(part.amountTwd));
}

function validCommand(value: unknown, ledgerId: string, actor: string, withKey: boolean): value is EntryCommand {
  if (!object(value) || !keysOnly(value, ["type", "amountTwd", "occurredOn", "description", "category", "categoryId", "note", "splitMethod", "payments", "shares", ...(withKey ? ["idempotencyKey"] : [])])) return false;
  if (!["expense", "income", "transfer"].includes(String(value.type)) || !amount(value.amountTwd)
    || typeof value.description !== "string" || !value.description.trim() || value.description.length > 120
    || typeof value.occurredOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.occurredOn)
    || !["none", "weights", "equal", "percentage", "exact"].includes(String(value.splitMethod))
    || !(value.category === null || typeof value.category === "string" && value.category.length <= 40)
    || !(value.categoryId === null || uuid(value.categoryId))
    || !(value.note === null || typeof value.note === "string" && value.note.length <= 1000)
    || !participantAmounts(value.payments) || !participantAmounts(value.shares)) return false;
  const members = [...new Set([...value.payments, ...value.shares].map(part => part.userId))];
  if (members.length !== 2 || !members.includes(actor)) return false;
  try {
    validateV2Transaction({ ...value, ledgerId } as Parameters<typeof validateV2Transaction>[0], { ledgerId, memberIds: members as [string, string] });
    return true;
  } catch { return false; }
}

function amountsMatch(actual: unknown, expected: EntryCommand["shares"]) {
  return participantAmounts(actual) && actual.length === expected.length && new Set(actual.map(part => part.userId)).size === actual.length && actual.every(part => expected.some(other => other.userId === part.userId && other.amountTwd === part.amountTwd));
}

/** A matching posted transaction is proof even when the response has no complete snapshot. */
export function parseCommitProof(value: unknown, operation: EntryOperation): CommitProof | null {
  if (!object(value) || !object(value.transaction)) return null;
  const tx = value.transaction;
  const command = commandOf(operation);
  if (!uuid(tx.id) || tx.ledgerId !== operation.ledgerId || tx.status !== "posted"
    || !["type", "amountTwd", "occurredOn", "description"].every(key => tx[key] === command[key as keyof EntryCommand])
    || !amountsMatch(tx.payments, command.payments) || !amountsMatch(tx.shares, command.shares)
    || (tx.note ?? null) !== command.note || (tx.categoryId ?? null) !== command.categoryId) return null;
  if (operation.operationType === "replace" && (value.replacedTransactionId !== resourceId(operation)
    || tx.replacesTransactionId !== resourceId(operation) || !("expectedVersion" in operation.body)
    || value.version !== operation.body.expectedVersion + 1)) return null;
  const transaction: V2LedgerTransaction = {
    ...command, id: tx.id, ledgerId: operation.ledgerId, status: "posted",
    ...(positiveVersion(tx.version) ? { version: tx.version } : {}),
    ...(typeof tx.createdAt === "string" && Number.isFinite(Date.parse(tx.createdAt)) ? { createdAt: tx.createdAt } : {}),
    ...(operation.operationType === "replace" ? { replacesTransactionId: resourceId(operation) } : {}),
  };
  const proof: CommitProof = {
    transaction,
    ...(operation.operationType === "replace" ? { replacedTransactionId: resourceId(operation), originalVersion: value.version as number } : {}),
    ...(positiveVersion(value.ledgerVersion) ? { ledgerVersion: value.ledgerVersion } : {}),
  };
  const members = [...new Set([...command.payments, ...command.shares].map(part => part.userId))];
  const balance = value.balance;
  const next = value.nextPayer;
  const validBalance = object(balance) && Object.keys(balance).length === 2 && members.every(member => typeof balance[member] === "string" && /^-?(0|[1-9][0-9]*)$/.test(balance[member] as string));
  const validNext = next === null || object(next) && members.includes(String(next.payerUserId)) && members.includes(String(next.payeeUserId)) && next.payerUserId !== next.payeeUserId && amount(next.amountTwd);
  if (operation.operationType === "create" && transaction.version && transaction.createdAt && proof.ledgerVersion && validBalance && validNext) {
    proof.snapshot = {
      transaction: transaction as V2CreateTransactionResult["transaction"], ledgerVersion: proof.ledgerVersion,
      balance: Object.fromEntries(members.map(member => [member, balance[member] as string])),
      nextPayer: next === null ? null : { payerUserId: String((next as Record<string, unknown>).payerUserId), payeeUserId: String((next as Record<string, unknown>).payeeUserId), amountTwd: String((next as Record<string, unknown>).amountTwd) },
    };
  }
  return proof;
}

export function readRecovery(storage: RecoveryStorage): EntryOperation | null {
  const text = storage.getItem(ENTRY_RECOVERY_KEY);
  if (text === null) return null;
  if (text.length > 32_000) throw new Error("未完成操作的儲存格式無法辨認，請保留此頁並重新登入原帳號");
  const record: unknown = JSON.parse(text);
  if (!object(record) || !keysOnly(record, ["schemaVersion", "actorUserId", "coupleId", "ledgerId", "operationType", "endpoint", "idempotencyKey", "body", "submittedAt", "phase", "hadUnknown", "proof"])
    || record.schemaVersion !== 1 || !uuid(record.actorUserId) || !positiveVersion(record.coupleId) || !uuid(record.ledgerId)
    || !["create", "replace"].includes(String(record.operationType)) || typeof record.endpoint !== "string"
    || typeof record.idempotencyKey !== "string" || !record.idempotencyKey.length || record.idempotencyKey.length > 100
    || !object(record.body) || record.body.idempotencyKey !== record.idempotencyKey
    || typeof record.submittedAt !== "string" || !Number.isFinite(Date.parse(record.submittedAt))
    || !["submitting", "unknown", "committed"].includes(String(record.phase)) || typeof record.hadUnknown !== "boolean") throw new Error("未完成操作的儲存格式無法辨認，請保留此頁並重新登入原帳號");
  const op = record as unknown as EntryOperation;
  if (op.operationType === "create") {
    if (op.endpoint !== `/api/app/v2/ledgers/${op.ledgerId}/transactions` || !validCommand(op.body, op.ledgerId, op.actorUserId, true)) throw new Error("未完成操作的內容或帳本範圍無法驗證");
  } else {
    if (!uuid(resourceId(op)) || op.endpoint !== `/api/app/v2/transactions/${resourceId(op)}/mutate` || !keysOnly(record.body, ["action", "expectedVersion", "replacement", "idempotencyKey"])
      || record.body.action !== "replace" || !positiveVersion(record.body.expectedVersion) || !validCommand(record.body.replacement, op.ledgerId, op.actorUserId, false)) throw new Error("未完成修改的內容或範圍無法驗證");
  }
  if (op.phase === "committed") {
    if (!object(record.proof)) throw new Error("已完成操作的證據無法驗證");
    const proof = parseCommitProof({ ...record.proof, ...(object(record.proof.snapshot) ? record.proof.snapshot : {}), version: record.proof.originalVersion }, op);
    if (!proof) throw new Error("已完成操作的證據無法驗證");
    return immutable({ ...op, proof });
  }
  // A previous document cannot still own the promise. Never auto-dispatch this record.
  return immutable({ ...op, phase: "unknown", hadUnknown: true, proof: undefined });
}

export function writeRecovery(storage: RecoveryStorage, operation: EntryOperation): void {
  const text = JSON.stringify(operation);
  storage.setItem(ENTRY_RECOVERY_KEY, text);
  if (storage.getItem(ENTRY_RECOVERY_KEY) !== text) throw new Error("送出結果無法安全保留");
}

export function recoveryMatches(operation: EntryOperation, actorUserId: string, bootstrap: V2LedgerBootstrap): boolean {
  const members = bootstrap.ledger.members.map(member => member.userId);
  const command = commandOf(operation);
  return operation.actorUserId === actorUserId && operation.coupleId === bootstrap.ledger.coupleId
    && operation.ledgerId === bootstrap.ledger.id && bootstrap.ledger.status === "active" && members.includes(actorUserId)
    && [...command.payments, ...command.shares].every(part => members.includes(part.userId));
}

export function classifyWriteFailure(error: unknown, operation: EntryOperation): "rejected" | "unknown" {
  if (operation.hadUnknown) return "unknown";
  // Both existing endpoints validate/authenticate before commit and roll back their transaction
  // on these errors. 409 has no machine-readable version-vs-receipt discriminator: fail closed.
  return error instanceof ApiError && error.recognized && [400, 401, 403, 404, 422].includes(error.status) ? "rejected" : "unknown";
}

export function canApplySnapshot(current: V2LedgerBootstrap | null, result: V2CreateTransactionResult): boolean {
  if (!current || current.ledger.id !== result.transaction.ledgerId || current.ledger.version > result.ledgerVersion) return false;
  const known = current.transactions.find(transaction => transaction.id === result.transaction.id);
  return !known || known.status === "posted" && !known.replacedByTransactionId && (known.version ?? 1) <= result.transaction.version;
}

export function applyCanonicalSnapshot(current: V2LedgerBootstrap, result: V2CreateTransactionResult): V2LedgerBootstrap {
  if (!canApplySnapshot(current, result)) return current;
  return { ...current, ledger: { ...current.ledger, version: result.ledgerVersion }, balance: result.balance, nextPayer: result.nextPayer,
    transactions: [result.transaction, ...current.transactions.filter(row => row.id !== result.transaction.id)].sort((a, b) => (b.occurredOn ?? "").localeCompare(a.occurredOn ?? "") || (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id.localeCompare(a.id)) };
}

export function isCurrentBootstrap(current: V2LedgerBootstrap | null, result: V2LedgerBootstrap, minimumVersion: number): boolean {
  if (result.ledger.version < minimumVersion || current && current.ledger.id !== result.ledger.id) return false;
  return !current || current.transactions.every(known => {
    const next = result.transactions.find(row => row.id === known.id);
    return Boolean(next && (next.version ?? 1) >= (known.version ?? 1)
      && !((next.version ?? 1) === (known.version ?? 1) && known.status !== "posted" && next.status === "posted"));
  });
}
