import type { ActionResult } from "./pending-action-service";
import type { SecretaryInput, SecretaryResult } from "./secretary-agent";

const actionClaimRegex =
  /(?:已|已經|已幫|幫你|幫).{0,6}?(?:記帳|記了|記好|新增|加入|修改|改|刪除|結清|建立)/;

export interface SecretaryServiceResult {
  reply: string;
  notifyPartner: boolean;
  partnerMessage: string | null;
  actionFailure: ActionResult | null;
}

export class SecretaryService {
  async run(input: {
    initialInput: SecretaryInput;
    sessionId: string | null;
    runLoop: (input: SecretaryInput, sessionId: string | null) => Promise<SecretaryResult>;
    executeAction: (action: Record<string, unknown>) => Promise<ActionResult>;
  }): Promise<SecretaryServiceResult> {
    const result = await input.runLoop(input.initialInput, input.sessionId);
    return this.finish(result, input);
  }

  private async finish(
    result: SecretaryResult,
    input: {
      runLoop: (input: SecretaryInput, sessionId: string | null) => Promise<SecretaryResult>;
      executeAction: (action: Record<string, unknown>) => Promise<ActionResult>;
    },
  ): Promise<SecretaryServiceResult> {
    if (result.pendingActions.length > 0) {
      return this.applyActions(result, input.executeAction);
    }

    if (actionClaimRegex.test(result.answer)) {
      const correctionResult = await input.runLoop(
        {
          text: `⚠️ 你剛才說「${result.answer.slice(0, 100)}」，但你沒有實際呼叫工具。請立刻呼叫 record_expense（或其他對應工具）來執行，不要只用文字回覆。`,
        },
        result.sessionId,
      );
      if (correctionResult.pendingActions.length > 0) {
        return this.applyActions(correctionResult, input.executeAction);
      }
    }

    return {
      reply: result.answer,
      notifyPartner: result.notifyPartner,
      partnerMessage: result.partnerMessage,
      actionFailure: null,
    };
  }

  private async applyActions(
    result: SecretaryResult,
    executeAction: (action: Record<string, unknown>) => Promise<ActionResult>,
  ): Promise<SecretaryServiceResult> {
    for (const action of result.pendingActions) {
      const actionResult = await executeAction(action as Record<string, unknown>);
      if (!["confirmed", "already_done"].includes(actionResult.result)) {
        return {
          reply: result.answer,
          notifyPartner: false,
          partnerMessage: null,
          actionFailure: actionResult,
        };
      }
    }
    return {
      reply: result.answer,
      notifyPartner: result.notifyPartner,
      partnerMessage: result.partnerMessage,
      actionFailure: null,
    };
  }
}
