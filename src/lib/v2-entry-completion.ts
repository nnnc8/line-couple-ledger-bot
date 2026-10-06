import type { V2LedgerTransaction } from "./types";
import { effectiveTimelineTransactions, TIMELINE_PAGE_SIZE } from "./v2-timeline";

/** Choose a presentation target over P2-C's canonical, sorted collection. */
export function entryCompletionTarget({ transaction, transactions, today, surface, moved, visibleCount }: {
  transaction: V2LedgerTransaction;
  transactions: readonly V2LedgerTransaction[];
  today: string;
  surface: string;
  moved: boolean;
  visibleCount: number;
}): { kind: "row"; visibleCount: number } | { kind: "detail" } {
  if (surface !== "HOME" || moved || transaction.occurredOn !== today) return { kind: "detail" };
  const position = effectiveTimelineTransactions(transactions).findIndex(row => row.id === transaction.id && row.ledgerId === transaction.ledgerId);
  if (position < 0) return { kind: "detail" };
  return { kind: "row", visibleCount: Math.max(visibleCount, Math.ceil((position + 1) / TIMELINE_PAGE_SIZE) * TIMELINE_PAGE_SIZE) };
}
