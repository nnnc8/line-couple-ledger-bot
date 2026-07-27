import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { loadGroupBalances } from "./balance-loader";
import {
  flexExpensePending,
  flexTransferConfirm,
  quickReplyText,
  type LineReplyMessage,
  type QuickReplyAction,
} from "./flex-message-builder";
import type { LineUser, ReplyPayload } from "./line-bot-shared";
import { pendingActionService } from "./services";

const MENU_ACTIONS = [
  "expense",
  "expense_ledger",
  "expense_group",
  "expense_payer",
  "expense_tag",
  "expense_description",
  "expense_amount",
  "transfer",
  "transfer_group",
  "transfer_direction",
  "transfer_amount",
  "settle",
  "settle_group",
] as const;

const TAGS = {
  f: "餐飲",
  tr: "交通",
  fu: "油資",
  pk: "停車費",
  sh: "購物",
  med: "醫療",
  en: "娛樂",
  ot: "其他",
} as const;

const DESCRIPTIONS = {
  bf: "早餐",
  lu: "午餐",
  di: "晚餐",
  dr: "飲料",
  ride: "交通",
  fuel: "加油",
  park: "停車",
  shop: "購物",
  medical: "醫療",
  fun: "娛樂",
  other: "日常支出",
} as const;

const DESCRIPTION_CHOICES: Record<keyof typeof TAGS, Array<keyof typeof DESCRIPTIONS>> = {
  f: ["bf", "lu", "di", "dr"],
  tr: ["ride"],
  fu: ["fuel"],
  pk: ["park"],
  sh: ["shop"],
  med: ["medical"],
  en: ["fun"],
  ot: ["other"],
};

const menuPostbackSchema = z
  .object({
    m: z.literal("1"),
    a: z.enum(MENU_ACTIONS),
    l: z.enum(["s", "p"]).optional(),
    g: z.string().uuid().optional(),
    p: z.enum(["m", "o"]).optional(),
    t: z.enum(Object.keys(TAGS) as [keyof typeof TAGS, ...(keyof typeof TAGS)[]]).optional(),
    d: z
      .enum(
        Object.keys(DESCRIPTIONS) as [
          keyof typeof DESCRIPTIONS,
          ...(keyof typeof DESCRIPTIONS)[],
        ],
      )
      .optional(),
    r: z.enum(["m", "p"]).optional(),
    n: z
      .string()
      .regex(/^\d{1,9}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(100_000_000))
      .optional(),
  })
  .strict();

export type LineMenuPostback = z.infer<typeof menuPostbackSchema>;

const ACTION_KEYS: Record<LineMenuPostback["a"], string[]> = {
  expense: ["m", "a"],
  expense_ledger: ["m", "a", "l"],
  expense_group: ["m", "a", "l", "g"],
  expense_payer: ["m", "a", "l", "g", "p"],
  expense_tag: ["m", "a", "l", "g", "p", "t"],
  expense_description: ["m", "a", "l", "g", "p", "t", "d"],
  expense_amount: ["m", "a", "l", "g", "p", "t", "d", "n"],
  transfer: ["m", "a"],
  transfer_group: ["m", "a", "g"],
  transfer_direction: ["m", "a", "g", "r"],
  transfer_amount: ["m", "a", "g", "r", "n"],
  settle: ["m", "a"],
  settle_group: ["m", "a", "g"],
};

export function parseLineMenuPostback(data: string): LineMenuPostback | null {
  if (data.length > 300) return null;
  const params = new URLSearchParams(data);
  const entries = [...params.entries()];
  const keys = entries.map(([key]) => key);
  if (new Set(keys).size !== keys.length) return null;
  const parsed = menuPostbackSchema.safeParse(Object.fromEntries(entries));
  if (!parsed.success) return null;
  const expected =
    parsed.data.l === "p"
      ? ACTION_KEYS[parsed.data.a].filter((key) => key !== "g")
      : ACTION_KEYS[parsed.data.a];
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  ) {
    return null;
  }
  if (parsed.data.l === "p" && parsed.data.g) return null;
  if (parsed.data.l === "p" && parsed.data.p === "o") return null;
  if (
    (parsed.data.a === "expense_group" ||
      parsed.data.a === "expense_payer") &&
    parsed.data.l !== "s"
  ) {
    return null;
  }
  if (
    parsed.data.t &&
    parsed.data.d &&
    !DESCRIPTION_CHOICES[parsed.data.t].includes(parsed.data.d)
  ) {
    return null;
  }
  return parsed.data;
}

type Group = { id: string; name: string };

export async function handleLineMenuPostback(input: {
  menu: LineMenuPostback;
  user: LineUser;
  db: SupabaseClient;
  appUrl: string;
  sourceEventId: string;
  sourceEventTimestamp: number;
}): Promise<ReplyPayload> {
  const { menu } = input;
  if (menu.a === "expense") {
    return quickReplyText("這筆要記在哪一本帳？", [
      postback("共同花費", data({ a: "expense_ledger", l: "s" }), "共同花費"),
      postback("私人花費", data({ a: "expense_ledger", l: "p" }), "私人花費"),
      uri("完整表單", prefillUrl(input.appUrl, { action: "expense" })),
    ]);
  }

  if (menu.a === "expense_ledger") {
    if (menu.l === "p") return categoryReply({ l: "p", p: "m" }, input.appUrl);
    return chooseExpenseGroup(input);
  }

  if (menu.a === "expense_group") {
    const group = await requireMenuGroup(input.db, input.user, menu.g);
    return payerReply(group);
  }

  if (menu.a === "expense_payer") {
    await validateExpenseState(input);
    return categoryReply(menu, input.appUrl);
  }

  if (menu.a === "expense_tag") {
    await validateExpenseState(input);
    return descriptionReply(menu, input.appUrl);
  }

  if (menu.a === "expense_description") {
    await validateExpenseState(input);
    return amountReply(menu, input.appUrl, "expense");
  }

  if (menu.a === "expense_amount") {
    return proposeExpense(input);
  }

  if (menu.a === "transfer") return chooseTransferGroup(input);
  if (menu.a === "transfer_group") {
    const group = await requireMenuGroup(input.db, input.user, menu.g);
    return directionReply(group);
  }
  if (menu.a === "transfer_direction") {
    await requireMenuGroup(input.db, input.user, menu.g);
    return amountReply(menu, input.appUrl, "transfer");
  }
  if (menu.a === "transfer_amount") return proposeTransfer(input);

  if (menu.a === "settle") return chooseSettleGroup(input);
  return proposeSettle(input);
}

function data(
  values: Omit<LineMenuPostback, "m"> & { a: LineMenuPostback["a"] },
): string {
  const params = new URLSearchParams({ m: "1" });
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  if (encoded.length > 300) throw new Error("LINE menu postback is too long");
  return encoded;
}

function postback(
  label: string,
  postbackData: string,
  displayText = label,
): QuickReplyAction {
  return {
    type: "postback",
    label: label.slice(0, 20),
    data: postbackData,
    displayText,
  };
}

function uri(label: string, target: string): QuickReplyAction {
  return { type: "uri", label: label.slice(0, 20), uri: target };
}

async function listGroups(db: SupabaseClient, user: LineUser): Promise<Group[]> {
  const query = await db
    .from("groups")
    .select("id, name")
    .eq("couple_id", user.couple_id)
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  if (query.error) throw new Error("group lookup failed");
  return z
    .array(z.object({ id: z.string().uuid(), name: z.string().min(1).max(100) }))
    .parse(query.data ?? []);
}

async function requireMenuGroup(
  db: SupabaseClient,
  user: LineUser,
  groupId: string | undefined,
): Promise<Group> {
  if (!groupId) throw new Error("group is required");
  const groups = await listGroups(db, user);
  const group = groups.find((item) => item.id === groupId);
  if (!group) throw new Error("group is unavailable");
  return group;
}

async function chooseExpenseGroup(
  input: Parameters<typeof handleLineMenuPostback>[0],
): Promise<LineReplyMessage> {
  const groups = await listGroups(input.db, input.user);
  if (groups.length === 0) return quickReplyText("目前沒有可用的共同群組。", []);
  if (groups.length === 1) return payerReply(groups[0]!);
  return quickReplyText(
    "要記到哪個群組？",
    groups.slice(0, 12).map((group) =>
      postback(
        group.name,
        data({ a: "expense_group", l: "s", g: group.id }),
        `群組：${group.name}`,
      ),
    ),
  );
}

function payerReply(group: Group): LineReplyMessage {
  return quickReplyText("這筆是誰付款？", [
    postback(
      "我付",
      data({ a: "expense_payer", l: "s", g: group.id, p: "m" }),
      "我付款",
    ),
    postback(
      "另一半付",
      data({ a: "expense_payer", l: "s", g: group.id, p: "o" }),
      "另一半付款",
    ),
  ]);
}

function categoryReply(
  state: Pick<LineMenuPostback, "l" | "g" | "p">,
  appUrl: string,
): LineReplyMessage {
  const actions = Object.entries(TAGS).map(([code, label]) =>
    postback(
      label,
      data({
        a: "expense_tag",
        l: state.l,
        g: state.g,
        p: state.p,
        t: code as keyof typeof TAGS,
      }),
      `分類：${label}`,
    ),
  );
  actions.push(
    uri(
      "自訂",
      prefillUrl(appUrl, {
        action: "expense",
        ledger: state.l === "p" ? "private" : "shared",
        groupId: state.g,
        paidBy: state.p === "o" ? "partner" : "self",
      }),
    ),
  );
  return quickReplyText("選擇分類", actions);
}

function descriptionReply(
  state: LineMenuPostback,
  appUrl: string,
): LineReplyMessage {
  const tagCode = state.t!;
  const actions: QuickReplyAction[] = DESCRIPTION_CHOICES[tagCode].map((code) =>
    postback(
      DESCRIPTIONS[code],
      data({
        a: "expense_description",
        l: state.l,
        g: state.g,
        p: state.p,
        t: tagCode,
        d: code,
      }),
      `項目：${DESCRIPTIONS[code]}`,
    ),
  );
  actions.push(
    uri(
      "自訂說明",
      prefillUrl(appUrl, {
        action: "expense",
        ledger: state.l === "p" ? "private" : "shared",
        groupId: state.g,
        paidBy: state.p === "o" ? "partner" : "self",
        tag: TAGS[tagCode],
      }),
    ),
  );
  return quickReplyText("這筆是什麼？", actions);
}

function amountReply(
  state: LineMenuPostback,
  appUrl: string,
  flow: "expense" | "transfer",
): LineReplyMessage {
  const amounts = [100, 200, 500, 1000];
  const actions = amounts.map((amount) =>
    postback(
      `NT$${amount.toLocaleString()}`,
      data({
        ...state,
        a: flow === "expense" ? "expense_amount" : "transfer_amount",
        n: amount,
      }),
      `金額 NT$${amount.toLocaleString()}`,
    ),
  );
  actions.push(
    uri(
      "自訂金額",
      flow === "expense"
        ? prefillUrl(appUrl, {
            action: "expense",
            ledger: state.l === "p" ? "private" : "shared",
            groupId: state.g,
            paidBy: state.p === "o" ? "partner" : "self",
            tag: state.t ? TAGS[state.t] : undefined,
            description: state.d ? DESCRIPTIONS[state.d] : undefined,
          })
        : prefillUrl(appUrl, {
            action: "transfer",
            groupId: state.g,
            direction: state.r === "p" ? "partner_to_me" : "me_to_partner",
          }),
    ),
  );
  return quickReplyText("選擇金額", actions);
}

async function validateExpenseState(
  input: Parameters<typeof handleLineMenuPostback>[0],
) {
  if (input.menu.l === "s") {
    await requireMenuGroup(input.db, input.user, input.menu.g);
  }
}

async function proposeExpense(
  input: Parameters<typeof handleLineMenuPostback>[0],
): Promise<LineReplyMessage> {
  const menu = input.menu;
  await validateExpenseState(input);
  const ledger: "private" | "shared" = menu.l === "p" ? "private" : "shared";
  const group =
    ledger === "shared"
      ? await requireMenuGroup(input.db, input.user, menu.g)
      : null;
  const tag = TAGS[menu.t!];
  const description = DESCRIPTIONS[menu.d!];
  const command = {
    ledger,
    groupId: group?.id ?? null,
    description,
    merchant: null,
    notes: null,
    tag,
    amountTwd: menu.n!,
    paidBy: ledger === "private" || menu.p !== "o" ? "self" as const : "partner" as const,
    expenseDate: taipeiDate(input.sourceEventTimestamp),
    splitMethod: "equal" as const,
    selfValue: null,
    partnerValue: null,
  };
  const metadata = lineMetadata(input.sourceEventId, command);
  const proposed = z
    .object({
      result: z.literal("pending"),
      action_id: z.string().uuid(),
      expense: z.object({
        description: z.string(),
        tag: z.string(),
        amount_twd: z.number().int(),
      }),
    })
    .parse(
      await pendingActionService.proposeCreateExpensePending(
        {
          db: input.db,
          user: input.user,
        },
        command,
        metadata,
      ),
    );
  return flexExpensePending({
    actionId: proposed.action_id,
    description: proposed.expense.description,
    amountTwd: proposed.expense.amount_twd,
    tag: proposed.expense.tag,
    paidByLabel: command.paidBy === "self" ? "你付" : "另一半付",
    ledgerLabel: ledger === "private" ? "私人帳" : "共同帳",
    groupName: group?.name,
  });
}

async function chooseTransferGroup(
  input: Parameters<typeof handleLineMenuPostback>[0],
): Promise<LineReplyMessage> {
  const groups = await listGroups(input.db, input.user);
  if (groups.length === 0) return quickReplyText("目前沒有可用的共同群組。", []);
  if (groups.length === 1) return directionReply(groups[0]!);
  return quickReplyText(
    "這筆轉帳屬於哪個群組？",
    groups.slice(0, 12).map((group) =>
      postback(
        group.name,
        data({ a: "transfer_group", g: group.id }),
        `群組：${group.name}`,
      ),
    ),
  );
}

function directionReply(group: Group): LineReplyMessage {
  return quickReplyText("選擇實際轉帳方向", [
    postback(
      "我轉給另一半",
      data({ a: "transfer_direction", g: group.id, r: "m" }),
      "我轉給另一半",
    ),
    postback(
      "另一半轉給我",
      data({ a: "transfer_direction", g: group.id, r: "p" }),
      "另一半轉給我",
    ),
  ]);
}

async function proposeTransfer(
  input: Parameters<typeof handleLineMenuPostback>[0],
): Promise<LineReplyMessage> {
  const group = await requireMenuGroup(input.db, input.user, input.menu.g);
  const direction =
    input.menu.r === "p" ? "partner_to_me" as const : "me_to_partner" as const;
  const command = {
    type: "transfer" as const,
    groupId: group.id,
    direction,
    amountTwd: input.menu.n!,
    occurredOn: taipeiDate(input.sourceEventTimestamp),
  };
  const proposed = await pendingActionService.proposeTransferPending(
    { db: input.db, user: input.user },
    command,
    lineMetadata(input.sourceEventId, command),
  );
  return moneyMovementCard(proposed, input.user.id, group.name);
}

async function chooseSettleGroup(
  input: Parameters<typeof handleLineMenuPostback>[0],
): Promise<ReplyPayload> {
  const groups = await listGroups(input.db, input.user);
  if (groups.length === 0) return "目前沒有可用的共同群組。";
  if (groups.length === 1) {
    return proposeSettle({ ...input, menu: { m: "1", a: "settle_group", g: groups[0]!.id } });
  }
  return quickReplyText(
    "要結清哪個群組？",
    groups.slice(0, 12).map((group) =>
      postback(
        group.name,
        data({ a: "settle_group", g: group.id }),
        `結清群組：${group.name}`,
      ),
    ),
  );
}

async function proposeSettle(
  input: Parameters<typeof handleLineMenuPostback>[0],
): Promise<ReplyPayload> {
  const group = await requireMenuGroup(input.db, input.user, input.menu.g);
  const balances = await loadGroupBalances(input.db, group.id);
  const mine = balances.find((row) => row.userId === input.user.id)?.balanceTwd ?? 0;
  if (mine === 0) return "這個群組目前已全部結清。";
  const command = {
    type: "settle" as const,
    groupId: group.id,
    direction: mine < 0 ? "me_to_partner" as const : "partner_to_me" as const,
  };
  const proposed = await pendingActionService.proposeSettlementPending(
    { db: input.db, user: input.user },
    command,
    lineMetadata(input.sourceEventId, command),
  );
  return moneyMovementCard(proposed, input.user.id, group.name);
}

function moneyMovementCard(
  raw: unknown,
  userId: string,
  groupName: string,
): LineReplyMessage {
  const proposed = z
    .object({
      action_id: z.string().uuid(),
      action_type: z.enum(["transfer", "settle"]),
      direction: z.enum(["me_to_partner", "partner_to_me"]),
      amount_twd: z.number().int().positive(),
      balance: z.object({
        before_by_user_id: z.record(z.string(), z.number().int()),
        after_by_user_id: z.record(z.string(), z.number().int()),
      }),
    })
    .parse(raw);
  const before = proposed.balance.before_by_user_id[userId] ?? 0;
  const after = proposed.balance.after_by_user_id[userId] ?? 0;
  return flexTransferConfirm({
    actionId: proposed.action_id,
    intent: proposed.action_type,
    directionLabel:
      proposed.direction === "me_to_partner" ? "你 → 另一半" : "另一半 → 你",
    amountTwd: proposed.amount_twd,
    groupName,
    beforeBalanceText: balanceText(before),
    afterBalanceText: balanceText(after),
    warning:
      proposed.action_type === "transfer"
        ? transferWarning(before, after)
        : undefined,
  });
}

function balanceText(balance: number): string {
  if (balance === 0) return "已結清";
  return balance > 0
    ? `另一半欠你 NT$${balance.toLocaleString()}`
    : `你欠另一半 NT$${Math.abs(balance).toLocaleString()}`;
}

function transferWarning(before: number, after: number): string | undefined {
  if (before === 0) return "目前沒有欠款；這筆會建立預付款餘額。";
  if (Math.sign(before) !== Math.sign(after) && after !== 0) {
    return "金額超過目前欠款，餘額會跨過 0。";
  }
  if (Math.abs(after) > Math.abs(before)) return "這是目前欠款的反方向，欠款會增加。";
  return undefined;
}

function lineMetadata(sourceEventId: string, command: object) {
  const fingerprint = createHash("sha256")
    .update(`${sourceEventId}:${JSON.stringify(command)}`)
    .digest("hex")
    .slice(0, 48);
  const key = `line-menu:${fingerprint}`;
  return {
    source: "line-menu",
    sourceEventId: key,
    idempotencyKey: key,
  };
}

function taipeiDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function prefillUrl(
  appUrl: string,
  values: Record<string, string | undefined>,
): string {
  const url = new URL(appUrl);
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}
