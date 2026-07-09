import type { ToolContext } from "./accountant-tools";

const NOTIFY_TAG = "[通知另一半]";
const PARTNER_NOTIFICATION_TOOLS = new Set([
  "update_expense",
  "propose_settlement",
  "propose_merchant_rule",
]);

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface SecretaryWorkflowResult {
  answer: string;
  toolCallCount: number;
  pendingActions: unknown[];
  newTasks: string[];
  notifyPartner: boolean;
  partnerMessage: string | null;
  lastToolCall: ToolCallRecord | null;
}

export class SecretaryWorkflowService {
  private toolCallCount = 0;
  private notifyPartner = false;
  private readonly pendingActions: unknown[] = [];
  private readonly newTasks: string[] = [];
  private lastToolCall: ToolCallRecord | null = null;

  constructor(
    private readonly input: {
      executeTool: (
        name: string,
        args: Record<string, unknown>,
        ctx: ToolContext,
      ) => Promise<unknown>;
    },
  ) {}

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<unknown> {
    this.toolCallCount++;
    const result = await this.input.executeTool(name, args, ctx);
    this.lastToolCall = { name, args, result };
    const record = asRecord(result);
    if (record?.pending_action) {
      this.pendingActions.push(record.pending_action);
    }
    if (record?.task_id) {
      this.newTasks.push(String(record.task_id));
    }
    if (PARTNER_NOTIFICATION_TOOLS.has(name)) {
      this.notifyPartner = true;
    }
    return result;
  }

  finish(answer: string): SecretaryWorkflowResult {
    let finalAnswer = answer || "處理完成。";
    if (finalAnswer.includes(NOTIFY_TAG)) {
      this.notifyPartner = true;
      finalAnswer = finalAnswer.replace(NOTIFY_TAG, "").trim();
    }

    return {
      answer: finalAnswer,
      toolCallCount: this.toolCallCount,
      pendingActions: [...this.pendingActions],
      newTasks: [...this.newTasks],
      notifyPartner: this.notifyPartner,
      partnerMessage: this.notifyPartner ? finalAnswer.slice(0, 200) : null,
      lastToolCall: this.lastToolCall,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
