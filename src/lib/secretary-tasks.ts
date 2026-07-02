/**
 * Assistant Task CRUD helpers.
 * All DB writes are deterministic — LLM never calls these directly.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/* ─── Consts ─── */

const ASSISTANT_TASK_TYPES = [
  "review_unmatched_bank_items",
  "settlement_suggestion",
  "duplicate_expense_review",
  "merchant_rule_suggestion",
  "missing_daily_entry",
  "budget_warning",
  "tag_cleanup",
  "recurring_expense_review",
] as const;

const DEFAULT_TASK_EXPIRY_DAYS = 7;

/* ─── Types ─── */

export type AssistantTaskType = (typeof ASSISTANT_TASK_TYPES)[number];

const DEFAULT_VISIBLE_TASK_TYPES = ASSISTANT_TASK_TYPES.filter(
  (type) => type !== "merchant_rule_suggestion",
) as AssistantTaskType[];

export interface AssistantTask {
  id: string;
  couple_id: number;
  group_id: string;
  owner_user_id: string | null;
  type: AssistantTaskType;
  title: string;
  summary: string | null;
  payload: Record<string, unknown> | null;
  status: "open" | "snoozed" | "done" | "dismissed" | "expired";
  priority: "low" | "normal" | "high";
  due_at: string | null;
  snooze_until: string | null;
  source: string | null;
  related_pending_action_id: string | null;
  related_expense_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTaskInput {
  coupleId: number;
  groupId: string;
  ownerUserId?: string | null;
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

const taskRowSchema = z.object({
  id: z.string().uuid(),
  couple_id: z.number().int(),
  group_id: z.string().uuid(),
  owner_user_id: z.string().uuid().nullable(),
  type: z.enum(ASSISTANT_TASK_TYPES),
  title: z.string(),
  summary: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  status: z.enum(["open", "snoozed", "done", "dismissed", "expired"]),
  priority: z.enum(["low", "normal", "high"]),
  due_at: z.string().nullable(),
  snooze_until: z.string().nullable(),
  source: z.string().nullable(),
  related_pending_action_id: z.string().uuid().nullable(),
  related_expense_id: z.string().uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/* ─── Create ─── */

export async function createTask(
  db: SupabaseClient,
  input: CreateTaskInput,
): Promise<string> {
  const { data, error } = await db
    .from("assistant_tasks")
    .insert({
      couple_id: input.coupleId,
      group_id: input.groupId,
      owner_user_id: input.ownerUserId ?? null,
      type: input.type,
      title: input.title,
      summary: input.summary ?? null,
      payload: input.payload ?? null,
      priority: input.priority ?? "normal",
      due_at: input.dueAt ?? null,
      source: input.source ?? null,
      related_pending_action_id: input.relatedPendingActionId ?? null,
      related_expense_id: input.relatedExpenseId ?? null,
    })
    .select("id")
    .single();

  if (error) throw new Error(`create assistant task failed: ${error.message}`);
  return z.object({ id: z.string().uuid() }).parse(data).id;
}

/* ─── Query ─── */

export async function getOpenTasks(
  db: SupabaseClient,
  options: {
    coupleId: number;
    groupId?: string;
    userId?: string;
    limit?: number;
    types?: AssistantTaskType[];
  },
): Promise<AssistantTask[]> {
  let query = db
    .from("assistant_tasks")
    .select("*")
    .eq("couple_id", options.coupleId)
    .eq("status", "open")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false });

  const visibleTypes = options.types ?? DEFAULT_VISIBLE_TASK_TYPES;

  if (options.groupId) {
    query = query.eq("group_id", options.groupId);
  }
  if (options.userId) {
    query = query.eq("owner_user_id", options.userId);
  }
  if (visibleTypes.length) {
    query = query.in("type", visibleTypes);
  }
  if (options.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;
  if (error) throw new Error(`get open tasks failed: ${error.message}`);
  return z.array(taskRowSchema).parse(data).map(toTask);
}

export async function getOpenTaskCount(
  db: SupabaseClient,
  coupleId: number,
  groupId?: string,
): Promise<number> {
  let query = db
    .from("assistant_tasks")
    .select("id", { count: "exact", head: true })
    .eq("couple_id", coupleId)
    .eq("status", "open");

  if (groupId) {
    query = query.eq("group_id", groupId);
  }

  const { count, error } = await query;
  if (error) throw new Error(`task count failed: ${error.message}`);
  return count ?? 0;
}

export async function getTask(
  db: SupabaseClient,
  taskId: string,
): Promise<AssistantTask | null> {
  const { data, error } = await db
    .from("assistant_tasks")
    .select("*")
    .eq("id", z.string().uuid().parse(taskId))
    .single();

  if (error) return null;
  return toTask(taskRowSchema.parse(data));
}

/* ─── Update ─── */

export async function completeTask(
  db: SupabaseClient,
  taskId: string,
): Promise<void> {
  await db
    .from("assistant_tasks")
    .update({ status: "done", updated_at: new Date().toISOString() })
    .eq("id", z.string().uuid().parse(taskId));
}

export async function dismissTask(
  db: SupabaseClient,
  taskId: string,
): Promise<void> {
  await db
    .from("assistant_tasks")
    .update({ status: "dismissed", updated_at: new Date().toISOString() })
    .eq("id", z.string().uuid().parse(taskId));
}

export async function snoozeTask(
  db: SupabaseClient,
  taskId: string,
  until: string,
): Promise<void> {
  await db
    .from("assistant_tasks")
    .update({
      status: "snoozed",
      snooze_until: until,
      updated_at: new Date().toISOString(),
    })
    .eq("id", z.string().uuid().parse(taskId));
}

/* ─── Cleanup ─── */

export async function expireOldTasks(
  db: SupabaseClient,
  coupleId?: number,
): Promise<number> {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() - DEFAULT_TASK_EXPIRY_DAYS);

  let query = db
    .from("assistant_tasks")
    .update({ status: "expired", updated_at: new Date().toISOString() })
    .eq("status", "open")
    .lt("created_at", expiry.toISOString());

  if (coupleId) {
    query = query.eq("couple_id", coupleId);
  }

  const { error } = await query;
  if (error) throw new Error(`expire old tasks failed: ${error.message}`);

  const { count } = await db
    .from("assistant_tasks")
    .select("id", { count: "exact", head: true })
    .eq("status", "expired")
    .lt("created_at", expiry.toISOString());

  return count ?? 0;
}

/* ─── Dedup ─── */

export async function hasPendingTaskOfType(
  db: SupabaseClient,
  options: {
    coupleId: number;
    groupId: string;
    type: AssistantTaskType;
    relatedExpenseId?: string;
  },
): Promise<boolean> {
  let query = db
    .from("assistant_tasks")
    .select("id")
    .eq("couple_id", options.coupleId)
    .eq("group_id", options.groupId)
    .eq("type", options.type)
    .eq("status", "open");

  if (options.relatedExpenseId) {
    query = query.eq("related_expense_id", options.relatedExpenseId);
  }

  const { data } = await query.limit(1);
  return (data?.length ?? 0) > 0;
}

/* ─── Helpers ─── */

function toTask(row: z.infer<typeof taskRowSchema>): AssistantTask {
  return {
    id: row.id,
    couple_id: row.couple_id,
    group_id: row.group_id,
    owner_user_id: row.owner_user_id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    payload: row.payload,
    status: row.status,
    priority: row.priority,
    due_at: row.due_at,
    snooze_until: row.snooze_until,
    source: row.source,
    related_pending_action_id: row.related_pending_action_id,
    related_expense_id: row.related_expense_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function formatTaskList(tasks: AssistantTask[], title: string): string {
  if (tasks.length === 0) return "";
  const lines = [title];
  for (const [i, task] of tasks.entries()) {
    const label = task.summary || task.title;
    lines.push(`${i + 1}. ${label}`);
  }
  return lines.join("\n");
}
