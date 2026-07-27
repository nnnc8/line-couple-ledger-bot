"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Empty } from "@/components/ui/empty";
import { ArrowLeftRight, CircleCheckBig, Inbox, Plus, TrendingDown } from "lucide-react";
import { useCategoryAnalytics } from "@/hooks/use-analytics";
import { SecretaryTaskCard } from "@/components/dashboard/secretary-task-card";
import { AgentTaskBar } from "@/components/dashboard/agent-task-bar";
import { RecentDecisions } from "@/components/dashboard/recent-decisions";
import { money, moneyAbs, shortMoney, monthShort } from "@/lib/format";
import { tagColor, tagTint, displayTag } from "@/lib/categories";
import type { Bootstrap, Expense, User } from "@/lib/types";
import { CategoryPieChart } from "./category-pie-chart";
import { TagBarChart } from "./tag-bar-chart";

interface DashboardProps {
  data: Bootstrap;
  onTransfer: () => void;
  onSettle: () => void;
  onAdd: () => void;
  onEdit: (expense: Expense) => void;
  onRefresh?: () => void;
}

type Range = "this_month" | "six_months" | "all";

export function Dashboard({
  data,
  onTransfer,
  onSettle,
  onAdd,
  onEdit,
  onRefresh,
}: DashboardProps) {
  const [range, setRange] = React.useState<Range>("this_month");
  const [selectedCategory, setSelectedCategory] = React.useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = React.useState<string | null>(null);

  const activeGroup = data.groups.find((g) => g.id === data.activeGroupId)!;
  const mine =
    data.balances.find((b) => b.user_id === data.user.id)?.balance_twd ?? 0;
  const owed = Math.abs(mine);

  const analytics = useCategoryAnalytics(range, "shared");
  const fallbackCategories = Object.entries(data.dashboard.categoryTotals)
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
        const tag = c.tag || "其他";
        return {
          tag,
          label: tag,
          value: c.totalTwd,
          color: tagColor(tag),
        };
      })
    : fallbackCategories;
  const categoryTotal = analytics?.totalTwd ?? data.dashboard.monthlyTotalTwd;

  return (
    <div className="space-y-3">
      <BalanceCard
        groupName={activeGroup.name}
        groupColor={activeGroup.color || "#142a47"}
        balance={mine}
        owed={owed}
        onTransfer={onTransfer}
        onSettle={onSettle}
        onAdd={onAdd}
        sharedMonthly={data.dashboard.monthlyTotalTwd}
        privateMonthly={data.privateDashboard?.monthlyTotalTwd ?? 0}
      />
      <SecretaryTaskCard />
      {data.openTasks && data.openTasks.length > 0 && onRefresh && (
        <AgentTaskBar tasks={data.openTasks} onRefresh={onRefresh} />
      )}
      {data.recentEvents && data.recentEvents.length > 0 && (
        <RecentDecisions events={data.recentEvents} />
      )}

      <div className="grid grid-cols-2 gap-3">
        <Card className="p-4">
          <p className="text-[12px] font-medium text-[var(--muted-foreground)]">
            本月共同支出
          </p>
          <p className="mt-1.5 text-xl font-bold tabular-nums">
            {money(data.dashboard.monthlyTotalTwd)}
          </p>
          <p className="mt-0.5 text-[12px] text-[var(--muted-foreground)]">
            {data.dashboard.monthlyCount} 筆交易
          </p>
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[12px] font-medium text-[var(--muted-foreground)]">
              支出分析
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
            onValueChange={(v) => {
              setRange(v);
              setSelectedCategory(null);
            }}
            options={[
              { value: "this_month", label: "本月" },
              { value: "six_months", label: "近六月" },
              { value: "all", label: "全部" },
            ]}
          />
        </div>

        {categoryRows.length > 0 ? (
          <div className="mt-5 space-y-4">
            <CategoryPieChart
              data={categoryRows}
              total={categoryTotal}
              onSelect={setSelectedCategory}
              selected={selectedCategory}
            />
            <div className="w-full space-y-1">
              {categoryRows.slice(0, 6).map((cat) => {
                const active = selectedCategory === cat.label;
                const pct =
                  categoryTotal > 0 ? Math.round((cat.value / categoryTotal) * 100) : 0;
                return (
                  <button
                    key={cat.label}
                    type="button"
                    onClick={() =>
                      setSelectedCategory(active ? null : cat.label)
                    }
                    className={`flex min-h-[40px] w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[14px] transition active:scale-[0.99] ${
                      active ? "bg-muted" : "hover:bg-muted"
                    }`}
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
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <Empty
            icon={<Inbox />}
            title="這個範圍還沒有共同支出"
            description="新增一筆就會出現在這裡"
            className="py-8"
          />
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[12px] font-medium text-[var(--muted-foreground)]">
              趨勢
            </p>
            <h2 className="text-base font-bold">近六個月</h2>
          </div>
          <Button variant="ghost" size="sm" onClick={onAdd}>
            <Plus className="size-4" /> 新增
          </Button>
        </div>
        {data.dashboard.trend.some((p) => p.totalTwd > 0) ? (
          <div className="mt-3 flex gap-1">
            {data.dashboard.trend.map((point) => {
              const max = Math.max(1, ...data.dashboard.trend.map((p) => p.totalTwd));
              const active = selectedMonth === point.month;
              const heightPct = Math.max(4, (point.totalTwd / max) * 100);
              return (
                <button
                  key={point.month}
                  type="button"
                  onClick={() => setSelectedMonth(active ? null : point.month)}
                  className={`flex h-32 flex-1 flex-col items-center justify-end gap-1 rounded-lg py-2 transition active:scale-[0.98] ${
                    active ? "bg-muted" : "hover:bg-muted"
                  }`}
                >
                  <span className="text-[10px] font-semibold tabular-nums">
                    {point.totalTwd > 0 ? shortMoney(point.totalTwd) : ""}
                  </span>
                  <div className="flex h-20 w-full flex-1 items-end justify-center px-1">
                    <div
                      className="w-full max-w-[26px] origin-bottom rounded-t-md transition-all"
                      style={{
                        height: `${heightPct}%`,
                        background: active ? "var(--accent)" : "color-mix(in srgb, var(--accent) 50%, transparent)",
                      }}
                    />
                  </div>
                  <span className="text-[10px] font-semibold text-[var(--muted-foreground)]">
                    {monthShort(point.month)}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <Empty
            icon={<TrendingDown />}
            title="近六個月尚無支出"
            className="py-8"
          />
        )}
      </Card>

      <Card className="p-4">
        <div>
          <p className="text-[12px] font-medium text-[var(--muted-foreground)]">
            標籤排行
          </p>
          <h2 className="text-base font-bold">前 5 大標籤</h2>
        </div>
        <div className="mt-3">
          {categoryRows.length > 0 ? (
            <TagBarChart
              data={categoryRows.map((c) => ({ tag: c.tag, amount: c.value }))}
            />
          ) : (
            <Empty
              icon={<Inbox />}
              title="尚無標籤資料"
              className="py-8"
            />
          )}
        </div>
      </Card>

      <RecentTransactions
        expenses={data.dashboard.recent}
        users={data.users}
        onEdit={onEdit}
        monthFilter={selectedMonth}
        tagFilter={selectedCategory}
      />
    </div>
  );
}

/* ─── Balance Card ─── */
function BalanceCard({
  groupName,
  groupColor,
  balance,
  owed,
  onTransfer,
  onSettle,
  onAdd,
  sharedMonthly,
  privateMonthly,
}: {
  groupName: string;
  groupColor: string;
  balance: number;
  owed: number;
  onTransfer: () => void;
  onSettle: () => void;
  onAdd: () => void;
  sharedMonthly: number;
  privateMonthly: number;
}) {
  return (
    <div
      className="relative overflow-hidden rounded-2xl p-5 text-[var(--primary-foreground)]"
      style={{
        background: `linear-gradient(135deg, ${groupColor}, #0c2240)`,
      }}
    >
      <div className="pointer-events-none absolute -right-10 -top-12 size-44 rounded-full border-[28px] border-white/5" />
      <p className="relative text-[13px] font-medium text-white/80">
        💰 {groupName} · 目前餘額
      </p>
      <p className="relative mt-2 text-[26px] font-extrabold tracking-tight">
        {balance === 0
          ? "已結清 ✨"
          : balance > 0
            ? `另一半欠你 ${moneyAbs(owed)}`
            : `你欠另一半 ${moneyAbs(owed)}`}
      </p>

      <div className="relative mt-4 grid grid-cols-2 gap-2">
        <Button
          variant="secondary"
          size="sm"
          className="h-10 bg-white/20 text-white hover:bg-white/30"
          onClick={onTransfer}
        >
          <ArrowLeftRight className="size-4" /> 記錄轉帳
        </Button>
        {balance !== 0 ? (
          <Button
            variant="secondary"
            size="sm"
            className="h-10 bg-white/15 text-white hover:bg-white/25"
            onClick={onSettle}
          >
            <CircleCheckBig className="size-4" />
            {balance < 0 ? "全部結清" : "已收到全部欠款"}
          </Button>
        ) : (
          <div className="flex h-10 items-center justify-center rounded-lg bg-white/10 px-2 text-[12px] font-semibold text-white/75">
            目前沒有待結清欠款
          </div>
        )}
      </div>

      <Button
        variant="secondary"
        size="sm"
        className="relative mt-4 bg-white/15 text-white hover:bg-white/25"
        onClick={onAdd}
      >
        <Plus className="mr-1 size-4" /> 新增支出
      </Button>

      <div className="relative mt-4 flex gap-4 border-t border-white/10 pt-3">
        <div className="flex-1">
          <p className="text-[11px] text-white/60">本月共同</p>
          <p className="mt-0.5 text-lg font-bold tabular-nums">
            {money(sharedMonthly)}
          </p>
        </div>
        <div className="flex-1">
          <p className="text-[11px] text-white/60">本月私人</p>
          <p className="mt-0.5 text-lg font-bold tabular-nums">
            {money(privateMonthly)}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ─── Recent Transactions ─── */
function RecentTransactions({
  expenses,
  users,
  onEdit,
  monthFilter,
  tagFilter,
}: {
  expenses: Expense[];
  users: User[];
  onEdit: (e: Expense) => void;
  monthFilter: string | null;
  tagFilter: string | null;
}) {
  const filtered = React.useMemo(() => {
    let list = expenses;
    if (monthFilter) list = list.filter((e) => e.expense_date.startsWith(monthFilter));
    if (tagFilter) {
      list = list.filter((e) => {
        const tag = displayTag(e);
        return tag === tagFilter;
      });
    }
    return list.slice(0, 12);
  }, [expenses, monthFilter, tagFilter]);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[12px] font-medium text-[var(--muted-foreground)]">
            最新動態
          </p>
          <h2 className="text-base font-bold">最近流水</h2>
        </div>
        {(monthFilter || tagFilter) ? (
          <p className="text-[11px] text-var(--muted-foreground)">
            已套用篩選
          </p>
        ) : null}
      </div>
      <div className="mt-3">
        {filtered.length > 0 ? (
          <ExpenseList
            expenses={filtered}
            users={users}
            onEdit={onEdit}
          />
        ) : (
          <Empty
            icon={<Inbox />}
            title="尚無流水"
            className="py-8"
          />
        )}
      </div>
    </Card>
  );
}

export function ExpenseList({
  expenses,
  users,
  onEdit,
}: {
  expenses: Expense[];
  users: User[];
  onEdit?: (e: Expense) => void;
}) {
  return (
    <div className="divide-y divide-[var(--border)]">
      {expenses.map((expense) => {
        const tag = displayTag(expense);
        const payer = users.find((u) => u.id === expense.paid_by_user_id);
        const tint = tagTint(expense.tag);
        return (
          <button
            key={expense.id}
            type="button"
            onClick={() => onEdit?.(expense)}
            disabled={!!expense.mirror_kind || !!expense.deleted_at}
            className={`flex min-h-[56px] w-full items-center gap-3 py-3 text-left transition active:scale-[0.99] hover:bg-muted/60 disabled:opacity-45 ${
              expense._optimistic ? "animate-pulse-soft" : ""
            }`}
          >
            <div
              className="flex size-10 shrink-0 items-center justify-center rounded-full text-[14px] font-bold"
              style={{ background: tint, color: tagColor(expense.tag) }}
            >
              {tag.charAt(0)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[14px] font-medium">
                  {expense.description}
                </span>
                {expense._optimistic ? (
                  <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold text-accent">
                    同步中
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 truncate text-[12px] text-[var(--muted-foreground)]">
                {payer?.label ?? "?"}付款 · {displayTag(expense)}
                {expense.ledger === "private" && expense.mirror_kind
                  ? " · 共同分攤"
                  : expense.ledger === "private"
                    ? " · 私人"
                    : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <span className="text-[14px] font-bold tabular-nums">
                {money(expense.amount_twd)}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
