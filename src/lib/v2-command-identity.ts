import { createHash } from "node:crypto";

export type V2CommandOperation = "ledger.create" | "ledger.defaults" | "category.create" | "category.update"
  | "transaction.create" | "transaction.void" | "transaction.restore" | "transaction.replace" | "ledger.settle"
  | "recurring.create" | "proposal.create";

export interface V2CommandScope {
  operation: V2CommandOperation;
  coupleId: number;
  ledgerId: string | null;
  resourceId: string | null;
  actorUserId: string;
}

// Inputs have already passed their operation's Zod schema. Preserve command and
// percentage order; participant order and TWD number/string spelling are immaterial.
function canonical(value: unknown, field = ""): unknown {
  if (value === null || value === undefined) return value;
  if ((field === "amountTwd" || field === "weight" || field === "exactAmount") && (typeof value === "number" || typeof value === "string")) return String(value);
  if (Array.isArray(value)) {
    const entries = value.map((entry) => canonical(entry));
    return field === "payments" || field === "shares"
      ? entries.sort((a, b) => String((a as { userId: string }).userId).localeCompare(String((b as { userId: string }).userId))) : entries;
  }
  if (typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const defaults = "type" in object && "amountTwd" in object
    ? { category: null, categoryId: null, note: null, splitMethod: "weights", ...object } : object;
  return Object.fromEntries(Object.keys(defaults).sort().filter((key) => key !== "idempotencyKey" && defaults[key] !== undefined)
    .map((key) => [key, canonical(defaults[key], field === "exactShares" ? "exactAmount" : key)]));
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export function v2CommandIdentity(scope: V2CommandScope, key: string, payload: unknown, legacyHash: string) {
  // One LINE event represents one immutable intent, even if its active Ledger
  // preference changes before a retry. Keep these server-generated keys global.
  const eventKey = key.startsWith("line:v2:");
  return {
    ...scope,
    key,
    storageKey: eventKey ? key : `v3:${hash({ ...scope, key })}`,
    hash: `v3:${hash({ ...scope, payload })}`,
    legacyHash,
  };
}

export type V2CommandIdentity = ReturnType<typeof v2CommandIdentity>;

export function receiptResultMatchesScope(identity: V2CommandIdentity, ledgerId: string | null, result: Record<string, unknown>): boolean {
  if (identity.ledgerId !== null && ledgerId !== identity.ledgerId) return false;
  const transaction = result.transaction as { ledgerId?: string } | undefined;
  const category = result.category as { id?: string; ledgerId?: string } | undefined;
  switch (identity.operation) {
    case "ledger.create": return (result.ledger as { id?: string; coupleId?: number } | undefined)?.id === ledgerId
      && (result.ledger as { coupleId?: number }).coupleId === identity.coupleId;
    case "ledger.defaults": return result.ledgerId === ledgerId && typeof result.defaultShares === "object";
    case "category.create": return category?.ledgerId === ledgerId;
    case "category.update": return category?.ledgerId === ledgerId && category?.id === identity.resourceId;
    case "transaction.create": return transaction?.ledgerId === ledgerId && !("settled" in result) && !("replacedTransactionId" in result);
    case "transaction.replace": return result.replacedTransactionId === identity.resourceId && transaction?.ledgerId === ledgerId;
    case "transaction.void": return result.transactionId === identity.resourceId && result.status === "voided";
    case "transaction.restore": return result.transactionId === identity.resourceId && result.status === "posted";
    case "ledger.settle": return typeof result.settled === "boolean" && (!transaction || transaction.ledgerId === ledgerId);
    case "recurring.create": return (result.recurring as { ledgerId?: string } | undefined)?.ledgerId === ledgerId;
    case "proposal.create": return result.ledgerId === ledgerId && typeof result.proposalId === "string";
  }
}
