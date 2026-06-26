"use client";

import { useState, useEffect } from "react";
import type {
  Bootstrap,
  Group,
  Expense,
  CategoryAnalytics,
  BalanceSuggestion,
} from "@/lib/types";
import { CategoryPieChart } from "@/components/dashboard/category-pie-chart";
import { TrendBarChart } from "@/components/dashboard/trend-bar-chart";
import { TransactionList } from "@/components/dashboard/transaction-list";
import { MetricCards } from "@/components/dashboard/metric-cards";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus } from "lucide-react";

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

function money(n: number) {
  return `NT$${Math.abs(n).toLocaleString()}`;
}

interface DashboardProps {
  data: Bootstrap;
  activeGroup: Group;
  onSettle(amount: number): void;
  onAdd(): void;
  onEdit(expense: Expense): void;
  onReceipt(id: string): void;
}

export function Dashboard({
  data,
  activeGroup,
  onSettle,
  onAdd,
  onEdit,
  onReceipt,
}: DashboardProps) {
  const [partialAmount, setPartialAmount] = useState("");
  const [categoryRange, setCategoryRange] =
    useState<CategoryAnalytics["range"]>("this_month");
  const [analytics, setAnalytics] = useState<CategoryAnalytics | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<BalanceSuggestion[]>([]);

  const mine =
    data.balances.find((item) => item.user_id === data.user.id)?.balance_twd ?? 0;
  const owed = Math.abs(mine);

  useEffect(() => {
    let cancelled = false;
    void fetch(
      `/api/app/analytics/categories?range=${categoryRange}&scope=shared`,
      { cache: "no-store" },
    )
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch analytics");
        return res.json() as Promise<CategoryAnalytics>;
      })
      .then((result) => {
        if (!cancelled) setAnalytics(result);
      })
      .catch(() => {
        if (!cancelled) setAnalytics(null);
      });
    return () => { cancelled = true; };
  }, [categoryRange, data.activeGroupId]);

  useEffect(() => {
    if (owed <= 0) return;
    let cancelled = false;
    void fetch("/api/app/balance/detail", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch balance detail");
        return res.json() as Promise<{ suggestions: BalanceSuggestion[] }>;
      })
      .then((result) => {
        if (!cancelled) {
          setSuggestions(result.suggestions);
        }
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => { cancelled = true; };
  }, [owed, data.activeGroupId, data.balances]);

  const fallbackCategories = Object.entries(data.dashboard.categoryTotals)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([category, value]) => ({
      label: categoryNames[category] ?? category,
      totalTwd: value,
      count: 0,
      percent: 0,
    }));

  const categoryRows = analytics?.categories.length
    ? analytics.categories
    : fallbackCategories;
  const categoryTotal = analytics?.totalTwd ?? data.dashboard.monthlyTotalTwd;
  const budget = data.budgets.find((item) => item.category === null);
  const budgetPercent = budget
    ? Math.min(
        100,
        Math.round(
          (data.dashboard.monthlyTotalTwd / Number(budget.limit_twd)) * 100,
        ),
      )
    : 0;

  const visibleSuggestions = owed > 0 ? suggestions : [];

  return (
    <div className="space-y-4 px-1 pb-20">
      {/* Balance card */}
      <Card
        className="relative overflow-hidden border-0 text-white"
        style={{
          background: `linear-gradient(135deg, ${activeGroup.color || "#0f2f52"}, #0c2744)`,
        }}
      >
        <div className="pointer-events-none absolute -right-8 -top-12 h-44 w-44 rounded-full border-[30px] border-white/5" />
        <CardContent className="relative z-10 p-5">
          <p className="flex items-center gap-1.5 text-sm font-medium text-white/80">
            💰 {activeGroup.name} · 目前餘額
          </p>
          <p className="mt-2.5 text-[26px] font-extrabold tracking-tight">
            {mine === 0
              ? "已結清 ✨"
              : mine > 0
                ? `另一半欠你 ${money(owed)}`
                : `你欠另一半 ${money(owed)}`}
          </p>

          {owed > 0 && (
            <div className="mt-4 space-y-2.5">
              <div className="flex gap-2">
                <Input
                  inputMode="numeric"
                  placeholder={`部分結清（最多 ${owed}）`}
                  value={partialAmount}
                  onChange={(e) => setPartialAmount(e.target.value)}
                  className="h-10 border-white/25 bg-white/15 text-white placeholder:text-white/60 focus-visible:border-white/50 focus-visible:ring-white/15"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-10 bg-white/20 text-white hover:bg-white/30"
                  onClick={() => {
                    const amount = Number(partialAmount);
                    if (amount > 0 && amount <= owed) onSettle(amount);
                  }}
                >
                  部分結清
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-10 bg-white/25 font-bold text-white hover:bg-white/35"
                  onClick={() => onSettle(owed)}
                >
                  全額結清 ✓
                </Button>
              </div>

              {visibleSuggestions.length > 0 && (
                <div className="border-t border-white/15 pt-2.5">
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/60">
                    建議先結清
                  </p>
                  <ul className="space-y-1 text-sm text-white/90">
                    {visibleSuggestions.map((s) => (
                      <li key={s.expenseId}>
                        {s.description} {money(s.amountTwd)}（
                        {s.expenseDate.slice(5).replace("-", "/")}）
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-4 bg-white/15 text-white hover:bg-white/25"
            onClick={onAdd}
          >
            <Plus className="mr-1 h-4 w-4" /> 新增支出
          </Button>
        </CardContent>
      </Card>

      {/* Metric cards */}
      <MetricCards
        monthlyTotal={data.dashboard.monthlyTotalTwd}
        monthlyCount={data.dashboard.monthlyCount}
        budgetPercent={budgetPercent}
        budgetSet={!!budget}
      />

      {/* Category pie chart + range selector */}
      <CategoryPieChart
        categories={categoryRows}
        totalTwd={categoryTotal}
        selectedCategory={selectedCategory}
        onSelectCategory={setSelectedCategory}
      />
      <div className="flex gap-1.5">
        {(["this_month", "six_months", "all"] as const).map((range) => (
          <Button
            key={range}
            type="button"
            variant={categoryRange === range ? "default" : "outline"}
            size="sm"
            className="flex-1"
            onClick={() => {
              setCategoryRange(range);
              setSelectedCategory(null);
            }}
          >
            {range === "this_month" ? "本月" : range === "six_months" ? "近六月" : "全部"}
          </Button>
        ))}
      </div>

      {/* Trend bar chart */}
      <TrendBarChart
        trend={data.dashboard.trend}
        selectedMonth={selectedMonth}
        onSelectMonth={setSelectedMonth}
      />

      {/* Transaction list */}
      <TransactionList
        expenses={data.dashboard.recent}
        users={data.users}
        onEdit={onEdit}
        onReceipt={onReceipt}
      />
    </div>
  );
}
