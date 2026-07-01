import { pendingActionService } from "./services";
import { type PendingRetargetInput } from "./pending-action-service";

export * from "./server-runtime";
export * from "./ledger-shared";
export { type AppExpense } from "./ledger-query";

export function retargetPendingActionPayload(
  payload: Record<string, unknown>,
  userId: string,
  input: PendingRetargetInput,
): Record<string, unknown> {
  return pendingActionService.retargetPayload(payload, userId, input);
}
