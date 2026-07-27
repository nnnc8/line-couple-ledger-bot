import { LedgerCommandService } from "./ledger-core";
import { LedgerQueryService } from "./ledger-query";
import { GroupService } from "./group-service";
import { RecurringService } from "./recurring-service";
import { BankImportService } from "./bank-import-service";
import { AccountantService } from "./accountant-service";
import { AgentChatService } from "./agent-chat-service";
import { PendingActionService } from "./pending-action-service";
import { registerPendingActionService } from "./pending-action-builders";
import { deliverNotifications } from "./notification-service";
import {
  requireGroup,
  appendActivity,
  notifyPartner,
} from "./ledger-shared";
import { type ServerContext } from "./server-runtime";

const ACTION_SECONDS = 60 * 10;

export const ledgerCommandService = new LedgerCommandService();
export const ledgerQueryService = new LedgerQueryService();
export const groupService = new GroupService();
export const recurringService = new RecurringService();
export const bankImportService = new BankImportService();
export const accountantService = new AccountantService();
export const agentChatService = new AgentChatService();
export const pendingActionService = new PendingActionService({
  actionSeconds: ACTION_SECONDS,
  deliverNotifications: async (context) => {
    await deliverNotifications(context as ServerContext);
  },
});
registerPendingActionService(pendingActionService);

export async function changeGroup(context: ServerContext, input: unknown) {
  return groupService.change(
    {
      db: context.db,
      user: context.user,
      requireGroup: (groupId) => requireGroup(context, groupId),
      appendActivity: (entityId, action, groupId, beforeState, afterState) =>
        appendActivity(
          context,
          "group",
          entityId,
          action,
          groupId,
          beforeState,
          afterState,
        ),
    },
    input,
  );
}

export async function saveRecurring(context: ServerContext, input: unknown) {
  return recurringService.save(
    {
      db: context.db,
      user: context.user,
      requireGroup: (groupId) => requireGroup(context, groupId),
      appendActivity: (entityId, action, groupId, beforeState, afterState) =>
        appendActivity(
          context,
          "recurring",
          entityId,
          action,
          groupId,
          beforeState,
          afterState,
        ),
      notifyPartner: (title, body, groupId, entityId) =>
        notifyPartner(
          context,
          "recurring",
          title,
          body,
          groupId,
          "recurring",
          entityId,
        ),
      deliverNotifications: () => deliverNotifications(context),
    },
    input,
  );
}



export async function importBankCsv(context: ServerContext, input: unknown) {
  const preference = await context.db
    .from("user_preferences")
    .select("active_group_id")
    .eq("user_id", context.user.id)
    .single();
  if (preference.error) throw new Error("active group lookup failed");
  const activeGroupId = preference.data.active_group_id;
  return bankImportService.import(
    {
      db: context.db,
      getActiveGroupId: async () => activeGroupId,
    },
    input,
  );
}
