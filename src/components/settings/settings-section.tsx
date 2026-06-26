"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronRight, CreditCard, Tag, RefreshCw, Download, Plus, Trash2, Pause, Play } from "lucide-react";
import type { Bootstrap } from "@/lib/types";

function money(n: number) {
  return `NT$${Math.abs(n).toLocaleString()}`;
}

function frequencyName(value: string) {
  return value === "weekly" ? "每週" : value === "yearly" ? "每年" : "每月";
}

interface SettingsSectionProps {
  data: Bootstrap;
  unread: number;
  onGroup(body: unknown): void;
  onRecurring(body: unknown): void;
  onRead(): void;
  onPropose(body: unknown): void;
  onBatchCreate(
    expenses: Array<{
      ledger: "shared" | "private";
      groupId: string | null;
      description: string;
      merchant: string | null;
      notes: string | null;
      category: string;
      amountTwd: number;
      paidBy: "self" | "partner";
      expenseDate: string;
      splitMethod: "equal" | "exact" | "percentage";
      selfValue: number | null;
      partnerValue: number | null;
      receiptId: string | null;
    }>,
  ): void;
}

export function SettingsSection({
  data,
  unread,
  onGroup,
  onRecurring,
  onRead,
}: SettingsSectionProps) {
  const [view, setView] = useState<"settings" | "labels" | "import">("settings");
  const [name, setName] = useState("");
  const [recurring, setRecurring] = useState({
    description: "",
    amountTwd: "",
    frequency: "monthly",
    nextRunDate: data.today,
  });

  if (view === "labels") {
    return (
      <div className="space-y-4 px-1 pb-20">
        <Button variant="ghost" size="sm" onClick={() => setView("settings")}>
          ← 返回設定
        </Button>
        <p className="text-sm text-muted-foreground">分類標籤管理（Coming soon）</p>
      </div>
    );
  }

  if (view === "import") {
    return (
      <div className="space-y-4 px-1 pb-20">
        <Button variant="ghost" size="sm" onClick={() => setView("settings")}>
          ← 返回設定
        </Button>
        <p className="text-sm text-muted-foreground">CSV 匯入（Coming soon）</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 px-1 pb-20">
      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-3">
        <Card
          className="cursor-pointer transition-colors hover:bg-muted"
          onClick={() => setView("import")}
        >
          <CardContent className="flex items-center gap-3 p-4">
            <CreditCard className="h-5 w-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">💳 匯入帳單</p>
              <p className="text-xs text-muted-foreground">
                上傳信用卡 CSV
              </p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </CardContent>
        </Card>
        <Card
          className="cursor-pointer transition-colors hover:bg-muted"
          onClick={() => setView("labels")}
        >
          <CardContent className="flex items-center gap-3 p-4">
            <Tag className="h-5 w-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">🏷️ 分類標籤</p>
              <p className="text-xs text-muted-foreground">
                合併或重命名標籤
              </p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </CardContent>
        </Card>
      </div>

      {/* Groups */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground">共同空間</p>
              <CardTitle className="text-base">群組</CardTitle>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.groups.map((group) => (
            <div
              key={group.id}
              className="flex items-center gap-3 rounded-md px-2 py-2"
            >
              <div
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ background: group.color }}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{group.name}</p>
                <p className="text-xs text-muted-foreground">
                  {group.archived_at
                    ? "已封存"
                    : group.id === data.activeGroupId
                      ? "目前使用"
                      : "雙方共享"}
                </p>
              </div>
              {!group.archived_at && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-destructive"
                  onClick={() =>
                    onGroup({ operation: "archive", groupId: group.id })
                  }
                >
                  封存
                </Button>
              )}
            </div>
          ))}
          <div className="flex gap-2 pt-2">
            <Input
              placeholder="新群組名稱"
              maxLength={40}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9"
            />
            <Button
              size="sm"
              className="h-9"
              onClick={() => {
                onGroup({ operation: "create", name, color: "#173B63" });
                setName("");
              }}
            >
              <Plus className="mr-1 h-3 w-3" /> 新增
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Recurring expenses */}
      <Card>
        <CardHeader className="pb-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">提醒</p>
            <CardTitle className="text-base">週期支出</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.recurring.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-3 rounded-md px-2 py-2"
            >
              <RefreshCw className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {item.description} · {money(item.amount_twd)}
                </p>
                <p className="text-xs text-muted-foreground">
                  下次 {item.next_run_date} · {frequencyName(item.frequency)}
                </p>
              </div>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  onClick={() =>
                    onRecurring({
                      operation: "toggle",
                      id: item.id,
                      active: !item.active,
                    })
                  }
                >
                  {item.active ? (
                    <Pause className="h-3 w-3" />
                  ) : (
                    <Play className="h-3 w-3" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-destructive"
                  onClick={() => {
                    if (confirm("確定要刪除此週期支出嗎？")) {
                      onRecurring({ operation: "delete", id: item.id });
                    }
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}

          <Separator />

          {/* Add new recurring */}
          <div className="space-y-2">
            <Input
              placeholder="說明"
              value={recurring.description}
              onChange={(e) =>
                setRecurring({ ...recurring, description: e.target.value })
              }
            />
            <div className="grid grid-cols-2 gap-2">
              <Input
                inputMode="numeric"
                placeholder="金額"
                value={recurring.amountTwd}
                onChange={(e) =>
                  setRecurring({ ...recurring, amountTwd: e.target.value })
                }
              />
              <Select
                value={recurring.frequency}
                onValueChange={(v) =>
                  setRecurring({ ...recurring, frequency: v ?? "monthly" })
                }
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">每週</SelectItem>
                  <SelectItem value="monthly">每月</SelectItem>
                  <SelectItem value="yearly">每年</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Input
              type="date"
              value={recurring.nextRunDate}
              onChange={(e) =>
                setRecurring({ ...recurring, nextRunDate: e.target.value })
              }
            />
            <Button
              className="w-full"
              onClick={() =>
                onRecurring({
                  id: null,
                  ledger: "shared",
                  groupId: data.activeGroupId,
                  description: recurring.description,
                  merchant: null,
                  notes: null,
                  category: "other",
                  amountTwd: Number(recurring.amountTwd),
                  paidBy: "self",
                  expenseDate: recurring.nextRunDate,
                  splitMethod: "equal",
                  selfValue: null,
                  partnerValue: null,
                  receiptId: null,
                  frequency: recurring.frequency,
                  nextRunDate: recurring.nextRunDate,
                  endDate: null,
                  active: true,
                  updated_at: new Date().toISOString(),
                })
              }
            >
              新增週期支出
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Notifications */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground">通知中心</p>
              <CardTitle className="text-base">
                {unread ? `${unread} 則未讀` : "全部已讀"}
              </CardTitle>
            </div>
            {unread > 0 && (
              <Button variant="ghost" size="sm" onClick={onRead}>
                全部已讀
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.notifications.slice(0, 10).map((item) => (
            <div
              key={item.id}
              className={`rounded-md px-2 py-2 ${
                item.read_at ? "opacity-60" : ""
              }`}
            >
              <p className="text-sm font-medium">{item.title}</p>
              <p className="text-xs text-muted-foreground">{item.body}</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {new Date(item.created_at).toLocaleString("zh-TW")}
                {item.line_status === "skipped" ? " · 已留在站內" : ""}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Export */}
      <Link
        href="/api/app/export"
        className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted"
      >
        <Download className="h-4 w-4" /> 匯出目前流水 CSV
      </Link>
    </div>
  );
}
