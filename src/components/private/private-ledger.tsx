"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { Empty } from "@/components/ui/empty";
import { Inbox } from "lucide-react";
import { HistorySection } from "@/components/history/history-section";
import { useCategoryAnalytics } from "@/hooks/use-analytics";
import { donutGradient, money } from "@/lib/format";
import { tagColor } from "@/lib/categories";
import type { Bootstrap, Expense } from "@/lib/types";

type Range = "this_month" | "six_months" | "all";

interface PrivateLedgerProps {
  data: Bootstrap;
  onEdit: (expense: Expense) => void;
  onDelete: (expense: Expense) => void;
}

export function PrivateLedger({
  data,
  onEdit,
  onDelete,
}: PrivateLedgerProps) {
  const [range, setRange] = React.useState<Range>("this_month");
  const privateExpenses =
    data.privateExpenses ??
    data.expenses.filter(
      (e) => e.ledger === "private" && e.created_by_user_id === data.user.id,
    );
  const privateDashboard = data.privateDashboard ?? {
    monthlyTotalTwd: 0,
    monthlyCount: 0,
    categoryTotals: {},
    trend: [],
    recent: [],
  };

  const analytics = useCategoryAnalytics(range, "private");
  const fallbackCategories = Object.entries(privateDashboard.categoryTotals)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({
      tag: key,
      label: key,
      value,
      color: tagColor(key),
    }));
  const categoryRows = (analytics?.categories.length ?? 0)
    ? analytics!.categories.map((c) => {
        const tag = c.tag || (c as any).label || "其他";
        return {
          tag,
          label: tag,
          value: c.totalTwd,
          color: tagColor(tag),
        };
      })
    : fallbackCategories;
  const categoryTotal = analytics?.totalTwd ?? privateDashboard.monthlyTotalTwd;

  return (
    <div className="space-y-3">
      <div
        className="rounded-2xl p-5 text-[var(--primary-foreground)]"
        style={{
          background:
            "linear-gradient(135deg, #4a5470, #2d3a52)",
        }}
      >
        <p className="text-[13px] font-medium text-white/85">👤 私人帳</p>
        <p className="mt-2 text-[26px] font-extrabold tracking-tight">
          {money(privateDashboard.monthlyTotalTwd)}
        </p>
        <p className="mt-2 text-[12px] text-white/70">
          本月 {privateDashboard.monthlyCount} 筆，含共同帳自動分攤
        </p>
      </div>

      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[12px] font-medium text-[var(--muted-foreground)]">
              私人支出分析
            </p>
            <h2 className="text-base font-bold">分類占比</h2>
          </div>
          <span className="text-[15px] font-bold tabular-nums">
            {money(categoryTotal)}
          </span>
        </div>
        <div className="mt-3">
          <Segmented
            value={range}
            onValueChange={(v) => setRange(v)}
            options={[
              { value: "this_month", label: "本月" },
              { value: "six_months", label: "近六月" },
              { value: "all", label: "全部" },
            ]}
          />
        </div>
        {categoryRows.length > 0 ? (
          <div className="mt-5 flex flex-col items-center gap-4 sm:flex-row">
            <div
              className="relative size-[150px] shrink-0 rounded-full"
              style={{ background: donutGradient(categoryRows, categoryTotal) }}
            >
              <div className="absolute inset-[22%] grid place-items-center rounded-full bg-[var(--card)]">
                <div className="text-center">
                  <p className="text-xl font-extrabold leading-none">
                    {categoryRows.length}
                  </p>
                  <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">
                    分類
                  </p>
                </div>
              </div>
            </div>
            <div className="w-full space-y-1">
              {categoryRows.slice(0, 6).map((cat) => {
                const pct =
                  categoryTotal > 0
                    ? Math.round((cat.value / categoryTotal) * 100)
                    : 0;
                return (
                  <div
                    key={cat.label}
                    className="flex min-h-[36px] items-center gap-2 rounded-lg px-2 py-1.5 text-[13px]"
                  >
                    <span
                      className="size-2.5 shrink-0 rounded-sm"
                      style={{ background: cat.color }}
                    />
                    <span className="flex-1 truncate">{cat.label}</span>
                    <span className="font-semibold tabular-nums">{money(cat.value)}</span>
                    <span className="w-9 text-right text-[11px] text-[var(--muted-foreground)]">
                      {pct}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <Empty
            icon={<Inbox />}
            title="私人帳還沒有支出"
            className="py-8"
          />
        )}
      </Card>

      <HistorySection
        expenses={privateExpenses}
        users={data.users}
        onEdit={onEdit}
        onDelete={onDelete}

      />
    </div>
  );
}