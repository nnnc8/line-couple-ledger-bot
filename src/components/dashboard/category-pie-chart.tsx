"use client";

import { Inbox } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Pie, PieChart, Cell } from "recharts";

function money(n: number) {
  return `NT$${Math.abs(n).toLocaleString()}`;
}

const palette = [
  "#0f2f52",
  "#1a4a7a",
  "#3a7fc2",
  "#68a8e0",
  "#b3d1f0",
  "#e2effa",
  "#f4a261",
  "#e76f51",
  "#2a9d8f",
  "#264653",
  "#f2cc8f",
  "#d4a373",
];

type CategoryRow = {
  label: string;
  totalTwd: number;
  count: number;
  percent: number;
};

interface CategoryPieChartProps {
  categories: CategoryRow[];
  totalTwd: number;
  selectedCategory: string | null;
  onSelectCategory(label: string | null): void;
}

export function CategoryPieChart({
  categories,
  totalTwd,
  selectedCategory,
  onSelectCategory,
}: CategoryPieChartProps) {
  const chartData = categories.map((c, i) => ({
    name: c.label,
    value: c.totalTwd,
    fill: palette[i % palette.length],
  }));

  const config: ChartConfig = Object.fromEntries(
    categories.map((c, i) => [
      c.label,
      { label: c.label, color: palette[i % palette.length] },
    ]),
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              支出分析
            </p>
            <CardTitle className="text-base">分類占比</CardTitle>
          </div>
          <span className="text-sm font-bold tabular-nums">{money(totalTwd)}</span>
        </div>
      </CardHeader>
      <CardContent>
        {categories.length > 0 ? (
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:gap-4">
            {/* Donut chart */}
            <div className="relative h-[160px] w-[160px] shrink-0 sm:h-[180px] sm:w-[180px]">
              <ChartContainer config={config} className="h-full w-full">
                <PieChart>
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value) => money(Number(value))}
                      />
                    }
                  />
                  <Pie
                    data={chartData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={48}
                    outerRadius={72}
                    strokeWidth={2}
                    stroke="#ffffff"
                  >
                    {chartData.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={entry.fill}
                        className={
                          selectedCategory &&
                          selectedCategory !== entry.name
                            ? "opacity-40"
                            : ""
                        }
                        style={{ cursor: "pointer" }}
                        onClick={() =>
                          onSelectCategory(
                            selectedCategory === entry.name ? null : entry.name,
                          )
                        }
                      />
                    ))}
                  </Pie>
                </PieChart>
              </ChartContainer>
              {/* Center label */}
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-xl font-extrabold sm:text-2xl">
                  {categories.length}
                </span>
                <span className="text-[10px] text-muted-foreground">分類</span>
              </div>
            </div>

            {/* Legend list */}
            <div className="w-full flex-1 space-y-1 sm:w-auto">
              {categories.slice(0, 6).map((cat, index) => {
                const pct =
                  totalTwd > 0
                    ? Math.round((cat.totalTwd / totalTwd) * 100)
                    : 0;
                const active = selectedCategory === cat.label;
                return (
                  <button
                    type="button"
                    key={cat.label}
                    className={`flex min-h-[40px] w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors active:scale-[0.99] hover:bg-muted ${
                      active ? "bg-muted ring-1 ring-ring" : ""
                    }`}
                    onClick={() =>
                      onSelectCategory(
                        selectedCategory === cat.label ? null : cat.label,
                      )
                    }
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ background: palette[index % palette.length] }}
                    />
                    <span className="flex-1 truncate">{cat.label}</span>
                    <span className="font-medium tabular-nums">
                      {money(cat.totalTwd)}
                    </span>
                    <span className="w-10 text-right text-xs text-muted-foreground">
                      {pct}%
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-muted-foreground">
            <Inbox className="h-8 w-8 opacity-40" />
            <p className="text-sm">這個範圍還沒有共同支出</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
