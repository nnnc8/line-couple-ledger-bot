"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Expense, User } from "@/lib/types";

function money(n: number) {
  return `NT$${Math.abs(n).toLocaleString()}`;
}

const categoryEmojis: Record<string, string> = {
  food: "🍜",
  transport: "🚌",
  shopping: "🛍️",
  entertainment: "🎬",
  housing: "🏠",
  utilities: "💡",
  health: "🏥",
  education: "📚",
  travel: "✈️",
  other: "📦",
};

const categoryNames: Record<string, string> = {
  food: "餐飲",
  transport: "交通",
  shopping: "購物",
  entertainment: "娛樂",
  housing: "住房",
  utilities: "水電",
  health: "醫療",
  education: "教育",
  travel: "旅行",
  other: "其他",
};

function displayCategoryLabel(expense: Expense): string {
  if (expense.custom_category_label) return expense.custom_category_label;
  return categoryNames[expense.category] ?? expense.category;
}

interface TransactionListProps {
  expenses: Expense[];
  users: User[];
  onEdit?(expense: Expense): void;
  onReceipt?(id: string): void;
}

export function TransactionList({
  expenses,
  users,
  onEdit,
}: TransactionListProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div>
          <p className="text-xs font-medium text-muted-foreground">最新動態</p>
          <CardTitle className="text-base">最近流水</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        {expenses.length > 0 ? (
          <div className="space-y-1">
            {expenses.map((expense) => {
              const emoji = categoryEmojis[expense.category] ?? "📦";
              const label = displayCategoryLabel(expense);
              const payer = users.find(
                (u) => u.id === expense.paid_by_user_id,
              );

              return (
                <button
                  key={expense.id}
                  type="button"
                  className={`flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-muted ${
                    expense.deleted_at ? "opacity-40" : ""
                  } ${expense._optimistic ? "animate-pulse" : ""}`}
                  onClick={() => onEdit?.(expense)}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-lg">
                    {emoji}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">
                        {expense.description}
                      </span>
                      {expense._optimistic && (
                        <Badge
                          variant="secondary"
                          className="h-4 shrink-0 px-1 text-[10px]"
                        >
                          同步中
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {expense.expense_date} · {payer?.label ?? "???"}付款 · {label}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">
                    {money(expense.amount_twd)}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            📝 尚無流水
          </p>
        )}
      </CardContent>
    </Card>
  );
}
