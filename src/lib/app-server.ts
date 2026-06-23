import { randomUUID } from "node:crypto";

import { GoogleGenAI } from "@google/genai";
import type { LineBotClient } from "@line/bot-sdk";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  categories,
  geminiReceiptJsonSchema,
  nextRecurringDate,
  receiptExtractionSchema,
  splitEqual,
  splitExact,
  splitPercentage,
  type RecurringFrequency,
  type SplitMethod,
} from "./ledger";
import {
  detectReceiptMime,
  safeSecretEqual,
  signSession,
  verifySession,
} from "./security";

export const SESSION_COOKIE = "couple_ledger_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const ACTION_SECONDS = 60 * 5;
const RECEIPT_LIMIT = 10 * 1024 * 1024;
const MODEL = "gemini-3.1-flash-lite";

const envSchema = z.object({
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1),
  LINE_LOGIN_CHANNEL_ID: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  COUPLE_SETUP_CODE: z.string().min(20),
  LIFF_SESSION_SECRET: z.string().min(32),
  APP_URL: z.url(),
  CRON_SECRET: z.string().min(16),
});

const userSchema = z.object({
  id: z.string().uuid(),
  couple_id: z.number().int(),
  line_user_id: z.string(),
  role: z.enum(["owner", "partner"]),
});
const groupSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  color: z.string(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
});
const splitSchema = z.object({
  user_id: z.string().uuid(),
  amount_twd: z.coerce.number().int(),
});
const receiptRowSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
});
const expenseSchema = z.object({
  id: z.string().uuid(),
  group_id: z.string().uuid().nullable(),
  ledger: z.enum(["shared", "private"]),
  description: z.string(),
  merchant: z.string().nullable(),
  notes: z.string().nullable(),
  category: z.enum(categories),
  amount_twd: z.coerce.number().int(),
  paid_by_user_id: z.string().uuid(),
  created_by_user_id: z.string().uuid(),
  expense_date: z.string(),
  split_method: z.enum(["equal", "exact", "percentage"]),
  version: z.number().int(),
  deleted_at: z.string().nullable(),
  created_at: z.string(),
  expense_splits: z.array(splitSchema),
  receipts: z.array(receiptRowSchema).default([]),
});

export type AppUser = z.infer<typeof userSchema>;
export type AppExpense = z.infer<typeof expenseSchema>;

export interface ServerContext {
  env: z.infer<typeof envSchema>;
  db: SupabaseClient;
  user: AppUser;
}

export function serverEnvironment(): z.infer<typeof envSchema> {
  return envSchema.parse(process.env);
}

export function serverDatabase(env = serverEnvironment()): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function assertSameOrigin(request: Request, appUrl: string): void {
  if (request.headers.get("origin") !== new URL(appUrl).origin) {
    throw new HttpError(403, "Invalid origin");
  }
}

export async function createSession(
  idToken: string,
  inviteCode?: string,
): Promise<{ token: string; user: AppUser }> {
  const env = serverEnvironment();
  const body = new URLSearchParams({
    id_token: idToken,
    client_id: env.LINE_LOGIN_CHANNEL_ID,
  });
  const response = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!response.ok) throw new HttpError(401, "LINE login failed");
  const identity = z
    .object({ sub: z.string(), aud: z.string(), exp: z.number() })
    .parse(await response.json());
  if (
    identity.aud !== env.LINE_LOGIN_CHANNEL_ID ||
    identity.exp <= Math.floor(Date.now() / 1_000)
  ) {
    throw new HttpError(401, "LINE login expired");
  }
  const db = serverDatabase(env);
  const result = await db
    .from("users")
    .select("id, couple_id, line_user_id, role")
    .eq("line_user_id", identity.sub)
    .maybeSingle();
  if (result.error) throw new Error("user lookup failed");
  let user = userSchema.nullable().parse(result.data);
  if (!user && inviteCode) {
    if (!safeSecretEqual(inviteCode.trim(), env.COUPLE_SETUP_CODE)) {
      throw new HttpError(403, "邀請連結無效");
    }
    const claim = await db.rpc("claim_user", {
      p_line_user_id: identity.sub,
    });
    if (claim.error) throw new Error("claim_user failed");
    const claimed = z
      .object({
        result: z.enum(["joined", "already_joined", "full"]),
      })
      .parse(claim.data);
    if (claimed.result === "full") {
      throw new HttpError(403, "帳本已綁定兩位使用者");
    }
    const refreshed = await db
      .from("users")
      .select("id, couple_id, line_user_id, role")
      .eq("line_user_id", identity.sub)
      .single();
    if (refreshed.error) throw new Error("user lookup failed");
    user = userSchema.parse(refreshed.data);
  }
  if (!user) throw new HttpError(403, "請先在 LINE Bot 輸入加入設定碼");
  const expiresAt = Math.min(
    identity.exp,
    Math.floor(Date.now() / 1_000) + SESSION_SECONDS,
  );
  return {
    token: signSession(
      { userId: user.id, lineUserId: user.line_user_id, expiresAt },
      env.LIFF_SESSION_SECRET,
    ),
    user,
  };
}

export async function requireContext(request: Request): Promise<ServerContext> {
  const env = serverEnvironment();
  const cookie = parseCookie(request.headers.get("cookie") ?? "").get(
    SESSION_COOKIE,
  );
  const session = cookie
    ? verifySession(cookie, env.LIFF_SESSION_SECRET)
    : null;
  if (!session) throw new HttpError(401, "Session expired");
  const db = serverDatabase(env);
  const result = await db
    .from("users")
    .select("id, couple_id, line_user_id, role")
    .eq("id", session.userId)
    .eq("line_user_id", session.lineUserId)
    .single();
  if (result.error) throw new HttpError(401, "User not found");
  return { env, db, user: userSchema.parse(result.data) };
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function parseCookie(value: string): Map<string, string> {
  return new Map(
    value
      .split(";")
      .map((part) => part.trim().split("=", 2) as [string, string]),
  );
}

export async function loadBootstrap(context: ServerContext) {
  const { db, user } = context;
  const [usersResult, groupsResult, preferenceResult] = await Promise.all([
    db
      .from("users")
      .select("id, couple_id, line_user_id, role")
      .eq("couple_id", user.couple_id)
      .order("role"),
    db
      .from("groups")
      .select("id, name, color, archived_at, created_at")
      .eq("couple_id", user.couple_id)
      .order("created_at"),
    db
      .from("user_preferences")
      .select("active_group_id")
      .eq("user_id", user.id)
      .single(),
  ]);
  if (usersResult.error || groupsResult.error || preferenceResult.error)
    throw new Error("bootstrap lookup failed");
  const users = z.array(userSchema).parse(usersResult.data);
  const groups = z.array(groupSchema).parse(groupsResult.data);
  const activeGroupId = z
    .object({ active_group_id: z.string().uuid() })
    .parse(preferenceResult.data).active_group_id;
  if (!groups.some((group) => group.id === activeGroupId && !group.archived_at))
    throw new HttpError(409, "Active group unavailable");

  const expenseSelect =
    "id, group_id, ledger, description, merchant, notes, category, amount_twd, paid_by_user_id, created_by_user_id, expense_date, split_method, version, deleted_at, created_at, expense_splits(user_id, amount_twd), receipts(id, status)";
  const month = taipeiToday().slice(0, 7);
  const sixMonthsAgo = shiftMonth(month, -5);
  const [
    sharedResult,
    privateResult,
    balancesResult,
    budgetsResult,
    recurringResult,
    notificationsResult,
  ] = await Promise.all([
    db
      .from("expenses")
      .select(expenseSelect)
      .eq("group_id", activeGroupId)
      .gte("expense_date", `${sixMonthsAgo}-01`)
      .order("expense_date", { ascending: false })
      .limit(300),
    db
      .from("expenses")
      .select(expenseSelect)
      .eq("ledger", "private")
      .eq("created_by_user_id", user.id)
      .gte("expense_date", `${sixMonthsAgo}-01`)
      .order("expense_date", { ascending: false })
      .limit(300),
    db.rpc("group_balances", { p_group_id: activeGroupId }),
    db
      .from("budgets")
      .select("id, group_id, category, month, limit_twd")
      .eq("group_id", activeGroupId)
      .eq("month", `${month}-01`)
      .order("category"),
    db
      .from("recurring_expenses")
      .select(
        "id, group_id, ledger, description, category, amount_twd, frequency, next_run_date, active",
      )
      .eq("couple_id", user.couple_id)
      .order("next_run_date"),
    db
      .from("notifications")
      .select(
        "id, group_id, kind, title, body, read_at, created_at, line_status",
      )
      .eq("recipient_user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  if (
    sharedResult.error ||
    privateResult.error ||
    balancesResult.error ||
    budgetsResult.error ||
    recurringResult.error ||
    notificationsResult.error
  ) {
    throw new Error("ledger lookup failed");
  }
  const expenses = z
    .array(expenseSchema)
    .parse([...(sharedResult.data ?? []), ...(privateResult.data ?? [])]);
  const activeShared = expenses.filter(
    (expense) =>
      expense.group_id === activeGroupId &&
      expense.ledger === "shared" &&
      !expense.deleted_at,
  );
  const categoryTotals = Object.fromEntries(
    categories.map((category) => [category, 0]),
  ) as Record<string, number>;
  const trend = Array.from({ length: 6 }, (_, index) => ({
    month: shiftMonth(month, index - 5),
    totalTwd: 0,
  }));
  for (const expense of activeShared) {
    const expenseMonth = expense.expense_date.slice(0, 7);
    const point = trend.find((item) => item.month === expenseMonth);
    if (point) point.totalTwd += expense.amount_twd;
    if (expenseMonth === month)
      categoryTotals[expense.category] += expense.amount_twd;
  }
  const thisMonth = activeShared.filter((expense) =>
    expense.expense_date.startsWith(month),
  );
  const balances = z
    .array(
      z.object({
        user_id: z.string().uuid(),
        balance_twd: z.coerce.number().int(),
      }),
    )
    .parse(balancesResult.data);
  return {
    today: taipeiToday(),
    month,
    user: publicUser(user, user.id),
    users: users.map((item) => publicUser(item, user.id)),
    groups,
    activeGroupId,
    expenses,
    balances,
    budgets: budgetsResult.data,
    recurring: recurringResult.data,
    notifications: notificationsResult.data,
    dashboard: {
      monthlyTotalTwd: thisMonth.reduce(
        (sum, expense) => sum + expense.amount_twd,
        0,
      ),
      monthlyCount: thisMonth.length,
      categoryTotals,
      trend,
      recent: activeShared.slice(0, 8),
    },
  };
}

function publicUser(user: AppUser, requesterId: string) {
  return {
    id: user.id,
    role: user.role,
    label: user.id === requesterId ? "你" : "另一半",
  };
}

const expenseInputSchema = z.object({
  ledger: z.enum(["shared", "private"]),
  groupId: z.string().uuid().nullable(),
  description: z.string().trim().min(1).max(100),
  merchant: z.string().trim().max(100).nullable().default(null),
  notes: z.string().trim().max(500).nullable().default(null),
  category: z.enum(categories),
  amountTwd: z.number().int().positive().max(100_000_000),
  paidBy: z.enum(["self", "partner"]),
  expenseDate: z.iso.date(),
  splitMethod: z.enum(["equal", "exact", "percentage"]),
  selfValue: z.number().min(0).nullable().default(null),
  partnerValue: z.number().min(0).nullable().default(null),
  receiptId: z.string().uuid().nullable().default(null),
});

export const actionInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_expense"), expense: expenseInputSchema }),
  z.object({
    type: z.literal("update_expense"),
    expenseId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    expense: expenseInputSchema,
  }),
  z.object({
    type: z.literal("delete_expense"),
    expenseId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("restore_expense"),
    expenseId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("settle"),
    groupId: z.string().uuid(),
    amountTwd: z.number().int().positive().max(100_000_000),
  }),
]);

export async function proposeAction(
  context: ServerContext,
  input: unknown,
  idempotencyKey?: string,
) {
  const parsed = actionInputSchema.parse(input);
  const usersResult = await context.db
    .from("users")
    .select("id, couple_id, line_user_id, role")
    .eq("couple_id", context.user.couple_id)
    .order("role");
  if (usersResult.error) throw new Error("users lookup failed");
  const users = z.array(userSchema).parse(usersResult.data);
  const partner = users.find((user) => user.id !== context.user.id);
  if (!partner) throw new HttpError(409, "請先讓另一半加入");
  let groupId: string | null = null;
  let payload: Record<string, unknown>;
  let preview: string;

  if (parsed.type === "create_expense" || parsed.type === "update_expense") {
    const prepared = await prepareExpense(context, parsed.expense, partner);
    groupId = prepared.groupId;
    payload = prepared.payload;
    preview = `${parsed.type === "create_expense" ? "新增" : "修改"} ${prepared.groupName}\n${parsed.expense.description} NT$${parsed.expense.amountTwd}\n${splitLabel(parsed.expense.splitMethod)}`;
    if (parsed.type === "update_expense")
      Object.assign(payload, {
        expense_id: parsed.expenseId,
        expected_version: parsed.expectedVersion,
      });
  } else if (parsed.type === "settle") {
    await requireGroup(context, parsed.groupId);
    const result = await context.db.rpc("group_balances", {
      p_group_id: parsed.groupId,
    });
    if (result.error) throw new Error("balance lookup failed");
    const balances = z
      .array(
        z.object({
          user_id: z.string().uuid(),
          balance_twd: z.coerce.number().int(),
        }),
      )
      .parse(result.data);
    const debtor = balances.find((item) => item.balance_twd < 0);
    const creditor = balances.find((item) => item.balance_twd > 0);
    if (!debtor || !creditor || parsed.amountTwd > Math.abs(debtor.balance_twd))
      throw new HttpError(409, "結清金額超過目前欠款");
    groupId = parsed.groupId;
    payload = {
      group_id: groupId,
      from_user_id: debtor.user_id,
      to_user_id: creditor.user_id,
      amount_twd: parsed.amountTwd,
      expected_balance_twd: debtor.balance_twd,
    };
    preview = `結清 NT$${parsed.amountTwd}`;
  } else {
    const expenseResult = await context.db
      .from("expenses")
      .select(
        "id, group_id, ledger, description, amount_twd, version, deleted_at, created_by_user_id",
      )
      .eq("id", parsed.expenseId)
      .eq("couple_id", context.user.couple_id)
      .single();
    if (expenseResult.error) throw new HttpError(404, "找不到支出");
    const expense = z
      .object({
        id: z.string().uuid(),
        group_id: z.string().uuid().nullable(),
        ledger: z.enum(["shared", "private"]),
        description: z.string(),
        amount_twd: z.coerce.number().int(),
        version: z.number().int(),
        deleted_at: z.string().nullable(),
        created_by_user_id: z.string().uuid(),
      })
      .parse(expenseResult.data);
    if (
      expense.ledger === "private" &&
      expense.created_by_user_id !== context.user.id
    )
      throw new HttpError(403, "無權操作私人支出");
    if (expense.version !== parsed.expectedVersion)
      throw new HttpError(409, "帳目已被修改，請重新整理");
    groupId = expense.group_id;
    payload = { expense_id: expense.id, expected_version: expense.version };
    preview = `${parsed.type === "delete_expense" ? "刪除" : "復原"}「${expense.description} NT$${expense.amount_twd}」`;
  }

  const sourceEventId = `liff:${randomUUID()}`;
  const insert = await context.db
    .from("pending_actions")
    .insert({
      couple_id: context.user.couple_id,
      group_id: groupId,
      requested_by_user_id: context.user.id,
      action_type: parsed.type,
      payload,
      source_event_id: sourceEventId,
      idempotency_key: idempotencyKey || null,
      expires_at: new Date(Date.now() + ACTION_SECONDS * 1_000).toISOString(),
    })
    .select("id")
    .single();
  if (insert.error) {
    if (idempotencyKey) {
      const existing = await context.db
        .from("pending_actions")
        .select("id")
        .eq("idempotency_key", idempotencyKey)
        .single();
      if (!existing.error) return { actionId: existing.data.id, preview };
    }
    throw new Error("pending action insert failed");
  }
  return {
    actionId: z.object({ id: z.string().uuid() }).parse(insert.data).id,
    preview,
  };
}

async function prepareExpense(
  context: ServerContext,
  expense: z.infer<typeof expenseInputSchema>,
  partner: AppUser,
) {
  const group =
    expense.ledger === "shared"
      ? await requireGroup(context, expense.groupId)
      : null;
  if (expense.ledger === "private" && expense.paidBy !== "self")
    throw new HttpError(400, "私人支出只能由本人付款");
  const payerId = expense.paidBy === "self" ? context.user.id : partner.id;
  let splits: Record<string, number>;
  if (expense.ledger === "private")
    splits = { [context.user.id]: expense.amountTwd };
  else if (expense.splitMethod === "equal")
    splits = splitEqual(
      expense.amountTwd,
      payerId,
      payerId === context.user.id ? partner.id : context.user.id,
    );
  else if (expense.splitMethod === "exact")
    splits = splitExact(expense.amountTwd, {
      [context.user.id]: expense.selfValue ?? -1,
      [partner.id]: expense.partnerValue ?? -1,
    });
  else
    splits = splitPercentage(expense.amountTwd, payerId, {
      [context.user.id]: expense.selfValue ?? -1,
      [partner.id]: expense.partnerValue ?? -1,
    });
  return {
    groupId: group?.id ?? null,
    groupName: expense.ledger === "private" ? "私人帳" : group!.name,
    payload: {
      group_id: group?.id ?? null,
      ledger: expense.ledger,
      description: expense.description,
      merchant: expense.merchant,
      notes: expense.notes,
      category: expense.category,
      amount_twd: expense.amountTwd,
      paid_by_user_id: expense.ledger === "private" ? context.user.id : payerId,
      expense_date: expense.expenseDate,
      split_method: expense.splitMethod,
      splits,
      receipt_id: expense.receiptId,
    },
  };
}

async function requireGroup(context: ServerContext, groupId: string | null) {
  if (!groupId) throw new HttpError(400, "請選擇群組");
  const result = await context.db
    .from("groups")
    .select("id, name")
    .eq("id", groupId)
    .eq("couple_id", context.user.couple_id)
    .is("archived_at", null)
    .single();
  if (result.error) throw new HttpError(404, "群組不存在或已封存");
  return z
    .object({ id: z.string().uuid(), name: z.string() })
    .parse(result.data);
}

function splitLabel(method: SplitMethod): string {
  return method === "equal"
    ? "平均分帳"
    : method === "exact"
      ? "指定金額"
      : "百分比分帳";
}

export async function confirmAction(
  context: ServerContext,
  actionId: string,
  confirm: boolean,
) {
  const id = z.string().uuid().parse(actionId);
  const result = await context.db.rpc("confirm_pending_action", {
    p_action_id: id,
    p_line_user_id: context.user.line_user_id,
    p_confirm: confirm,
  });
  if (result.error) throw new Error("confirm action failed");
  const value = z
    .object({
      result: z.enum([
        "confirmed",
        "cancelled",
        "expired",
        "stale",
        "not_found",
        "already_done",
      ]),
      action_type: z.string().nullable().optional(),
    })
    .parse(result.data);
  if (value.result === "confirmed") {
    await createBudgetAlerts(context);
    await deliverNotifications(context);
  }
  return value;
}

const groupInputSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("create"),
    name: z.string().trim().min(1).max(40),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  z.object({
    operation: z.literal("rename"),
    groupId: z.string().uuid(),
    name: z.string().trim().min(1).max(40),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  z.object({ operation: z.literal("archive"), groupId: z.string().uuid() }),
  z.object({ operation: z.literal("activate"), groupId: z.string().uuid() }),
]);

export async function changeGroup(context: ServerContext, input: unknown) {
  const parsed = groupInputSchema.parse(input);
  if (parsed.operation === "create") {
    const result = await context.db
      .from("groups")
      .insert({
        couple_id: context.user.couple_id,
        name: parsed.name,
        color: parsed.color,
        created_by_user_id: context.user.id,
      })
      .select("id")
      .single();
    if (result.error) throw new Error("group create failed");
    await context.db
      .from("user_preferences")
      .update({
        active_group_id: result.data.id,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", context.user.id);
    await appendActivity(context, "group", result.data.id, "create", result.data.id, null, { name: parsed.name, color: parsed.color });
    return { groupId: result.data.id };
  }
  const group = await requireGroup(context, parsed.groupId);
  if (parsed.operation === "activate") {
    const result = await context.db
      .from("user_preferences")
      .update({
        active_group_id: group.id,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", context.user.id);
    if (result.error) throw new Error("active group update failed");
  } else if (parsed.operation === "rename") {
    const result = await context.db
      .from("groups")
      .update({
        name: parsed.name,
        color: parsed.color,
        updated_at: new Date().toISOString(),
      })
      .eq("id", group.id);
    if (result.error) throw new Error("group update failed");
    await appendActivity(context, "group", group.id, "update", group.id, group, { ...group, name: parsed.name, color: parsed.color });
  } else {
    const available = await context.db
      .from("groups")
      .select("id")
      .eq("couple_id", context.user.couple_id)
      .is("archived_at", null)
      .neq("id", group.id)
      .order("created_at")
      .limit(1)
      .maybeSingle();
    if (available.error || !available.data)
      throw new HttpError(409, "至少保留一個使用中的群組");
    const archive = await context.db
      .from("groups")
      .update({
        archived_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", group.id);
    if (archive.error) throw new Error("group archive failed");
    await context.db
      .from("user_preferences")
      .update({
        active_group_id: available.data.id,
        updated_at: new Date().toISOString(),
      })
      .eq("active_group_id", group.id);
    await appendActivity(context, "group", group.id, "archive", group.id, group, { ...group, archived: true });
  }
  return { ok: true };
}

const budgetInputSchema = z.object({
  groupId: z.string().uuid(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  category: z.enum(categories).nullable(),
  limitTwd: z.number().int().positive().max(100_000_000),
});

export async function saveBudget(context: ServerContext, input: unknown) {
  const parsed = budgetInputSchema.parse(input);
  await requireGroup(context, parsed.groupId);
  let query = context.db
    .from("budgets")
    .select("id, category, limit_twd")
    .eq("group_id", parsed.groupId)
    .eq("month", `${parsed.month}-01`);
  query = parsed.category
    ? query.eq("category", parsed.category)
    : query.is("category", null);
  const existing = await query.maybeSingle();
  if (existing.error) throw new Error("budget lookup failed");
  const result = existing.data
    ? await context.db
        .from("budgets")
        .update({
          limit_twd: parsed.limitTwd,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.data.id)
        .select("id")
        .single()
    : await context.db
        .from("budgets")
        .insert({
          group_id: parsed.groupId,
          month: `${parsed.month}-01`,
          category: parsed.category,
          limit_twd: parsed.limitTwd,
          created_by_user_id: context.user.id,
        })
        .select("id")
        .single();
  if (result.error) throw new Error("budget save failed");
  const budgetId = String(result.data.id);
  await appendActivity(context, "budget", budgetId, existing.data ? "update" : "create", parsed.groupId, existing.data ?? null, parsed);
  await notifyPartner(context, "budget", "預算已更新", `${parsed.category ? categoryLabel(parsed.category) : "群組總額"} ${parsed.limitTwd} 元`, parsed.groupId, "budget", budgetId);
  await createBudgetAlerts(context);
  await deliverNotifications(context);
  return { ok: true };
}

const recurringInputSchema = expenseInputSchema.extend({
  id: z.string().uuid().nullable().default(null),
  frequency: z.enum(["weekly", "monthly", "yearly"]),
  nextRunDate: z.iso.date(),
  endDate: z.iso.date().nullable().default(null),
  active: z.boolean().default(true),
});

export async function saveRecurring(context: ServerContext, input: unknown) {
  const toggle = z
    .object({
      operation: z.literal("toggle"),
      id: z.string().uuid(),
      active: z.boolean(),
    })
    .safeParse(input);
  if (toggle.success) {
    const before = await context.db.from("recurring_expenses").select("id, group_id, active").eq("id", toggle.data.id).eq("couple_id", context.user.couple_id).single();
    const result = await context.db
      .from("recurring_expenses")
      .update({
        active: toggle.data.active,
        updated_at: new Date().toISOString(),
      })
      .eq("id", toggle.data.id)
      .eq("couple_id", context.user.couple_id);
    if (result.error) throw new Error("recurring update failed");
    await appendActivity(context, "recurring", toggle.data.id, "update", before.data?.group_id ?? null, before.data ?? null, toggle.data);
    await notifyPartner(context, "recurring", "週期支出已更新", toggle.data.active ? "已啟用週期支出" : "已停用週期支出", before.data?.group_id ?? null, "recurring", toggle.data.id);
    await deliverNotifications(context);
    return { ok: true };
  }
  const parsed = recurringInputSchema.parse(input);
  const users = await context.db
    .from("users")
    .select("id, couple_id, line_user_id, role")
    .eq("couple_id", context.user.couple_id);
  if (users.error) throw new Error("users lookup failed");
  const partner = z
    .array(userSchema)
    .parse(users.data)
    .find((user) => user.id !== context.user.id);
  if (!partner) throw new HttpError(409, "請先讓另一半加入");
  const prepared = await prepareExpense(context, parsed, partner);
  const anchorDay = Number(parsed.nextRunDate.slice(8, 10));
  const row = {
    couple_id: context.user.couple_id,
    group_id: prepared.groupId,
    created_by_user_id: context.user.id,
    paid_by_user_id: prepared.payload.paid_by_user_id,
    ledger: parsed.ledger,
    description: parsed.description,
    category: parsed.category,
    amount_twd: parsed.amountTwd,
    split_method: parsed.splitMethod,
    splits: prepared.payload.splits,
    frequency: parsed.frequency,
    anchor_day: anchorDay,
    next_run_date: parsed.nextRunDate,
    end_date: parsed.endDate,
    active: parsed.active,
    updated_at: new Date().toISOString(),
  };
  const result = parsed.id
    ? await context.db
        .from("recurring_expenses")
        .update(row)
        .eq("id", parsed.id)
        .eq("created_by_user_id", context.user.id)
        .select("id")
        .single()
    : await context.db.from("recurring_expenses").insert(row).select("id").single();
  if (result.error) throw new Error("recurring save failed");
  const recurringId = String(result.data.id);
  await appendActivity(context, "recurring", recurringId, parsed.id ? "update" : "create", prepared.groupId, null, row);
  await notifyPartner(context, "recurring", "週期支出已更新", `${parsed.description} NT$${parsed.amountTwd}`, prepared.groupId, "recurring", recurringId);
  await deliverNotifications(context);
  return { ok: true };
}

const uploadInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  mimeType: z.enum([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
  ]),
  sizeBytes: z.number().int().positive().max(RECEIPT_LIMIT),
  groupId: z.string().uuid().nullable(),
});

export async function createReceiptUpload(
  context: ServerContext,
  input: unknown,
) {
  const parsed = uploadInputSchema.parse(input);
  await assertReceiptRate(context.db, context.user.id);
  if (parsed.groupId) await requireGroup(context, parsed.groupId);
  const receiptId = randomUUID();
  const extension =
    parsed.mimeType === "image/jpeg" ? "jpg" : parsed.mimeType.split("/")[1];
  const path = `${context.user.couple_id}/${context.user.id}/${receiptId}.${extension}`;
  const row = await context.db.from("receipts").insert({
    id: receiptId,
    couple_id: context.user.couple_id,
    owner_user_id: context.user.id,
    group_id: parsed.groupId,
    storage_path: path,
    mime_type: parsed.mimeType,
    size_bytes: parsed.sizeBytes,
  });
  if (row.error) throw new Error("receipt create failed");
  const signed = await context.db.storage
    .from("receipts")
    .createSignedUploadUrl(path);
  if (signed.error) throw new Error("receipt upload URL failed");
  return {
    receiptId,
    path,
    token: signed.data.token,
    signedUrl: signed.data.signedUrl,
  };
}

export async function processReceipt(
  context: ServerContext,
  receiptId: string,
) {
  const id = z.string().uuid().parse(receiptId);
  const row = await context.db
    .from("receipts")
    .select("id, owner_user_id, storage_path, size_bytes")
    .eq("id", id)
    .eq("couple_id", context.user.couple_id)
    .eq("owner_user_id", context.user.id)
    .single();
  if (row.error) throw new HttpError(404, "找不到收據");
  await context.db
    .from("receipts")
    .update({
      status: "processing",
      failure_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  try {
    const file = await context.db.storage
      .from("receipts")
      .download(row.data.storage_path);
    if (file.error) throw new Error("download failed");
    const bytes = new Uint8Array(await file.data.arrayBuffer());
    if (bytes.length > RECEIPT_LIMIT || bytes.length !== row.data.size_bytes)
      throw new HttpError(400, "收據大小不符");
    const mimeType = detectReceiptMime(bytes);
    if (!mimeType) throw new HttpError(400, "收據格式不正確");
    const gemini = new GoogleGenAI({ apiKey: context.env.GEMINI_API_KEY });
    const response = await gemini.models.generateContent({
      model: MODEL,
      contents: [
        {
          inlineData: { mimeType, data: Buffer.from(bytes).toString("base64") },
        },
        {
          text: "辨識這張台灣收據。只抽取商家名稱、消費日期、應付總額（TWD 整數）與整體信心值；看不清楚的欄位用 null。",
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: geminiReceiptJsonSchema,
        temperature: 0,
        maxOutputTokens: 200,
      },
    });
    const extraction = receiptExtractionSchema.parse(
      JSON.parse(response.text ?? "{}"),
    );
    const update = await context.db
      .from("receipts")
      .update({
        status: "ready",
        mime_type: mimeType,
        extraction,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (update.error) throw new Error("receipt update failed");
    return extraction;
  } catch (error) {
    await context.db
      .from("receipts")
      .update({
        status: "failed",
        failure_reason:
          error instanceof Error ? error.message.slice(0, 200) : "OCR failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    throw error;
  }
}

export async function receiptUrl(context: ServerContext, receiptId: string) {
  const row = await context.db
    .from("receipts")
    .select("storage_path, owner_user_id, group_id, expense_id")
    .eq("id", z.string().uuid().parse(receiptId))
    .eq("couple_id", context.user.couple_id)
    .is("deleted_at", null)
    .single();
  if (row.error) throw new HttpError(404, "找不到收據");
  if (!row.data.group_id && row.data.owner_user_id !== context.user.id)
    throw new HttpError(403, "無權查看私人收據");
  const signed = await context.db.storage
    .from("receipts")
    .createSignedUrl(row.data.storage_path, 300);
  if (signed.error) throw new Error("receipt URL failed");
  return signed.data.signedUrl;
}

export async function receiptDetails(
  context: ServerContext,
  receiptId: string,
) {
  const result = await context.db
    .from("receipts")
    .select("id, owner_user_id, status, extraction")
    .eq("id", z.string().uuid().parse(receiptId))
    .eq("couple_id", context.user.couple_id)
    .is("deleted_at", null)
    .single();
  if (result.error || result.data.owner_user_id !== context.user.id)
    throw new HttpError(404, "找不到待確認收據");
  return z
    .object({
      id: z.string().uuid(),
      status: z.enum(["uploaded", "processing", "ready", "failed"]),
      extraction: receiptExtractionSchema.nullable(),
    })
    .parse(result.data);
}

export async function processLineReceipt(
  lineClient: Pick<LineBotClient, "getMessageContent">,
  input: { messageId: string; eventId: string; lineUserId: string },
) {
  const env = serverEnvironment();
  const db = serverDatabase(env);
  const userResult = await db
    .from("users")
    .select("id, couple_id, line_user_id, role")
    .eq("line_user_id", input.lineUserId)
    .maybeSingle();
  const user = userSchema.nullable().parse(userResult.data);
  if (userResult.error || !user) return;
  const existing = await db
    .from("receipts")
    .select("id")
    .eq("source_event_id", input.eventId)
    .maybeSingle();
  if (existing.data) return;
  await assertReceiptRate(db, user.id);
  const preference = await db
    .from("user_preferences")
    .select("active_group_id")
    .eq("user_id", user.id)
    .single();
  if (preference.error) throw new Error("active group lookup failed");

  const content = await lineClient.getMessageContent(input.messageId);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of content) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > RECEIPT_LIMIT) throw new HttpError(413, "收據不可超過 10 MB");
    chunks.push(buffer);
  }
  const bytes = Buffer.concat(chunks);
  const mimeType = detectReceiptMime(bytes);
  if (!mimeType) throw new HttpError(400, "收據格式不正確");
  const receiptId = randomUUID();
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1];
  const path = `${user.couple_id}/${user.id}/${receiptId}.${extension}`;
  const receipt = await db.from("receipts").insert({
    id: receiptId,
    couple_id: user.couple_id,
    owner_user_id: user.id,
    group_id: preference.data.active_group_id,
    storage_path: path,
    mime_type: mimeType,
    size_bytes: size,
    source_event_id: input.eventId,
    status: "uploaded",
  });
  if (receipt.error) throw new Error("receipt create failed");
  const upload = await db.storage
    .from("receipts")
    .upload(path, bytes, { contentType: mimeType, upsert: false });
  if (upload.error) {
    await db
      .from("receipts")
      .update({ status: "failed", failure_reason: "upload failed" })
      .eq("id", receiptId);
    throw new Error("receipt upload failed");
  }
  const context = { env, db, user } satisfies ServerContext;
  try {
    const extraction = await processReceipt(context, receiptId);
    await db.from("notifications").upsert(
      {
        recipient_user_id: user.id,
        group_id: preference.data.active_group_id,
        kind: "receipt",
        title: "收據辨識完成",
        body: `${extraction.merchant ?? "未知商家"} ${extraction.amountTwd ? `NT$${extraction.amountTwd}` : "金額待確認"}\n${env.APP_URL}/?receipt=${receiptId}`,
        entity_type: "receipt",
        entity_id: receiptId,
        dedupe_key: `receipt:${receiptId}`,
      },
      { onConflict: "dedupe_key", ignoreDuplicates: true },
    );
  } catch {
    await db.from("notifications").upsert(
      {
        recipient_user_id: user.id,
        group_id: preference.data.active_group_id,
        kind: "receipt",
        title: "收據辨識失敗",
        body: `請到圖形化帳本重新上傳。${env.APP_URL}`,
        entity_type: "receipt",
        entity_id: receiptId,
        dedupe_key: `receipt:${receiptId}:failed`,
      },
      { onConflict: "dedupe_key", ignoreDuplicates: true },
    );
  }
  await deliverNotifications(context);
}

export async function markNotificationsRead(context: ServerContext) {
  const result = await context.db
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("recipient_user_id", context.user.id)
    .is("read_at", null);
  if (result.error) throw new Error("notification update failed");
  return { ok: true };
}

async function createBudgetAlerts(context: ServerContext) {
  const month = taipeiToday().slice(0, 7);
  const preferences = await context.db
    .from("user_preferences")
    .select("active_group_id")
    .eq("user_id", context.user.id)
    .single();
  if (preferences.error) return;
  const groupId = preferences.data.active_group_id as string;
  const [budgets, expenses, users] = await Promise.all([
    context.db
      .from("budgets")
      .select("id, category, limit_twd")
      .eq("group_id", groupId)
      .eq("month", `${month}-01`),
    context.db
      .from("expenses")
      .select("category, amount_twd")
      .eq("group_id", groupId)
      .is("deleted_at", null)
      .gte("expense_date", `${month}-01`)
      .lt("expense_date", shiftMonth(month, 1) + "-01"),
    context.db
      .from("users")
      .select("id")
      .eq("couple_id", context.user.couple_id),
  ]);
  if (budgets.error || expenses.error || users.error) return;
  for (const budget of budgets.data ?? []) {
    const spent = (expenses.data ?? [])
      .filter(
        (expense) => !budget.category || expense.category === budget.category,
      )
      .reduce((sum, expense) => sum + Number(expense.amount_twd), 0);
    for (const threshold of [80, 100]) {
      if (spent * 100 < Number(budget.limit_twd) * threshold) continue;
      for (const user of users.data ?? []) {
        await context.db.from("notifications").upsert(
          {
            recipient_user_id: user.id,
            group_id: groupId,
            kind: "budget",
            title: threshold === 100 ? "預算已超過" : "預算接近上限",
            body: `${budget.category ?? "本月總額"}已使用 ${Math.floor((spent / Number(budget.limit_twd)) * 100)}%`,
            entity_type: "budget",
            entity_id: String(budget.id),
            dedupe_key: `budget:${budget.id}:${threshold}:user:${user.id}`,
          },
          { onConflict: "dedupe_key", ignoreDuplicates: true },
        );
      }
    }
  }
}

export async function deliverNotifications(context: ServerContext) {
  const pending = await context.db
    .from("notifications")
    .select(
      "id, recipient_user_id, title, body, users!notifications_recipient_user_id_fkey(line_user_id)",
    )
    .eq("line_status", "pending")
    .order("created_at")
    .limit(20);
  if (pending.error || !pending.data?.length) return;
  let canPush = false;
  try {
    const headers = {
      authorization: `Bearer ${context.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    };
    const [quotaResponse, usageResponse] = await Promise.all([
      fetch("https://api.line.me/v2/bot/message/quota", {
        headers,
        cache: "no-store",
      }),
      fetch("https://api.line.me/v2/bot/message/quota/consumption", {
        headers,
        cache: "no-store",
      }),
    ]);
    const quota = z
      .object({
        type: z.enum(["none", "limited"]),
        value: z.number().optional(),
      })
      .parse(await quotaResponse.json());
    const usage = z
      .object({ totalUsage: z.number() })
      .parse(await usageResponse.json());
    canPush =
      quota.type === "none" ||
      (quota.value !== undefined && usage.totalUsage / quota.value < 0.9);
  } catch {
    canPush = false;
  }
  for (const notification of pending.data) {
    const userRelation = notification.users as unknown;
    const lineUserId = z
      .union([
        z.object({ line_user_id: z.string() }),
        z
          .array(z.object({ line_user_id: z.string() }))
          .transform((rows) => rows[0]),
      ])
      .parse(userRelation)?.line_user_id;
    let status = "skipped";
    if (canPush && lineUserId) {
      const response = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          authorization: `Bearer ${context.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          to: lineUserId,
          messages: [
            {
              type: "text",
              text: `${notification.title}\n${notification.body}\n${context.env.APP_URL}`,
            },
          ],
        }),
      });
      status = response.ok ? "sent" : "failed";
    }
    await context.db
      .from("notifications")
      .update({ line_status: status })
      .eq("id", notification.id);
  }
}

export async function runDailyJobs(request: Request) {
  const env = serverEnvironment();
  if (request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`)
    throw new HttpError(401, "Unauthorized");
  const db = serverDatabase(env);
  const today = taipeiToday();
  const due = await db
    .from("recurring_expenses")
    .select("*")
    .eq("active", true)
    .lte("next_run_date", today);
  if (due.error) throw new Error("recurring lookup failed");
  let drafts = 0;
  for (const row of due.data ?? []) {
    const source = `recurring:${row.id}:${row.next_run_date}`;
    const action = await db.from("pending_actions").upsert(
      {
        couple_id: row.couple_id,
        group_id: row.group_id,
        requested_by_user_id: row.created_by_user_id,
        action_type: "create_expense",
        payload: {
          group_id: row.group_id,
          ledger: row.ledger,
          description: row.description,
          amount_twd: Number(row.amount_twd),
          paid_by_user_id: row.paid_by_user_id,
          expense_date: row.next_run_date,
          category: row.category,
          split_method: row.split_method,
          splits: row.splits,
        },
        source_event_id: source,
        idempotency_key: source,
        expires_at: new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1_000,
        ).toISOString(),
      },
      { onConflict: "source_event_id", ignoreDuplicates: true },
    );
    if (!action.error) drafts += 1;
    const next = nextRecurringDate(
      row.next_run_date,
      row.frequency as RecurringFrequency,
      row.anchor_day,
    );
    await db
      .from("recurring_expenses")
      .update({
        next_run_date: next,
        active: !row.end_date || next <= row.end_date,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    await db.from("notifications").upsert(
      {
        recipient_user_id: row.created_by_user_id,
        group_id: row.group_id,
        kind: "recurring",
        title: "週期支出待確認",
        body: `${row.description} NT$${row.amount_twd}`,
        entity_type: "recurring",
        entity_id: row.id,
        dedupe_key: source,
      },
      { onConflict: "dedupe_key", ignoreDuplicates: true },
    );
  }
  const expiredReceipts = await db
    .from("receipts")
    .select("id, storage_path")
    .lt(
      "deleted_at",
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString(),
    );
  if (!expiredReceipts.error && expiredReceipts.data?.length) {
    await db.storage
      .from("receipts")
      .remove(expiredReceipts.data.map((row) => row.storage_path));
    await db
      .from("receipts")
      .delete()
      .in(
        "id",
        expiredReceipts.data.map((row) => row.id),
      );
  }
  return { drafts, purgedReceipts: expiredReceipts.data?.length ?? 0 };
}

export function expensesCsv(
  expenses: AppExpense[],
  users: Array<{ id: string; label: string }>,
): string {
  const rows = [
    [
      "日期",
      "帳本",
      "說明",
      "商家",
      "分類",
      "金額",
      "付款人",
      "分帳方式",
      "狀態",
    ],
  ];
  for (const expense of expenses)
    rows.push([
      expense.expense_date,
      expense.ledger === "shared" ? "共同" : "私人",
      expense.description,
      expense.merchant ?? "",
      expense.category,
      String(expense.amount_twd),
      users.find((user) => user.id === expense.paid_by_user_id)?.label ?? "",
      splitLabel(expense.split_method),
      expense.deleted_at ? "已刪除" : "有效",
    ]);
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

async function assertReceiptRate(db: SupabaseClient, userId: string) {
  const result = await db
    .from("receipts")
    .select("id", { count: "exact", head: true })
    .eq("owner_user_id", userId)
    .gte("created_at", new Date(Date.now() - 10 * 60 * 1_000).toISOString());
  if (result.error) throw new Error("receipt rate lookup failed");
  if ((result.count ?? 0) >= 10)
    throw new HttpError(429, "收據上傳太頻繁，請稍後再試");
}

async function appendActivity(
  context: ServerContext,
  entityType: "group" | "budget" | "recurring",
  entityId: string,
  action: "create" | "update" | "archive",
  groupId: string | null,
  beforeState: unknown,
  afterState: unknown,
) {
  const result = await context.db.from("activity_events").insert({
    couple_id: context.user.couple_id,
    group_id: groupId,
    actor_user_id: context.user.id,
    entity_type: entityType,
    entity_id: entityId,
    action,
    before_state: beforeState,
    after_state: afterState,
  });
  if (result.error) throw new Error("activity insert failed");
}

async function notifyPartner(
  context: ServerContext,
  kind: "budget" | "recurring",
  title: string,
  body: string,
  groupId: string | null,
  entityType: string,
  entityId: string,
) {
  const users = await context.db.from("users").select("id").eq("couple_id", context.user.couple_id).neq("id", context.user.id);
  if (users.error) throw new Error("partner lookup failed");
  for (const user of users.data ?? []) {
    await context.db.from("notifications").insert({
      recipient_user_id: user.id,
      group_id: groupId,
      kind,
      title,
      body,
      entity_type: entityType,
      entity_id: entityId,
      dedupe_key: `${kind}:${entityId}:${randomUUID()}:user:${user.id}`,
    });
  }
}

function categoryLabel(category: (typeof categories)[number]) {
  return ({
    food: "餐飲", transport: "交通", groceries: "生鮮", household: "居家",
    entertainment: "娛樂", shopping: "購物", medical: "醫療", travel: "旅行", other: "其他",
  } as const)[category];
}

function taipeiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function shiftMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year!, monthNumber! - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
