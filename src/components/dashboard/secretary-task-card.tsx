"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BellRing, CheckCheck } from "lucide-react";
import type { AssistantTask } from "@/lib/secretary-tasks";

export function SecretaryTaskCard() {
  const [tasks, setTasks] = useState<AssistantTask[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/app/secretary/tasks", { cache: "no-store" })
      .then((res) => res.json())
      .then((result) => {
        if (!cancelled) {
          setTasks((result as { tasks: AssistantTask[] }).tasks ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) setTasks([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  if (loading) return null;
  if (tasks.length === 0) return null;

  return (
    <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <BellRing className="h-4 w-4 text-primary" />
          <CardTitle className="text-base">秘書待辦</CardTitle>
          <Badge variant="secondary" className="ml-auto h-5 px-1.5 text-xs">
            {tasks.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-1.5">
          {tasks.slice(0, 3).map((task) => (
            <div
              key={task.id}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground"
            >
              <CheckCheck className="h-3.5 w-3.5 shrink-0 opacity-50" />
              <span className="flex-1 truncate">{task.summary || task.title}</span>
              {task.priority === "high" && (
                <Badge
                  variant="danger"
                  className="h-4 shrink-0 px-1 text-[10px]"
                >
                  急
                </Badge>
              )}
            </div>
          ))}
          {tasks.length > 3 && (
            <p className="text-center text-xs text-muted-foreground">
              還有 {tasks.length - 3} 件待處理
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
