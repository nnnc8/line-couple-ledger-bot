"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Search, Pencil, Trash2, RotateCcw, Image } from "lucide-react";
import type { Expense, User } from "@/lib/types";

function money(n: number) {
  return `NT$${Math.abs(n).toLocaleString()}`;
}

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

function displayCategoryLabel(expense: Expense): string {
  if (expense.custom_category_label) return expense.custom_category_label;
  return categoryNames[expense.category] ?? expense.category;
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  return `${month}/${day}（${weekdays[d.getDay()]}）`;
}

interface HistorySectionProps {
  expenses: Expense[];
  users: User[];
  onEdit(expense: Expense): void;
  onDelete(expense: Expense): void;
  onReceipt(id: string): void;
}

export function HistorySection({
  expenses,
  users,
  onEdit,
  onDelete,
  onReceipt,
}: HistorySectionProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [deleted, setDeleted] = useState(false);

  const filtered = expenses
    .filter(
      (expense) =>
        (deleted ? !!expense.deleted_at : !expense.deleted_at) &&
        (category === "all" || expense.category === category) &&
        `${expense.description} ${expense.merchant ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) => b.expense_date.localeCompare(a.expense_date));

  // Group by date
  const dateGroups: Array<{ date: string; items: Expense[] }> = [];
  for (const expense of filtered) {
    const last = dateGroups[dateGroups.length - 1];
    if (last && last.date === expense.expense_date) {
      last.items.push(expense);
    } else {
      dateGroups.push({ date: expense.expense_date, items: [expense] });
    }
  }

  return (
    <div className="space-y-4 px-1 pb-20">
      {/* Search + Filters */}
      <div className="space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="搜尋說明或商家"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex gap-2">
          <Select value={category} onValueChange={(v) => setCategory(v ?? "all")}>
            <SelectTrigger className="h-9 flex-1">
              <SelectValue placeholder="全部分類" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部分類</SelectItem>
              {Object.entries(categoryNames).map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant={deleted ? "default" : "outline"}
            size="sm"
            className="h-9"
            onClick={() => setDeleted(!deleted)}
          >
            🗑️ 垃圾桶
          </Button>
        </div>
      </div>

      {/* Transaction list */}
      <Card>
        <CardContent className="p-0">
          {dateGroups.length > 0 ? (
            <div className="divide-y">
              {dateGroups.map((group) => (
                <div key={group.date}>
                  <div className="sticky top-0 z-10 bg-muted/80 px-4 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur">
                    {formatDate(group.date)}
                  </div>
                  <div className="divide-y">
                    {group.items.map((expense) => {
                      const emoji = categoryEmojis[expense.category] ?? "📦";
                      const label = displayCategoryLabel(expense);
                      const payer = users.find(
                        (u) => u.id === expense.paid_by_user_id,
                      );

                      return (
                        <div
                          key={expense.id}
                          className={`flex items-center gap-3 px-4 py-3 ${
                            expense.deleted_at ? "opacity-40" : ""
                          } ${expense._optimistic ? "animate-pulse" : ""}`}
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
                              {payer?.label ?? "???"}付款
                              {expense.ledger === "private" ? (
                                <>
                                  {" · "}
                                  <span className="inline-flex items-center rounded-sm bg-orange-100 px-1 text-[10px] text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
                                    {expense.mirror_kind ? "共同分攤" : "私人"}
                                  </span>{" "}
                                  {label}
                                </>
                              ) : (
                                <> · {label}</>
                              )}
                            </p>
                          </div>
                          <span className="shrink-0 text-sm font-semibold tabular-nums">
                            {money(expense.amount_twd)}
                          </span>
                          <div className="flex shrink-0 gap-1">
                            {!expense.deleted_at && !expense.mirror_kind && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => onEdit(expense)}
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                            )}
                            {expense.receipts[0] && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => onReceipt(expense.receipts[0]!.id)}
                              >
                                <Image className="h-3 w-3" />
                              </Button>
                            )}
                            {!expense.mirror_kind && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className={`h-7 w-7 p-0 ${
                                  expense.deleted_at
                                    ? "text-green-600"
                                    : "text-destructive"
                                }`}
                                onClick={() => onDelete(expense)}
                              >
                                {expense.deleted_at ? (
                                  <RotateCcw className="h-3 w-3" />
                                ) : (
                                  <Trash2 className="h-3 w-3" />
                                )}
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              🔍 找不到符合條件的流水
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
