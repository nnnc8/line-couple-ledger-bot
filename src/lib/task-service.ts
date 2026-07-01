import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createTask,
  formatTaskList,
  getOpenTasks,
  type AssistantTask,
  type AssistantTaskType,
} from "./secretary-tasks";

export interface CreateSecretaryTaskInput {
  coupleId: number;
  groupId: string;
  userId?: string | null;
  type: AssistantTaskType;
  title: string;
  summary?: string;
  payload?: Record<string, unknown>;
  priority?: "low" | "normal" | "high";
  dueAt?: string;
  source?: string;
  relatedPendingActionId?: string;
  relatedExpenseId?: string;
}

export class TaskService {
  constructor(private readonly db: SupabaseClient) {}

  async createSecretaryTask(input: CreateSecretaryTaskInput): Promise<{
    taskId: string;
    message: string;
  }> {
    const taskId = await createTask(this.db, {
      coupleId: input.coupleId,
      groupId: input.groupId,
      ownerUserId: input.userId ?? null,
      type: input.type,
      title: input.title,
      summary: input.summary,
      payload: input.payload,
      priority: input.priority,
      dueAt: input.dueAt,
      source: input.source,
      relatedPendingActionId: input.relatedPendingActionId,
      relatedExpenseId: input.relatedExpenseId,
    });

    return {
      taskId,
      message: `已建立任務：${input.title}`,
    };
  }

  async listOpenTasks(options: {
    coupleId: number;
    groupId?: string;
    userId?: string;
    limit?: number;
    types?: AssistantTaskType[];
  }): Promise<AssistantTask[]> {
    return getOpenTasks(this.db, options);
  }

  formatTaskList(tasks: AssistantTask[], title: string): string {
    return formatTaskList(tasks, title);
  }
}
