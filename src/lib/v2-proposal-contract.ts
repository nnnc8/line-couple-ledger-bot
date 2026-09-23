import { z } from "zod";

const twdAmountStringSchema = z.string().regex(/^(0|[1-9][0-9]*)$/, "TWD 必須是非負整數");

export const v2ProposalStatusSchema = z.enum(["proposed", "confirmed", "cancelled", "expired"]);

export const v2ProposalSourceSchema = z.object({
  kind: z.enum(["line_text", "line_audio", "line_ai"]),
  eventId: z.string().trim().min(1).max(200),
}).strict();

export const v2ProposalRevisionSchema = z.object({
  revision: z.number().int().positive(),
  parentProposalId: z.string().uuid().nullable(),
  rootProposalId: z.string().uuid(),
  reason: z.string().trim().max(500).nullable(),
  source: v2ProposalSourceSchema.nullable(),
  changes: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
  supersededByProposalId: z.string().uuid().nullable().optional(),
  supersededAt: z.string().datetime().nullable().optional(),
}).strict();

export const v2ProposalParticipantSchema = z.object({
  userId: z.string().uuid(),
  amountTwd: twdAmountStringSchema,
}).strict();

const v2ProposalCommandFields = {
  type: z.enum(["expense", "income", "transfer"]),
  amountTwd: twdAmountStringSchema,
  occurredOn: z.iso.date(),
  description: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(40).nullable(),
  categoryId: z.string().uuid().nullable(),
  note: z.string().trim().max(1000).nullable(),
  splitMethod: z.enum(["none", "equal", "exact", "percentage", "weights"]),
  payments: z.array(v2ProposalParticipantSchema).min(1).max(2),
  shares: z.array(v2ProposalParticipantSchema).max(2).optional(),
  percentages: z.tuple([z.number().min(0).max(100), z.number().min(0).max(100)]).optional(),
  exactShares: z.record(z.string().uuid(), twdAmountStringSchema).optional(),
} as const;

export const v2ProposalCommandInputSchema = z.object(v2ProposalCommandFields).strict();

export const v2ProposalCommandSchema = z.object({
  ...v2ProposalCommandFields,
  shares: z.array(v2ProposalParticipantSchema).max(2),
  commandIndex: z.number().int().nonnegative().max(19),
  commandId: z.string().trim().min(1).max(120),
  ledgerId: z.string().uuid(),
  ledgerName: z.string().trim().min(1).max(40),
  validation: z.object({
    state: z.enum(["valid", "invalid"]),
    issues: z.array(z.string().trim().min(1).max(300)).max(20),
  }).strict(),
}).strict();

export const v2ProposalValidationIssueSchema = z.object({
  code: z.string().trim().min(1).max(80),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string().trim().min(1).max(300),
}).strict();

export const v2ProposalValidationSchema = z.object({
  state: z.enum(["valid", "invalid", "needs_clarification", "stale", "expired"]),
  issues: z.array(v2ProposalValidationIssueSchema).max(50),
  clarifications: z.array(z.string().trim().min(1).max(300)).max(20),
}).strict();

export const v2ProposalResultSchema = z.record(z.string(), z.unknown());

export const v2ProposalConfirmationSchema = z.object({
  proposalId: z.string().uuid(),
  status: z.literal("confirmed"),
  transactions: z.array(z.record(z.string(), z.unknown())).min(1).max(20),
  balance: z.record(z.string(), z.string().regex(/^-?(0|[1-9][0-9]*)$/, "餘額必須是整數 TWD")),
  nextPayer: z.object({
    payerUserId: z.string().uuid(),
    payeeUserId: z.string().uuid(),
    amountTwd: twdAmountStringSchema,
  }).nullable(),
  ledgerVersion: z.number().int().positive(),
}).passthrough();

export const v2ProposalDetailSchema = z.object({
  proposalId: z.string().uuid(),
  coupleId: z.number().int().positive(),
  createdAt: z.string().datetime(),
  ledgerId: z.string().uuid(),
  ledgerName: z.string().trim().min(1).max(40),
  ledgerVersion: z.number().int().positive(),
  currentLedgerVersion: z.number().int().positive(),
  status: v2ProposalStatusSchema,
  commands: z.array(v2ProposalCommandSchema).min(1).max(20),
  commandCount: z.number().int().positive().max(20),
  expiresAt: z.string().datetime(),
  source: v2ProposalSourceSchema.nullable(),
  sourceSummary: z.string().trim().max(200).nullable(),
  revision: v2ProposalRevisionSchema,
  validation: v2ProposalValidationSchema,
  result: v2ProposalResultSchema.nullable(),
}).strict();

export const reviseV2ProposalInputSchema = z.object({
  ledgerId: z.string().uuid().optional(),
  commands: z.array(v2ProposalCommandInputSchema).min(1).max(20),
  reason: z.string().trim().max(500).optional(),
  expiresInSeconds: z.number().int().min(30).max(15 * 60).optional(),
}).strict();

export type V2ProposalCommand = z.infer<typeof v2ProposalCommandSchema>;
export type V2ProposalCommandInput = z.infer<typeof v2ProposalCommandInputSchema>;
export type V2ProposalConfirmation = z.infer<typeof v2ProposalConfirmationSchema>;
export type V2ProposalDetail = z.infer<typeof v2ProposalDetailSchema>;
export type V2ProposalRevision = z.infer<typeof v2ProposalRevisionSchema>;
export type V2ProposalSource = z.infer<typeof v2ProposalSourceSchema>;
export type ReviseV2ProposalInput = z.infer<typeof reviseV2ProposalInputSchema>;

export type V2ProposalStoredMetadata = {
  proposal: V2ProposalRevision;
};

export function parseV2ProposalStoredMetadata(value: unknown): V2ProposalStoredMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = z.object({ proposal: v2ProposalRevisionSchema }).strict().safeParse(value);
  return parsed.success ? parsed.data : null;
}
