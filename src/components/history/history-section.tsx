"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Empty } from "@/components/ui/empty";
import { Search, Trash2 } from "lucide-react";
import { ExpenseList } from "@/components/dashboard/dashboard";
import { categoryList } from "@/lib/categories";
import { dateFormat } from "@/lib/format";
import type { Expense, User } from "@/lib/types";

interface HistorySectionProps {
  expenses: Expense[];
  users: User[];
  onEdit: (expense: Expense) => void;
  onDelete: (expense: Expense) => void;
  onReceipt: (id: string) => void;
}

export function HistorySection({
  expenses,
  users,
  onEdit,
  onDelete,
  onReceipt,
}: HistorySectionProps) {
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState("all");
  const [showDeleted, setShowDeleted] = React.useState(false);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return expenses
      .filter((e) =>
        showDeleted ? !!e.deleted_at : !e.deleted_at,
      )
      .filter((e) => category === "all" || e.category === category)
      .filter((e) => {
        if (!q) return true;
        return `${e.description} ${e.merchant ?? ""}`.toLowerCase().includes(q);
      })
      .sort((a, b) => b.expense_date.localeCompare(a.expense_date));
  }, [expenses, query, category, showDeleted]);

  const groups: Array<{ date: string; items: Expense[] }> = [];
  for (const e of filtered) {
    const last = groups[groups.length - 1];
    if (last && last.date === e.expense_date) last.items.push(e);
    else groups.push({ date: e.expense_date, items: [e] });
  }

  return (
    <div className="space-y-3 pt-1">
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
          <Select
            value={category}
            onValueChange={setCategory}
            size="md"
            className="flex-1"
            options={[
              { value: "all", label: "全部分類" },
              ...categoryList.map((c) => ({ value: c.key, label: `${c.emoji} ${c.label}` })),
            ]}
          />
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
                  onReceipt={onReceipt}
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