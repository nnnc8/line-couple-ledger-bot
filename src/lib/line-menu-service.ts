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
import {
  startLineMenuAmountDraft,
  supersedeLineMenuAmountDraft,
  type LineMenuAmountDraft,
  type LineMenuAmountDraftPayload,
} from "./line-menu-amount-draft";
import { buildLiffUrl } from "./liff-url";
import { pendingActionService } from "./services";

export const LINE_MENU_PROTOCOL = "quick";

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

const tagSchema = z.enum(
  Object.keys(TAGS) as [keyof typeof TAGS, ...(keyof typeof TAGS)[]],
);
const descriptionSchema = z.enum(
  Object.keys(DESCRIPTIONS) as [
    keyof typeof DESCRIPTIONS,
    ...(keyof typeof DESCRIPTIONS)[],
  ],
);
const groupIdSchema = z.string().uuid();
const payerSchema = z.enum(["m", "o"]);
const amountSchema = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^\d{1,9}$/)
      .transform(Number),
  ])
  .pipe(z.number().int().min(1).max(100_000_000));

const menuPostbackSchema = z
  .discriminatedUnion("a", [
    z.object({ a: z.literal("expense") }).strict(),
    z
      .object({
        a: z.literal("expense_ledger"),
        l: z.enum(["s", "p"]),
      })
      .strict(),
    z
      .object({
        a: z.literal("expense_group"),
        l: z.literal("s"),
        g: groupIdSchema,
      })
      .strict(),
    z
      .object({
        a: z.literal("expense_payer"),
        l: z.literal("s"),
        g: groupIdSchema,
        p: payerSchema,
      })
      .strict(),
    z
      .object({
        a: z.literal("expense_tag"),
        l: z.enum(["s", "p"]),
        g: groupIdSchema.optional(),
        p: payerSchema,
        t: tagSchema,
      })
      .strict(),
    z
      .object({
        a: z.literal("expense_description"),
        l: z.enum(["s", "p"]),
        g: groupIdSchema.optional(),
        p: payerSchema,
        t: tagSchema,
        d: descriptionSchema,
      })
      .strict(),
    z
      .object({
        a: z.literal("expense_amount"),
        l: z.enum(["s", "p"]),
        g: groupIdSchema.optional(),
        p: payerSchema,
        t: tagSchema,
        d: descriptionSchema,
        n: amountSchema,
      })
      .strict(),
    z.object({ a: z.literal("transfer") }).strict(),
    z
      .object({
        a: z.literal("transfer_group"),
        g: groupIdSchema,
      })
      .strict(),
    z
      .object({
        a: z.literal("transfer_direction"),
        g: groupIdSchema,
        r: z.enum(["m", "p"]),
      })
      .strict(),
    z
      .object({
        a: z.literal("transfer_amount"),
        g: groupIdSchema,
        r: z.enum(["m", "p"]),
        n: amountSchema,
      })
      .strict(),
    z.object({ a: z.literal("settle") }).strict(),
    z
      .object({
        a: z.literal("settle_group"),
        g: groupIdSchema,
      })
      .strict(),
  ])
  .superRefine((menu, context) => {
    if (
      (menu.a === "expense_tag" ||
        menu.a === "expense_description" ||
        menu.a === "expense_amount") &&
      ((menu.l === "s" && !menu.g) ||
        (menu.l === "p" && (menu.g !== undefined || menu.p !== "m")))
    ) {
      context.addIssue({
        code: "custom",
        message: "invalid expense ledger state",
      });
    }
    if (
      (menu.a === "expense_description" || menu.a === "expense_amount") &&
      !DESCRIPTION_CHOICES[menu.t].includes(menu.d)
    ) {
      context.addIssue({
        code: "custom",
        message: "description does not match category",
      });
    }
  });

export type LineMenuPostback = z.infer<typeof menuPostbackSchema>;

export type LineMenuRejectReason =
  | "too_long"
  | "duplicate_key"
  | "unsupported_protocol"
  | "missing_action"
  | "unknown_action"
  | "unexpected_key"
  | "invalid_stage";

export type LineMenuParseResult =
  | { ok: true; menu: LineMenuPostback }
  | { ok: false; reason: LineMenuRejectReason };

const MENU_KEYS = new Set([
  "menu",
  "m",
  "a",
  "l",
  "g",
  "p",
  "t",
  "d",
  "r",
  "n",
]);

export function parseLineMenuPostbackDetailed(
  data: string,
): LineMenuParseResult {
  if (data.length > 300) return { ok: false, reason: "too_long" };
  const params = new URLSearchParams(data);
  const entries = [...params.entries()];
  const keys = entries.map(([key]) => key);
  if (new Set(keys).size !== keys.length) {
    return { ok: false, reason: "duplicate_key" };
  }
  const protocol = params.get("menu");
  const legacyProtocol = params.get("m");
  if (
    (protocol !== null && legacyProtocol !== null) ||
    (protocol !== LINE_MENU_PROTOCOL && legacyProtocol !== "1")
  ) {
    return { ok: false, reason: "unsupported_protocol" };
  }
  const action = params.get("a");
  if (!action) return { ok: false, reason: "missing_action" };
  if (!MENU_ACTIONS.includes(action as LineMenuPostback["a"])) {
    return { ok: false, reason: "unknown_action" };
  }
  if (keys.some((key) => !MENU_KEYS.has(key))) {
    return { ok: false, reason: "unexpected_key" };
  }
  const parsed = menuPostbackSchema.safeParse(
    Object.fromEntries(
      entries.filter(([key]) => key !== "menu" && key !== "m"),
    ),
  );
  if (!parsed.success) return { ok: false, reason: "invalid_stage" };
  return { ok: true, menu: parsed.data };
}

export function parseLineMenuPostback(data: string): LineMenuPostback | null {
  const parsed = parseLineMenuPostbackDetailed(data);
  return parsed.ok ? parsed.menu : null;
}

export function encodeLineMenuPostback(values: LineMenuPostback): string {
  const menu = menuPostbackSchema.parse(values);
  const params = new URLSearchParams({ menu: LINE_MENU_PROTOCOL });
  for (const [key, value] of Object.entries(menu)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  if (encoded.length > 300) throw new Error("LINE menu postback is too long");
  return encoded;
}

type Group = { id: string; name: string };

type LineMenuInput = {
  menu: LineMenuPostback;
  user: LineUser;
  db: SupabaseClient;
  liffId: string;
  sourceEventId: string;
  sourceEventTimestamp: number;
};

export class LineMenuStateError extends Error {
  constructor(
    readonly reason: "group_unavailable",
  ) {
    super(reason);
    this.name = "LineMenuStateError";
  }
}

export function lineMenuRestartReply(
  text = "這個操作已失效，請重新開始。",
): LineReplyMessage {
  return quickReplyText(text, [
    postback("快速記帳", data({ a: "expense" })),
    postback("記錄轉帳", data({ a: "transfer" })),
    postback("全部結清", data({ a: "settle" })),
  ]);
}

export async function handleLineMenuPostback(
  input: LineMenuInput,
): Promise<ReplyPayload> {
  const { menu } = input;
  if (menu.a === "expense") {
    await supersedeLineMenuAmountDraft(
      input.db,
      input.user,
      input.sourceEventTimestamp,
    );
    return quickReplyText("這筆要記在哪一本帳？", [
      postback("共同花費", data({ a: "expense_ledger", l: "s" })),
      postback("私人花費", data({ a: "expense_ledger", l: "p" })),
      uri("完整表單", buildLiffUrl(input.liffId, { action: "expense" })),
    ]);
  }

  if (menu.a === "expense_ledger") {
    if (menu.l === "p") return categoryReply({ l: "p", p: "m" }, input.liffId);
    return chooseExpenseGroup(input);
  }

  if (menu.a === "expense_group") {
    const group = await requireMenuGroup(input.db, input.user, menu.g);
    return payerReply(group);
  }

  if (menu.a === "expense_payer") {
    await validateExpenseState(input.db, input.user, menu);
    return categoryReply(menu, input.liffId);
  }

  if (menu.a === "expense_tag") {
    await validateExpenseState(input.db, input.user, menu);
    return descriptionReply(menu, input.liffId);
  }

  if (menu.a === "expense_description") {
    await validateExpenseState(input.db, input.user, menu);
    return beginExpenseAmountInput(input, menu);
  }

  if (menu.a === "expense_amount") {
    return proposeExpense({ ...input, menu });
  }

  if (menu.a === "transfer") {
    await supersedeLineMenuAmountDraft(
      input.db,
      input.user,
      input.sourceEventTimestamp,
    );
    return chooseTransferGroup(input);
  }
  if (menu.a === "transfer_group") {
    const group = await requireMenuGroup(input.db, input.user, menu.g);
    return directionReply(group);
  }
  if (menu.a === "transfer_direction") {
    await requireMenuGroup(input.db, input.user, menu.g);
    return beginTransferAmountInput(input, menu);
  }
  if (menu.a === "transfer_amount") return proposeTransfer({ ...input, menu });

  if (menu.a === "settle") {
    await supersedeLineMenuAmountDraft(
      input.db,
      input.user,
      input.sourceEventTimestamp,
    );
    return chooseSettleGroup(input);
  }
  return proposeSettle({ ...input, menu });
}

function data(values: LineMenuPostback): string {
  return encodeLineMenuPostback(values);
}

function postback(
  label: string,
  postbackData: string,
  options?: { openKeyboard?: boolean },
): QuickReplyAction {
  return {
    type: "postback",
    label: label.slice(0, 20),
    data: postbackData,
    ...(options?.openKeyboard ? { inputOption: "openKeyboard" as const } : {}),
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
  if (!groupId) throw new LineMenuStateError("group_unavailable");
  const groups = await listGroups(db, user);
  const group = groups.find((item) => item.id === groupId);
  if (!group) throw new LineMenuStateError("group_unavailable");
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
      ),
    ),
  );
}

function payerReply(group: Group): LineReplyMessage {
  return quickReplyText("這筆是誰付款？", [
    postback(
      "我付",
      data({ a: "expense_payer", l: "s", g: group.id, p: "m" }),
    ),
    postback(
      "另一半付",
      data({ a: "expense_payer", l: "s", g: group.id, p: "o" }),
    ),
  ]);
}

function categoryReply(
  state: { l: "s" | "p"; g?: string; p: "m" | "o" },
  liffId: string,
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
    ),
  );
  actions.push(
    uri(
      "自訂",
      buildLiffUrl(liffId, {
        action: "expense",
        ledger: state.l === "p" ? "private" : "shared",
        groupId: state.g,
        paidBy: state.p === "o" ? "partner" : "self",
      }),
    ),
  );
  return quickReplyText("選擇分類", actions);
}

type ExpenseTagMenu = Extract<LineMenuPostback, { a: "expense_tag" }>;

function descriptionReply(
  state: ExpenseTagMenu,
  liffId: string,
): LineReplyMessage {
  const tagCode = state.t;
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
      { openKeyboard: true },
    ),
  );
  actions.push(
    uri(
      "自訂說明",
      buildLiffUrl(liffId, {
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

type ExpenseDescriptionMenu = Extract<
  LineMenuPostback,
  { a: "expense_description" }
>;
type TransferDirectionMenu = Extract<
  LineMenuPostback,
  { a: "transfer_direction" }
>;

async function beginExpenseAmountInput(
  input: LineMenuInput,
  menu: ExpenseDescriptionMenu,
): Promise<ReplyPayload> {
  const group =
    menu.l === "s"
      ? await requireMenuGroup(input.db, input.user, menu.g)
      : null;
  const payload: LineMenuAmountDraftPayload = {
    type: "expense",
    ledger: menu.l === "p" ? "private" : "shared",
    paidBy: menu.p === "o" ? "partner" : "self",
    tag: TAGS[menu.t],
    description: DESCRIPTIONS[menu.d],
  };
  const draft = await startLineMenuAmountDraft({
    db: input.db,
    user: input.user,
    groupId: group?.id ?? null,
    sourceEventId: input.sourceEventId,
    payload,
  });
  if (draft.status !== "active") {
    return lineMenuRestartReply("這個金額步驟已被更新，請重新開始。");
  }
  return [
    [
      payload.description,
      group?.name ?? "私人帳",
      payload.paidBy === "self" ? "我付款" : "另一半付款",
    ].join("｜"),
    "請輸入金額，例如 415。",
    "輸入「取消」可離開。",
  ].join("\n");
}

async function beginTransferAmountInput(
  input: LineMenuInput,
  menu: TransferDirectionMenu,
): Promise<ReplyPayload> {
  const group = await requireMenuGroup(input.db, input.user, menu.g);
  const payload: LineMenuAmountDraftPayload = {
    type: "transfer",
    direction: menu.r === "p" ? "partner_to_me" : "me_to_partner",
  };
  const draft = await startLineMenuAmountDraft({
    db: input.db,
    user: input.user,
    groupId: group.id,
    sourceEventId: input.sourceEventId,
    payload,
  });
  if (draft.status !== "active") {
    return lineMenuRestartReply("這個金額步驟已被更新，請重新開始。");
  }
  return [
    [
      group.name,
      payload.direction === "me_to_partner"
        ? "我轉給另一半"
        : "另一半轉給我",
    ].join("｜"),
    "請輸入金額，例如 415。",
    "輸入「取消」可離開。",
  ].join("\n");
}

async function validateExpenseState(
  db: SupabaseClient,
  user: LineUser,
  menu: { l: "s" | "p"; g?: string },
) {
  if (menu.l === "s") {
    await requireMenuGroup(db, user, menu.g);
  }
}

type ExpenseAmountMenu = Extract<
  LineMenuPostback,
  { a: "expense_amount" }
>;

async function proposeExpense(
  input: Omit<LineMenuInput, "menu"> & { menu: ExpenseAmountMenu },
): Promise<LineReplyMessage> {
  const menu = input.menu;
  return proposeExpensePayload({
    ...input,
    groupId: menu.g ?? null,
    amountTwd: menu.n,
    payload: {
      type: "expense",
      ledger: menu.l === "p" ? "private" : "shared",
      paidBy: menu.p === "o" ? "partner" : "self",
      tag: TAGS[menu.t],
      description: DESCRIPTIONS[menu.d],
    },
  });
}

async function proposeExpensePayload(input: {
  db: SupabaseClient;
  user: LineUser;
  groupId: string | null;
  payload: Extract<LineMenuAmountDraftPayload, { type: "expense" }>;
  amountTwd: number;
  sourceEventId: string;
  sourceEventTimestamp: number;
}): Promise<LineReplyMessage> {
  const { payload } = input;
  const group =
    payload.ledger === "shared"
      ? await requireMenuGroup(input.db, input.user, input.groupId ?? undefined)
      : null;
  const command = {
    ledger: payload.ledger,
    groupId: group?.id ?? null,
    description: payload.description,
    merchant: null,
    notes: null,
    tag: payload.tag,
    amountTwd: input.amountTwd,
    paidBy:
      payload.ledger === "private" ? "self" as const : payload.paidBy,
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
    ledgerLabel: payload.ledger === "private" ? "私人帳" : "共同帳",
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
      ),
    ),
  );
}

function directionReply(group: Group): LineReplyMessage {
  return quickReplyText("選擇實際轉帳方向", [
    postback(
      "我轉給另一半",
      data({ a: "transfer_direction", g: group.id, r: "m" }),
      { openKeyboard: true },
    ),
    postback(
      "另一半轉給我",
      data({ a: "transfer_direction", g: group.id, r: "p" }),
      { openKeyboard: true },
    ),
  ]);
}

type TransferAmountMenu = Extract<
  LineMenuPostback,
  { a: "transfer_amount" }
>;

async function proposeTransfer(
  input: Omit<LineMenuInput, "menu"> & { menu: TransferAmountMenu },
): Promise<LineReplyMessage> {
  return proposeTransferPayload({
    ...input,
    groupId: input.menu.g,
    amountTwd: input.menu.n,
    payload: {
      type: "transfer",
      direction:
        input.menu.r === "p" ? "partner_to_me" : "me_to_partner",
    },
  });
}

async function proposeTransferPayload(input: {
  db: SupabaseClient;
  user: LineUser;
  groupId: string;
  payload: Extract<LineMenuAmountDraftPayload, { type: "transfer" }>;
  amountTwd: number;
  sourceEventId: string;
  sourceEventTimestamp: number;
}): Promise<LineReplyMessage> {
  const group = await requireMenuGroup(input.db, input.user, input.groupId);
  const command = {
    type: "transfer" as const,
    groupId: group.id,
    direction: input.payload.direction,
    amountTwd: input.amountTwd,
    occurredOn: taipeiDate(input.sourceEventTimestamp),
  };
  const proposed = await pendingActionService.proposeTransferPending(
    { db: input.db, user: input.user },
    command,
    lineMetadata(input.sourceEventId, command),
  );
  return moneyMovementCard(proposed, input.user.id, group.name);
}

export async function completeLineMenuAmountDraft(input: {
  draft: LineMenuAmountDraft;
  db: SupabaseClient;
  user: LineUser;
  sourceEventId: string;
  sourceEventTimestamp: number;
}): Promise<LineReplyMessage> {
  if (input.draft.status !== "consumed" || input.draft.amount_twd === null) {
    throw new Error("LINE amount draft is not consumable");
  }
  if (input.draft.payload.type === "expense") {
    return proposeExpensePayload({
      ...input,
      groupId: input.draft.group_id,
      payload: input.draft.payload,
      amountTwd: input.draft.amount_twd,
    });
  }
  if (!input.draft.group_id) throw new LineMenuStateError("group_unavailable");
  return proposeTransferPayload({
    ...input,
    groupId: input.draft.group_id,
    payload: input.draft.payload,
    amountTwd: input.draft.amount_twd,
  });
}

async function chooseSettleGroup(
  input: Parameters<typeof handleLineMenuPostback>[0],
): Promise<ReplyPayload> {
  const groups = await listGroups(input.db, input.user);
  if (groups.length === 0) return "目前沒有可用的共同群組。";
  if (groups.length === 1) {
    return proposeSettle({
      ...input,
      menu: { a: "settle_group", g: groups[0]!.id },
    });
  }
  return quickReplyText(
    "要結清哪個群組？",
    groups.slice(0, 12).map((group) =>
      postback(
        group.name,
        data({ a: "settle_group", g: group.id }),
      ),
    ),
  );
}

type SettleGroupMenu = Extract<
  LineMenuPostback,
  { a: "settle_group" }
>;

async function proposeSettle(
  input: Omit<LineMenuInput, "menu"> & { menu: SettleGroupMenu },
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
