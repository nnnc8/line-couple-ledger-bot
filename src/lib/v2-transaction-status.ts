import type { V2LedgerTransaction } from "./types";

export type TransactionStatusProof = {
  transactionId: string;
  status: "posted" | "voided";
  version: number;
  ledgerVersion: number;
};

/** The existing mutate response proves this resource/action, not a full snapshot. */
export function transactionStatusProof(value: unknown, transaction: V2LedgerTransaction, action: "void" | "restore"): TransactionStatusProof | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  const status = action === "void" ? "voided" : "posted";
  if (result.transactionId !== transaction.id || result.status !== status || result.version !== (transaction.version ?? 1) + 1
    || !Number.isSafeInteger(result.ledgerVersion) || Number(result.ledgerVersion) < 1) return null;
  return { transactionId: transaction.id, status, version: result.version as number, ledgerVersion: result.ledgerVersion as number };
}
