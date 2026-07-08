"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { History, Receipt, HelpCircle, AlertTriangle, Mic } from "lucide-react";

interface AgentEvent {
  id: string;
  kind: string;
  status: string;
  input_text: string | null;
  reply_text: string | null;
  created_at: string;
}

interface RecentDecisionsProps {
  events: AgentEvent[];
}

const KIND_LABELS: Record<string, string> = {
  text_expense: "記帳",
  text_query: "查詢",
  text_other: "對話",
  image_rejected: "圖片",
  audio_transcribed: "語音",
  needs_group: "需選群組",
  action_executed: "執行",
  action_failed: "失敗",
  task_created: "建任務",
  cron_recurring: "定期",
  cron_report: "報表",
};

const KIND_ICONS: Record<string, typeof Receipt> = {
  text_expense: Receipt,
  audio_transcribed: Mic,
  needs_group: HelpCircle,
  action_failed: AlertTriangle,
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "剛剛";
  if (mins < 60) return `${mins} 分鐘前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小時前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

export function RecentDecisions({ events }: RecentDecisionsProps) {
  if (events.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">最近決策紀錄</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {events.slice(0, 8).map((event) => {
            const Icon = KIND_ICONS[event.kind] ?? History;
            const label = KIND_LABELS[event.kind] ?? event.kind;
            return (
              <div
                key={event.id}
                className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm"
              >
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-50" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">{label}</span>
                    {event.status === "failed" && (
                      <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-bold text-destructive">
                        失敗
                      </span>
                    )}
                  </div>
                  {event.input_text && (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {event.input_text.slice(0, 60)}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {timeAgo(event.created_at)}
                </span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
