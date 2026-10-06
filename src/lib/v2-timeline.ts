import type { V2Category, V2LedgerTransaction } from "./types";

export const TIMELINE_PAGE_SIZE = 20;

export type TimelineDateGroup = {
  occurredOn: string;
  label: string;
  transactions: V2LedgerTransaction[];
};

/** Keep the bootstrap untouched: chronology and accounting still belong to it. */
export function effectiveTimelineTransactions(transactions: readonly V2LedgerTransaction[]): V2LedgerTransaction[] {
  return transactions
    .filter(transaction => transaction.status === "posted" && !transaction.replacedByTransactionId)
    .sort((a, b) => (b.occurredOn ?? "").localeCompare(a.occurredOn ?? "")
      || (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
      || b.id.localeCompare(a.id));
}

/** This is a render window over already-loaded, sorted effective transactions. */
export function visibleTimelineTransactions(transactions: readonly V2LedgerTransaction[], visibleCount = TIMELINE_PAGE_SIZE): V2LedgerTransaction[] {
  const count = Number.isFinite(visibleCount) ? Math.max(0, Math.floor(visibleCount)) : TIMELINE_PAGE_SIZE;
  return transactions.slice(0, count);
}

/** `today` is the Asia/Taipei calendar date supplied by the existing app context. */
export function timelineDateLabel(occurredOn: string, today: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) return occurredOn || "日期未提供";
  if (occurredOn === today) return "今天";
  const previousDay = new Date(`${today}T00:00:00.000Z`);
  if (Number.isFinite(previousDay.getTime())) {
    previousDay.setUTCDate(previousDay.getUTCDate() - 1);
    if (occurredOn === previousDay.toISOString().slice(0, 10)) return "昨天";
  }
  const [year, month, day] = occurredOn.split("-");
  const monthDay = `${Number(month)}月${Number(day)}日`;
  return year === today.slice(0, 4) ? monthDay : `${year}年${monthDay}`;
}

export function groupTimelineTransactions(transactions: readonly V2LedgerTransaction[], today: string): TimelineDateGroup[] {
  const groups = new Map<string, TimelineDateGroup>();
  for (const transaction of transactions) {
    const occurredOn = transaction.occurredOn ?? "";
    let group = groups.get(occurredOn);
    if (!group) {
      group = { occurredOn, label: timelineDateLabel(occurredOn, today), transactions: [] };
      groups.set(occurredOn, group);
    }
    group.transactions.push(transaction);
  }
  return [...groups.values()];
}

export function timelineTypeLabel(type: V2LedgerTransaction["type"]): string {
  return type === "income" ? "收入／退款" : type === "transfer" ? "轉帳" : "支出";
}

/** The row clamps presentation to two lines; this text remains complete for Detail and accessibility. */
export function timelinePurpose(transaction: V2LedgerTransaction): string {
  return transaction.description?.trim() ? transaction.description : timelineTypeLabel(transaction.type);
}

/** Canonical integer strings are formatted directly, without a Number conversion. */
export function timelineMoney(amountTwd: string): string {
  return /^\d+$/.test(amountTwd) ? `NT$${BigInt(amountTwd).toLocaleString("en-US")}` : "NT$—";
}

export function timelineTransferDirection(transaction: V2LedgerTransaction, userId: string): string {
  const sender = transaction.payments[0]?.userId;
  const receiver = transaction.shares[0]?.userId;
  const label = (id: string | undefined) => id ? id === userId ? "你" : "另一半" : "方向未提供";
  return `${label(sender)} → ${label(receiver)}`;
}

export function timelinePaymentSummary(transaction: V2LedgerTransaction, userId: string): string {
  if (transaction.type === "transfer") return timelineTransferDirection(transaction, userId);
  const participants = new Set(transaction.payments
    .filter(payment => /^\d+$/.test(payment.amountTwd) && BigInt(payment.amountTwd) > 0n)
    .map(payment => payment.userId));
  const action = transaction.type === "income" ? "收款" : "付款";
  if (participants.size > 1) return `兩人${action}`;
  const participant = [...participants][0];
  return participant ? `${participant === userId ? "你" : "另一半"}${action}` : `${action}資訊未提供`;
}

export function timelineCategoryLabel(transaction: V2LedgerTransaction, categories: readonly V2Category[]): string | null {
  const category = transaction.categoryId
    ? categories.find(item => item.id === transaction.categoryId && item.ledgerId === transaction.ledgerId)
    : undefined;
  return transaction.category || category?.name || null;
}

/** Historical rows stay available; the exact transaction must also belong to the requested Ledger. */
export function lookupTimelineTransaction(transactions: readonly V2LedgerTransaction[], ledgerId: string, transactionId: string): V2LedgerTransaction | undefined {
  return transactions.find(transaction => transaction.id === transactionId && transaction.ledgerId === ledgerId);
}
