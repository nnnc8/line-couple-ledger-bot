"use client";

import * as React from "react";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { money } from "@/lib/format";

interface CategoryPieChartProps {
  data: Array<{ tag: string; value: number; color: string }>;
  total: number;
  onSelect?: (tag: string | null) => void;
  selected?: string | null;
}

export function CategoryPieChart({
  data,
  total,
  onSelect,
  selected,
}: CategoryPieChartProps) {
  if (data.length === 0) {
    return null;
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="tag"
          cx="50%"
          cy="50%"
          innerRadius={45}
          outerRadius={80}
          paddingAngle={2}
          onClick={(entry: any) => {
            const tag = entry?.tag;
            if (onSelect && tag) {
              onSelect(selected === tag ? null : tag);
            }
          }}
        >
          {data.map((entry) => (
            <Cell
              key={entry.tag}
              fill={entry.color}
              stroke={selected === entry.tag ? "#fff" : "none"}
              strokeWidth={selected === entry.tag ? 2 : 0}
              style={{ cursor: "pointer" }}
            />
          ))}
        </Pie>
        <Tooltip
          formatter={(value, name) => [
            `${money(Number(value))} (${total > 0 ? Math.round((Number(value) / total) * 100) : 0}%)`,
            String(name),
          ]}
          contentStyle={{
            borderRadius: "8px",
            border: "1px solid var(--border)",
            fontSize: "13px",
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
