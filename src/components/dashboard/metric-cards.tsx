"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

function money(n: number) {
  return `NT$${Math.abs(n).toLocaleString()}`;
}

interface MetricCardsProps {
  monthlyTotal: number;
  monthlyCount: number;
  budgetPercent: number;
  budgetSet: boolean;
}

export function MetricCards({
  monthlyTotal,
  monthlyCount,
  budgetPercent,
  budgetSet,
}: MetricCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Card>
        <CardContent className="p-3.5 sm:p-4">
          <p className="text-xs font-medium text-muted-foreground">
            📊 本月共同支出
          </p>
          <p className="mt-1.5 text-lg font-bold tabular-nums sm:text-xl">
            {money(monthlyTotal)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {monthlyCount} 筆交易
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-3.5 sm:p-4">
          <p className="text-xs font-medium text-muted-foreground">
            🎯 月預算
          </p>
          <p className="mt-1.5 text-lg font-bold tabular-nums sm:text-xl">
            {budgetSet ? `${budgetPercent}%` : "未設定"}
          </p>
          {budgetSet && (
            <Progress
              value={budgetPercent}
              className={`mt-2 h-2 ${budgetPercent >= 80 ? "[&>div]:bg-destructive" : ""}`}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
