"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus } from "lucide-react";

type BalanceSuggestion = {
  expenseId: string;
  description: string;
  amountTwd: number;
  expenseDate: string;
};

function money(n: number) {
  return `NT$${Math.abs(n).toLocaleString()}`;
}

interface BalanceCardsProps {
  groupName: string;
  groupColor: string;
  balance: number;
  suggestions: BalanceSuggestion[];
  onSettle(amount: number): void;
  onAdd(): void;
}

export function BalanceCards({
  groupName,
  groupColor,
  balance,
  suggestions,
  onSettle,
  onAdd,
}: BalanceCardsProps) {
  const [partialAmount, setPartialAmount] = useState("");
  const owed = Math.abs(balance);
  const isPositive = balance > 0;
  const isSettled = balance === 0;

  return (
    <div className="space-y-3">
      <Card
        className="relative overflow-hidden border-0 text-white"
        style={{
          background: `linear-gradient(135deg, ${groupColor || "#0f2f52"}, #0c2744)`,
        }}
      >
        <div className="pointer-events-none absolute -right-8 -top-12 h-44 w-44 rounded-full border-[30px] border-white/5" />
        <CardContent className="relative z-10 p-5">
          <p className="flex items-center gap-1.5 text-sm font-medium text-white/80">
            💰 {groupName} · 目前餘額
          </p>
          <p className="mt-2.5 text-[26px] font-extrabold tracking-tight">
            {isSettled
              ? "已結清 ✨"
              : isPositive
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

              {suggestions.length > 0 && (
                <div className="border-t border-white/15 pt-2.5">
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/60">
                    建議先結清
                  </p>
                  <ul className="space-y-1 text-sm text-white/90">
                    {suggestions.map((s) => (
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
    </div>
  );
}
