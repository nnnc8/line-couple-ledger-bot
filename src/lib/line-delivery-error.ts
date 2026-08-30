export type LineDeliveryDisposition = "permanent" | "transient";

export interface LineDeliveryFailure {
  disposition: LineDeliveryDisposition;
  operationError: string;
}

function statusFrom(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  if (error instanceof Error) {
    const match = error.message.match(/\b([1-5]\d{2})\b/);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * Retrying the same request cannot repair a LINE client/authentication error.
 * Unknown failures deliberately remain retryable because they may be a timeout
 * after LINE accepted the request or a temporary network failure.
 */
export function classifyLineDeliveryError(error: unknown): LineDeliveryFailure {
  const status = statusFrom(error);
  if (status === null) {
    return { disposition: "transient", operationError: "LINE delivery network failure" };
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { disposition: "transient", operationError: `LINE delivery HTTP ${status}` };
  }
  if (status >= 400 && status < 500) {
    return { disposition: "permanent", operationError: `LINE delivery HTTP ${status}` };
  }
  return { disposition: "transient", operationError: `LINE delivery HTTP ${status}` };
}
