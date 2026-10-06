"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import type { V2Category, V2LedgerTransaction } from "@/lib/types";
import {
  effectiveTimelineTransactions,
  groupTimelineTransactions,
  timelineCategoryLabel,
  timelineMoney,
  timelinePaymentSummary,
  timelinePurpose,
  timelineTypeLabel,
  visibleTimelineTransactions,
} from "@/lib/v2-timeline";

type OpenTransaction = (transactionId: string, trigger: HTMLButtonElement) => void;

export type LedgerTimelineProps = {
  transactions: readonly V2LedgerTransaction[];
  userId: string;
  categories: readonly V2Category[];
  today: string;
  visibleCount: number;
  onLoadOlder: () => void;
  onOpenTransaction: OpenTransaction;
  loading?: boolean;
  highlightedId?: string;
};

export type TimelineTransactionRowProps = Pick<LedgerTimelineProps, "userId" | "categories" | "today" | "onOpenTransaction"> & {
  transaction: V2LedgerTransaction;
  animate?: boolean;
  highlighted?: boolean;
};

/** Search reuses the same reading row, including historical/void transactions. */
export function TimelineTransactionRow({ transaction, userId, categories, onOpenTransaction, animate = false, highlighted = false }: TimelineTransactionRowProps) {
  const purpose = timelinePurpose(transaction);
  const typeLabel = timelineTypeLabel(transaction.type);
  const summary = timelinePaymentSummary(transaction, userId);
  const category = timelineCategoryLabel(transaction, categories);
  const amount = `${transaction.type === "income" ? "＋" : ""}${timelineMoney(transaction.amountTwd)}`;
  const status = transaction.replacedByTransactionId ? "這筆已更新" : transaction.status === "voided" ? "已作廢" : transaction.status === "deleted" ? "已刪除" : "";
  const secondary = [transaction.type === "expense" ? "" : typeLabel, summary, category, status].filter(Boolean).join(" · ");

  return <button
    type="button"
    data-transaction-id={transaction.id}
    data-created-highlight={highlighted || undefined}
    className={`${highlighted ? "timeline-created-row " : animate ? "timeline-new-row " : ""}flex min-h-11 w-full min-w-0 flex-wrap items-start gap-x-3 gap-y-1 rounded-xl px-2 py-3 text-left transition-colors hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
    aria-label={[purpose, typeLabel, amount, summary, transaction.occurredOn || "日期未提供", status].filter(Boolean).join("，")}
    onClick={event => onOpenTransaction(transaction.id, event.currentTarget)}
  >
    <span className="flex min-w-0 flex-[1_1_11rem] flex-col gap-1">
      <span data-timeline-purpose className="line-clamp-2 whitespace-normal break-words text-sm font-semibold [overflow-wrap:anywhere]">{purpose}</span>
      <span className="whitespace-normal break-words text-xs text-[var(--muted-foreground)] [overflow-wrap:anywhere]">{secondary}</span>
    </span>
    <span data-timeline-amount className={`ml-auto min-w-0 max-w-full flex-[0_1_auto] whitespace-normal text-right text-sm font-semibold tabular-nums [overflow-wrap:anywhere] ${transaction.type === "income" ? "text-success" : ""}`}>{amount}</span>
  </button>;
}

export function LedgerTimeline({ transactions, userId, categories, today, visibleCount, onLoadOlder, onOpenTransaction, loading = false, highlightedId }: LedgerTimelineProps) {
  const effective = React.useMemo(() => effectiveTimelineTransactions(transactions), [transactions]);
  const visible = React.useMemo(() => visibleTimelineTransactions(effective, visibleCount), [effective, visibleCount]);
  const groups = React.useMemo(() => groupTimelineTransactions(visible, today), [visible, today]);
  const [initialVisibleIds] = React.useState(() => new Set(visible.map(transaction => transaction.id)));
  const container = React.useRef<HTMLDivElement>(null);
  const pendingOlderFocus = React.useRef<number | null>(null);
  const hasOlder = visible.length < effective.length;

  React.useLayoutEffect(() => {
    const previousCount = pendingOlderFocus.current;
    if (previousCount === null || visible.length <= previousCount) return;
    pendingOlderFocus.current = null;
    // The final append removes its control. Keep keyboard focus on the first new row.
    if (!hasOlder) container.current?.querySelectorAll<HTMLButtonElement>("button[data-transaction-id]")[previousCount]?.focus({ preventScroll: true });
  }, [hasOlder, visible.length]);

  if (loading && transactions.length === 0) return <div data-testid="ledger-timeline" aria-busy="true" role="status" className="space-y-3 py-3">
    <p className="text-sm text-[var(--muted-foreground)]">正在載入帳本…</p>
    {[0, 1, 2].map(row => <div key={row} data-timeline-skeleton aria-hidden="true" className="flex min-h-16 items-center gap-4 rounded-xl bg-muted/60 px-3">
      <div className="flex-1 space-y-2"><div className="h-3 w-3/5 rounded bg-border" /><div className="h-2 w-2/5 rounded bg-border" /></div><div className="h-3 w-16 rounded bg-border" />
    </div>)}
  </div>;

  return <div ref={container} data-testid="ledger-timeline" className="min-w-0">
    {!visible.length ? <p className="py-8 text-center text-sm text-[var(--muted-foreground)]">從一起花的第一筆開始</p> : null}
    {groups.map(group => <section key={group.occurredOn} className="min-w-0 py-2">
      <h3 tabIndex={-1} data-timeline-date={group.occurredOn} className="px-2 py-2 text-sm font-semibold text-[var(--muted-foreground)]">{group.label}</h3>
      <ul className="min-w-0 divide-y divide-border">
        {group.transactions.map(transaction => <li key={transaction.id} className="min-w-0"><TimelineTransactionRow transaction={transaction} userId={userId} categories={categories} today={today} onOpenTransaction={onOpenTransaction} animate={!highlightedId && !initialVisibleIds.has(transaction.id)} highlighted={transaction.id === highlightedId} /></li>)}
      </ul>
    </section>)}
    <p className="sr-only">已顯示 {visible.length} 筆紀錄</p>
    {hasOlder ? <Button variant="ghost" className="mt-2 w-full" onClick={() => { pendingOlderFocus.current = visible.length; onLoadOlder(); }}>更早紀錄</Button> : null}
  </div>;
}
