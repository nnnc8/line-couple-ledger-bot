import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createExpenseCommandSchema,
  batchCreateExpensesCommandSchema,
  updateExpenseCommandSchema,
  deleteExpenseCommandSchema,
  restoreExpenseCommandSchema,
  transferCommandSchema,
  createSettlementCommandSchema,
  voidSettlementCommandSchema,
} from "./ledger-core";
import { batchCategoryUpdateSchema } from "./ledger-agent";

export const actionInputSchema = z.discriminatedUnion("type", [
  createExpenseCommandSchema,
  batchCreateExpensesCommandSchema,
  updateExpenseCommandSchema,
  deleteExpenseCommandSchema,
  restoreExpenseCommandSchema,
  transferCommandSchema,
  createSettlementCommandSchema,
  voidSettlementCommandSchema,
  z.object({
    type: z.literal("batch_update_expenses"),
    updates: z.array(batchCategoryUpdateSchema).min(1).max(50),
  }),
]);

export const actionResultSchema = z.object({
  result: z.enum([
    "confirmed",
    "cancelled",
    "expired",
    "stale",
    "not_found",
    "already_done",
  ]),
  action_type: z.string().nullable().optional(),
  created_count: z.number().int().optional(),
  settlement_id: z.string().uuid().optional(),
  settlement_version: z.number().int().positive().optional(),
  balance: z
    .object({
      group_id: z.string().uuid(),
      before_by_user_id: z.record(z.string(), z.number().int()),
      after_by_user_id: z.record(z.string(), z.number().int()),
    })
    .optional(),
});

export const pendingRetargetInputSchema = z.object({
  ledger: z.literal("private"),
  tag: z.literal("交通"),
});

export type ActionInput = z.infer<typeof actionInputSchema>;
export type ActionResult = z.infer<typeof actionResultSchema>;
export type PendingRetargetInput = z.infer<typeof pendingRetargetInputSchema>;
export type CreateExpenseActionInput = Extract<
  z.infer<typeof actionInputSchema>,
  { type: "create_expense" }
>;

export interface PendingActionContext {
  db: SupabaseClient;
  user: {
    id: string;
    couple_id: number;
    line_user_id: string;
    role: "owner" | "partner";
  };
  env?: unknown;
}

export interface PendingActionInsertInput {
  actionType: string;
  groupId: string | null;
  payload: Record<string, unknown>;
  sourceEventId: string;
  idempotencyKey?: string | null;
}

export const pendingActionRowSchema = z.object({
  id: z.string(),
  couple_id: z.number().int(),
  group_id: z.string().nullable(),
  action_type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "confirmed", "cancelled", "expired"]),
  expires_at: z.string(),
});

export const pendingUserRowSchema = z.object({
  id: z.string(),
  couple_id: z.number().int(),
  line_user_id: z.string(),
  role: z.enum(["owner", "partner"]),
});

export const pendingGroupRowSchema = z.object({
  id: z.string(),
});

export const pendingExpenseRowSchema = z.object({
  id: z.string(),
  couple_id: z.number().int(),
  group_id: z.string().nullable(),
  ledger: z.enum(["shared", "private"]),
  description: z.string(),
  merchant: z.string().nullable(),
  notes: z.string().nullable(),
  tag: z.string(),
  amount_twd: z.number().int(),
  paid_by_user_id: z.string(),
  created_by_user_id: z.string(),
  expense_date: z.string(),
  split_method: z.enum(["equal", "exact", "percentage"]),
  version: z.number().int(),
  deleted_at: z.string().nullable(),
  deleted_by_user_id: z.string().nullable().optional(),
  mirror_kind: z.enum(["shared_share"]).nullable().optional().default(null),
  expense_splits: z
    .array(
      z.object({
        user_id: z.string(),
        amount_twd: z.number().int(),
      }),
    )
    .default([]),
});

export const pendingSettlementRowSchema = z.object({
  id: z.string().uuid().optional(),
  group_id: z.string().uuid().optional(),
  from_user_id: z.string(),
  to_user_id: z.string(),
  amount_twd: z.number().int(),
  intent: z.enum(["settle", "transfer"]).optional(),
  occurred_on: z.iso.date().optional(),
  notes: z.string().nullable().optional(),
  voided_at: z.string().nullable().optional(),
  version: z.number().int().positive().optional(),
});

export interface PendingActionPlan {
  expected_request_fingerprint?: string;
  ledger_action?: "transfer" | "settle" | "void_settlement";
  lock_group_ids?: string[];
  active_group_ids?: string[];
  reject_shared_to_private_if_settled_group_id?: string;
  insert_expenses?: Array<Record<string, unknown>>;
  update_expenses?: Array<Record<string, unknown>>;
  delete_expense_splits?: string[];
  insert_expense_splits?: Array<Record<string, unknown>>;
  insert_settlements?: Array<Record<string, unknown>>;
  insert_activities?: Array<Record<string, unknown>>;
  insert_notifications?: Array<Record<string, unknown>>;
}

export class StaleActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleActionError";
  }
}
