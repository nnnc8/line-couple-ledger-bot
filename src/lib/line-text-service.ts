import { serverEnvironment } from "./server-runtime";
import { pendingActionService, ledgerQueryService } from "./services";
import { replyText, type LineUser } from "./line-bot-shared";
import { runLineSecretaryTurn } from "./line-secretary-service";
import { claimUser } from "./claim-user";
import { safeSecretEqual } from "./security";
import { parseSearchCommand, parsePendingRetargetCommand } from "./line-message-parsers";
import type { BotDependencies } from "./line-webhook-service";

const MAX_MESSAGE_LENGTH = 500;

export async function handleLineTextMessage(
  text: string,
  eventId: string,
  user: LineUser,
  replyToken: string,
  dependencies: BotDependencies,
): Promise<void> {
  if (text.length > MAX_MESSAGE_LENGTH) {
    await replyText(dependencies.lineClient, replyToken, "訊息太長，請縮短後再試。");
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
    user,
    dependencies,
    reply: (replyMsg) => replyText(dependencies.lineClient, replyToken, replyMsg),
  });
}

async function replySearch(
  query: string,
  user: LineUser,
  replyToken: string,
  dependencies: BotDependencies,
) {
  const env = serverEnvironment();
  const params = new URLSearchParams({ q: query, limit: "5" });
  const result = await ledgerQueryService.searchExpenses(
    { db: dependencies.supabase, user },
    params,
  );
  const expenses = result.expenses.slice(0, 5);
  const link = `${env.APP_URL}/?search=${encodeURIComponent(query)}`;
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
