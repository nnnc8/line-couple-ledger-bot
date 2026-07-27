import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { HttpError } from "./http-error";
import type { SecretaryResult } from "./secretary-agent";

const secretaryResultSchema = z.object({
  answer: z.string(),
  toolCallCount: z.number().int().nonnegative(),
  pendingActions: z.array(z.record(z.string(), z.unknown())).min(1).max(50),
  sessionId: z.string().min(1),
  newTasks: z.array(z.string()),
  notifyPartner: z.boolean(),
  partnerMessage: z.string().nullable(),
  lastToolCall: z
    .object({
      name: z.string(),
      args: z.record(z.string(), z.unknown()),
      result: z.unknown(),
    })
    .nullable(),
});

const lineActionPlanRowSchema = z.object({
  source_event_id: z.string(),
  couple_id: z.number().int(),
  group_id: z.string().uuid(),
  user_id: z.string().uuid(),
  plan_version: z.literal(1),
  result: secretaryResultSchema,
});

export interface LineActionPlan {
  groupId: string;
  result: SecretaryResult;
}

type PlanOwner = {
  id: string;
  couple_id: number;
};

const PLAN_COLUMNS =
  "source_event_id, couple_id, group_id, user_id, plan_version, result";

function parseOwnedPlan(
  raw: unknown,
  user: PlanOwner,
): LineActionPlan {
  const row = lineActionPlanRowSchema.parse(raw);
  if (row.couple_id !== user.couple_id || row.user_id !== user.id) {
    throw new HttpError(409, "LINE 事件識別衝突");
  }
  return {
    groupId: row.group_id,
    result: row.result,
  };
}

export async function loadLineActionPlan(
  db: SupabaseClient,
  sourceEventId: string,
  user: PlanOwner,
): Promise<LineActionPlan | null> {
  const query = await db
    .from("line_action_plans")
    .select(PLAN_COLUMNS)
    .eq("source_event_id", sourceEventId)
    .maybeSingle();
  if (query.error) throw new Error("LINE action plan lookup failed");
  return query.data ? parseOwnedPlan(query.data, user) : null;
}

/**
 * Stores the model's first financial action plan before any action executes.
 * A concurrent redelivery may generate a different plan, but the unique event
 * key makes every worker read and execute the same winning plan.
 */
export async function persistLineActionPlan(
  db: SupabaseClient,
  input: {
    sourceEventId: string;
    groupId: string;
    user: PlanOwner;
    result: SecretaryResult;
  },
): Promise<LineActionPlan> {
  const result = secretaryResultSchema.parse(input.result);
  const row = {
    source_event_id: input.sourceEventId,
    couple_id: input.user.couple_id,
    group_id: input.groupId,
    user_id: input.user.id,
    plan_version: 1,
    result,
  };
  const inserted = await db
    .from("line_action_plans")
    .insert(row)
    .select(PLAN_COLUMNS)
    .maybeSingle();
  if (!inserted.error && inserted.data) {
    return parseOwnedPlan(inserted.data, input.user);
  }

  // The expected failure is a unique-key race. Reading after any insert error
  // also covers the case where the insert committed but its response was lost.
  const existing = await loadLineActionPlan(
    db,
    input.sourceEventId,
    input.user,
  );
  if (existing) return existing;
  throw new Error("LINE action plan insert failed");
}
