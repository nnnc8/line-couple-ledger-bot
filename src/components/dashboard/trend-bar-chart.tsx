"use client";

import { TrendingDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function shortMoney(n: number) {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}萬`;
  return n.toLocaleString();
}

type TrendPoint = { month: string; totalTwd: number };

interface TrendBarChartProps {
  trend: TrendPoint[];
  selectedMonth: string | null;
  onSelectMonth(month: string | null): void;
}

export function TrendBarChart({
  trend,
  selectedMonth,
  onSelectMonth,
}: TrendBarChartProps) {
  const maxTrend = Math.max(1, ...trend.map((p) => p.totalTwd));

  return (
    <Card>
      <CardHeader className="pb-2">
        <div>
          <p className="text-xs font-medium text-muted-foreground">趨勢</p>
          <CardTitle className="text-base">近六個月</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        {trend.some((p) => p.totalTwd > 0) ? (
          <div className="flex gap-1">
            {trend.map((point) => {
              const active = selectedMonth === point.month;
              return (
                <button
                  type="button"
                  key={point.month}
                  className={`flex min-h-[120px] flex-1 flex-col items-center justify-between rounded-lg py-2 transition-colors active:scale-[0.98] hover:bg-muted ${
                    active ? "bg-muted ring-1 ring-ring" : ""
                  }`}
                  onClick={() =>
                    onSelectMonth(
                      selectedMonth === point.month ? null : point.month,
                    )
                  }
                >
                  <span className="text-[11px] font-medium tabular-nums">
                    {point.totalTwd > 0 ? shortMoney(point.totalTwd) : ""}
                  </span>
                  <div className="relative flex h-20 w-full flex-1 items-end justify-center px-1">
                    <div
                      className="w-full max-w-7 rounded-t-md transition-all"
                      style={{
                        height: `${Math.max(4, (point.totalTwd / maxTrend) * 100)}%`,
                        background: active
                          ? "var(--primary)"
                          : "color-mix(in srgb, var(--primary) 45%, transparent)",
                      }}
                    />
                  </div>
                  <span className="text-[11px] font-semibold text-muted-foreground">
                    {Number(point.month.slice(5))}月
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-muted-foreground">
            <TrendingDown className="h-8 w-8 opacity-40" />
            <p className="text-sm">近六個月尚無支出</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
