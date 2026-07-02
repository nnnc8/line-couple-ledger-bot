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

export function mapMessages(messages: any[]): any[] {
  return messages.map((msg) => {
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.parts)) {
      content = msg.parts.map((p: any) => p.text || "").join("\n");
    } else if (typeof msg.parts === "string") {
      content = msg.parts;
    }
    return {
      role: msg.role === "model" ? "assistant" : msg.role,
      content,
    };
  });
}

export async function runVercelAgent(
  messages: any[],
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

  const result = await generateText({
    model: getModel(),
    system: systemInstruction,
    messages: coreMessages,
    tools,
    stopWhen: (({ steps }: any) => steps.length >= 8) as any,
  } as any);

  return workflow.finish(result.text || "處理完成。");
}
