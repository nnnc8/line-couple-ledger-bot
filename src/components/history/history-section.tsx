"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Search, Trash2 } from "lucide-react";
import { ExpenseList } from "@/components/dashboard/dashboard";
import { dateFormat } from "@/lib/format";
import type { Expense, SettlementView, User } from "@/lib/types";

interface HistorySectionProps {
  expenses: Expense[];
  users: User[];
  settlements: SettlementView[];
  onEdit: (expense: Expense) => void;
  onDelete: (expense: Expense) => void;
}

export function HistorySection({
  expenses,
  users,
  settlements,
  onEdit,
  onDelete,
}: HistorySectionProps) {
  const [query, setQuery] = React.useState("");
  const [showDeleted, setShowDeleted] = React.useState(false);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return expenses
      .filter((e) =>
        showDeleted ? !!e.deleted_at : !e.deleted_at,
      )
      .filter((e) => {
        if (!q) return true;
        return `${e.description} ${e.merchant ?? ""}`.toLowerCase().includes(q);
      })
      .sort((a, b) => b.expense_date.localeCompare(a.expense_date));
  }, [expenses, query, showDeleted]);

  const groups: Array<{ date: string; items: Expense[] }> = [];
  for (const e of filtered) {
    const last = groups[groups.length - 1];
    if (last && last.date === e.expense_date) last.items.push(e);
    else groups.push({ date: e.expense_date, items: [e] });
  }

  return (
    <div className="space-y-3 pt-1">
      {settlements.length > 0 && (
        <Card className="p-4">
          <p className="text-[12px] font-medium text-[var(--muted-foreground)]">轉帳流水</p>
          <div className="mt-3 divide-y divide-[var(--border)]">
            {settlements.map((settlement) => {
              const from = users.find((user) => user.id === settlement.from_user_id)?.label ?? "?";
              const to = users.find((user) => user.id === settlement.to_user_id)?.label ?? "?";
              return (
                <div key={settlement.id} className="flex items-center gap-3 py-3 text-[14px]">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{from} → {to}</p>
                    <p className="mt-0.5 text-[12px] text-[var(--muted-foreground)]">
                      {new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(settlement.created_at))}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold tabular-nums">NT${settlement.amount_twd.toLocaleString()}</p>
                    <p className="text-[12px] text-[var(--muted-foreground)]">已入帳</p>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
      <div className="space-y-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <input
            type="search"
            placeholder="搜尋說明或商家"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] pl-9 pr-3 text-[15px] focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)]"
          />
        </div>
        <div className="flex gap-2">
          <Button
            variant={showDeleted ? "primary" : "outline"}
            className="h-11 px-3 text-[13px]"
            onClick={() => setShowDeleted((v) => !v)}
          >
            <Trash2 className="size-4" /> {showDeleted ? "回收" : "垃圾桶"}
          </Button>
        </div>
      </div>

      <Card className="p-4">
        {groups.length > 0 ? (
          <div className="space-y-4">
            {groups.map((group) => (
              <div key={group.date}>
                <div className="sticky top-[64px] z-[1] -mx-1 mb-1 rounded-md bg-[var(--card)] px-2 py-1.5 text-[12px] font-bold text-[var(--muted-foreground)]">
                  {dateFormat(group.date)}
                </div>
                <ExpenseList
                  expenses={group.items}
                  users={users}
                  onEdit={onEdit}

                />
                {showDeleted && (
                  <div className="flex flex-wrap justify-end gap-1 pt-2">
                    {group.items.filter((e) => !e.mirror_kind).map((e) => (
                      <button
                        key={e.id}
                        className="rounded-md px-2 py-1 text-[12px] font-semibold text-destructive hover:bg-destructive/10"
                        onClick={() => onDelete(e)}
                      >
                        {e.deleted_at ? "復原" : "刪除"}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty
            icon={<Search />}
            title="找不到符合條件的流水"
            description="試試看其他關鍵字或分類"
            className="py-10"
          />
        )}
      </Card>
    </div>
  );
}
