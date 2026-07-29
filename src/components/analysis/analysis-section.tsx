"use client";

import * as React from "react";
import { ChartNoAxesCombined, ChevronDown, Inbox } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Segmented } from "@/components/ui/segmented";
import { useCategoryAnalytics } from "@/hooks/use-analytics";
import { get } from "@/lib/api";
import { tagColor, tagTint } from "@/lib/categories";
import { dateFormat, money, monthShort, shortMoney } from "@/lib/format";
import type { Bootstrap, CategoryAnalytics, DashboardData } from "@/lib/types";

type AnalysisScope = CategoryAnalytics["scope"];
type AnalysisRange = CategoryAnalytics["range"];

interface AnalysisSectionProps {
  data: Bootstrap;
  scope: AnalysisScope;
  onScopeChange: (scope: AnalysisScope) => void;
}

type DrillExpense = {
  id: string;
  description: string;
  merchant: string | null;
  amount_twd: number;
  expense_date: string;
  tag: string;
};

type DrillResponse = {
  total: number;
  expenses: DrillExpense[];
};

type DrillState = DrillResponse & {
  key: string;
  failed?: boolean;
};

export function AnalysisSection({
  data,
  scope,
  onScopeChange,
}: AnalysisSectionProps) {
  const [range, setRange] = React.useState<AnalysisRange>("this_month");
  const [selectedCategory, setSelectedCategory] = React.useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = React.useState<string | null>(null);
  const [drill, setDrill] = React.useState<DrillState | null>(null);
  const analytics = useCategoryAnalytics(range, scope);
  const analyticsReady =
    analytics?.range === range && analytics.scope === scope ? analytics : null;
  const categories =
    analyticsReady?.categories ??
    (range === "this_month" ? fallbackCategories(data, scope) : []);
  const categoryTotal =
    analyticsReady?.totalTwd ??
    (range === "this_month" ? monthlyTotal(data, scope) : 0);
  const trend = trendForScope(data.dashboard, data.privateDashboard, scope);
  const maxTrend = Math.max(1, ...trend.map((point) => point.totalTwd));
  const drillKey = selectedCategory
    ? drillQuery(selectedCategory, range, scope, selectedMonth)
    : "";
  const activeDrill = drill?.key === drillKey ? drill : null;

  React.useEffect(() => {
    if (!drillKey) return;
    let cancelled = false;
    void get<DrillResponse>(`/api/app/analytics/expenses?${drillKey}`)
      .then((result) => {
        if (!cancelled) setDrill({ ...result, key: drillKey });
      })
      .catch(() => {
        if (!cancelled) setDrill({ key: drillKey, total: 0, expenses: [], failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [drillKey]);

  function changeScope(next: AnalysisScope) {
    onScopeChange(next);
    setSelectedCategory(null);
    setSelectedMonth(null);
  }

  function changeRange(next: AnalysisRange) {
    setRange(next);
    setSelectedCategory(null);
    setSelectedMonth(null);
  }

  function selectTrendMonth(month: string) {
    const next = selectedMonth === month ? null : month;
    setSelectedMonth(next);
    if (next && next !== data.month && range === "this_month") {
      setRange("six_months");
      setSelectedCategory(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <div>
          <p className="text-[13px] font-semibold text-[var(--muted-foreground)]">
            查看範圍
          </p>
          <h2 className="text-lg font-bold">你的支出結構</h2>
        </div>
        <Segmented
          ariaLabel="帳本範圍"
          value={scope}
          onValueChange={changeScope}
          className="grid w-full grid-cols-3"
          options={[
            { value: "shared", label: "共同" },
            { value: "private", label: "私人" },
            { value: "combined", label: "合併" },
          ]}
        />
      </Card>

      <Card className="p-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[13px] font-semibold text-[var(--muted-foreground)]">
              支出趨勢
            </p>
            <h2 className="text-base font-bold">近六個月</h2>
          </div>
          {selectedMonth ? (
            <button
              type="button"
              className="min-h-11 rounded-xl px-3 text-[13px] font-semibold text-accent"
              onClick={() => setSelectedMonth(null)}
            >
              清除 {monthShort(selectedMonth)}
            </button>
          ) : (
            <p className="text-[13px] text-[var(--muted-foreground)]">點選月份可篩選明細</p>
          )}
        </div>

        {trend.some((point) => point.totalTwd > 0) ? (
          <div className="mt-4 grid h-44 grid-cols-6 gap-1" aria-label="近六個月支出趨勢">
            {trend.map((point) => {
              const active = selectedMonth === point.month;
              const height = Math.max(5, (point.totalTwd / maxTrend) * 100);
              return (
                <button
                  key={point.month}
                  type="button"
                  aria-pressed={active}
                  aria-label={`${monthShort(point.month)} ${money(point.totalTwd)}`}
                  onClick={() => selectTrendMonth(point.month)}
                  className={`flex min-w-0 flex-col items-center justify-end rounded-xl px-0.5 py-2 transition active:scale-[0.98] ${
                    active ? "bg-accent-soft" : "hover:bg-muted"
                  }`}
                >
                  <span className="mb-1 w-full truncate text-center text-[13px] font-semibold tabular-nums">
                    {point.totalTwd > 0 ? shortMoney(point.totalTwd) : "0"}
                  </span>
                  <span className="flex h-24 w-full items-end justify-center">
                    <span
                      className="w-full max-w-7 rounded-t-md bg-accent transition-[height]"
                      style={{
                        height: `${height}%`,
                        opacity: active ? 1 : 0.58,
                      }}
                    />
                  </span>
                  <span className="mt-1 text-[13px] font-semibold text-[var(--muted-foreground)]">
                    {monthShort(point.month)}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <Empty
            icon={<ChartNoAxesCombined />}
            title="近六個月還沒有支出"
            className="py-8"
          />
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[13px] font-semibold text-[var(--muted-foreground)]">
              分類排名
            </p>
            <h2 className="text-base font-bold">{rangeLabel(range)}支出</h2>
          </div>
          <p className="text-[15px] font-bold tabular-nums">{money(categoryTotal)}</p>
        </div>
        <Segmented
          ariaLabel="分類排名期間"
          value={range}
          onValueChange={changeRange}
          className="mt-3 grid w-full grid-cols-3"
          options={[
            { value: "this_month", label: "本月" },
            { value: "six_months", label: "近六月" },
            { value: "all", label: "全部" },
          ]}
        />

        {categories.length > 0 ? (
          <div className="mt-3 divide-y divide-[var(--border)]">
            {categories.slice(0, 8).map((category, index) => {
              const tag = category.tag || "其他";
              const active = selectedCategory === tag;
              const percent =
                category.percent ??
                (categoryTotal > 0
                  ? Math.round((category.totalTwd / categoryTotal) * 100)
                  : 0);
              return (
                <div
                  key={tag}
                  className={`rounded-xl transition ${
                    active ? "bg-muted" : "hover:bg-muted/70"
                  }`}
                >
                  <button
                    type="button"
                    aria-expanded={active}
                    onClick={() => setSelectedCategory(active ? null : tag)}
                    className="w-full rounded-xl px-2 py-3 text-left transition active:scale-[0.99]"
                  >
                    <span className="flex min-h-11 items-center gap-3">
                      <span className="w-5 text-center text-[13px] font-bold text-[var(--muted-foreground)]">
                        {index + 1}
                      </span>
                      <span
                        className="grid size-10 shrink-0 place-items-center rounded-xl text-[14px] font-bold"
                        style={{ background: tagTint(tag), color: tagColor(tag) }}
                      >
                        {tag.charAt(0)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-[15px] font-semibold">{tag}</span>
                          <span className="shrink-0 text-[15px] font-bold tabular-nums">
                            {money(category.totalTwd)}
                          </span>
                        </span>
                        <span className="mt-1 flex items-center gap-2">
                          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                            <span
                              className="block h-full rounded-full"
                              style={{
                                width: `${Math.max(2, percent)}%`,
                                background: tagColor(tag),
                              }}
                            />
                          </span>
                          <span className="w-9 text-right text-[13px] text-[var(--muted-foreground)]">
                            {percent}%
                          </span>
                        </span>
                      </span>
                      <ChevronDown
                        className={`size-4 shrink-0 text-[var(--muted-foreground)] transition ${
                          active ? "rotate-180" : ""
                        }`}
                        aria-hidden="true"
                      />
                    </span>
                  </button>

                  {active ? (
                    <div className="px-2 pb-3">
                      <CategoryDrill
                        category={tag}
                        month={selectedMonth}
                        result={activeDrill}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : analyticsReady ? (
          <Empty
            icon={<Inbox />}
            title="這個範圍還沒有支出"
            description="切換帳本或期間查看其他資料"
            className="py-8"
          />
        ) : (
          <div className="mt-4 space-y-3" aria-label="正在載入分類資料">
            {[0, 1, 2].map((item) => (
              <div key={item} className="h-14 animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function CategoryDrill({
  category,
  month,
  result,
}: {
  category: string;
  month: string | null;
  result: DrillState | null;
}) {
  if (!result) {
    return <p className="pt-3 text-[13px] text-[var(--muted-foreground)]">正在載入明細…</p>;
  }
  if (result.failed) {
    return <p className="pt-3 text-[13px] text-destructive">明細載入失敗，請稍後再試。</p>;
  }
  if (result.expenses.length === 0) {
    return (
      <p className="pt-3 text-[13px] text-[var(--muted-foreground)]">
        {month ? `${monthShort(month)}沒有` : "沒有"}「{category}」明細
      </p>
    );
  }
  return (
    <div className="mt-3 border-t border-[var(--border)] pt-2">
      <p className="py-2 text-[13px] font-semibold text-[var(--muted-foreground)]">
        {month ? `${monthShort(month)} · ` : ""}
        {result.total} 筆
      </p>
      <div className="divide-y divide-[var(--border)]">
        {result.expenses.slice(0, 8).map((expense) => (
          <div key={expense.id} className="flex min-h-12 items-center gap-3 py-2">
            <span className="w-[76px] shrink-0 text-[13px] text-[var(--muted-foreground)]">
              {dateFormat(expense.expense_date)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
              {expense.description}
            </span>
            <span className="shrink-0 text-[14px] font-bold tabular-nums">
              {money(expense.amount_twd)}
            </span>
          </div>
        ))}
      </div>
      {result.total > 8 ? (
        <p className="pt-2 text-[13px] text-[var(--muted-foreground)]">
          顯示金額最高的 8 筆，共 {result.total} 筆
        </p>
      ) : null}
    </div>
  );
}

function trendForScope(
  shared: DashboardData,
  privateDashboard: DashboardData,
  scope: AnalysisScope,
) {
  const sharedByMonth = new Map(
    shared.trend.map((point) => [point.month, point.totalTwd]),
  );
  const privateByMonth = new Map(
    privateDashboard.trend.map((point) => [point.month, point.totalTwd]),
  );
  const months = [...new Set([...sharedByMonth.keys(), ...privateByMonth.keys()])].sort();
  return months.map((month) => ({
    month,
    totalTwd:
      (scope === "private" ? 0 : (sharedByMonth.get(month) ?? 0)) +
      (scope === "shared" ? 0 : (privateByMonth.get(month) ?? 0)),
  }));
}

function monthlyTotal(data: Bootstrap, scope: AnalysisScope) {
  const shared = data.dashboard.monthlyTotalTwd;
  const privateTotal = data.privateDashboard.monthlyTotalTwd;
  if (scope === "shared") return shared;
  if (scope === "private") return privateTotal;
  return shared + privateTotal;
}

function fallbackCategories(data: Bootstrap, scope: AnalysisScope) {
  const totals = new Map<string, number>();
  if (scope !== "private") {
    for (const [tag, amount] of Object.entries(data.dashboard.categoryTotals)) {
      totals.set(tag, (totals.get(tag) ?? 0) + amount);
    }
  }
  if (scope !== "shared") {
    for (const [tag, amount] of Object.entries(data.privateDashboard.categoryTotals)) {
      totals.set(tag, (totals.get(tag) ?? 0) + amount);
    }
  }
  const total = [...totals.values()].reduce((sum, amount) => sum + amount, 0);
  return [...totals]
    .sort((left, right) => right[1] - left[1])
    .map(([tag, totalTwd]) => ({
      tag,
      totalTwd,
      count: 0,
      percent: total ? Math.round((totalTwd / total) * 100) : 0,
    }));
}

function drillQuery(
  label: string,
  range: AnalysisRange,
  scope: AnalysisScope,
  month: string | null,
) {
  const params = new URLSearchParams({
    label,
    range,
    scope,
    offset: "0",
    limit: "50",
  });
  if (month) params.set("month", month);
  return params.toString();
}

function rangeLabel(range: AnalysisRange) {
  if (range === "this_month") return "本月";
  if (range === "six_months") return "近六個月";
  return "全部";
}
