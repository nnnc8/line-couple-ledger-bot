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
  flexTransferConfirm,
  type LineReplyMessage,
} from "./flex-message-builder";
import type { ReplyPayload } from "./line-bot-shared";
import type { ToolCallRecord } from "./secretary-workflow-service";
import { loadGroupBalances } from "./balance-loader";
import type { SecretarySessionScope } from "./secretary-session-service";
import type { TransferDirection } from "./ledger-core";
import {
  loadLineActionPlan,
  persistLineActionPlan,
} from "./line-action-plan-service";

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

const pendingMoneyMovementSchema = z.object({
  result: z.literal("pending"),
  action_id: z.string().uuid(),
  action_type: z.enum(["transfer", "settle"]),
  group_id: z.string().uuid(),
  direction: z.enum(["me_to_partner", "partner_to_me"]),
  amount_twd: z.number().int().min(1).max(100_000_000),
  occurred_on: z.string().optional(),
  notes: z.string().nullable().optional(),
  balance: z.object({
    group_id: z.string().uuid(),
    before_by_user_id: z.record(z.string(), z.number().int()),
    after_by_user_id: z.record(z.string(), z.number().int()),
  }),
});

const secretaryService = new SecretaryService();

function looksLikeGroupRequiredIntent(text: string): boolean {
  return /記|帳|花|買|付|支出|收入|欠|結清|轉帳|轉給|還|已付款|刪除|修改|改成|查|多少|幫我/.test(text);
}

function isNonCommandMoneyMovement(text: string): boolean {
  const normalized = text.replace(/[\s,，]/g, "");
  const moneyMovement =
    /轉|已付款|還清|結清|還給|我還|他還|她還|對方還|另一半還/;
  return (
    moneyMovement.test(normalized) &&
    (/不要|不用|別|取消|不想|沒有|沒要|不是要|不需要/.test(normalized) ||
      /[?？]|嗎|是否|是不是|有沒有/.test(normalized))
  );
}

export function parseSettlementRequest(text: string): {
  intent: "transfer" | "settle";
  full: boolean;
  amountTwd: number | null;
  direction: TransferDirection | null;
} | null {
  const normalized = text.replace(/[\s,，]/g, "");
  const partner = "(?:另一半|對方|他|她)";
  if (isNonCommandMoneyMovement(normalized)) return null;
  const full = new RegExp(
    `(?:我|${partner})?(?:已經|已)?(?:全部|全額)?(?:還清|結清)(?:了)?`,
  ).test(normalized);
  const settleIntent =
    full ||
    new RegExp(`我.*還.*${partner}`).test(normalized) ||
    new RegExp(`${partner}.*還.*我`).test(normalized) ||
    /還另一半|還給另一半/.test(normalized);
  const transferIntent =
    /轉帳|已付款/.test(normalized) ||
    new RegExp(`(?:我|${partner}).*轉`).test(normalized);
  if (!settleIntent && !transferIntent) return null;

  let direction: TransferDirection | null = null;
  const partnerToMe = new RegExp(`^${partner}.*(?:轉帳|轉|還).*我`);
  const meToPartner = new RegExp(`^我.*(?:轉帳|轉|還).*${partner}`);
  const partnerFull = new RegExp(`^${partner}.*(?:還清|結清)`);
  const meFull = /^我.*(?:還清|結清)/;
  if (partnerToMe.test(normalized) || (full && partnerFull.test(normalized))) {
    direction = "partner_to_me";
  } else if (meToPartner.test(normalized) || (full && meFull.test(normalized))) {
    direction = "me_to_partner";
  } else if (settleIntent && full) direction = "me_to_partner";
  else if (/^我(?:已經|已)?(?:轉帳|轉|已付款)/.test(normalized)) {
    direction = "me_to_partner";
  }

  const amountMatch = text.match(/-?\d[\d,]*(?:\.\d+)?/);
  const amountTwd = amountMatch ? Number(amountMatch[0]!.replace(/,/g, "")) : null;
  return {
    intent: settleIntent ? "settle" : "transfer",
    full,
    amountTwd: Number.isFinite(amountTwd) ? amountTwd : null,
    direction,
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
  sourceEventTimestamp?: number;
}): Promise<void> {
  const { text, user, dependencies, reply, imageData } = input;
  const groups = await listActiveGroups(dependencies.supabase, user).catch(() => []);
  const replayPlan = input.sourceEventId
    ? await loadLineActionPlan(
        dependencies.supabase,
        input.sourceEventId,
        user,
      )
    : null;

  if (isNonCommandMoneyMovement(text)) {
    await reply(
      /不要|不用|別|取消|不想|沒有|沒要|不是要|不需要/.test(text)
        ? "好，沒有建立任何轉帳或結清。"
        : "這句看起來是在詢問，我沒有建立轉帳。要查目前餘額可以輸入「誰欠誰」。",
    );
    return;
  }

  // Strict group resolution: shared expenses require explicit group name
  const isExplicitlyPrivate = /私人|自己的|我自己/.test(text);
  const strictResult = resolveSharedGroupStrict(text, groups);
  const hasGroup =
    !!replayPlan ||
    !!strictResult.group ||
    !!input.groupIdOverride ||
    groups.length === 1;

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
    replayPlan?.groupId
    ?? input.groupIdOverride
    ?? strictResult.group?.id
    ?? (await getActiveGroupId(dependencies.supabase, user));
  const groupId = resolvedGroupId;
  const resolvedGroup =
    strictResult.group ?? groups.find((group) => group.id === groupId) ?? null;
  const sessionScope: SecretarySessionScope = isExplicitlyPrivate ? "user" : "group";

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

  const settlementRequest = replayPlan
    ? null
    : parseSettlementRequest(cleanedText);
  if (settlementRequest && hasGroup) {
    await handleSettlementTurn({
      request: settlementRequest,
      groupId,
      groupName: resolvedGroup?.name ?? "共同帳本",
      user,
      dependencies,
      reply,
      sourceEventId: input.sourceEventId,
      sourceEventTimestamp: input.sourceEventTimestamp,
    });
    return;
  }

  // A redelivery resumes the immutable plan without touching the model/session.
  let sessionId = replayPlan?.result.sessionId ?? null;
  if (!replayPlan) {
    let sessionQuery = dependencies.supabase
      .from("secretary_sessions")
      .select("id")
      .eq("couple_id", user.couple_id)
      .eq("group_id", groupId)
      .eq("scope", sessionScope);
    sessionQuery = sessionScope === "user"
      ? sessionQuery.eq("user_id", user.id)
      : sessionQuery.is("user_id", null);
    const { data: lastSession } = await sessionQuery
      .order("last_active_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    sessionId = lastSession?.id ?? null;
  }

  try {
    const userName = "你";
    const partnerName = "另一半";
    let executedPendingAction = false;

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
      plannedResult: replayPlan?.result,
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
          sessionScope,
        ),
      prepareResult: input.sourceEventId
        ? async (result) => {
            if (result.pendingActions.length === 0) return result;
            const plan = await persistLineActionPlan(
              dependencies.supabase,
              {
                sourceEventId: input.sourceEventId!,
                groupId,
                user,
                result,
              },
            );
            return plan.result;
          }
        : undefined,
      executeAction: async (action, actionIndex) => {
        executedPendingAction = true;
        return actionResultSchema.parse(
          await pendingActionService.executeAgentAction(
            serverContext,
            action,
            lineActionMetadata(input.sourceEventId, action, actionIndex),
          ),
        );
      },
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

    if (
      !executedPendingAction &&
      workflowResult.notifyPartner &&
      workflowResult.partnerMessage &&
      partner
    ) {
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
  request: {
    intent: "transfer" | "settle";
    full: boolean;
    amountTwd: number | null;
    direction: TransferDirection | null;
  };
  groupId: string;
  groupName: string;
  user: LineUser;
  dependencies: LineSecretaryDependencies;
  reply: (message: ReplyPayload) => Promise<void>;
  sourceEventId?: string;
  sourceEventTimestamp?: number;
}): Promise<void> {
  if (!input.request.direction) {
    await input.reply("這筆轉帳是「我轉給另一半」還是「另一半轉給我」？請把方向一起寫上。");
    return;
  }

  if (!input.sourceEventId) {
    await input.reply("這次無法建立安全的確認操作，請重新傳一次轉帳內容。");
    return;
  }

  let amount = input.request.amountTwd;
  if (input.request.intent === "settle") {
    const balances = await loadGroupBalances(
      input.dependencies.supabase,
      input.groupId,
    );
    const mine =
      balances.find((row) => row.userId === input.user.id)?.balanceTwd ?? 0;
    const owed = input.request.direction === "me_to_partner" ? -mine : mine;
    if (owed <= 0) {
      await input.reply(
        input.request.direction === "me_to_partner"
          ? "目前不是你欠另一半，不能使用結清；若是一般轉帳，請說「我轉給另一半 金額」。"
          : "目前不是另一半欠你，不能記錄收到還款；若是一般轉帳，請說「另一半轉給我 金額」。",
      );
      return;
    }
    amount = input.request.full ? owed : amount;
    if (amount !== null && amount > owed) {
      await input.reply(
        `還款不能超過最新欠款 NT$${owed.toLocaleString()}；若確實是超額轉帳，請改用「轉給」。`,
      );
      return;
    }
  }

  if (amount === null) {
    await input.reply(
      input.request.intent === "settle"
        ? "請提供還款金額，或直接說「我還清了／另一半已經還清了」。"
        : "請提供轉帳金額。",
    );
    return;
  }
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100_000_000) {
    await input.reply("金額必須是 1 到 100,000,000 的整數 TWD。");
    return;
  }

  const context = {
    env: serverEnvironment(),
    db: input.dependencies.supabase,
    user: input.user,
  };
  let proposedRaw: unknown;
  if (input.request.intent === "transfer") {
    const command = {
      type: "transfer" as const,
      groupId: input.groupId,
      direction: input.request.direction,
      amountTwd: amount,
      occurredOn: taipeiToday(
        input.sourceEventTimestamp === undefined
          ? new Date()
          : new Date(input.sourceEventTimestamp),
      ),
    };
    const metadata = lineActionMetadata(input.sourceEventId, command);
    if (!metadata) throw new Error("LINE source event id is required");
    proposedRaw = await pendingActionService.proposeTransferPending(
      context,
      command,
      metadata,
    );
  } else {
    const command = {
      type: "settle" as const,
      groupId: input.groupId,
      direction: input.request.direction,
      ...(input.request.full ? {} : { amountTwd: amount }),
    };
    const metadata = lineActionMetadata(input.sourceEventId, command);
    if (!metadata) throw new Error("LINE source event id is required");
    proposedRaw = await pendingActionService.proposeSettlementPending(
      context,
      command,
      metadata,
    );
  }
  const proposed = pendingMoneyMovementSchema.parse(proposedRaw);
  const before = proposed.balance.before_by_user_id[input.user.id] ?? 0;
  const after = proposed.balance.after_by_user_id[input.user.id] ?? 0;
  await input.reply(flexTransferConfirm({
    actionId: proposed.action_id,
    intent: proposed.action_type,
    directionLabel: proposed.direction === "me_to_partner"
      ? "你 → 另一半"
      : "另一半 → 你",
    amountTwd: proposed.amount_twd,
    groupName: input.groupName,
    beforeBalanceText: balanceText(before),
    afterBalanceText: balanceText(after),
    warning: proposed.action_type === "transfer"
      ? transferBalanceWarning(before, after)
      : undefined,
  }));
}

function taipeiToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function balanceText(balanceTwd: number): string {
  if (balanceTwd > 0) return `另一半欠你 NT$${balanceTwd.toLocaleString()}`;
  if (balanceTwd < 0) return `你欠另一半 NT$${Math.abs(balanceTwd).toLocaleString()}`;
  return "已結清";
}

function transferBalanceWarning(before: number, after: number): string | undefined {
  if (before === 0) {
    return "目前沒有欠款；這筆會作為預付款，並建立新的帳本餘額。";
  }
  if (after !== 0 && Math.sign(before) !== Math.sign(after)) {
    return "金額超過目前欠款；記錄後欠款方向會反轉。";
  }
  if (
    after !== 0 &&
    Math.sign(before) === Math.sign(after) &&
    Math.abs(after) > Math.abs(before)
  ) {
    return "這是目前欠款的反方向，記錄後欠款會增加。";
  }
  return undefined;
}

export async function handleLineAudioTurn(input: {
  messageId: string;
  sourceEventId?: string;
  sourceEventTimestamp?: number;
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
      sourceEventTimestamp: input.sourceEventTimestamp,
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
  actionIndex = 0,
) {
  if (!sourceEventId) return undefined;
  const eventDigest = createHash("sha256")
    .update(sourceEventId)
    .digest("hex")
    .slice(0, 32);
  const actionDigest = createHash("sha256")
    .update(
      `${actionIndex}:${typeof action.type === "string" ? action.type : "unknown"}`,
    )
    .digest("hex")
    .slice(0, 24);
  const key = `line:${eventDigest}:${actionDigest}`;
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
