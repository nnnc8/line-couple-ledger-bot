"use client";

import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Select } from "@/components/ui/select";
import {
  ChevronRight,
  Download,
  Plus,
  Pause,
  Play,
  Tag,
  CreditCard,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { Bootstrap } from "@/lib/types";
import { money, dateShort } from "@/lib/format";
import { cn } from "@/lib/utils";

interface SettingsProps {
  data: Bootstrap;
  onGroup: (body: unknown, success?: string) => void;
  onRecurring: (body: unknown, success?: string) => void;
}

export function SettingsSection({
  data,
  onGroup,
  onRecurring,
}: SettingsProps) {
  const [newGroupName, setNewGroupName] = React.useState("");

  return (
    <div className="space-y-3 pt-1">
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

      {/* Agent Rules / Memories */}
      <AgentRulesCard />

      {/* Export */}
      <ExportCard />

      <div className="pt-2">
        <p className="mb-2 px-1 text-[13px] font-semibold text-[var(--muted-foreground)]">
          即將推出
        </p>
        <div className="grid grid-cols-2 gap-3">
          <QuickAction
            icon={<CreditCard />}
            title="匯入帳單"
            subtitle="CSV 匯入"
            disabled
            onClick={() => {}}
          />
          <QuickAction
            icon={<Tag />}
            title="分類管理"
            subtitle="整理自訂分類"
            disabled
            onClick={() => {}}
          />
        </div>
      </div>
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

/* ─── Agent rules / memories ─── */
interface AgentMemory {
  id: string;
  kind: string;
  key: string;
  value: Record<string, unknown> | null;
  confidence: number;
  scope: string;
  approved: boolean;
}

function AgentRulesCard() {
  const [memories, setMemories] = React.useState<AgentMemory[] | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/app/agent/memories")
      .then((res) => res.json() as Promise<{ memories?: AgentMemory[] }>)
      .then((data) => {
        if (!cancelled) setMemories(data.memories ?? []);
      })
      .catch(() => {
        if (!cancelled) setMemories([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div>
          <p className="text-[12px] font-medium text-[var(--muted-foreground)]">
            AI 秘書
          </p>
          <CardTitle>學習紀錄</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        {memories === null ? (
          <p className="text-[13px] text-[var(--muted-foreground)]">載入中…</p>
        ) : memories.length === 0 ? (
          <p className="text-[13px] text-[var(--muted-foreground)]">尚無學習紀錄</p>
        ) : (
          <div className="space-y-2">
            {memories.slice(0, 10).map((m) => (
              <div
                key={m.id}
                className="flex items-start gap-2 rounded-lg px-1 py-1.5"
              >
                <span
                  className={cn(
                    "mt-0.5 inline-block size-2 shrink-0 rounded-full",
                    m.approved ? "bg-green-500" : "bg-amber-400",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">{m.key}</p>
                  <p className="text-[12px] text-[var(--muted-foreground)]">
                    {m.kind === "merchant_rule" ? "商家規則" : m.kind} ·{" "}
                    {m.approved ? "已確認" : "待確認"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
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
                  onClick={() =>
                    onSave(
                      { operation: "delete", id: item.id },
                      "週期支出已刪除",
                    )
                  }
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
                  tag: "其他",
                  amountTwd: Number(amountTwd),
                  paidBy: "self",
                  expenseDate: nextRunDate,
                  splitMethod: "equal",
                  selfValue: null,
                  partnerValue: null,
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

function ExportCard() {
  const today = new Date();
  const defaultPeriod = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const [period, setPeriod] = React.useState(defaultPeriod);
  const [ledger, setLedger] = React.useState<"all" | "shared" | "private">("all");

  const exportUrl = `/api/app/export?period=${encodeURIComponent(period)}&ledger=${ledger}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Download className="size-4" /> 匯出帳務
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-[12px] font-medium text-[var(--muted-foreground)]">月份</label>
            <Input
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="mt-1"
            />
          </div>
          <div className="flex-1">
            <label className="text-[12px] font-medium text-[var(--muted-foreground)]">帳本</label>
            <Select
              value={ledger}
              onValueChange={(v) => setLedger(v as "all" | "shared" | "private")}
              className="mt-1"
              options={[
                { value: "all", label: "全部" },
                { value: "shared", label: "共同帳" },
                { value: "private", label: "私人帳" },
              ]}
            />
          </div>
        </div>
        <Link
          href={exportUrl}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 text-[13px] font-semibold text-primary-foreground transition hover:opacity-90"
        >
          <Download className="size-4" /> 下載 CSV
        </Link>
      </CardContent>
    </Card>
  );
}
