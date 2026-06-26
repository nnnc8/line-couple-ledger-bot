"use client";

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
        <div className="flex gap-1.5">
          {trend.map((point) => {
            const active = selectedMonth === point.month;
            return (
              <button
                type="button"
                key={point.month}
                className={`flex flex-1 flex-col items-center gap-1 rounded-md py-2 transition-colors hover:bg-muted ${
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
                <div className="relative flex h-24 w-full items-end justify-center">
                  <div
                    className="w-full max-w-8 rounded-t-sm transition-all"
                    style={{
                      height: `${Math.max(4, (point.totalTwd / maxTrend) * 100)}%`,
                      background: active
                        ? "var(--primary)"
                        : "color-mix(in srgb, var(--primary) 40%, transparent)",
                    }}
                  />
                </div>
                <span className="text-xs text-muted-foreground">
                  {Number(point.month.slice(5))}月
                </span>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
