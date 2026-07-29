import { serverEnvironment } from "./server-runtime";
import { pendingActionService, ledgerQueryService } from "./services";
import { replyText, replyMessages, type LineUser } from "./line-bot-shared";
import { runLineSecretaryTurn } from "./line-secretary-service";
import { claimUser } from "./claim-user";
import { safeSecretEqual } from "./security";
import { parseSearchCommand, parsePendingRetargetCommand } from "./line-message-parsers";
import type { BotDependencies } from "./line-webhook-service";
import { buildLiffUrl, requireLiffId } from "./liff-url";
import {
  finishLineMenuAmountDraft,
  isLineMenuAmountCancel,
  loadLineMenuAmountDraft,
  parseLineMenuAmount,
} from "./line-menu-amount-draft";
import {
  completeLineMenuAmountDraft,
  lineMenuRestartReply,
  LineMenuStateError,
} from "./line-menu-service";

const MAX_MESSAGE_LENGTH = 500;

export async function handleLineTextMessage(
  text: string,
  eventId: string,
  user: LineUser,
  replyToken: string,
  dependencies: BotDependencies,
  eventTimestamp?: number,
): Promise<void> {
  if (text.length > MAX_MESSAGE_LENGTH) {
    await replyText(dependencies.lineClient, replyToken, "訊息太長，請縮短後再試。");
    return;
  }

  if (
    await handleLineMenuAmountText({
      text,
      eventId,
      eventTimestamp: eventTimestamp ?? Date.now(),
      user,
      replyToken,
      dependencies,
    })
  ) {
    return;
  }

  // Search command (kept for LIFF integration)
  const searchQuery = parseSearchCommand(text);
  if (searchQuery) {
    await replySearch(searchQuery, user, replyToken, dependencies);
    return;
  }

  // Pending retarget command
  const retarget = parsePendingRetargetCommand(text);
  if (retarget) {
    const result = await pendingActionService.retargetActions(
      { db: dependencies.supabase, user },
      retarget,
    );
    const serverContext = {
      env: serverEnvironment(),
      db: dependencies.supabase,
      user,
    };
    for (const actionId of result.actionIds) {
      await pendingActionService.confirm(serverContext, actionId, true);
    }
    await replyText(
      dependencies.lineClient,
      replyToken,
      result.count
        ? `已把 ${result.count} 筆待確認草稿改成私人帳｜交通，並直接入帳。`
        : "沒有找到還有效的待確認草稿，請重新傳照片或手動新增。",
    );
    return;
  }

  // Route all other messages through the Agent Loop
  await runLineSecretaryTurn({
    text,
    sourceEventId: eventId,
    sourceEventTimestamp: eventTimestamp,
    user,
    dependencies,
    reply: (replyMsg) => replyMessages(dependencies.lineClient, replyToken, replyMsg),
  });
}

async function handleLineMenuAmountText(input: {
  text: string;
  eventId: string;
  eventTimestamp: number;
  user: LineUser;
  replyToken: string;
  dependencies: BotDependencies;
}): Promise<boolean> {
  const amountTwd = parseLineMenuAmount(input.text);
  const cancelled = isLineMenuAmountCancel(input.text);
  const draft = await loadLineMenuAmountDraft({
    db: input.dependencies.supabase,
    user: input.user,
    sourceEventId: input.eventId,
    retryForNewAmount: amountTwd !== null || cancelled,
  });
  if (!draft) return false;

  if (draft.status === "consumed") {
    await replyCompletedAmountDraft(input, draft);
    return true;
  }
  if (draft.status === "cancelled") {
    await replyText(
      input.dependencies.lineClient,
      input.replyToken,
      "已取消這次快速輸入，沒有建立任何紀錄。",
    );
    return true;
  }
  if (draft.status === "expired" || draft.status === "superseded") {
    if (amountTwd === null && !cancelled) return false;
    await replyMessages(
      input.dependencies.lineClient,
      input.replyToken,
      lineMenuRestartReply("金額輸入已逾時或被新流程取代，請重新開始。"),
    );
    return true;
  }

  if (cancelled) {
    const finished = await finishLineMenuAmountDraft({
      db: input.dependencies.supabase,
      user: input.user,
      sourceEventId: input.eventId,
      status: "cancelled",
    });
    await replyText(
      input.dependencies.lineClient,
      input.replyToken,
      finished
        ? "已取消這次快速輸入，沒有建立任何紀錄。"
        : "這個金額步驟已完成或逾時，請重新開始。",
    );
    return true;
  }

  if (amountTwd === null) {
    await replyText(
      input.dependencies.lineClient,
      input.replyToken,
      "金額格式不正確。請輸入 1～100,000,000 的整數，例如 415；輸入「取消」可離開。",
    );
    return true;
  }

  const finished = await finishLineMenuAmountDraft({
    db: input.dependencies.supabase,
    user: input.user,
    sourceEventId: input.eventId,
    status: "consumed",
    amountTwd,
  });
  if (!finished) {
    await replyMessages(
      input.dependencies.lineClient,
      input.replyToken,
      lineMenuRestartReply("這個金額步驟已完成或逾時，請重新開始。"),
    );
    return true;
  }
  await replyCompletedAmountDraft(input, finished);
  return true;
}

async function replyCompletedAmountDraft(
  input: {
    eventId: string;
    eventTimestamp: number;
    user: LineUser;
    replyToken: string;
    dependencies: BotDependencies;
  },
  draft: Awaited<ReturnType<typeof loadLineMenuAmountDraft>>,
): Promise<void> {
  if (!draft) return;
  try {
    const response = await completeLineMenuAmountDraft({
      draft,
      db: input.dependencies.supabase,
      user: input.user,
      sourceEventId: input.eventId,
      sourceEventTimestamp: input.eventTimestamp,
    });
    await replyMessages(
      input.dependencies.lineClient,
      input.replyToken,
      response,
    );
  } catch (error) {
    if (!(error instanceof LineMenuStateError)) throw error;
    await replyMessages(
      input.dependencies.lineClient,
      input.replyToken,
      lineMenuRestartReply("群組已變更，請重新開始。"),
    );
  }
}

async function replySearch(
  query: string,
  user: LineUser,
  replyToken: string,
  dependencies: BotDependencies,
) {
  const params = new URLSearchParams({ q: query, limit: "5" });
  const result = await ledgerQueryService.searchExpenses(
    { db: dependencies.supabase, user },
    params,
  );
  const expenses = result.expenses.slice(0, 5);
  const link = buildLiffUrl(requireLiffId(), {
    tab: "history",
    search: query,
  });
  const lines = expenses.length
    ? [
        `找到 ${expenses.length} 筆：`,
        ...expenses.map((expense) => {
          const label = expense.tag;
          return `• ${expense.description} NT$${expense.amount_twd.toLocaleString("en-US")}｜${expense.expense_date}｜${label}`;
        }),
        `看更多：${link}`,
      ]
    : [`找不到「${query}」。`, `可到 LIFF 放寬日期或金額條件：${link}`];
  await replyText(dependencies.lineClient, replyToken, lines.join("\n"));
}

export async function joinCouple(
  receivedCode: string,
  lineUserId: string,
  replyToken: string,
  dependencies: BotDependencies,
): Promise<void> {
  if (!safeSecretEqual(receivedCode.trim(), dependencies.setupCode)) {
    await replyText(dependencies.lineClient, replyToken, "設定碼不正確。");
    return;
  }
  const result = await claimUser(dependencies.supabase, lineUserId);
  const message =
    result.result === "full"
      ? "帳本已綁定兩位使用者。"
      : result.result === "already_joined"
        ? "你已經加入帳本。"
        : `加入成功，你是 ${result.role}。`;
  await replyText(dependencies.lineClient, replyToken, message);
}
