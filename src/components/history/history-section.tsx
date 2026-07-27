"use client";

import * as React from "react";
import { ArrowRight, Search, Trash2 } from "lucide-react";
import { ExpenseList } from "@/components/dashboard/dashboard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { dateFormat } from "@/lib/format";
import type { Expense, SettlementView, User } from "@/lib/types";

type HistoryFilter = "all" | "expense" | "transfer";
type SettlementRecord = SettlementView;
type TimelineItem =
  | { kind: "expense"; date: string; sortKey: string; expense: Expense }
  | {
      kind: "transfer";
      date: string;
      sortKey: string;
      settlement: SettlementRecord;
    };

interface HistorySectionProps {
  expenses: Expense[];
  users: User[];
  settlements: SettlementView[];
  onEdit: (expense: Expense) => void;
  onDelete: (expense: Expense) => void;
  onVoid?: (settlement: SettlementRecord) => void;
  currentUserId?: string;
  currentBalance?: number;
  includeTransfers?: boolean;
  busy?: boolean;
}

function balanceCopy(balance: number): string {
  if (balance === 0) return "雙方已結清";
  return balance > 0
    ? `另一半欠你 NT$${balance.toLocaleString()}`
    : `你欠另一半 NT$${Math.abs(balance).toLocaleString()}`;
}

export function HistorySection({
  expenses,
  users,
  settlements,
  onEdit,
  onDelete,
  onVoid,
  currentUserId,
  currentBalance,
  includeTransfers = true,
  busy = false,
}: HistorySectionProps) {
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<HistoryFilter>("all");
  const [showDeleted, setShowDeleted] = React.useState(false);
  const [voidTarget, setVoidTarget] = React.useState<SettlementRecord | null>(null);

  const timeline = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const expenseItems: TimelineItem[] = filter === "transfer"
      ? []
      : expenses
          .filter((expense) =>
            showDeleted ? !!expense.deleted_at : !expense.deleted_at,
          )
          .filter((expense) => {
            if (!q) return true;
            return `${expense.description} ${expense.merchant ?? ""} ${expense.notes ?? ""}`
              .toLowerCase()
              .includes(q);
          })
          .map((expense) => ({
            kind: "expense" as const,
            date: expense.expense_date,
            sortKey: `${expense.expense_date}T00:00:00|${expense.id}`,
            expense,
          }));

    const transferItems: TimelineItem[] =
      !includeTransfers || showDeleted || filter === "expense"
        ? []
        : settlements
            .map((item) => item as SettlementRecord)
            .filter((settlement) => {
              if (!q) return true;
              const from = users.find((user) => user.id === settlement.from_user_id)?.label ?? "";
              const to = users.find((user) => user.id === settlement.to_user_id)?.label ?? "";
              const intent = settlement.intent === "transfer" ? "轉帳" : "結清";
              return `${from} ${to} ${intent} ${settlement.notes ?? ""}`
                .toLowerCase()
                .includes(q);
            })
            .map((settlement) => ({
              kind: "transfer" as const,
              date: settlement.occurred_on,
              sortKey: `${settlement.occurred_on}|${settlement.created_at}|${settlement.id}`,
              settlement,
            }));

    return [...expenseItems, ...transferItems].sort((a, b) =>
      b.sortKey.localeCompare(a.sortKey),
    );
  }, [expenses, filter, includeTransfers, query, settlements, showDeleted, users]);

  const groups: Array<{ date: string; items: TimelineItem[] }> = [];
  for (const item of timeline) {
    const last = groups[groups.length - 1];
    if (last && last.date === item.date) last.items.push(item);
    else groups.push({ date: item.date, items: [item] });
  }

  const voidAfterBalance =
    voidTarget && currentUserId !== undefined && currentBalance !== undefined
      ? currentBalance +
        (voidTarget.from_user_id === currentUserId
          ? -voidTarget.amount_twd
          : voidTarget.to_user_id === currentUserId
            ? voidTarget.amount_twd
            : 0)
      : null;

  return (
    <div className="space-y-3 pt-1">
      <div className="space-y-2">
        {includeTransfers ? (
          <Segmented
            value={filter}
            onValueChange={(value) => {
              setFilter(value as HistoryFilter);
              if (value === "transfer") setShowDeleted(false);
            }}
            options={[
              { value: "all", label: "全部" },
              { value: "expense", label: "花費" },
              { value: "transfer", label: "轉帳" },
            ]}
          />
        ) : null}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <input
            type="search"
            placeholder="搜尋說明、商家或轉帳備註"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] pl-9 pr-3 text-[15px] focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)]"
          />
        </div>
        {filter !== "transfer" ? (
          <div className="flex gap-2">
            <Button
              variant={showDeleted ? "primary" : "outline"}
              className="h-11 px-3 text-[13px]"
              onClick={() => setShowDeleted((value) => !value)}
            >
              <Trash2 className="size-4" /> {showDeleted ? "回收" : "垃圾桶"}
            </Button>
          </div>
        ) : null}
      </div>

      <Card className="p-4">
        {groups.length > 0 ? (
          <div className="space-y-4">
            {groups.map((group) => (
              <div key={group.date}>
                <div className="sticky top-[64px] z-[1] -mx-1 mb-1 rounded-md bg-[var(--card)] px-2 py-1.5 text-[12px] font-bold text-[var(--muted-foreground)]">
                  {dateFormat(group.date)}
                </div>
                <div className="divide-y divide-[var(--border)]">
                  {group.items.map((item) => {
                    if (item.kind === "expense") {
                      return (
                        <div key={item.expense.id}>
                          <ExpenseList
                            expenses={[item.expense]}
                            users={users}
                            onEdit={onEdit}
                          />
                          {showDeleted && !item.expense.mirror_kind ? (
                            <div className="flex justify-end pb-2">
                              <button
                                className="rounded-md px-2 py-1 text-[12px] font-semibold text-destructive hover:bg-destructive/10"
                                onClick={() => onDelete(item.expense)}
                              >
                                {item.expense.deleted_at ? "復原" : "刪除"}
                              </button>
                            </div>
                          ) : null}
                        </div>
                      );
                    }

                    const settlement = item.settlement;
                    const from =
                      users.find((user) => user.id === settlement.from_user_id)?.label ?? "?";
                    const to =
                      users.find((user) => user.id === settlement.to_user_id)?.label ?? "?";
                    const recorder =
                      users.find((user) => user.id === settlement.recorded_by_user_id)?.label ??
                      "帳本成員";
                    const voided = !!settlement.voided_at;
                    return (
                      <div
                        key={settlement.id}
                        className={`py-3 text-[14px] ${voided ? "opacity-55" : ""}`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent">
                                {settlement.intent === "transfer" ? "轉帳" : "結清"}
                              </span>
                              <p className="font-semibold">{from} → {to}</p>
                            </div>
                            {settlement.notes ? (
                              <p className="mt-1 break-words text-[13px]">{settlement.notes}</p>
                            ) : null}
                            <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
                              記錄者：{recorder}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="font-bold tabular-nums">
                              NT${settlement.amount_twd.toLocaleString()}
                            </p>
                            <p className="mt-0.5 text-[11px] font-semibold text-[var(--muted-foreground)]">
                              {voided ? "已撤銷" : "已入帳"}
                            </p>
                          </div>
                        </div>
                        {!voided && onVoid && currentUserId && currentBalance !== undefined ? (
                          <div className="mt-2 flex justify-end">
                            <button
                              type="button"
                              onClick={() => setVoidTarget(settlement)}
                              className="rounded-md px-2 py-1 text-[12px] font-semibold text-destructive hover:bg-destructive/10"
                            >
                              撤銷
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            icon={<Search />}
            title="找不到符合條件的流水"
            description="試試看其他關鍵字或篩選"
            className="py-10"
          />
        )}
      </Card>

      <Sheet
        open={!!voidTarget}
        onClose={() => setVoidTarget(null)}
        title="撤銷這筆轉帳？"
        subtitle="原紀錄會保留並標示為已撤銷"
        labelledBy="void-settlement-title"
      >
        {voidTarget ? (
          <div className="space-y-4">
            <div className="rounded-2xl border border-[var(--border)] bg-muted/55 p-4">
              <p className="text-[12px] font-semibold text-[var(--muted-foreground)]">
                撤銷後餘額
              </p>
              <div className="mt-2 flex items-center gap-2 text-[13px] font-semibold">
                <span className="min-w-0 flex-1">
                  {balanceCopy(currentBalance ?? 0)}
                </span>
                <ArrowRight className="size-4 shrink-0 text-[var(--muted-foreground)]" />
                <span className="min-w-0 flex-1 text-right">
                  {balanceCopy(voidAfterBalance ?? 0)}
                </span>
              </div>
            </div>
            <Button
              variant="primary"
              size="block"
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                onVoid?.(voidTarget);
                setVoidTarget(null);
              }}
            >
              確認撤銷
            </Button>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
