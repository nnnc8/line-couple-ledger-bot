"use client";

import { ArrowLeftRight, CircleCheckBig, Inbox, Lightbulb, Plus } from "lucide-react";
import { AgentTaskBar } from "@/components/dashboard/agent-task-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { useCategoryAnalytics } from "@/hooks/use-analytics";
import { displayTag, tagColor, tagTint } from "@/lib/categories";
import { money, moneyAbs } from "@/lib/format";
import type { Bootstrap, Expense, User } from "@/lib/types";

interface DashboardProps {
  data: Bootstrap;
  onTransfer: () => void;
  onSettle: () => void;
  onAdd: () => void;
  onEdit: (expense: Expense) => void;
  onViewHistory: () => void;
  onRefresh?: () => void;
}

export function Dashboard({
  data,
  onTransfer,
  onSettle,
  onAdd,
  onEdit,
  onViewHistory,
  onRefresh,
}: DashboardProps) {
  const activeGroup = data.groups.find((group) => group.id === data.activeGroupId)!;
  const balance =
    data.balances.find((item) => item.user_id === data.user.id)?.balance_twd ?? 0;
  const sharedMonthly = data.dashboard.monthlyTotalTwd;
  const privateMonthly = data.privateDashboard?.monthlyTotalTwd ?? 0;
  const combinedMonthly = sharedMonthly + privateMonthly;
  const categoryAnalytics = useCategoryAnalytics("this_month", "combined");
  const insight = buildMonthlyInsight(
    data,
    combinedMonthly,
    categoryAnalytics?.scope === "combined" &&
      categoryAnalytics.range === "this_month"
      ? categoryAnalytics.categories
      : undefined,
  );
  const recent = [...data.expenses]
    .filter((expense) => !expense.deleted_at)
    .sort(
      (left, right) =>
        right.expense_date.localeCompare(left.expense_date) ||
        right.id.localeCompare(left.id),
    )
    .slice(0, 5);
  const essentialTasks = data.openTasks
    .filter((task) => task.priority === "high")
    .slice(0, 1);

  return (
    <div className="space-y-4">
      <BalanceHero
        groupName={activeGroup.name}
        groupColor={activeGroup.color || "#142a47"}
        balance={balance}
        onAdd={onAdd}
        onTransfer={onTransfer}
        onSettle={onSettle}
      />

      <Card className="grid grid-cols-3 overflow-hidden">
        <SummaryStat label="共同" value={sharedMonthly} />
        <SummaryStat
          label="私人"
          value={privateMonthly}
          className="border-x border-[var(--border)]"
        />
        <SummaryStat label="本月合計" value={combinedMonthly} />
      </Card>

      {insight ? (
        <Card className="flex items-start gap-3 border-accent/20 bg-accent-soft p-4 shadow-none">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-white text-accent">
            <Lightbulb className="size-5" aria-hidden="true" />
          </div>
          <div>
            <p className="text-[13px] font-semibold text-[var(--muted-foreground)]">
              本月洞察
            </p>
            <p className="mt-0.5 text-[15px] font-semibold leading-6">
              {insight.label}是最大支出，佔本月合計 {insight.percent}%
            </p>
          </div>
        </Card>
      ) : null}

      {essentialTasks.length > 0 && onRefresh ? (
        <AgentTaskBar tasks={essentialTasks} onRefresh={onRefresh} />
      ) : null}

      <Card className="p-4">
        <div className="flex min-h-11 items-center justify-between gap-3">
          <div>
            <p className="text-[13px] font-semibold text-[var(--muted-foreground)]">
              最新動態
            </p>
            <h2 className="text-base font-bold">最近五筆流水</h2>
          </div>
          <Button variant="ghost" size="sm" className="min-h-11" onClick={onViewHistory}>
            查看全部
          </Button>
        </div>
        <div className="mt-2">
          {recent.length > 0 ? (
            <ExpenseList expenses={recent} users={data.users} onEdit={onEdit} />
          ) : (
            <Empty
              icon={<Inbox />}
              title="還沒有流水"
              description="新增第一筆支出後會顯示在這裡"
              className="py-8"
            />
          )}
        </div>
      </Card>
    </div>
  );
}

function BalanceHero({
  groupName,
  groupColor,
  balance,
  onAdd,
  onTransfer,
  onSettle,
}: {
  groupName: string;
  groupColor: string;
  balance: number;
  onAdd: () => void;
  onTransfer: () => void;
  onSettle: () => void;
}) {
  const amount = Math.abs(balance);

  return (
    <section
      aria-labelledby="balance-title"
      className="relative overflow-hidden rounded-2xl p-5 text-white shadow-[var(--shadow-card)]"
      style={{ background: `linear-gradient(140deg, ${groupColor}, #0c2240)` }}
    >
      <div className="pointer-events-none absolute -right-14 -top-16 size-48 rounded-full border-[30px] border-white/5" />
      <p className="relative text-[13px] font-semibold text-white/75">{groupName}</p>
      <h2 id="balance-title" className="relative mt-1 text-[28px] font-extrabold tracking-tight">
        {balance === 0
          ? "目前已結清"
          : balance > 0
            ? `另一半欠你 ${moneyAbs(amount)}`
            : `你欠另一半 ${moneyAbs(amount)}`}
      </h2>
      <p className="relative mt-1 text-[13px] text-white/70">
        {balance === 0 ? "沒有待處理的共同欠款" : "依目前共同帳流水計算"}
      </p>

      <Button
        variant="secondary"
        size="block"
        className="relative mt-5 h-12 bg-white text-[15px] font-bold text-primary hover:bg-white/90"
        onClick={onAdd}
      >
        <Plus className="size-5" />
        新增支出
      </Button>

      <div className={`relative mt-2 grid gap-2 ${balance === 0 ? "grid-cols-1" : "grid-cols-2"}`}>
        <Button
          variant="secondary"
          size="sm"
          className="h-11 bg-white/12 text-[13px] text-white hover:bg-white/20"
          onClick={onTransfer}
        >
          <ArrowLeftRight className="size-4" />
          記錄轉帳
        </Button>
        {balance !== 0 ? (
          <Button
            variant="secondary"
            size="sm"
            className="h-11 bg-white/12 text-[13px] text-white hover:bg-white/20"
            onClick={onSettle}
          >
            <CircleCheckBig className="size-4" />
            {balance < 0 ? "全部結清" : "已收到欠款"}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function SummaryStat({
  label,
  value,
  className = "",
}: {
  label: string;
  value: number;
  className?: string;
}) {
  return (
    <div className={`min-w-0 px-3 py-4 text-center ${className}`}>
      <p className="text-[13px] font-semibold text-[var(--muted-foreground)]">{label}</p>
      <p className="mt-1 truncate text-[15px] font-bold tabular-nums">{money(value)}</p>
    </div>
  );
}

function buildMonthlyInsight(
  data: Bootstrap,
  combinedTotal: number,
  categories?: Array<{ tag: string; totalTwd: number; percent: number }>,
) {
  if (categories?.length) {
    return {
      label: categories[0]!.tag,
      percent: categories[0]!.percent,
    };
  }
  if (combinedTotal <= 0) return null;
  const totals = new Map<string, number>();
  for (const [tag, amount] of Object.entries(data.dashboard.categoryTotals)) {
    totals.set(tag, (totals.get(tag) ?? 0) + amount);
  }
  for (const [tag, amount] of Object.entries(data.privateDashboard?.categoryTotals ?? {})) {
    totals.set(tag, (totals.get(tag) ?? 0) + amount);
  }
  const top = [...totals].sort((left, right) => right[1] - left[1])[0];
  if (!top) return null;
  return {
    label: top[0] || "其他",
    percent: Math.round((top[1] / combinedTotal) * 100),
  };
}

export function ExpenseList({
  expenses,
  users,
  onEdit,
}: {
  expenses: Expense[];
  users: User[];
  onEdit?: (expense: Expense) => void;
}) {
  return (
    <div className="divide-y divide-[var(--border)]">
      {expenses.map((expense) => {
        const tag = displayTag(expense);
        const payer = users.find((user) => user.id === expense.paid_by_user_id);
        return (
          <button
            key={expense.id}
            type="button"
            onClick={() => onEdit?.(expense)}
            disabled={!!expense.mirror_kind || !!expense.deleted_at}
            className={`flex min-h-[60px] w-full items-center gap-3 py-3 text-left transition active:scale-[0.99] hover:bg-muted/60 disabled:opacity-45 ${
              expense._optimistic ? "animate-pulse-soft" : ""
            }`}
          >
            <div
              className="flex size-10 shrink-0 items-center justify-center rounded-xl text-[14px] font-bold"
              style={{ background: tagTint(expense.tag), color: tagColor(expense.tag) }}
            >
              {tag.charAt(0)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[15px] font-semibold">
                  {expense.description}
                </span>
                {expense._optimistic ? (
                  <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[13px] font-bold text-accent">
                    同步中
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 truncate text-[13px] text-[var(--muted-foreground)]">
                {payer?.label ?? "?"}付款 · {tag}
                {expense.ledger === "private" && expense.mirror_kind
                  ? " · 共同分攤"
                  : expense.ledger === "private"
                    ? " · 私人"
                    : " · 共同"}
              </p>
            </div>
            <span className="shrink-0 text-[15px] font-bold tabular-nums">
              {money(expense.amount_twd)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
