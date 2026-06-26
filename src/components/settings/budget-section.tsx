"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Target } from "lucide-react";
import type { Bootstrap } from "@/lib/types";

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

interface BudgetSectionProps {
  data: Bootstrap;
  onSave(body: unknown): void;
}

export function BudgetSection({ data, onSave }: BudgetSectionProps) {
  const [category, setCategory] = useState("total");
  const [categoryLabel, setCategoryLabel] = useState("");
  const [limit, setLimit] = useState("");
  const [error, setError] = useState("");

  return (
    <div className="space-y-4 px-1 pb-20">
      {/* Current budgets */}
      <Card>
        <CardHeader className="pb-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              {data.month}
            </p>
            <CardTitle className="text-base">本月預算</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {data.budgets.length > 0 ? (
            <div className="space-y-4">
              {data.budgets.map((budget) => {
                const spent = budget.category_label
                  ? data.sharedExpenses
                      .filter(
                        (expense) =>
                          !expense.deleted_at &&
                          expense.expense_date.startsWith(data.month) &&
                          expense.category === budget.category &&
                          expense.category_label === budget.category_label,
                      )
                      .reduce((sum, expense) => sum + expense.amount_twd, 0)
                  : budget.category
                    ? (data.dashboard.categoryTotals[budget.category] ?? 0)
                    : data.dashboard.monthlyTotalTwd;
                const percent = Math.round(
                  (spent / Number(budget.limit_twd)) * 100,
                );
                const isOver = percent >= 100;
                const isWarn = percent >= 80;

                return (
                  <div key={budget.id} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">
                          {budget.category
                            ? `${categoryEmojis[budget.category] ?? "📦"} ${budget.category_label ?? categoryNames[budget.category]}`
                            : "📋 群組總預算"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {money(spent)} / {money(Number(budget.limit_twd))}
                        </p>
                      </div>
                      <span
                        className={`text-sm font-bold tabular-nums ${
                          isOver
                            ? "text-destructive"
                            : isWarn
                              ? "text-yellow-600"
                              : ""
                        }`}
                      >
                        {percent}%
                      </span>
                    </div>
                    <Progress
                      value={Math.min(100, percent)}
                      className={`h-2 ${
                        isOver
                          ? "[&>div]:bg-destructive"
                          : isWarn
                            ? "[&>div]:bg-yellow-500"
                            : ""
                      }`}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              🎯 尚未設定本月預算
            </p>
          )}
        </CardContent>
      </Card>

      {/* Add / edit budget */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">新增或調整預算</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">範圍</Label>
              <Select value={category} onValueChange={(v) => setCategory(v ?? "total")}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="total">群組總額</SelectItem>
                  {Object.entries(categoryNames).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">細分類標籤（選填）</Label>
              <Input
                value={categoryLabel}
                disabled={category === "total"}
                onChange={(e) => setCategoryLabel(e.target.value)}
                placeholder="例如：外食、油資"
                className="h-9"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">上限（TWD）</Label>
            <Input
              inputMode="numeric"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="例如：30000"
              className="h-9"
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button
            className="w-full"
            onClick={() => {
              const numLimit = Number(limit);
              if (!numLimit || numLimit <= 0) {
                setError("請輸入有效的預算金額");
                return;
              }
              setError("");
              onSave({
                id: null,
                groupId: data.activeGroupId,
                category: category === "total" ? null : category,
                categoryLabel: category === "total" ? null : categoryLabel || null,
                limitTwd: numLimit,
              });
              setLimit("");
              setCategoryLabel("");
            }}
          >
            <Target className="mr-1 h-4 w-4" /> 儲存預算
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
