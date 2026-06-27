"use client";

import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Select } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Empty } from "@/components/ui/empty";
import {
  Bell,
  ChevronRight,
  Download,
  Plus,
  RefreshCw,
  Pause,
  Play,
  Trash2,
  Tag,
  CreditCard,
  Target,
} from "lucide-react";
import type { Bootstrap } from "@/lib/types";
import type { PendingActionInput, ExpenseInput } from "@/lib/optimistic";
import { categoryList, categoryEmoji, categoryLabel } from "@/lib/categories";
import { money, dateShort, timeLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

interface SettingsProps {
  data: Bootstrap;
  unread: number;
  onGroup: (body: unknown, success?: string) => void;
  onRecurring: (body: unknown, success?: string) => void;
  onBudget: (body: unknown, success?: string) => void;
  onRead: () => void;
  onPropose: (proposal: {
    actionId: string;
    preview: string;
    action?: PendingActionInput;
  }) => void;
  onBatchCreate: (expenses: ExpenseInput[]) => void;
}

export function SettingsSection({
  data,
  unread,
  onGroup,
  onRecurring,
  onBudget,
  onRead,
}: SettingsProps) {
  const [newGroupName, setNewGroupName] = React.useState("");

  return (
    <div className="space-y-3 pt-1">
      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-3">
        <QuickAction
          icon={<CreditCard />}
          title="匯入帳單"
          subtitle="CSV 待開放"
          disabled
          onClick={() => {}}
        />
        <QuickAction
          icon={<Tag />}
          title="分類標籤"
          subtitle="整理自訂標籤"
          disabled
          onClick={() => {}}
        />
      </div>

      {/* Budgets */}
      <BudgetEditor data={data} onSave={onBudget} />

      {/* Groups */}
      <Card>
        <CardHeader className="pb-2">
          <div>
            <p className="text-[12px] font-medium text-[var(--muted-foreground)]">
              共同空間
            </p>
            <CardTitle>群組</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.groups.map((group) => (
            <div
              key={group.id}
              className="flex items-center gap-3 rounded-lg px-1 py-1.5"
            >
              <div
                className="size-3 shrink-0 rounded-full"
                style={{ background: group.color }}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium">{group.name}</p>
                <p className="text-[12px] text-[var(--muted-foreground)]">
                  {group.archived_at
                    ? "已封存"
                    : group.id === data.activeGroupId
                      ? "目前使用中"
                      : "雙方共享"}
                </p>
              </div>
              {!group.archived_at ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-destructive"
                  onClick={() =>
                    onGroup(
                      { operation: "archive", groupId: group.id },
                      "群組已封存",
                    )
                  }
                >
                  封存
                </Button>
              ) : null}
            </div>
          ))}
          <Separator />
          <div className="flex gap-2 pt-2">
            <Input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="新群組名稱"
              maxLength={40}
              className="h-10"
            />
            <Button
              variant="primary"
              className="h-10 px-4"
              disabled={!newGroupName.trim()}
              onClick={() => {
                onGroup(
                  { operation: "create", name: newGroupName.trim(), color: "#142a47" },
                  "群組已建立",
                );
                setNewGroupName("");
              }}
            >
              <Plus className="size-4" /> 新增
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Recurring expenses */}
      <RecurringEditor data={data} onSave={onRecurring} />

      {/* Notifications */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[12px] font-medium text-[var(--muted-foreground)]">
                通知中心
              </p>
              <CardTitle>
                {unread ? `${unread} 則未讀` : "全部已讀"}
              </CardTitle>
            </div>
            {unread > 0 ? (
              <Button variant="ghost" size="sm" onClick={onRead}>
                全部已讀
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.notifications.length > 0 ? (
            data.notifications.slice(0, 12).map((n) => (
              <div
                key={n.id}
                className={cn(
                  "rounded-lg px-2 py-2",
                  n.read_at ? "opacity-60" : "",
                )}
              >
                <div className="flex items-center gap-2">
                  <Bell className="size-3.5 shrink-0 text-[var(--muted-foreground)]" />
                  <p className="text-[14px] font-semibold">{n.title}</p>
                </div>
                <p className="mt-0.5 text-[12px] text-foreground/80">{n.body}</p>
                <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
                  {timeLabel(n.created_at)}
                  {n.line_status === "skipped" ? " · 已留在網頁" : ""}
                </p>
              </div>
            ))
          ) : (
            <Empty icon={<Bell />} title="沒有通知" className="py-6" />
          )}
        </CardContent>
      </Card>

      {/* Export */}
      <Link
        href="/api/app/export"
        className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] py-3 text-[13px] font-medium text-[var(--muted-foreground)] transition hover:bg-muted"
      >
        <Download className="size-4" /> 匯出目前流水 CSV
      </Link>
    </div>
  );
}

function QuickAction({
  icon,
  title,
  subtitle,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 text-left shadow-[var(--shadow-card)] transition",
        disabled ? "opacity-50 cursor-not-allowed" : "hover:border-accent active:scale-[0.99]",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold">{title}</p>
        <p className="text-[12px] text-[var(--muted-foreground)]">{subtitle}</p>
      </div>
      {!disabled ? (
        <ChevronRight className="size-4 text-[var(--muted-foreground)]" />
      ) : null}
    </button>
  );
}

/* ─── Budget editor ─── */
function BudgetEditor({
  data,
  onSave,
}: {
  data: Bootstrap;
  onSave: (body: unknown, success?: string) => void;
}) {
  const [scope, setScope] = React.useState("total");
  const [customLabel, setCustomLabel] = React.useState("");
  const [limit, setLimit] = React.useState("");
  const [err, setErr] = React.useState("");

  return (
    <Card>
      <CardHeader className="pb-2">
        <div>
          <p className="text-[12px] font-medium text-[var(--muted-foreground)]">
            {data.month} 月預算
          </p>
          <CardTitle>本月預算</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.budgets.length > 0 ? (
          <div className="space-y-3">
            {data.budgets.map((b) => {
              const totalBudget = b.category === null;
              const spent = totalBudget
                ? data.dashboard.monthlyTotalTwd
                : b.category_label
                  ? data.sharedExpenses
                      .filter(
                        (e) =>
                          !e.deleted_at &&
                          e.expense_date.startsWith(data.month) &&
                          e.category === b.category &&
                          e.category_label === b.category_label,
                      )
                      .reduce((acc, e) => acc + e.amount_twd, 0)
                  : (data.dashboard.categoryTotals[b.category!] ?? 0);
              const pct =
                Number(b.limit_twd) > 0
                  ? Math.round((spent / Number(b.limit_twd)) * 100)
                  : 0;
              const tone =
                pct >= 100 ? "danger" : pct >= 80 ? "warn" : "primary";
              const title = totalBudget
                ? "📋 群組總預算"
                : `${categoryEmoji(b.category!)} ${b.category_label ?? categoryLabel(b.category!)}`;
              return (
                <div key={b.id} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[14px] font-medium">{title}</p>
                      <p className="text-[12px] text-[var(--muted-foreground)]">
                        {money(spent)} / {money(Number(b.limit_twd))}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "text-[14px] font-bold tabular-nums",
                        pct >= 100 && "text-destructive",
                        pct >= 80 && pct < 100 && "text-[#b45309]",
                      )}
                    >
                      {pct}%
                    </span>
                  </div>
                  <Progress value={Math.min(100, pct)} tone={tone} />
                </div>
              );
            })}
          </div>
        ) : (
          <Empty
            icon={<Target />}
            title="尚未設定本月預算"
            className="py-6"
          />
        )}

        <Separator />

        <div className="space-y-3">
          <p className="text-[13px] font-semibold text-foreground/80">
            新增或調整預算
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="mb-1.5">範圍</Label>
              <Select
                value={scope}
                onValueChange={(v) => setScope(v)}
                options={[
                  { value: "total", label: "群組總額" },
                  ...categoryList.map((c) => ({
                    value: c.key,
                    label: `${c.emoji} ${c.label}`,
                  })),
                ]}
              />
            </div>
            <div>
              <Label className="mb-1.5">細分類（選填）</Label>
              <Input
                value={customLabel}
                disabled={scope === "total"}
                onChange={(e) => setCustomLabel(e.target.value)}
                placeholder="例如：外食"
                className="h-11"
              />
            </div>
          </div>
          <Label htmlFor="limit" className="mb-1.5">上限（TWD）</Label>
          <Input
            id="limit"
            inputMode="numeric"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            placeholder="例如：30000"
          />
          {err ? <p className="text-[12px] text-destructive">{err}</p> : null}
          <Button
            variant="primary"
            className="w-full"
            onClick={() => {
              const v = Number(limit);
              if (!v || v <= 0) {
                setErr("請輸入有效金額");
                return;
              }
              setErr("");
              onSave(
                {
                  groupId: data.activeGroupId,
                  category: scope === "total" ? null : scope,
                  categoryLabel:
                    scope === "total" ? null : customLabel.trim() || null,
                  limitTwd: v,
                },
                "預算已儲存",
              );
              setLimit("");
              setCustomLabel("");
            }}
          >
            <Target className="mr-1 size-4" /> 儲存預算
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Recurring editor ─── */
function RecurringEditor({
  data,
  onSave,
}: {
  data: Bootstrap;
  onSave: (body: unknown, success?: string) => void;
}) {
  const [form, setForm] = React.useState({
    description: "",
    amountTwd: "",
    frequency: "monthly",
    nextRunDate: data.today,
  });
  const { description, amountTwd, frequency, nextRunDate } = form;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div>
          <p className="text-[12px] font-medium text-[var(--muted-foreground)]">
            提醒
          </p>
          <CardTitle>週期支出</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.recurring.length > 0 ? (
          <div className="space-y-2">
            {data.recurring.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-lg px-1 py-1.5"
              >
                <RefreshCw
                  className={cn(
                    "size-4 shrink-0",
                    item.active ? "text-accent" : "text-[var(--muted-foreground)]",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium">
                    {item.description} · {money(item.amount_twd)}
                  </p>
                  <p className="text-[12px] text-[var(--muted-foreground)]">
                    下次 {dateShort(item.next_run_date)} ·{" "}
                    {item.frequency === "weekly" ? "每週" : item.frequency === "yearly" ? "每年" : "每月"}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() =>
                    onSave(
                      { operation: "toggle", id: item.id, active: !item.active },
                      item.active ? "週期支出已暫停" : "週期支出已恢復",
                    )
                  }
                >
                  {item.active ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-destructive"
                  onClick={() => {
                    if (confirm("確定要刪除嗎？")) {
                      onSave(
                        { operation: "delete", id: item.id },
                        "週期支出已刪除",
                      );
                    }
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        <Separator />

        <div className="space-y-2">
          <Input
            value={description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="說明"
          />
          <div className="grid grid-cols-2 gap-2">
            <Input
              inputMode="numeric"
              value={amountTwd}
              onChange={(e) => setForm((f) => ({ ...f, amountTwd: e.target.value }))}
              placeholder="金額"
            />
            <Select
              value={frequency}
              onValueChange={(v) => setForm((f) => ({ ...f, frequency: v }))}
              options={[
                { value: "weekly", label: "每週" },
                { value: "monthly", label: "每月" },
                { value: "yearly", label: "每年" },
              ]}
            />
          </div>
          <Input
            type="date"
            value={nextRunDate}
            onChange={(e) => setForm((f) => ({ ...f, nextRunDate: e.target.value }))}
          />
          <Button
            variant="primary"
            className="w-full"
            disabled={!description.trim() || !amountTwd.trim()}
            onClick={() => {
              onSave(
                {
                  id: null,
                  ledger: "shared",
                  groupId: data.activeGroupId,
                  description: description.trim(),
                  merchant: null,
                  notes: null,
                  category: "other",
                  amountTwd: Number(amountTwd),
                  paidBy: "self",
                  expenseDate: nextRunDate,
                  splitMethod: "equal",
                  selfValue: null,
                  partnerValue: null,
                  receiptId: null,
                  frequency,
                  nextRunDate,
                  endDate: null,
                  active: true,
                  updated_at: new Date().toISOString(),
                },
                "週期支出已建立",
              );
              setForm({ description: "", amountTwd: "", frequency: "monthly", nextRunDate: data.today });
            }}
          >
            <Plus className="size-4" /> 新增週期支出
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}