import { z } from "zod";
import { batchCategoryUpdateSchema } from "./ledger-agent";

export const accountantAskInputSchema = z.object({
  question: z.string().trim().min(1).max(500),
  scope: z.enum(["shared", "private", "combined"]).default("combined"),
});

export const agentRunInputSchema = z.object({
  message: z.string().trim().min(1).max(500),
  scope: z.enum(["shared", "private", "combined"]).optional(),
});

export const categoryAnalyticsInputSchema = z.object({
  range: z.enum(["this_month", "six_months", "all"]).catch("this_month"),
  scope: z.enum(["shared", "private", "combined"]).catch("shared"),
});

export const categoryCleanupInputSchema = z.object({
  updates: z.array(batchCategoryUpdateSchema).min(1).max(50),
});

/**
 * Shape of the action the agent wants the user to commit through the
 * pending-action service. Kept as a structural alias of
 * `PendingActionInsertInput` so the route can pass it straight to
 * `pendingActionService.execute(context, action)`.
 */
export type CleanupActionInput = {
  actionType: string;
  groupId: string | null;
  payload: Record<string, unknown>;
  sourceEventId: string;
  idempotencyKey?: string;
};
