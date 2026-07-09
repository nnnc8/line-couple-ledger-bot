"use client";

import * as React from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { money, shortMoney } from "@/lib/format";
import { tagColor } from "@/lib/categories";

interface TagBarChartProps {
  data: Array<{ tag: string; amount: number }>;
}

export function TagBarChart({ data }: TagBarChartProps) {
  if (data.length === 0) return null;
  const top5 = data.slice(0, 5);

  return (
    <ResponsiveContainer width="100%" height={160}>
      <BarChart
        data={top5}
        layout="vertical"
        margin={{ top: 0, right: 16, bottom: 0, left: 0 }}
      >
        <XAxis
          type="number"
          tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
          tickFormatter={(v: number) => shortMoney(v)}
        />
        <YAxis
          type="category"
          dataKey="tag"
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          width={60}
        />
        <Tooltip
          formatter={(value) => [money(Number(value)), "金額"]}
          contentStyle={{
            borderRadius: "8px",
            border: "1px solid var(--border)",
            fontSize: "13px",
          }}
        />
        <Bar dataKey="amount" radius={[0, 4, 4, 0]}>
          {top5.map((entry) => (
            <Cell key={entry.tag} fill={tagColor(entry.tag)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
