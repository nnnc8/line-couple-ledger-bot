import { z } from "zod";
import { ledgerExpenseInputSchema } from "./ledger-core";
import type { SupabaseClient } from "@supabase/supabase-js";

export const recurringInputSchema = ledgerExpenseInputSchema.extend({
  id: z.string().uuid().nullable().default(null),
  frequency: z.enum(["weekly", "monthly", "yearly"]),
  nextRunDate: z.iso.date(),
  endDate: z.iso.date().nullable().default(null),
  active: z.boolean().default(true),
});

export const recurringDeleteSchema = z.object({
  operation: z.literal("delete"),
  id: z.string().uuid(),
});

export const recurringToggleSchema = z.object({
  operation: z.literal("toggle"),
  id: z.string().uuid(),
  active: z.boolean(),
});

export const partnerRowSchema = z.object({
  id: z.string().uuid(),
});

export const recurringDeleteRowSchema = z.object({
  id: z.string().uuid(),
  group_id: z.string().uuid().nullable(),
  description: z.string(),
});

export const recurringToggleRowSchema = z.object({
  id: z.string().uuid(),
  group_id: z.string().uuid().nullable(),
  active: z.boolean(),
});

export const recurringRunUserSchema = z.object({
  id: z.string().uuid(),
  couple_id: z.number().int(),
  line_user_id: z.string(),
  role: z.enum(["owner", "partner"]),
});

export const recurringRunRowSchema = z.object({
  id: z.string().uuid(),
  group_id: z.string().uuid().nullable(),
  created_by_user_id: z.string().uuid(),
  paid_by_user_id: z.string().uuid(),
  ledger: z.enum(["shared", "private"]),
  description: z.string(),
  amount_twd: z.coerce.number().int(),
  tag: z.string(),
  split_method: z.enum(["equal", "exact", "percentage"]),
  splits: z.record(z.string(), z.coerce.number().int()),
  next_run_date: z.iso.date(),
  frequency: z.enum(["weekly", "monthly", "yearly"]),
  anchor_day: z.coerce.number().int(),
  end_date: z.iso.date().nullable(),
});

export interface RecurringSaveContext {
  db: SupabaseClient;
  user: {
    id: string;
    couple_id: number;
  };
  requireGroup: (groupId: string | null) => Promise<unknown>;
  appendActivity: (
    entityId: string,
    action: "create" | "update" | "delete",
    groupId: string | null,
    beforeState: unknown,
    afterState: unknown,
  ) => Promise<void>;
  notifyPartner: (
    title: string,
    body: string,
    groupId: string | null,
    entityId: string,
  ) => Promise<void>;
  deliverNotifications: () => Promise<void>;
}

export interface RecurringRunContext<Env = unknown> {
  env: Env;
  db: SupabaseClient;
  today: string;
  executePendingAction: (
    context: {
      env: Env;
      db: SupabaseClient;
      user: z.infer<typeof recurringRunUserSchema>;
    },
    input: {
      actionType: string;
      groupId: string | null;
      payload: Record<string, unknown>;
      sourceEventId: string;
      idempotencyKey: string;
    },
  ) => Promise<unknown>;
  logError?: (recurringId: string, error: unknown) => void;
}
