import { GoogleGenAI } from "@google/genai";
import type { LineBotClient, messagingApi, webhook } from "@line/bot-sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { parseAccountantCommand } from "./accountant";
import {
  confirmAction,
  retargetPendingActionById,
  retargetPendingActions,
  runAgent,
  serverEnvironment,
} from "./app-server";
import {
  calculateBalances,
  geminiTextParseJsonSchema,
  monthlySummary,
  textParseSchema,
  type LedgerExpense,
  type ParsedExpenseItem,
  type ParsedIntent,
  type Settlement,
  type TextParseResult,
} from "./ledger";
import { safeSecretEqual } from "./security";
import { classifyExpenseCategory } from "./category-agent";

export { safeSecretEqual } from "./security";

const MODEL = "gemini-3.1-flash-lite";
const TIME_ZONE = "Asia/Taipei";
const MAX_MESSAGE_LENGTH = 500;
const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;

const userRowSchema = z.object({
  id: z.string().uuid(),
  couple_id: z.number().int(),
  role: z.enum(["owner", "partner"]),
  line_user_id: z.string(),
});

const expenseRowSchema = z.object({
  id: z.string().uuid(),
  ledger: z.enum(["shared", "private"]),
  amount_twd: z.coerce.number().int(),
  paid_by_user_id: z.string().uuid(),
  created_by_user_id: z.string().uuid(),
  expense_date: z.string(),
  deleted_at: z.string().nullable(),
  expense_splits: z.array(
    z.object({
      user_id: z.string().uuid(),
      amount_twd: z.coerce.number().int(),
    }),
  ),
});

const settlementRowSchema = z.object({
  from_user_id: z.string().uuid(),
  to_user_id: z.string().uuid(),
  amount_twd: z.coerce.number().int(),
});

const actionResultSchema = z.object({
  result: z.enum([
    "confirmed",
    "cancelled",
    "expired",
    "stale",
    "not_found",
    "already_done",
  ]),
  action_type: z
    .enum([
      "create_expense",
      "update_expense",
      "delete_expense",
      "restore_expense",
      "settle",
      "batch_create_expenses",
      "batch_update_expenses",
    ])
    .nullable()
    .optional(),
  created_count: z.number().int().optional(),
});

type UserRow = z.infer<typeof userRowSchema>;

interface BotDependencies {
  lineClient: Pick<LineBotClient, "replyMessage" | "getMessageContent" | "pushMessage">;
  supabase: SupabaseClient;
  gemini: GoogleGenAI;
  setupCode: string;
  onImage?: (input: { messageId: string; eventId: string; lineUserId: string }) => void;
}

export async function handleLineEvent(
  event: webhook.Event,
  dependencies: BotDependencies,
): Promise<void> {
  const userId = event.source?.userId;
  const replyToken = "replyToken" in event ? event.replyToken : undefined;
  if (!userId || !replyToken) return;

  try {
    if (event.type === "postback") {
      await handlePostback(event, userId, replyToken, dependencies);
      return;
    }
    if (event.type !== "message") return;
    if (event.message.type === "image") {
      await replyText(dependencies.lineClient, replyToken, "已收到收據，辨識完成後會通知你到圖形化帳本確認。");
      dependencies.onImage?.({ messageId: event.message.id, eventId: event.webhookEventId, lineUserId: userId });
      return;
    }
    if (event.message.type !== "text") return;
    await handleText(
      event.message.text,
      event.webhookEventId,
      userId,
      replyToken,
      dependencies,
    );
  } catch (error) {
    console.error("LINE event failed", {
      eventId: event.webhookEventId,
      error: error instanceof Error ? error.name : "unknown",
    });
    await replyText(
      dependencies.lineClient,
      replyToken,
      "暫時無法處理，請稍後再試。",
    );
  }
}

export function parseFixedIntent(text: string): ParsedIntent | null {
  const intent = new Map<string, ParsedIntent["intent"]>([
    ["誰欠誰", "balance"],
    ["查詢目前誰欠誰", "balance"],
    ["本月共同支出", "shared_monthly"],
    ["本月私人支出", "private_monthly"],
    ["刪除剛剛那筆", "delete_last"],
    ["結清", "settle"],
    ["說明", "help"],
    ["help", "help"],
  ]).get(text.trim());
  return intent ? emptyIntent(intent) : null;
}

export function parseInlineExpenseItems(
  text: string,
  today: string,
): ParsedIntent[] {
  const matches = [
    ...text.matchAll(/(\d{1,9})\s*(?:元|塊|nt\$?)?\s*(我付|你付|他付|她付)/giu),
  ];
  if (matches.length < 2) return [];
  let cursor = 0;
  return matches.slice(0, 5).flatMap((match) => {
    const index = match.index ?? 0;
    const description = cleanInlineDescription(text.slice(cursor, index));
    cursor = index + match[0].length;
    const amountTwd = Number(match[1]);
    if (!description || !Number.isSafeInteger(amountTwd) || amountTwd <= 0)
      return [];
    return [
      {
        intent: "record_expense",
        description,
        amountTwd,
        ledger: /私人/.test(text) ? "private" : "shared",
        paidBy: match[2] === "我付" ? "self" : "partner",
        expenseDate: today,
        category: inferInlineCategory(`${text} ${description}`),
      } satisfies ParsedIntent,
    ];
  });
}

export function selectMentionedGroup<T extends { id: string; name: string }>(
  text: string,
  groups: T[],
  activeGroupId: string,
): T | null {
  const normalizedText = normalizeGroupText(text);
  const mentioned = groups
    .filter((group) => normalizedText.includes(normalizeGroupText(group.name)))
    .sort((left, right) => right.name.length - left.name.length);
  return (
    mentioned[0] ??
    groups.find((group) => group.id === activeGroupId) ??
    groups[0] ??
    null
  );
}

export function parsePendingRetargetCommand(text: string) {
  const normalized = text.replace(/\s+/g, "");
  if (!/(都|全部|這批|剛剛|剛才|上面|那些)/.test(normalized)) return null;
  if (!/(改成|改到|轉成|轉到|移到|換成)/.test(normalized)) return null;
  if (!/私人帳|私人/.test(normalized)) return null;
  if (!/交通|車資|搭車|行程|uber|計程車/i.test(normalized)) return null;
  return {
    ledger: "private",
    category: "transport",
    categoryLabel: "交通",
  } as const;
}

async function handleText(
  text: string,
  eventId: string,
  lineUserId: string,
  replyToken: string,
  dependencies: BotDependencies,
): Promise<void> {
  const joinMatch = text.trim().match(/^加入\s+(.+)$/);
  if (joinMatch) {
    await joinCouple(joinMatch[1]!, lineUserId, replyToken, dependencies);
    return;
  }

  const user = await findUser(dependencies.supabase, lineUserId);
  if (!user) {
    await replyText(
      dependencies.lineClient,
      replyToken,
      "請先輸入：加入 <設定碼>",
    );
    return;
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    await replyText(dependencies.lineClient, replyToken, "訊息太長，請縮短後再試。");
    return;
  }

  const retarget = parsePendingRetargetCommand(text);
  if (retarget) {
    const result = await retargetPendingActions(
      { db: dependencies.supabase, user },
      retarget,
    );
    await replyText(
      dependencies.lineClient,
      replyToken,
      result.count
        ? `已把 ${result.count} 筆待確認收據改成私人帳｜交通。請按原本那則訊息的確認。`
        : "沒有找到還有效的待確認收據，請重新傳照片或手動新增。",
    );
    return;
  }

  const accountant = parseAccountantCommand(text);
  if (accountant) {
    await replyAccountant(accountant, user, replyToken, dependencies);
    return;
  }

  const fixedIntent = parseFixedIntent(text);
  const parsed: TextParseResult = fixedIntent
    ? { ...fixedIntent, groupName: null }
    : await parseWithGemini(text, currentTaipeiDate(), dependencies.gemini);

  if (parsed.intent === "record_expenses") {
    await proposeExpenses(
      parsed.expenses,
      eventId,
      user,
      replyToken,
      dependencies,
      parsed.groupName ?? text,
    );
    return;
  }

  const inlineExpenses = parseInlineExpenseItems(text, currentTaipeiDate());
  if (inlineExpenses.length > 1) {
    await proposeExpenses(inlineExpenses, eventId, user, replyToken, dependencies, text);
    return;
  }

  switch (parsed.intent) {
    case "record_expense":
      await proposeExpense(parsed, eventId, user, replyToken, dependencies, text);
      return;
    case "balance":
      await replyBalance(user, replyToken, dependencies);
      return;
    case "shared_monthly":
      await replyMonthly("shared", user, replyToken, dependencies);
      return;
    case "private_monthly":
      await replyMonthly("private", user, replyToken, dependencies);
      return;
    case "delete_last":
      await proposeDelete(eventId, user, replyToken, dependencies);
      return;
    case "settle":
      await proposeSettlement(eventId, user, replyToken, dependencies);
      return;
    case "help":
      await replyText(dependencies.lineClient, replyToken, helpText());
      return;
    case "unknown":
      await replyText(
        dependencies.lineClient,
        replyToken,
        "看不懂這句。可試：晚餐 860 我付、誰欠誰、本月共同支出。",
      );
  }
}

async function replyAccountant(
  input: { question: string; scope: "shared" | "private" | "combined" },
  user: UserRow,
  replyToken: string,
  dependencies: BotDependencies,
): Promise<void> {
  const env = serverEnvironment();
  const result = await runAgent(
    { env, db: dependencies.supabase, user },
    {
      message: input.question,
      scope: input.scope,
    },
  );
  const liffLine =
    result.answer.length > 650
      ? `\n詳情：${env.APP_URL}/?tab=accountant`
      : `\n${env.APP_URL}/?tab=accountant`;
  await replyText(
    dependencies.lineClient,
    replyToken,
    `${result.answer.slice(0, 900)}${liffLine}`,
  );
}

async function joinCouple(
  receivedCode: string,
  lineUserId: string,
  replyToken: string,
  dependencies: BotDependencies,
): Promise<void> {
  if (!safeSecretEqual(receivedCode.trim(), dependencies.setupCode)) {
    await replyText(dependencies.lineClient, replyToken, "設定碼不正確。");
    return;
  }
  const { data, error } = await dependencies.supabase.rpc("claim_user", {
    p_line_user_id: lineUserId,
  });
  if (error) throw new Error("claim_user failed");
  const result = z
    .object({ result: z.enum(["joined", "already_joined", "full"]), role: z.string().optional() })
    .parse(data);
  const message =
    result.result === "full"
      ? "帳本已綁定兩位使用者。"
      : result.result === "already_joined"
        ? "你已經加入帳本。"
        : `加入成功，你是 ${result.role}。`;
  await replyText(dependencies.lineClient, replyToken, message);
}

async function parseWithGemini(
  text: string,
  today: string,
  gemini: GoogleGenAI,
): Promise<TextParseResult> {
  const response = await gemini.models.generateContent({
    model: MODEL,
    contents: text,
    config: {
      systemInstruction: `你是台灣情侶分帳 Bot 的文字解析器。今天是 ${today}（Asia/Taipei）。把自然語言轉成結構化 JSON，不計算分帳、不決定權限、不寫資料庫。可從一句話抽多筆支出；兩筆以上用 record_expenses。可抽 groupName，例如使用者提到「吃飽喝足」「旅遊」等帳本/群組名稱。支出預設 ledger=shared、paidBy=self、expenseDate=${today}、category=other；只有明確說私人時才用 private。付款人：「我付」=self，「你付/他付/她付/另一半付」=partner。金額缺失或矛盾時回 unknown。`,
      responseMimeType: "application/json",
      responseJsonSchema: geminiTextParseJsonSchema,
      temperature: 0,
      maxOutputTokens: 700,
    },
  });
  if (!response.text) return emptyTextIntent("unknown");
  try {
    return textParseSchema.parse(JSON.parse(response.text));
  } catch {
    return emptyTextIntent("unknown");
  }
}

async function proposeExpense(
  parsed: ParsedIntent,
  eventId: string,
  user: UserRow,
  replyToken: string,
  dependencies: BotDependencies,
  sourceText = "",
): Promise<void> {
  if (
    parsed.intent !== "record_expense" ||
    parsed.description === null ||
    parsed.amountTwd === null ||
    parsed.ledger === null ||
    parsed.paidBy === null ||
    parsed.expenseDate === null ||
    parsed.category === null
  ) {
    await replyText(dependencies.lineClient, replyToken, "資料不足，請重新描述這筆支出。");
    return;
  }
  if (parsed.ledger === "private" && parsed.paidBy === "partner") {
    await replyText(dependencies.lineClient, replyToken, "私人支出只能由本人付款。");
    return;
  }
  const users = await listUsers(dependencies.supabase);
  const partner = users.find((candidate) => candidate.id !== user.id);
  if (!partner) {
    await replyText(dependencies.lineClient, replyToken, "請先讓另一半加入帳本。");
    return;
  }
  const paidByUserId = parsed.paidBy === "self" ? user.id : partner.id;
  const activeGroup =
    parsed.ledger === "shared"
      ? await findTargetGroup(dependencies.supabase, user, sourceText)
      : null;
  const classification = await classifyExpenseCategory(
    {
      description: parsed.description,
      merchant: null,
      groupName: activeGroup?.name ?? "私人帳",
      fallbackCategory: parsed.category,
      history: [],
    },
    dependencies.gemini,
  );
  const actionId = await createPendingAction(
    dependencies.supabase,
    user,
    "create_expense",
    eventId,
    {
      ledger: parsed.ledger,
      group_id: activeGroup?.id ?? null,
      description: parsed.description,
      amount_twd: parsed.amountTwd,
      paid_by_user_id: parsed.ledger === "private" ? user.id : paidByUserId,
      expense_date: parsed.expenseDate,
      category: classification.category,
      category_label: classification.categoryLabel,
    },
    activeGroup?.id ?? null,
  );
  await replyConfirmation(
    dependencies.lineClient,
    replyToken,
    actionId,
    [
      `確認記帳？${parsed.ledger === "shared" ? activeGroup!.name : "私人帳"}`,
      `${parsed.description} NT$${parsed.amountTwd}`,
      `付款：${paidByUserId === user.id ? "你" : "另一半"}｜${parsed.expenseDate}｜${classification.categoryLabel}`,
    ].join("\n"),
  );
}

async function proposeExpenses(
  items: Array<ParsedIntent | ParsedExpenseItem>,
  eventId: string,
  user: UserRow,
  replyToken: string,
  dependencies: BotDependencies,
  sourceText: string,
): Promise<void> {
  const users = await listUsers(dependencies.supabase);
  const partner = users.find((candidate) => candidate.id !== user.id);
  if (!partner) {
    await replyText(dependencies.lineClient, replyToken, "請先讓另一半加入帳本。");
    return;
  }
  const activeGroup = await findTargetGroup(dependencies.supabase, user, sourceText);
  const actions: Array<{ id: string; item: ParsedIntent | ParsedExpenseItem; paidByUserId: string }> = [];
  for (const [index, item] of items.entries()) {
    if (
      ("intent" in item && item.intent !== "record_expense") ||
      item.description === null ||
      item.amountTwd === null ||
      item.paidBy === null ||
      item.expenseDate === null ||
      item.category === null ||
      item.ledger !== "shared"
    ) {
      await replyText(dependencies.lineClient, replyToken, "多筆記帳目前只支援共同帳。");
      return;
    }
    const paidByUserId = item.paidBy === "self" ? user.id : partner.id;
    const classification = await classifyExpenseCategory(
      {
        description: item.description,
        merchant: null,
        groupName: activeGroup.name,
        fallbackCategory: item.category,
        history: [],
      },
      dependencies.gemini,
    );
    const id = await createPendingAction(
      dependencies.supabase,
      user,
      "create_expense",
      `${eventId}:${index}`,
      {
        ledger: "shared",
        group_id: activeGroup.id,
        description: item.description,
        amount_twd: item.amountTwd,
        paid_by_user_id: paidByUserId,
        expense_date: item.expenseDate,
        category: classification.category,
        category_label: classification.categoryLabel,
      },
      activeGroup.id,
    );
    actions.push({ id, item, paidByUserId });
  }
  await replyBatchConfirmation(
    dependencies.lineClient,
    replyToken,
    actions.map((action) => action.id),
    [
      `確認記帳？${activeGroup.name} 共 ${actions.length} 筆`,
      ...actions.map(
        ({ item, paidByUserId }) =>
          `${item.description} NT$${item.amountTwd}｜${paidByUserId === user.id ? "你" : "另一半"}付`,
      ),
    ].join("\n"),
  );
}

function cleanInlineDescription(value: string) {
  return value
    .replace(/[，,。.!！?？|｜]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function inferInlineCategory(text: string): ParsedIntent["category"] {
  return /早餐|午餐|晚餐|宵夜|餐|吃|喝|咖啡|飲料|漢堡|便當|火鍋|越南|拉麵|麵|飯|披薩|甜點/.test(
    text,
  )
    ? "food"
    : /車|捷運|高鐵|火車|公車|計程車|uber|停車|加油|交通/.test(text)
      ? "transport"
      : "other";
}

async function proposeDelete(
  eventId: string,
  user: UserRow,
  replyToken: string,
  dependencies: BotDependencies,
): Promise<void> {
  const activeGroup = await findActiveGroup(dependencies.supabase, user);
  const { data, error } = await dependencies.supabase
    .from("expenses")
    .select("id, description, amount_twd")
    .is("deleted_at", null)
    .is("mirror_kind", null)
    .or(`and(ledger.eq.shared,group_id.eq.${activeGroup.id}),and(ledger.eq.private,created_by_user_id.eq.${user.id})`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("expense lookup failed");
  const expense = z
    .object({ id: z.string().uuid(), description: z.string(), amount_twd: z.coerce.number().int() })
    .nullable()
    .parse(data);
  if (!expense) {
    await replyText(dependencies.lineClient, replyToken, "沒有可刪除的支出。");
    return;
  }
  const actionId = await createPendingAction(
    dependencies.supabase,
    user,
    "delete_expense",
    eventId,
    { expense_id: expense.id },
    activeGroup.id,
  );
  await replyConfirmation(
    dependencies.lineClient,
    replyToken,
    actionId,
    `確認刪除「${expense.description} NT$${expense.amount_twd}」？`,
  );
}

async function proposeSettlement(
  eventId: string,
  user: UserRow,
  replyToken: string,
  dependencies: BotDependencies,
): Promise<void> {
  const activeGroup = await findActiveGroup(dependencies.supabase, user);
  const { users, balances } = await loadBalances(dependencies.supabase, activeGroup.id);
  const debtor = users.find((candidate) => (balances[candidate.id] ?? 0) < 0);
  const creditor = users.find((candidate) => (balances[candidate.id] ?? 0) > 0);
  if (!debtor || !creditor) {
    await replyText(dependencies.lineClient, replyToken, "目前已經結清。");
    return;
  }
  const amountTwd = Math.abs(balances[debtor.id]!);
  const actionId = await createPendingAction(
    dependencies.supabase,
    user,
    "settle",
    eventId,
    {
      from_user_id: debtor.id,
      to_user_id: creditor.id,
      amount_twd: amountTwd,
      expected_balance_twd: balances[debtor.id],
      group_id: activeGroup.id,
    },
    activeGroup.id,
  );
  await replyConfirmation(
    dependencies.lineClient,
    replyToken,
    actionId,
    `確認結清「${activeGroup.name}」？${debtor.id === user.id ? "你" : "另一半"} 支付 ${creditor.id === user.id ? "你" : "另一半"} NT$${amountTwd}`,
  );
}

async function replyBalance(
  user: UserRow,
  replyToken: string,
  dependencies: BotDependencies,
): Promise<void> {
  const activeGroup = await findActiveGroup(dependencies.supabase, user);
  const { users, balances } = await loadBalances(dependencies.supabase, activeGroup.id);
  const debtor = users.find((candidate) => (balances[candidate.id] ?? 0) < 0);
  const creditor = users.find((candidate) => (balances[candidate.id] ?? 0) > 0);
  const message =
    debtor && creditor
      ? `${activeGroup.name}：${debtor.id === user.id ? "你" : "另一半"} 欠 ${creditor.id === user.id ? "你" : "另一半"} NT$${Math.abs(balances[debtor.id]!)}`
      : `${activeGroup.name}：目前已經結清。`;
  await replyText(dependencies.lineClient, replyToken, message);
}

async function replyMonthly(
  ledger: "shared" | "private",
  user: UserRow,
  replyToken: string,
  dependencies: BotDependencies,
): Promise<void> {
  const month = currentTaipeiDate().slice(0, 7);
  const activeGroup = ledger === "shared" ? await findActiveGroup(dependencies.supabase, user) : null;
  let query = dependencies.supabase
    .from("expenses")
    .select("id, ledger, amount_twd, paid_by_user_id, created_by_user_id, expense_date, deleted_at, expense_splits(user_id, amount_twd)")
    .eq("ledger", ledger)
    .is("deleted_at", null)
    .gte("expense_date", `${month}-01`)
    .lt("expense_date", nextMonth(month));
  if (ledger === "shared") query = query.eq("group_id", activeGroup!.id);
  if (ledger === "private") query = query.eq("created_by_user_id", user.id);
  const { data, error } = await query;
  if (error) throw new Error("monthly lookup failed");
  const expenses = z.array(expenseRowSchema).parse(data).map(toLedgerExpense);
  const summary = monthlySummary(expenses, ledger, user.id, month);
  await replyText(
    dependencies.lineClient,
    replyToken,
    `本月${ledger === "shared" ? `${activeGroup!.name}共同` : "私人"}支出 NT$${summary.totalTwd}（${summary.count} 筆）`,
  );
}

async function handlePostback(
  event: webhook.PostbackEvent,
  lineUserId: string,
  replyToken: string,
  dependencies: BotDependencies,
): Promise<void> {
  const parameters = new URLSearchParams(event.postback.data);
  const actionId = parameters.get("id");
  const actionIds = parameters.get("ids")?.split(",").filter(Boolean) ?? [];
  const decision = parameters.get("decision");
  const edit = parameters.get("edit");
  if (edit === "private_transport") {
    if (!actionId || !z.string().uuid().safeParse(actionId).success) {
      await replyText(dependencies.lineClient, replyToken, "這個操作無效。");
      return;
    }
    const user = await findUser(dependencies.supabase, lineUserId);
    if (!user) {
      await replyText(dependencies.lineClient, replyToken, "請先加入帳本。");
      return;
    }
    const result = await retargetPendingActionById(
      { db: dependencies.supabase, user },
      actionId,
      { ledger: "private", category: "transport", categoryLabel: "交通" },
    );
    await replyConfirmation(
      dependencies.lineClient,
      replyToken,
      actionId,
      `已改成私人帳｜交通，共 ${result.count} 筆。\n確認後入帳。`,
    );
    return;
  }
  if (
    !["confirm", "cancel"].includes(decision ?? "") ||
    (!actionId && !actionIds.length) ||
    (actionId && !z.string().uuid().safeParse(actionId).success) ||
    actionIds.some((id) => !z.string().uuid().safeParse(id).success)
  ) {
    await replyText(dependencies.lineClient, replyToken, "這個操作無效。");
    return;
  }
  if (actionIds.length) {
    const results = [];
    for (const id of actionIds) {
      results.push(
        await confirmOneAction(id, decision === "confirm", lineUserId, dependencies),
      );
    }
    const confirmed = results.filter((result) => result.result === "confirmed").length;
    await replyText(
      dependencies.lineClient,
      replyToken,
      decision === "confirm"
        ? confirmed === results.length
          ? `已記帳 ${confirmed} 筆。`
          : `已記帳 ${confirmed} 筆，${results.length - confirmed} 筆未完成。`
        : "已取消。",
    );
    return;
  }
  const result = await confirmOneAction(actionId!, decision === "confirm", lineUserId, dependencies);
  const messages: Record<typeof result.result, string> = {
    confirmed:
      result.action_type === "batch_create_expenses"
        ? `已記帳 ${result.created_count ?? "這批"} 筆。`
        : result.action_type === "create_expense"
        ? "已記帳。"
        : result.action_type === "batch_update_expenses"
          ? "分類整理已套用。"
        : result.action_type === "delete_expense"
          ? "已刪除。"
          : "已結清。",
    cancelled: "已取消。",
    expired: "確認已過期，請重新操作。",
    stale: "帳目已變動，請重新操作。",
    not_found: "找不到這個操作。",
    already_done: "這個操作已處理。",
  };
  await replyText(dependencies.lineClient, replyToken, messages[result.result]);
}

async function confirmOneAction(
  actionId: string,
  confirm: boolean,
  lineUserId: string,
  dependencies: BotDependencies,
) {
  const user = await findUser(dependencies.supabase, lineUserId);
  if (!user) return { result: "not_found", action_type: null } as const;
  return actionResultSchema.parse(
    await confirmAction(
      { env: serverEnvironment(), db: dependencies.supabase, user },
      actionId,
      confirm,
    ),
  );
}

async function findUser(
  supabase: SupabaseClient,
  lineUserId: string,
): Promise<UserRow | null> {
  const { data, error } = await supabase
    .from("users")
    .select("id, couple_id, role, line_user_id")
    .eq("line_user_id", lineUserId)
    .maybeSingle();
  if (error) throw new Error("user lookup failed");
  return userRowSchema.nullable().parse(data);
}

async function listUsers(supabase: SupabaseClient): Promise<UserRow[]> {
  const { data, error } = await supabase
    .from("users")
    .select("id, couple_id, role, line_user_id")
    .order("role");
  if (error) throw new Error("users lookup failed");
  return z.array(userRowSchema).parse(data);
}

async function createPendingAction(
  supabase: SupabaseClient,
  user: UserRow,
  actionType: "create_expense" | "delete_expense" | "settle",
  sourceEventId: string,
  payload: Record<string, unknown>,
  groupId: string | null = null,
): Promise<string> {
  const expiresAt = new Date(Date.now() + PENDING_ACTION_TTL_MS).toISOString();
  const { data, error } = await supabase
    .from("pending_actions")
    .upsert(
      {
        couple_id: user.couple_id,
        requested_by_user_id: user.id,
        action_type: actionType,
        group_id: groupId,
        payload,
        source_event_id: sourceEventId,
        expires_at: expiresAt,
      },
      { onConflict: "source_event_id", ignoreDuplicates: true },
    )
    .select("id")
    .maybeSingle();
  if (error) throw new Error("pending action insert failed");
  if (data) return z.object({ id: z.string().uuid() }).parse(data).id;

  const existing = await supabase
    .from("pending_actions")
    .select("id")
    .eq("source_event_id", sourceEventId)
    .single();
  if (existing.error) throw new Error("pending action lookup failed");
  return z.object({ id: z.string().uuid() }).parse(existing.data).id;
}

async function loadBalances(
  supabase: SupabaseClient,
  groupId: string,
): Promise<{ users: UserRow[]; balances: Record<string, number> }> {
  const [users, expensesResult, settlementsResult] = await Promise.all([
    listUsers(supabase),
    supabase
      .from("expenses")
      .select("id, ledger, amount_twd, paid_by_user_id, created_by_user_id, expense_date, deleted_at, expense_splits(user_id, amount_twd)")
      .eq("ledger", "shared")
      .eq("group_id", groupId)
      .is("deleted_at", null),
    supabase
      .from("settlements")
      .select("from_user_id, to_user_id, amount_twd")
      .eq("group_id", groupId),
  ]);
  if (expensesResult.error || settlementsResult.error) {
    throw new Error("balance lookup failed");
  }
  const expenses = z
    .array(expenseRowSchema)
    .parse(expensesResult.data)
    .map(toLedgerExpense);
  const settlements: Settlement[] = z
    .array(settlementRowSchema)
    .parse(settlementsResult.data)
    .map((row) => ({
      fromUserId: row.from_user_id,
      toUserId: row.to_user_id,
      amountTwd: row.amount_twd,
    }));
  return { users, balances: calculateBalances(expenses, settlements) };
}

async function findActiveGroup(
  supabase: SupabaseClient,
  user: UserRow,
): Promise<{ id: string; name: string }> {
  const preference = await supabase.from("user_preferences")
    .select("active_group_id, groups!user_preferences_active_group_id_fkey(id, name, archived_at)")
    .eq("user_id", user.id).single();
  if (preference.error) throw new Error("active group lookup failed");
  const parsed = z.object({
    active_group_id: z.string().uuid(),
    groups: z.union([
      z.object({ id: z.string().uuid(), name: z.string(), archived_at: z.string().nullable() }),
      z.array(z.object({ id: z.string().uuid(), name: z.string(), archived_at: z.string().nullable() })).transform((rows) => rows[0]),
    ]),
  }).parse(preference.data);
  if (!parsed.groups || parsed.groups.archived_at) throw new Error("active group unavailable");
  return { id: parsed.groups.id, name: parsed.groups.name };
}

async function findTargetGroup(
  supabase: SupabaseClient,
  user: UserRow,
  sourceText: string,
): Promise<{ id: string; name: string }> {
  const [preference, groupsResult] = await Promise.all([
    supabase
      .from("user_preferences")
      .select("active_group_id")
      .eq("user_id", user.id)
      .single(),
    supabase
      .from("groups")
      .select("id, name")
      .eq("couple_id", user.couple_id)
      .is("archived_at", null),
  ]);
  if (preference.error || groupsResult.error)
    throw new Error("target group lookup failed");
  const activeGroupId = z
    .object({ active_group_id: z.string().uuid() })
    .parse(preference.data).active_group_id;
  const groups = z
    .array(z.object({ id: z.string().uuid(), name: z.string() }))
    .parse(groupsResult.data);
  const selected = selectMentionedGroup(sourceText, groups, activeGroupId);
  if (!selected) throw new Error("active group unavailable");
  return selected;
}

function normalizeGroupText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function toLedgerExpense(row: z.infer<typeof expenseRowSchema>): LedgerExpense {
  return {
    id: row.id,
    ledger: row.ledger,
    amountTwd: row.amount_twd,
    paidByUserId: row.paid_by_user_id,
    createdByUserId: row.created_by_user_id,
    expenseDate: row.expense_date,
    deleted: row.deleted_at !== null,
    splits: Object.fromEntries(
      row.expense_splits.map((split) => [split.user_id, split.amount_twd]),
    ),
  };
}

async function replyText(
  lineClient: Pick<LineBotClient, "replyMessage">,
  replyToken: string,
  text: string,
): Promise<void> {
  await lineClient.replyMessage({
    replyToken,
    messages: [{ type: "text", text }],
  });
}

async function replyConfirmation(
  lineClient: Pick<LineBotClient, "replyMessage">,
  replyToken: string,
  actionId: string,
  text: string,
): Promise<void> {
  const message: messagingApi.TextMessage = {
    type: "text",
    text,
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: "確認",
            data: `decision=confirm&id=${actionId}`,
            displayText: "確認",
          },
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "取消",
            data: `decision=cancel&id=${actionId}`,
            displayText: "取消",
          },
        },
      ],
    },
  };
  await lineClient.replyMessage({ replyToken, messages: [message] });
}

async function replyBatchConfirmation(
  lineClient: Pick<LineBotClient, "replyMessage">,
  replyToken: string,
  actionIds: string[],
  text: string,
): Promise<void> {
  const ids = actionIds.join(",");
  const message: messagingApi.TextMessage = {
    type: "text",
    text,
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: "確認全部",
            data: `decision=confirm&ids=${ids}`,
            displayText: "確認全部",
          },
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "取消全部",
            data: `decision=cancel&ids=${ids}`,
            displayText: "取消全部",
          },
        },
      ],
    },
  };
  await lineClient.replyMessage({ replyToken, messages: [message] });
}

function emptyIntent(intent: ParsedIntent["intent"]): ParsedIntent {
  return {
    intent,
    description: null,
    amountTwd: null,
    ledger: null,
    paidBy: null,
    expenseDate: null,
    category: null,
  };
}

function emptyTextIntent(intent: ParsedIntent["intent"]): TextParseResult {
  return { ...emptyIntent(intent), groupName: null };
}

function currentTaipeiDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function nextMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const next = new Date(Date.UTC(year!, monthNumber!, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function helpText(): string {
  return [
    "可用說法：",
    "晚餐 860 我付",
    "私人 午餐 120",
    "誰欠誰",
    "本月共同支出／本月私人支出",
    "刪除剛剛那筆／結清",
  ].join("\n");
}
