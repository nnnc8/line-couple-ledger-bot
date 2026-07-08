/**
 * agent-event-service — write-behind audit log for agent interactions.
 *
 * Every LINE message, LIFF action, and cron job that touches the agent
 * surface writes an event here AFTER the main business logic completes.
 * All writes are best-effort: failures are logged but never block the
 * primary write path.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/* ─── Types ─── */

const AGENT_EVENT_KINDS = [
  "text_expense",
  "text_query",
  "text_other",
  "image_rejected",
  "audio_transcribed",
  "needs_group",
  "action_executed",
  "action_failed",
  "task_created",
  "cron_recurring",
  "cron_report",
] as const;

const AGENT_EVENT_STATUSES = [
  "completed",
  "failed",
  "needs_group",
  "rejected",
] as const;

export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];
export type AgentEventStatus = (typeof AGENT_EVENT_STATUSES)[number];
export type AgentEventSource = "line" | "liff" | "cron" | "system";

export interface LogAgentEventInput {
  coupleId: number;
  groupId: string | null;
  userId: string;
  source: AgentEventSource;
  sourceEventId: string | null;
  kind: AgentEventKind;
  status: AgentEventStatus;
  inputText: string | null;
  replyText: string | null;
  payload?: Record<string, unknown>;
  pendingActionId?: string;
  taskId?: string;
}

/* ─── Write (best-effort) ─── */

/**
 * Log an agent event. Best-effort: never throws.
 * Call this AFTER the primary business logic has completed.
 */
export async function logAgentEvent(
  db: SupabaseClient,
  input: LogAgentEventInput,
): Promise<void> {
  try {
    await db.from("agent_events").insert({
      couple_id: input.coupleId,
      group_id: input.groupId,
      user_id: input.userId,
      source: input.source,
      source_event_id: input.sourceEventId,
      kind: input.kind,
      status: input.status,
      input_text: input.inputText?.slice(0, 2000) ?? null,
      reply_text: input.replyText?.slice(0, 2000) ?? null,
      payload: input.payload ?? null,
      pending_action_id: input.pendingActionId ?? null,
      task_id: input.taskId ?? null,
      processed_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("agent_event write failed (non-blocking)", {
      kind: input.kind,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/* ─── Read ─── */

const agentEventRowSchema = z.object({
  id: z.string().uuid(),
  couple_id: z.number().int(),
  group_id: z.string().uuid().nullable(),
  user_id: z.string().uuid(),
  source: z.string(),
  source_event_id: z.string().nullable(),
  kind: z.string(),
  status: z.string(),
  input_text: z.string().nullable(),
  reply_text: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  pending_action_id: z.string().uuid().nullable(),
  task_id: z.string().uuid().nullable(),
  created_at: z.string(),
  processed_at: z.string().nullable(),
});

export type AgentEventRow = z.infer<typeof agentEventRowSchema>;

export async function getRecentEvents(
  db: SupabaseClient,
  coupleId: number,
  options?: { limit?: number; offset?: number },
): Promise<AgentEventRow[]> {
  const limit = options?.limit ?? 20;
  const offset = options?.offset ?? 0;

  const { data, error } = await db
    .from("agent_events")
    .select("*")
    .eq("couple_id", coupleId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`get recent events failed: ${error.message}`);
  return z.array(agentEventRowSchema).parse(data ?? []);
}
