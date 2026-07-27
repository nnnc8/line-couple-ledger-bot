import type { ActionResult } from "./pending-action-service";
import type { SecretaryInput, SecretaryResult } from "./secretary-agent";
import type { ToolCallRecord } from "./secretary-workflow-service";

const actionClaimRegex =
  /(?:已|已經|已幫|幫你|幫).{0,6}?(?:記帳|記了|記好|新增|加入|修改|改|刪除|結清|建立)/;

export interface SecretaryServiceResult {
  reply: string;
  notifyPartner: boolean;
  partnerMessage: string | null;
  actionFailure: ActionResult | null;
  didExecuteAction: boolean;
  lastToolCall: ToolCallRecord | null;
}

export class SecretaryService {
  async run(input: {
    initialInput: SecretaryInput;
    sessionId: string | null;
    runLoop: (input: SecretaryInput, sessionId: string | null) => Promise<SecretaryResult>;
    plannedResult?: SecretaryResult;
    prepareResult?: (result: SecretaryResult) => Promise<SecretaryResult>;
    executeAction: (
      action: Record<string, unknown>,
      actionIndex: number,
    ) => Promise<ActionResult>;
  }): Promise<SecretaryServiceResult> {
    const generated =
      input.plannedResult ??
      (await input.runLoop(input.initialInput, input.sessionId));
    const result =
      input.plannedResult || !input.prepareResult
        ? generated
        : await input.prepareResult(generated);
    return this.finish(result, input);
  }

  private async finish(
    result: SecretaryResult,
    input: {
      runLoop: (input: SecretaryInput, sessionId: string | null) => Promise<SecretaryResult>;
      prepareResult?: (result: SecretaryResult) => Promise<SecretaryResult>;
      executeAction: (
        action: Record<string, unknown>,
        actionIndex: number,
      ) => Promise<ActionResult>;
    },
  ): Promise<SecretaryServiceResult> {
    if (result.pendingActions.length > 0) {
      return this.applyActions(result, input.executeAction);
    }

    if (result.lastToolCall && result.toolCallCount > 0) {
      const record = asRecord(result.lastToolCall.result);
      if (record && !("error" in record)) {
        return {
          reply: result.answer,
          notifyPartner: result.notifyPartner,
          partnerMessage: result.partnerMessage,
          actionFailure: null,
          didExecuteAction: true,
          lastToolCall: result.lastToolCall,
        };
      }
    }

    if (actionClaimRegex.test(result.answer)) {
      const generatedCorrection = await input.runLoop(
        {
          text: `⚠️ 你剛才說「${result.answer.slice(0, 100)}」，但你沒有實際呼叫工具。請立刻呼叫 record_expense（或其他對應工具）來執行，不要只用文字回覆。`,
        },
        result.sessionId,
      );
      const correctionResult = input.prepareResult
        ? await input.prepareResult(generatedCorrection)
        : generatedCorrection;
      if (correctionResult.pendingActions.length > 0) {
        return this.applyActions(correctionResult, input.executeAction);
      }
    }

    return {
      reply: result.answer,
      notifyPartner: result.notifyPartner,
      partnerMessage: result.partnerMessage,
      actionFailure: null,
      didExecuteAction: false,
      lastToolCall: result.lastToolCall,
    };
  }

  private async applyActions(
    result: SecretaryResult,
    executeAction: (
      action: Record<string, unknown>,
      actionIndex: number,
    ) => Promise<ActionResult>,
  ): Promise<SecretaryServiceResult> {
    let sawConfirmed = false;
    let sawAlreadyDone = false;
    for (const [actionIndex, action] of result.pendingActions.entries()) {
      const actionResult = await executeAction(
        action as Record<string, unknown>,
        actionIndex,
      );
      if (!["confirmed", "already_done"].includes(actionResult.result)) {
        return {
          reply: result.answer,
          notifyPartner: false,
          partnerMessage: null,
          actionFailure: actionResult,
          didExecuteAction: false,
          lastToolCall: result.lastToolCall,
        };
      }
      sawConfirmed ||= actionResult.result === "confirmed";
      sawAlreadyDone ||= actionResult.result === "already_done";
    }
    return {
      reply: result.answer,
      notifyPartner: result.notifyPartner && (sawConfirmed || !sawAlreadyDone),
      partnerMessage: result.notifyPartner && (sawConfirmed || !sawAlreadyDone)
        ? result.partnerMessage
        : null,
      actionFailure: null,
      didExecuteAction: true,
      lastToolCall: result.lastToolCall,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
