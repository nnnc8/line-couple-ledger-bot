import { createHash } from "node:crypto";

import type { PendingActionInsertInput } from "./pending-action-types";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item) ?? null);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("idempotency payload contains a non-finite number");
  }
  return value;
}

/**
 * SHA-256(lowercase hex) of stable JSON containing only action type, group and
 * payload. Requester/action scoping is enforced by the database index; source
 * event, expiry and timestamps are deliberately excluded so retries match.
 */
export function pendingActionRequestFingerprint(
  input: Pick<PendingActionInsertInput, "actionType" | "groupId" | "payload">,
): string {
  const canonicalRequest = canonicalize({
    actionType: input.actionType,
    groupId: input.groupId,
    payload: input.payload,
  });
  return createHash("sha256")
    .update(JSON.stringify(canonicalRequest))
    .digest("hex");
}
