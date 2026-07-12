/**
 * Secretary Agent — the main agent loop for the LINE financial secretary.
 *
 * Routes user messages through Gemini, executes tools, maintains
 * couple-level sessions, and collects pending actions / tasks / memories.
 *
 * Unlike the accountant agent (per-user), the secretary agent maintains
 * shared context for both partners in a couple.
 */

import { runVercelAgent } from "./vercel-agent";
import type { ToolContext } from "./secretary-tools";
import type { AgentDeps } from "./agent-loop";
import type { ToolCallRecord } from "./secretary-workflow-service";
import { SecretaryPromptService } from "./secretary-prompt-service";
import { SecretarySessionService, type SecretarySessionScope } from "./secretary-session-service";

/* ─── Types ─── */

export type { AgentDeps } from "./agent-loop";

export interface SecretaryResult {
  answer: string;
  toolCallCount: number;
  pendingActions: unknown[];
  sessionId: string;
  newTasks: string[];
  notifyPartner: boolean;
  partnerMessage: string | null;
  lastToolCall: ToolCallRecord | null;
}

/* ─── Main Agent Loop ─── */

export interface SecretaryInput {
  text: string;
  imageData?: string;
  mimeType?: string;
}

export async function runSecretaryLoop(
  input: SecretaryInput,
  sessionId: string | null,
  userId: string,
  coupleId: number,
  userName: string,
  partnerName: string,
  ctx: ToolContext,
  deps: AgentDeps,
  sessionScope: SecretarySessionScope = "group",
): Promise<SecretaryResult> {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const sessionService = new SecretarySessionService({
    db: deps.supabase,
  });
  const prepared = await sessionService.prepareTurn({
    input,
    sessionId,
    userId,
    coupleId,
    groupId: ctx.groupId,
    scope: sessionScope,
    userName,
  });

  const systemInstruction = await new SecretaryPromptService({
    db: ctx.db,
  }).buildPrompt({
    ctx,
    today,
    userName,
    partnerName,
  });

  const result = await runVercelAgent(prepared.messages, systemInstruction, ctx);

  await sessionService.saveTurn({
    sessionId: prepared.sessionId,
    userId,
    coupleId,
    groupId: ctx.groupId,
    scope: sessionScope,
    messages: prepared.messages,
    answer: result.answer,
  });

  return {
    answer: result.answer,
    toolCallCount: result.toolCallCount,
    pendingActions: result.pendingActions,
    sessionId: prepared.sessionId,
    newTasks: result.newTasks,
    notifyPartner: result.notifyPartner,
    partnerMessage: result.partnerMessage,
    lastToolCall: result.lastToolCall,
  };
}
