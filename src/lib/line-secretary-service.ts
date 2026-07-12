import { createHash } from "node:crypto";
import { z } from "zod";
import type { GoogleGenAI } from "@google/genai";
import type { LineBotClient } from "@line/bot-sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serverEnvironment } from "./server-runtime";
import { runSecretaryLoop } from "./secretary-agent";
import { notifyPartner as pushNotifyPartner } from "./secretary-push";
import { SecretaryService } from "./secretary-service";
import { pendingActionService, agentChatService } from "./services";
import {
  inferDeterministicPayerHint,
  resolveSharedGroupStrict,
} from "./line-message-parsers";
import { logAgentEvent } from "./agent-event-service";
import {
  flexNeedsGroup,
  flexExpenseConfirm,
  flexQueryResult,
  type LineReplyMessage,
} from "./flex-message-builder";
import { actionResultMessage, type ReplyPayload } from "./line-bot-shared";
import type { ToolCallRecord } from "./secretary-workflow-service";
import { loadGroupBalances } from "./balance-loader";

export interface LineUser {
  id: string;
  couple_id: number;
  role: "owner" | "partner";
  line_user_id: string;
}

export interface LineSecretaryDependencies {
  lineClient: Pick<LineBotClient, "replyMessage" | "getMessageContent" | "pushMessage">;
  supabase: SupabaseClient;
  gemini: GoogleGenAI;
  context?: Record<string, unknown>;
}

const actionResultSchema = z.object({
  result: z.enum([
    "confirmed",
    "cancelled",
    "expired",
    "stale",
    "not_found",
    "already_done",
  ]),
  action_type: z.string().nullable().optional(),
  created_count: z.number().int().optional(),
});

const secretaryService = new SecretaryService();

function looksLikeGroupRequiredIntent(text: string): boolean {
  return /記|帳|花|買|付|支出|收入|欠|結清|轉帳|轉給|還|已付款|刪除|修改|改成|查|多少|幫我/.test(text);
}

export function parseSettlementRequest(text: string): {
  full: boolean;
  amountTwd: number | null;
  partnerClaim: boolean;
} | null {
  const normalized = text.replace(/[\s,，]/g, "");
  const partnerClaim = /另一半已還我|對方已還我|他已還我|她已還我/.test(normalized);
  const full = /全部結清|全額結清|全部還清|結清/.test(normalized);
  if (
    !partnerClaim &&
    !full &&
    !/我轉|轉帳|轉給|我還|還另一半|還給另一半|我已付款|我已轉帳/.test(normalized)
  ) {
    return null;
  }
  const amountMatch = text.match(/-?\d[\d,]*(?:\.\d+)?/);
  const amountTwd = amountMatch ? Number(amountMatch[0]!.replace(/,/g, "")) : null;
  return {
    full,
    amountTwd: Number.isFinite(amountTwd) ? amountTwd : null,
    partnerClaim,
  };
}

export async function runLineSecretaryTurn(input: {
  text: string;
  user: LineUser;
  dependencies: LineSecretaryDependencies;
  reply: (message: ReplyPayload) => Promise<void>;
  imageData?: { imageData: string; mimeType: string };
  groupIdOverride?: string;
  sourceEventId?: string;
}): Promise<void> {
  const { text, user, dependencies, reply, imageData } = input;
  const groups = await listActiveGroups(dependencies.supabase, user).catch(() => []);

  // Strict group resolution: shared expenses require explicit group name
  const isExplicitlyPrivate = /私人|自己的|我自己/.test(text);
  const strictResult = resolveSharedGroupStrict(text, groups);
  const hasGroup = !!strictResult.group || !!input.groupIdOverride || groups.length === 1;

  // Gate: only accounting-style intents fail fast when shared account is in scope.
  // Help, join, greetings, and other chitchat pass through to the LLM.
  if (
    !isExplicitlyPrivate &&
    !hasGroup &&
    groups.length > 1 &&
    looksLikeGroupRequiredIntent(text)
  ) {
    const groupNames = groups.map(g => g.name).join("、");
    const replyText = `要記到哪個群組？你的群組有：${groupNames}`;
    const flexMsg = flexNeedsGroup(groups);
    await reply(flexMsg);
    await logAgentEvent(dependencies.supabase, {
      coupleId: user.couple_id,
      groupId: null,
      userId: user.id,
      source: "line",
      sourceEventId: input.sourceEventId ?? null,
      kind: "needs_group",
      status: "needs_group",
      inputText: text,
      replyText,
    });
    return;
  }

  // Determine groupId: prefer explicit mention, then override, then LIFF active group.
  // No more audio-implicit fallback.
  const resolvedGroupId =
    input.groupIdOverride
    ?? strictResult.group?.id
    ?? (await getActiveGroupId(dependencies.supabase, user));
  const groupId = resolvedGroupId;
  const resolvedGroup =
    strictResult.group ?? groups.find((group) => group.id === groupId) ?? null;

  // Use cleaned text from strict resolver (group name stripped) to avoid LLM hallucination
  const cleanedText = strictResult.cleanedText;

  // Local-only toolCtx: never write back to dependencies.context so concurrent
  // webhook events in the same batch don't pollute each other.
  const toolCtx = {
    db: dependencies.supabase,
    groupId,
    userId: user.id,
    coupleId: user.couple_id,
    context: {
      resolvedGroupId: hasGroup ? groupId : undefined,
      resolvedGroupName: hasGroup ? resolvedGroup?.name : undefined,
      deterministicPayerHint: inferDeterministicPayerHint(text) ?? undefined,
    },
  };

  const agentDeps = {
    gemini: dependencies.gemini,
    supabase: dependencies.supabase,
  };

  // Get partner user info for secretary context
  const partner = await findPartner(dependencies.supabase, user);

  const settlementRequest = parseSettlementRequest(text);
  if (settlementRequest && hasGroup) {
    await handleSettlementTurn({
      request: settlementRequest,
      groupId,
      groupName: resolvedGroup?.name ?? "共同帳本",
      user,
      partner,
      dependencies,
      reply,
      sourceEventId: input.sourceEventId,
    });
    return;
  }

  // Load couple-level session
  const { data: lastSession } = await dependencies.supabase
    .from("secretary_sessions")
    .select("id")
    .eq("couple_id", user.couple_id)
    .eq("group_id", groupId)
    .order("last_active_at", { ascending: false })
    .limit(1)
    .single();

  const sessionId = lastSession?.id ?? null;

  try {
    const userName = "你";
    const partnerName = "另一半";

    const serverContext = {
      env: serverEnvironment(),
      db: dependencies.supabase,
      user: {
        id: user.id,
        couple_id: user.couple_id,
        line_user_id: user.line_user_id,
        role: user.role,
      },
    };
    const workflowResult = await secretaryService.run({
      initialInput: {
        text: cleanedText,
        ...(imageData ? { imageData: imageData.imageData, mimeType: imageData.mimeType } : {}),
      },
      sessionId,
      runLoop: (inputMsg, currentSessionId) =>
        runSecretaryLoop(
          inputMsg,
          currentSessionId,
          user.id,
          user.couple_id,
          userName,
          partnerName,
          toolCtx,
          agentDeps,
        ),
      executeAction: async (action) =>
        actionResultSchema.parse(
          await pendingActionService.executeAgentAction(
            serverContext,
            action,
            lineActionMetadata(input.sourceEventId, action),
          ),
        ),
    });
    if (workflowResult.actionFailure) {
      const { actionResultMessage } = await import("./line-bot-shared");
      const failReply = actionResultMessage(workflowResult.actionFailure);
      await reply(failReply);
      // Write-behind: log failed action
      await logAgentEvent(dependencies.supabase, {
        coupleId: user.couple_id,
        groupId,
        userId: user.id,
        source: "line",
        sourceEventId: input.sourceEventId ?? null,
        kind: "action_failed",
        status: "failed",
        inputText: text,
        replyText: failReply,
      });
      return;
    }

    // Build Flex card from the last tool call if applicable
    const flexCard = workflowResult.didExecuteAction
      ? await buildFlexFromToolCall(
          workflowResult.lastToolCall,
          { db: dependencies.supabase, groupId, userId: user.id },
        )
      : null;

    const finalReply = workflowResult.reply;
    const replyPayload: ReplyPayload = flexCard ?? finalReply;

    await reply(replyPayload);

    // Write-behind: log successful interaction
    const eventKind = workflowResult.didExecuteAction
      ? "action_executed" as const
      : "text_other" as const;
    await logAgentEvent(dependencies.supabase, {
      coupleId: user.couple_id,
      groupId,
      userId: user.id,
      source: "line",
      sourceEventId: input.sourceEventId ?? null,
      kind: eventKind,
      status: "completed",
      inputText: text,
      replyText: finalReply,
    });

    if (workflowResult.notifyPartner && workflowResult.partnerMessage && partner) {
      await pushNotifyPartner(dependencies.lineClient, dependencies.supabase, {
        targetUserId: partner.id,
        message: workflowResult.partnerMessage,
      });
    }
  } catch (error) {
    console.error("Secretary loop failed", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.slice(0, 500) : undefined,
      name: error instanceof Error ? error.name : typeof error,
    });
    await reply("抱歉，我暫時無法處理你的請求，請稍後再試。");
  }
}

async function handleSettlementTurn(input: {
  request: { full: boolean; amountTwd: number | null; partnerClaim: boolean };
  groupId: string;
  groupName: string;
  user: LineUser;
  partner: LineUser | null;
  dependencies: LineSecretaryDependencies;
  reply: (message: ReplyPayload) => Promise<void>;
  sourceEventId?: string;
}): Promise<void> {
  const balances = await loadGroupBalances(input.dependencies.supabase, input.groupId);
  const mine = balances.find((row) => row.userId === input.user.id)?.balanceTwd ?? 0;

  if (input.request.partnerClaim && mine > 0) {
    const replyText = "請讓實際付款者從自己的 LINE 記錄轉帳，我不會代替對方改帳。";
    await input.reply(replyText);
    return;
  }
  if (mine >= 0) {
    await input.reply(mine === 0 ? "目前帳務已結清。" : "目前是對方欠你，請由對方從自己的 LINE 記錄轉帳。再見到實際轉帳後，我才會入帳。");
    return;
  }

  const owed = Math.abs(mine);
  const amount = input.request.full ? owed : input.request.amountTwd;
  if (amount === null) {
    await input.reply(`請提供轉帳金額（目前欠 NT$${owed.toLocaleString()}）。`);
    return;
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    await input.reply("轉帳金額必須是正整數。");
    return;
  }
  if (amount > owed) {
    await input.reply(`轉帳金額不能超過目前欠款 NT$${owed.toLocaleString()}。`);
    return;
  }

  const result = actionResultSchema.parse(
    await pendingActionService.executeAgentAction(
      {
        env: serverEnvironment(),
        db: input.dependencies.supabase,
        user: input.user,
      },
      { type: "settle", groupId: input.groupId, amountTwd: amount },
      lineActionMetadata(input.sourceEventId, {
        type: "settle",
        groupId: input.groupId,
        amountTwd: amount,
      }),
    ),
  );
  if (!["confirmed", "already_done"].includes(result.result)) {
    await input.reply(actionResultMessage(result));
    return;
  }

  const after = await loadGroupBalances(input.dependencies.supabase, input.groupId);
  const remaining = Math.max(
    0,
    -(after.find((row) => row.userId === input.user.id)?.balanceTwd ?? 0),
  );
  const notification = remaining === 0
    ? `${input.groupName}帳務已結清｜收到 NT$${amount.toLocaleString()}`
    : `另一半記錄已轉帳 NT$${amount.toLocaleString()}｜${input.groupName}｜尚欠 NT$${remaining.toLocaleString()}`;
  await input.reply(
    remaining === 0
      ? `${input.groupName}帳務已結清｜已記錄轉帳 NT$${amount.toLocaleString()}`
      : `已記錄轉帳 NT$${amount.toLocaleString()}｜${input.groupName}｜尚欠 NT$${remaining.toLocaleString()}`,
  );
  await logAgentEvent(input.dependencies.supabase, {
    coupleId: input.user.couple_id,
    groupId: input.groupId,
    userId: input.user.id,
    source: "line",
    sourceEventId: input.sourceEventId ?? null,
    kind: "action_executed",
    status: "completed",
    inputText: null,
    replyText: notification,
  });
  if (result.result === "confirmed" && input.partner) {
    await pushNotifyPartner(input.dependencies.lineClient, input.dependencies.supabase, {
      targetUserId: input.partner.id,
      message: notification,
    });
  }
}

export async function handleLineAudioTurn(input: {
  messageId: string;
  sourceEventId?: string;
  user: LineUser;
  dependencies: LineSecretaryDependencies;
  reply: (message: ReplyPayload) => Promise<void>;
}): Promise<void> {
  const { messageId, user, dependencies, reply } = input;
  try {
    const content = await dependencies.lineClient.getMessageContent(messageId);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of content) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 10 * 1024 * 1024) {
        await reply("語音訊息太大，請傳短一點的語音。");
        return;
      }
      chunks.push(buffer);
    }
    const bytes = Buffer.concat(chunks);
    const text = await agentChatService.transcribeAudio(bytes, "audio/x-m4a");
    if (!text) {
      await reply("沒聽清楚，可以再說一次或打字嗎？");
      return;
    }

    await runLineSecretaryTurn({
      text,
      sourceEventId: input.sourceEventId,
      user,
      dependencies,
      reply: async (assistantReply: ReplyPayload) => {
        const items = Array.isArray(assistantReply) ? assistantReply : [assistantReply];
        await reply([`聽到：「${text}」`, ...items]);
      },
    });
  } catch (err) {
    console.error("Failed to process audio message:", err);
    await reply("語音處理失敗，請稍後再試或直接打字。");
  }
}

export async function handleLineImageTurn(input: {
  messageId: string;
  sourceEventId?: string;
  user: LineUser;
  dependencies: LineSecretaryDependencies;
  reply: (message: ReplyPayload) => Promise<void>;
}): Promise<void> {
  const replyText = "目前請直接用文字記帳，圖片暫不自動入帳 📝";
  await input.reply(replyText);
  await logAgentEvent(input.dependencies.supabase, {
    coupleId: input.user.couple_id,
    groupId: null,
    userId: input.user.id,
    source: "line",
    sourceEventId: input.sourceEventId ?? null,
    kind: "image_rejected",
    status: "rejected",
    inputText: null,
    replyText,
  });
}

async function findPartner(
  supabase: SupabaseClient,
  user: LineUser,
): Promise<LineUser | null> {
  const { data, error } = await supabase
    .from("users")
    .select("id, couple_id, role, line_user_id")
    .eq("couple_id", user.couple_id)
    .neq("id", user.id)
    .maybeSingle();

  if (error || !data) return null;
  return data as LineUser;
}

async function getActiveGroupId(
  supabase: SupabaseClient,
  user: LineUser,
): Promise<string> {
  const { data } = await supabase
    .from("user_preferences")
    .select("active_group_id")
    .eq("user_id", user.id)
    .single();

  if (data) {
    return z.object({ active_group_id: z.string().uuid() }).parse(data).active_group_id;
  }

  // Fallback: get any group for this couple
  const { data: groups } = await supabase
    .from("groups")
    .select("id")
    .eq("couple_id", user.couple_id)
    .is("archived_at", null)
    .limit(1);

  if (groups?.length) {
    return z.object({ id: z.string().uuid() }).parse(groups[0]).id;
  }

  throw new Error("找不到可用群組");
}

async function listActiveGroups(
  supabase: SupabaseClient,
  user: LineUser,
): Promise<Array<{ id: string; name: string }>> {
  const { data, error } = await supabase
    .from("groups")
    .select("id, name")
    .eq("couple_id", user.couple_id)
    .is("archived_at", null);

  if (error) throw error;
  return z.array(z.object({ id: z.string().uuid(), name: z.string() })).parse(data ?? []);
}

function lineActionMetadata(
  sourceEventId: string | undefined,
  action: Record<string, unknown>,
) {
  if (!sourceEventId) return undefined;
  const digest = createHash("sha256")
    .update(JSON.stringify(action))
    .digest("hex")
    .slice(0, 24);
  const key = `${sourceEventId}:${digest}`;
  return {
    source: "line",
    sourceEventId: key,
    idempotencyKey: key,
  };
}

async function buildFlexFromToolCall(
  toolCall: ToolCallRecord | null,
  ctx: { db: SupabaseClient; groupId: string; userId: string },
): Promise<LineReplyMessage | null> {
  if (!toolCall) return null;

  if (toolCall.name === "record_expense") {
    const args = toolCall.args as {
      description?: string;
      amount_twd?: number;
      tag?: string;
      paid_by?: "self" | "partner";
      ledger?: "shared" | "private";
    };
    if (!args.description || !args.amount_twd || !args.paid_by) return null;

    let balanceText: string | undefined;
    let groupName: string | undefined;
    if (args.ledger !== "private" && ctx.groupId) {
      try {
        const balances = await loadGroupBalances(ctx.db, ctx.groupId);
        const myBalance = balances.find((b) => b.userId === ctx.userId)?.balanceTwd ?? 0;
        balanceText = myBalance > 0
          ? `對方欠你 NT$${myBalance.toLocaleString()}`
          : myBalance < 0
            ? `你欠對方 NT$${Math.abs(myBalance).toLocaleString()}`
            : "帳務已結清";
        const { data: groupRow } = await ctx.db
          .from("groups")
          .select("name")
          .eq("id", ctx.groupId)
          .single();
        groupName = groupRow?.name ?? undefined;
      } catch {
        // Balance/group lookup is optional; card works without it
      }
    }

    return flexExpenseConfirm({
      description: args.description,
      amountTwd: args.amount_twd,
      tag: args.tag,
      paidBy: args.paid_by,
      ledger: args.ledger ?? "shared",
      groupName,
      balanceText,
    });
  }

  if (toolCall.name === "query_expenses" || toolCall.name === "analyze_spending") {
    const result = toolCall.result as Record<string, unknown> | null;
    if (!result || "error" in result) return null;

    if (toolCall.name === "query_expenses") {
      const summary = result.summary as { total: number; count: number } | undefined;
      if (!summary) return null;
      return flexQueryResult({
        title: "查帳結果",
        totalTwd: summary.total,
        count: summary.count,
      });
    }

    const total = result.total as number | undefined;
    const count = result.transaction_count as number | undefined;
    const topTags = result.top_tags as Array<{ label: string; amount: number; percent: number }> | undefined;
    if (total == null || count == null) return null;
    return flexQueryResult({
      title: "支出分析",
      totalTwd: total,
      count,
      topTags,
    });
  }

  return null;
}
