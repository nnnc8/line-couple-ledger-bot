import { generateText } from "ai";

import { executeSecretaryTool } from "./secretary-tools";
import type { ToolContext } from "./secretary-tools";
import { getModel } from "./model-provider";
import { vercelToolDefs } from "./secretary-tool-registry";
import {
  SecretaryWorkflowService,
  type SecretaryWorkflowResult as VercelAgentResult,
} from "./secretary-workflow-service";

/* ─── Mapper function ─── */

type AgentMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function mapMessages(messages: unknown[]): AgentMessage[] {
  return messages.map((msg) => {
    const record = isRecord(msg) ? msg : {};
    let content = "";
    if (typeof record.content === "string") {
      content = record.content;
    } else if (Array.isArray(record.parts)) {
      content = record.parts
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("\n");
    } else if (typeof record.parts === "string") {
      content = record.parts;
    }
    const role = record.role === "model" || record.role === "assistant"
      ? "assistant"
      : record.role === "system"
        ? "system"
        : "user";
    return {
      role,
      content,
    };
  });
}

export async function runVercelAgent(
  messages: unknown[],
  systemInstruction: string,
  ctx: ToolContext,
): Promise<VercelAgentResult> {
  const workflow = new SecretaryWorkflowService({
    executeTool: executeSecretaryTool,
  });

  const coreMessages = mapMessages(messages);

  // The tool list (descriptions, parameter shapes, executors) is
  // defined exactly once, in secretary-tool-registry. This file no
  // longer hand-rolls zod schemas or per-tool descriptions — that was
  // the duplication this module previously carried.
  const tools = vercelToolDefs({
    dispatchTool: (name, args) => workflow.executeTool(name, args, ctx),
  });

  const options: Parameters<typeof generateText>[0] = {
    model: getModel(),
    system: systemInstruction,
    messages: coreMessages,
    tools,
    stopWhen: ({ steps }: { steps: unknown[] }) => steps.length >= 8,
  };
  const result = await generateText(options);

  return workflow.finish(result.text || "處理完成。");
}
