"use client";

import * as React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import { shortMoney, money } from "@/lib/format";

interface SpendingTrendProps {
  data: Array<{ date: string; thisMonth: number; lastMonth: number }>;
}

export function SpendingTrend({ data }: SpendingTrendProps) {
  if (data.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
          tickFormatter={(d: string) => d.slice(5)}
        />
        <YAxis
          tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
          tickFormatter={(v: number) => shortMoney(v)}
          width={50}
        />
        <Tooltip
          formatter={(value, name) => [money(Number(value)), name === "thisMonth" ? "本月" : "上月"]}
          contentStyle={{
            borderRadius: "8px",
            border: "1px solid var(--border)",
            fontSize: "13px",
          }}
        />
        <Legend
          formatter={(value: string) => (value === "thisMonth" ? "本月" : "上月")}
          wrapperStyle={{ fontSize: "11px" }}
        />
        <Line
          type="monotone"
          dataKey="thisMonth"
          stroke="#2563EB"
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="lastMonth"
          stroke="#94A3B8"
          strokeWidth={1.5}
          strokeDasharray="5 5"
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
