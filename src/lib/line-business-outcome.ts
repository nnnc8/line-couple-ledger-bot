import { HttpError } from "./http-error";
import { isV2IncidentFreezeError } from "./v2-incident-freeze";

export type LineBusinessOutcome =
  | { kind: "SUCCESS" }
  | { kind: "USER_REJECTED_OR_CLARIFICATION" }
  | { kind: "PERMANENT_BUSINESS_FAILURE"; error: string }
  | { kind: "RETRYABLE_PROCESSING_FAILURE"; error: string }
  | { kind: "MAINTENANCE" };

export const lineSuccess: LineBusinessOutcome = { kind: "SUCCESS" };
export const lineClarification: LineBusinessOutcome = { kind: "USER_REJECTED_OR_CLARIFICATION" };

export function lineProcessingFailure(error: unknown): LineBusinessOutcome {
  if (isV2IncidentFreezeError(error)) return { kind: "MAINTENANCE" };
  // Only our explicit business rejections are terminal. Provider/configuration,
  // network and unknown DB errors remain retryable; never infer HTTP from text.
  if (error instanceof HttpError && [400, 403, 404, 409, 422].includes(error.status)) {
    return { kind: "PERMANENT_BUSINESS_FAILURE", error: `business rejection HTTP ${error.status}` };
  }
  return { kind: "RETRYABLE_PROCESSING_FAILURE", error: "business processing failed; retry required" };
}

export function malformedInboxEvent(payload: Record<string, unknown>): boolean {
  if (!payload || typeof payload.type !== "string") return true;
  if (payload.type !== "message" && payload.type !== "postback") return false;
  if (typeof payload.webhookEventId !== "string" || !payload.webhookEventId || !Number.isFinite(payload.timestamp)) return true;
  const message = payload.message as Record<string, unknown> | undefined;
  if (payload.type === "message") return !message || typeof message.type !== "string" || typeof message.id !== "string"
    || (message.type === "text" && (typeof message.text !== "string" || !message.text.trim()));
  return typeof (payload.postback as { data?: unknown } | undefined)?.data !== "string";
}
