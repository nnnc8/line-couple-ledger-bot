"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ListTodo, Check, Clock, X } from "lucide-react";
import { api } from "@/lib/api";

interface AgentTask {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  priority: "low" | "normal" | "high";
  status: string;
}

interface AgentTaskBarProps {
  tasks: AgentTask[];
  onRefresh: () => void;
}

export function AgentTaskBar({ tasks, onRefresh }: AgentTaskBarProps) {
  const [busyId, setBusyId] = useState<string | null>(null);

  if (tasks.length === 0) return null;

  const handleAction = async (taskId: string, action: "complete" | "dismiss") => {
    setBusyId(taskId);
    try {
      await api("/api/app/agent/tasks", { taskId, action });
      onRefresh();
    } catch {
      // silently fail
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <ListTodo className="h-4 w-4 text-primary" />
          <CardTitle className="text-base">待處理事項</CardTitle>
          <Badge variant="secondary" className="ml-auto h-6 px-2 text-[13px]">
            {tasks.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {tasks.slice(0, 5).map((task) => (
            <div
              key={task.id}
              className="flex items-start gap-2 rounded-md px-2 py-1.5"
            >
              <div className="mt-0.5 shrink-0">
                {task.priority === "high" ? (
                  <Badge variant="danger" className="h-6 px-2 text-[13px]">
                    急
                  </Badge>
                ) : (
                  <Clock className="h-3.5 w-3.5 opacity-40" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium">{task.title}</p>
                {task.summary && (
                  <p className="mt-0.5 truncate text-[13px] text-muted-foreground">
                    {task.summary}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`完成「${task.title}」`}
                  className="h-11 w-11 p-0"
                  disabled={busyId === task.id}
                  onClick={() => void handleAction(task.id, "complete")}
                >
                  <Check className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`略過「${task.title}」`}
                  className="h-11 w-11 p-0"
                  disabled={busyId === task.id}
                  onClick={() => void handleAction(task.id, "dismiss")}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
          {tasks.length > 5 && (
            <p className="text-center text-xs text-muted-foreground">
              還有 {tasks.length - 5} 件待處理
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
