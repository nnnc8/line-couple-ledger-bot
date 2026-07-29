import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { LineUser } from "./line-bot-shared";

const amountDraftPayloadSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("expense"),
      ledger: z.enum(["shared", "private"]),
      paidBy: z.enum(["self", "partner"]),
      tag: z.string().min(1).max(50),
      description: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal("transfer"),
      direction: z.enum(["me_to_partner", "partner_to_me"]),
    })
    .strict(),
]);

const amountDraftRowSchema = z
  .object({
    id: z.string().uuid(),
    couple_id: z.number().int(),
    group_id: z.string().uuid().nullable(),
    requested_by_user_id: z.string().uuid(),
    draft_type: z.enum(["expense", "transfer"]),
    draft_version: z.literal(1),
    payload: amountDraftPayloadSchema,
    status: z.enum(["active", "consumed", "cancelled", "expired", "superseded"]),
    started_by_event_id: z.string(),
    finished_by_event_id: z.string().nullable(),
    amount_twd: z.number().int().nullable(),
    expires_at: z.string(),
    finished_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .superRefine((row, context) => {
    if (row.draft_type !== row.payload.type) {
      context.addIssue({ code: "custom", message: "draft type mismatch" });
    }
    if (row.payload.type === "transfer" && row.group_id === null) {
      context.addIssue({ code: "custom", message: "transfer group missing" });
    }
    if (
      row.payload.type === "expense" &&
      ((row.payload.ledger === "private" && row.group_id !== null) ||
        (row.payload.ledger === "shared" && row.group_id === null))
    ) {
      context.addIssue({ code: "custom", message: "expense group mismatch" });
    }
  });

export type LineMenuAmountDraftPayload = z.infer<
  typeof amountDraftPayloadSchema
>;
export type LineMenuAmountDraft = z.infer<typeof amountDraftRowSchema>;

const CANCEL_INPUTS = new Set(["取消", "不要了", "算了"]);
const RECENT_DRAFT_MS = 30 * 60 * 1000;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function parseLineMenuAmount(text: string): number | null {
  const normalized = text.normalize("NFKC").trim();
  const match = normalized.match(
    /^(?:(?:NTD|NT\$|\$)\s*)?((?:\d{1,3}(?:,\d{3})+|\d+))\s*元?$/i,
  );
  if (!match) return null;
  const amount = Number(match[1]!.replaceAll(",", ""));
  return Number.isSafeInteger(amount) && amount >= 1 && amount <= 100_000_000
    ? amount
    : null;
}

export function isLineMenuAmountCancel(text: string): boolean {
  return CANCEL_INPUTS.has(text.normalize("NFKC").trim());
}

export async function startLineMenuAmountDraft(input: {
  db: SupabaseClient;
  user: LineUser;
  groupId: string | null;
  sourceEventId: string;
  payload: LineMenuAmountDraftPayload;
}): Promise<LineMenuAmountDraft> {
  const payload = amountDraftPayloadSchema.parse(input.payload);
  const result = await input.db.rpc("start_line_menu_amount_draft", {
    p_couple_id: input.user.couple_id,
    p_user_id: input.user.id,
    p_group_id: input.groupId,
    p_draft_type: payload.type,
    p_payload: payload,
    p_source_event_id: input.sourceEventId,
  });
  if (result.error) throw new Error("LINE amount draft start failed");
  return amountDraftRowSchema.parse(result.data);
}

export async function loadLineMenuAmountDraft(input: {
  db: SupabaseClient;
  user: LineUser;
  sourceEventId: string;
  retryForNewAmount?: boolean;
}): Promise<LineMenuAmountDraft | null> {
  const replay = await findFinishedDraft(input.db, input.user, input.sourceEventId);
  if (replay) return replay;

  const first = await findLatestDraft(input.db, input.user);
  if (first) return normalizeExpiredDraft(input.db, first);
  if (!input.retryForNewAmount) return null;

  await new Promise((resolve) => setTimeout(resolve, 120));
  const retried = await findLatestDraft(input.db, input.user);
  return retried ? normalizeExpiredDraft(input.db, retried) : null;
}

export async function finishLineMenuAmountDraft(input: {
  db: SupabaseClient;
  user: LineUser;
  sourceEventId: string;
  status: "consumed" | "cancelled";
  amountTwd?: number;
}): Promise<LineMenuAmountDraft | null> {
  const result = await input.db.rpc("finish_line_menu_amount_draft", {
    p_couple_id: input.user.couple_id,
    p_user_id: input.user.id,
    p_source_event_id: input.sourceEventId,
    p_status: input.status,
    p_amount_twd: input.status === "consumed" ? input.amountTwd : null,
  });
  if (result.error) throw new Error("LINE amount draft finish failed");
  return result.data === null ? null : amountDraftRowSchema.parse(result.data);
}

export async function supersedeLineMenuAmountDraft(
  db: SupabaseClient,
  user: LineUser,
  sourceEventTimestamp: number,
): Promise<void> {
  const now = new Date().toISOString();
  const eventTime = new Date(sourceEventTimestamp).toISOString();
  const result = await db
    .from("line_menu_amount_drafts")
    .update({
      status: "superseded",
      finished_at: now,
      updated_at: now,
    })
    .eq("requested_by_user_id", user.id)
    .eq("couple_id", user.couple_id)
    .eq("status", "active")
    .lte("created_at", eventTime);
  if (result.error) throw new Error("LINE amount draft supersede failed");
}

export async function cleanupLineMenuAmountDrafts(
  db: SupabaseClient,
  now = new Date(),
): Promise<{ expired: number; purged: number }> {
  const nowIso = now.toISOString();
  const expired = await db
    .from("line_menu_amount_drafts")
    .update({
      status: "expired",
      finished_at: nowIso,
      updated_at: nowIso,
    })
    .eq("status", "active")
    .lte("expires_at", nowIso)
    .select("id");
  if (expired.error) throw new Error("LINE amount draft expiry failed");

  const cutoff = new Date(now.getTime() - TERMINAL_RETENTION_MS).toISOString();
  const purged = await db
    .from("line_menu_amount_drafts")
    .delete()
    .neq("status", "active")
    .lte("finished_at", cutoff)
    .select("id");
  if (purged.error) throw new Error("LINE amount draft cleanup failed");

  return {
    expired: Array.isArray(expired.data) ? expired.data.length : 0,
    purged: Array.isArray(purged.data) ? purged.data.length : 0,
  };
}

async function findFinishedDraft(
  db: SupabaseClient,
  user: LineUser,
  sourceEventId: string,
): Promise<LineMenuAmountDraft | null> {
  const result = await db
    .from("line_menu_amount_drafts")
    .select("*")
    .eq("requested_by_user_id", user.id)
    .eq("couple_id", user.couple_id)
    .eq("finished_by_event_id", sourceEventId)
    .maybeSingle();
  if (result.error) throw new Error("LINE amount draft replay lookup failed");
  return result.data ? amountDraftRowSchema.parse(result.data) : null;
}

async function findLatestDraft(
  db: SupabaseClient,
  user: LineUser,
): Promise<LineMenuAmountDraft | null> {
  const recent = new Date(Date.now() - RECENT_DRAFT_MS).toISOString();
  const result = await db
    .from("line_menu_amount_drafts")
    .select("*")
    .eq("requested_by_user_id", user.id)
    .eq("couple_id", user.couple_id)
    .in("status", ["active", "expired", "superseded"])
    .gte("created_at", recent)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (result.error) throw new Error("LINE amount draft lookup failed");
  return result.data ? amountDraftRowSchema.parse(result.data) : null;
}

async function normalizeExpiredDraft(
  db: SupabaseClient,
  draft: LineMenuAmountDraft,
): Promise<LineMenuAmountDraft> {
  if (
    draft.status !== "active" ||
    Date.parse(draft.expires_at) > Date.now()
  ) {
    return draft;
  }
  const now = new Date().toISOString();
  const result = await db
    .from("line_menu_amount_drafts")
    .update({ status: "expired", finished_at: now, updated_at: now })
    .eq("id", draft.id)
    .eq("status", "active")
    .select("*")
    .maybeSingle();
  if (result.error) throw new Error("LINE amount draft expiry failed");
  return result.data
    ? amountDraftRowSchema.parse(result.data)
    : { ...draft, status: "expired", finished_at: now, updated_at: now };
}
