import { randomUUID } from "node:crypto";

import { GoogleGenAI } from "@google/genai";
import type { LineBotClient, messagingApi } from "@line/bot-sdk";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  accountantLlmReportSchema,
  accountantReportFromLlm,
  buildAccountantSnapshot,
  fallbackAccountantReport,
  geminiAccountantJsonSchema,
  type AccountantExpense,
  type AccountantReport,
} from "./accountant";
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
  agentRangeLabel,
  aggregateAgentExpenses,
  batchCategoryUpdateSchema,
  detectDuplicateAgentExpenses,
  filterAgentExpenses,
  parseAgentRequest,
  rankCategoryLabels,
  safeBatchCategoryUpdates,
  suggestCategoryCleanup,
  type AgentExpense,
  type AgentScope,
  type AgentTimeRange,
} from "./ledger-agent";
import {
  classifyExpenseCategory,
  isLegacyCategoryLabel,
  splitBootstrapExpenses,
  type CategoryClassificationInput,
} from "./category-agent";
import {
  detectReceiptMime,
  safeSecretEqual,
  signSession,
  verifySession,
} from "./security";
import {
  executeTool,
  toolDeclarations,
  type ToolContext,
} from "./accountant-tools";

export const SESSION_COOKIE = "couple_ledger_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const ACTION_SECONDS = 60 * 5;
const RECEIPT_LIMIT = 10 * 1024 * 1024;
const MODEL = "gemini-3.1-flash-lite";
const AGENT_MODEL = "gemini-2.0-flash";
const SESSION_EXPIRE_MS = 2 * 60 * 60 * 1_000;
const EXPENSE_SELECT =
  "id, group_id, ledger, description, merchant, notes, category, category_label, mirror_kind, mirror_source_expense_id, amount_twd, paid_by_user_id, created_by_user_id, expense_date, split_method, version, deleted_at, created_at, expense_splits(user_id, amount_twd), receipts(id, status)";

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
  category_label: z.string(),
  mirror_kind: z.enum(["shared_share"]).nullable().default(null),
  mirror_source_expense_id: z.string().uuid().nullable().default(null),
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
const accountantReportRowSchema = z.object({
  id: z.string().uuid(),
  group_id: z.string().uuid().nullable(),
  owner_user_id: z.string().uuid().nullable(),
  report_type: z.enum(["manual_question", "monthly_health", "cleanup_review"]),
  scope: z.enum(["shared", "private", "combined"]),
  month: z.string(),
  question: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  facts: z.unknown(),
  findings: z.unknown(),
  suggestions: z.unknown(),
  source: z.enum(["llm", "fallback"]),
  created_at: z.string(),
});
const agentLlmAnswerSchema = z
  .object({
    answer: z.string().trim().min(1).max(1_800),
    facts: z
      .object({
        totalTwd: z.number().int().min(0),
        transactionCount: z.number().int().min(0),
        topCategoryLabel: z.string().trim().min(1).max(40).nullable(),
        topCategoryTotalTwd: z.number().int().min(0).nullable(),
      })
      .strict(),
  })
  .strict();
const geminiAgentAnswerJsonSchema = Object.fromEntries(
  Object.entries(z.toJSONSchema(agentLlmAnswerSchema)).filter(
    ([key]) => key !== "$schema",
  ),
);

export type AppUser = z.infer<typeof userSchema>;
export type AppExpense = z.infer<typeof expenseSchema>;
export type AppAccountantReport = z.infer<typeof accountantReportRowSchema>;

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
      .select(EXPENSE_SELECT)
      .eq("group_id", activeGroupId)
      .gte("expense_date", `${sixMonthsAgo}-01`)
      .order("expense_date", { ascending: false })
      .limit(300),
    db
      .from("expenses")
      .select(EXPENSE_SELECT)
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
  const { sharedExpenses, privateExpenses } = splitBootstrapExpenses(
    expenses,
    activeGroupId,
    user.id,
  );
  const activeShared = sharedExpenses.filter((expense) => !expense.deleted_at);
  const activePrivate = privateExpenses.filter((expense) => !expense.deleted_at);
  const balances = z
    .array(
      z.object({
        user_id: z.string().uuid(),
        balance_twd: z.coerce.number().int(),
      }),
    )
    .parse(balancesResult.data);
  const projection = buildProjection(
    activeShared,
    month,
    taipeiToday(),
    budgetsResult.data ?? [],
  );
  return {
    today: taipeiToday(),
    month,
    user: publicUser(user, user.id),
    users: users.map((item) => publicUser(item, user.id)),
    groups,
    activeGroupId,
    expenses,
    sharedExpenses,
    privateExpenses,
    balances,
    budgets: budgetsResult.data,
    recurring: recurringResult.data,
    notifications: notificationsResult.data,
    dashboard: buildDashboard(activeShared, month),
    privateDashboard: buildDashboard(activePrivate, month),
    projection,
  };
}

function buildDashboard(expenses: AppExpense[], month: string) {
  const trend = Array.from({ length: 6 }, (_, index) => ({
    month: shiftMonth(month, index - 5),
    totalTwd: 0,
  }));
  for (const expense of expenses) {
    const expenseMonth = expense.expense_date.slice(0, 7);
    const point = trend.find((item) => item.month === expenseMonth);
    if (point) point.totalTwd += expense.amount_twd;
  }
  const thisMonth = expenses.filter((expense) =>
    expense.expense_date.startsWith(month),
  );
  const categoryTotals = Object.fromEntries(
    rankCategoryLabels(thisMonth).map((item) => [item.label, item.totalTwd]),
  );
  return {
    monthlyTotalTwd: thisMonth.reduce((sum, expense) => sum + expense.amount_twd, 0),
    monthlyCount: thisMonth.length,
    categoryTotals,
    trend,
    recent: expenses.slice(0, 8),
  };
}

function publicUser(user: AppUser, requesterId: string) {
  return {
    id: user.id,
    role: user.role,
    label: user.id === requesterId ? "你" : "另一半",
  };
}

const accountantAskInputSchema = z.object({
  question: z.string().trim().min(1).max(500),
  scope: z.enum(["shared", "private", "combined"]).default("combined"),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});
const agentRunInputSchema = z.object({
  message: z.string().trim().min(1).max(500),
  scope: z.enum(["shared", "private", "combined"]).optional(),
});
const categoryAnalyticsInputSchema = z.object({
  range: z
    .enum(["this_month", "six_months", "all"])
    .catch("this_month"),
  scope: z.enum(["shared", "private", "combined"]).catch("shared"),
});
const categoryCleanupInputSchema = z.object({
  updates: z.array(batchCategoryUpdateSchema).min(1).max(50),
});

export async function askAccountant(context: ServerContext, input: unknown) {
  const parsed = accountantAskInputSchema.parse(input);
  const run = await runAgent(context, {
    message: parsed.question,
    scope: parsed.scope,
  });
  return run.report;
}

export async function runAgent(context: ServerContext, input: unknown) {
  const parsed = agentRunInputSchema.parse(input);
  const request = parseAgentRequest(`會計師 ${parsed.message}`)!;
  const scope = parsed.scope ?? request.scope;
  const groupId = await activeGroupId(context);
  const allExpenses = await loadAgentExpenses(context, groupId);
  const expenses = filterAgentExpenses({
    activeGroupId: groupId,
    expenses: allExpenses,
    now: taipeiToday(),
    scope,
    timeRange: request.timeRange,
    userId: context.user.id,
  });
  const aggregate = aggregateAgentExpenses(expenses);
  const categories = rankCategoryLabels(expenses);
  const duplicates = detectDuplicateAgentExpenses(expenses);
  const cleanupUpdates = safeBatchCategoryUpdates(
    suggestCategoryCleanup(expenses),
    allExpenses,
    { activeGroupId: groupId, userId: context.user.id },
  ).slice(0, 20);
  const toolCalls: Array<Record<string, unknown>> = [
    {
      tool: "search_expenses",
      args: { scope, timeRange: request.timeRange },
      count: expenses.length,
    },
    { tool: "aggregate_expenses", result: aggregate },
    { tool: "rank_categories", result: categories.slice(0, 8) },
    {
      tool: "detect_duplicates",
      count: duplicates.length,
      result: duplicates.slice(0, 5).map((items) =>
        items.map((expense) => ({
          id: expense.id,
          description: expense.description,
          amountTwd: expense.amount_twd,
          date: expense.expense_date,
          version: expense.version,
        })),
      ),
    },
  ];
  if (cleanupUpdates.length) {
    toolCalls.push({
      tool: "suggest_category_cleanup",
      count: cleanupUpdates.length,
      result: cleanupUpdates,
    });
  }
  const fallbackAnswer = buildAgentAnswer({
    message: request.message,
    scope,
    timeRange: request.timeRange,
    aggregate,
    categories,
    duplicateCount: duplicates.length,
    cleanupCount: cleanupUpdates.length,
  });
  const answered = await answerWithGemini(
    context,
    {
      message: request.message,
      scope,
      timeRange: request.timeRange,
      aggregate,
      categories,
      duplicateCount: duplicates.length,
      cleanupCount: cleanupUpdates.length,
    },
    fallbackAnswer,
  );
  const answer = answered.answer;
  const suggestions = cleanupUpdates.length
    ? [
        {
          title: "整理其他分類",
          body: `找到 ${cleanupUpdates.length} 筆可以整理的分類，確認後才會批次更新。`,
          actionInput: {
            type: "batch_update_expenses",
            updates: cleanupUpdates,
          },
        },
      ]
    : [];
  const ownerUserId = scope === "shared" ? null : context.user.id;
  const reportGroupId = scope === "private" ? null : groupId;
  const savedReport = await context.db
    .from("accountant_reports")
    .insert({
      couple_id: context.user.couple_id,
      group_id: reportGroupId,
      owner_user_id: ownerUserId,
      report_type: "manual_question",
      scope,
      month: `${taipeiToday().slice(0, 7)}-01`,
      question: request.message,
      title: `AI 會計師 · ${agentRangeLabel(request.timeRange)}`,
      summary: answer,
      facts: {
        ...aggregate,
        scope,
        timeRange: request.timeRange,
        topCategoryLabel: categories[0]?.label ?? null,
        otherLabelTotalTwd:
          categories.find((item) => item.label === "其他" || item.label === "other")
            ?.totalTwd ?? 0,
      },
      findings: buildAgentFindings(categories, duplicates.length),
      suggestions,
      source: answered.source,
      dedupe_key: `agent:${randomUUID()}`,
    })
    .select(accountantReportSelect())
    .single();
  if (savedReport.error) throw new Error("agent report save failed");
  const report = accountantReportRowSchema.parse(savedReport.data);
  const run = await context.db
    .from("agent_runs")
    .insert({
      couple_id: context.user.couple_id,
      user_id: context.user.id,
      group_id: reportGroupId,
      report_id: report.id,
      scope,
      time_range: request.timeRange,
      message: request.message,
      answer,
      tool_calls: toolCalls,
      suggestions,
    })
    .select("id")
    .single();
  if (run.error) throw new Error("agent run save failed");
  return {
    answer,
    reportId: report.id,
    toolCalls,
    suggestions,
    report,
  };
}

export async function categoryAnalytics(
  context: ServerContext,
  params: URLSearchParams,
) {
  const parsed = categoryAnalyticsInputSchema.parse({
    range: params.get("range") ?? undefined,
    scope: params.get("scope") ?? undefined,
  });
  const groupId = await activeGroupId(context);
  const allExpenses = await loadAgentExpenses(context, groupId);
  const timeRange: AgentTimeRange =
    parsed.range === "six_months" ? "last_3_months" : parsed.range;
  const expenses = filterAgentExpenses({
    activeGroupId: groupId,
    expenses: allExpenses,
    now: taipeiToday(),
    scope: parsed.scope,
    timeRange: parsed.range === "six_months" ? "all" : timeRange,
    userId: context.user.id,
  }).filter((expense) =>
    parsed.range === "six_months"
      ? expense.expense_date >= `${shiftMonth(taipeiToday().slice(0, 7), -5)}-01`
      : true,
  );
  const categories = rankCategoryLabels(expenses);
  const totalTwd = categories.reduce((total, item) => total + item.totalTwd, 0);
  return {
    range: parsed.range,
    scope: parsed.scope,
    totalTwd,
    count: expenses.length,
    categories: categories.map((item) => ({
      ...item,
      percent: totalTwd ? Math.round((item.totalTwd / totalTwd) * 100) : 0,
    })),
  };
}

export async function suggestCategoryUpdates(context: ServerContext, input: unknown) {
  const parsed = categoryAnalyticsInputSchema.parse(input);
  const groupId = await activeGroupId(context);
  const group = await requireGroup(context, groupId);
  const allExpenses = await loadAgentExpenses(context, groupId);
  const expenses = filterAgentExpenses({
    activeGroupId: groupId,
    expenses: allExpenses,
    now: taipeiToday(),
    scope: parsed.scope === "combined" ? "shared" : parsed.scope,
    timeRange: parsed.range === "all" ? "all" : parsed.range === "six_months" ? "all" : "this_month",
    userId: context.user.id,
  }).filter((expense) =>
    parsed.range === "six_months"
      ? expense.expense_date >= `${shiftMonth(taipeiToday().slice(0, 7), -5)}-01`
      : true,
  );
  const history = expenses
    .filter((expense) => !isLegacyCategoryLabel(expense.category_label))
    .map((expense) => ({
      category: expense.category,
      categoryLabel: expense.category_label,
      description: expense.description,
      merchant: expense.merchant,
    }));
  const gemini = new GoogleGenAI({ apiKey: context.env.GEMINI_API_KEY });
  const rawUpdates = [];
  for (const expense of expenses.slice(0, 50)) {
    if (
      expense.category_label !== "其他" &&
      expense.category_label !== "other" &&
      !isLegacyCategoryLabel(expense.category_label)
    )
      continue;
    const classified = await classifyExpenseCategory(
      {
        description: expense.description,
        merchant: expense.merchant,
        groupName: expense.ledger === "shared" ? group.name : "私人帳",
        fallbackCategory: expense.category,
        history,
      },
      gemini,
    );
    if (classified.categoryLabel === "其他" || classified.categoryLabel === "other")
      continue;
    rawUpdates.push({
      expenseId: expense.id,
      expectedVersion: expense.version,
      categoryLabel: classified.categoryLabel,
    });
  }
  const updates = safeBatchCategoryUpdates(rawUpdates, allExpenses, {
    activeGroupId: groupId,
    userId: context.user.id,
  });
  return { updates };
}

export async function createCategoryCleanup(
  context: ServerContext,
  input: unknown,
  idempotencyKey?: string,
) {
  const parsed = categoryCleanupInputSchema.parse(input);
  const groupId = await activeGroupId(context);
  const expenses = await loadAgentExpenses(context, groupId);
  const updates = safeBatchCategoryUpdates(parsed.updates, expenses, {
    activeGroupId: groupId,
    userId: context.user.id,
  });
  if (!updates.length) throw new HttpError(400, "沒有可套用的分類整理");
  const payloadUpdates = updates.map((update) => ({
    expense_id: update.expenseId,
    expected_version: update.expectedVersion,
    category_label: update.categoryLabel,
  }));
  const insert = await context.db
    .from("pending_actions")
    .insert({
      couple_id: context.user.couple_id,
      group_id: groupId,
      requested_by_user_id: context.user.id,
      action_type: "batch_update_expenses",
      payload: { updates: payloadUpdates },
      source_event_id: `liff:category:${randomUUID()}`,
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
      if (!existing.error)
        return {
          actionId: existing.data.id,
          preview: `套用 ${updates.length} 筆分類整理`,
        };
    }
    throw new Error("category cleanup insert failed");
  }
  return {
    actionId: z.object({ id: z.string().uuid() }).parse(insert.data).id,
    preview: `套用 ${updates.length} 筆分類整理`,
  };
}

export async function listAccountantReports(context: ServerContext) {
  const groupId = await activeGroupId(context);
  const [shared, own] = await Promise.all([
    context.db
      .from("accountant_reports")
      .select(accountantReportSelect())
      .eq("couple_id", context.user.couple_id)
      .eq("group_id", groupId)
      .is("owner_user_id", null)
      .order("created_at", { ascending: false })
      .limit(20),
    context.db
      .from("accountant_reports")
      .select(accountantReportSelect())
      .eq("couple_id", context.user.couple_id)
      .eq("owner_user_id", context.user.id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  if (shared.error || own.error) throw new Error("accountant reports lookup failed");
  return z
    .array(accountantReportRowSchema)
    .parse([...(shared.data ?? []), ...(own.data ?? [])])
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, 30);
}

export async function generateAccountantReport(
  context: ServerContext,
  input: {
    question: string;
    scope: "shared" | "private" | "combined";
    month: string;
    reportType: "manual_question" | "monthly_health" | "cleanup_review";
    groupId?: string;
  },
  gemini = new GoogleGenAI({ apiKey: context.env.GEMINI_API_KEY }),
) {
  const snapshot = await loadAccountantSnapshot(
    context,
    input.scope,
    input.month,
    input.groupId,
  );
  let report: AccountantReport = fallbackAccountantReport(
    snapshot,
    input.question,
    input.reportType,
  );
  try {
    const response = await gemini.models.generateContent({
      model: MODEL,
      contents: JSON.stringify(accountantPrompt(input.question, snapshot)),
      config: {
        systemInstruction:
          "你是台灣情侶帳本的會計師。只能根據提供的 snapshot 分析。facts 必須逐字等於 snapshot.facts；不能自行改金額、改權限或假設不存在的帳務。可給建議，但所有改帳都只是待確認草稿。你只能根據提供的 snapshot 資料中出現的 merchant 或 description 進行字面推論，絕對禁止憑空捏造 snapshot 中沒有明確指出的具體事件、活動或情境（例如捏造出去某個商圈逛街、參加某種生日聚會、出遊等）。如果資料中沒有明確的商家或備註，僅能說明『主要來自大額支出』，不得虛構原因！",
        responseMimeType: "application/json",
        responseJsonSchema: geminiAccountantJsonSchema,
        temperature: 0.2,
        maxOutputTokens: 1_400,
      },
    });
    report = accountantReportFromLlm(
      accountantLlmReportSchema.parse(JSON.parse(response.text ?? "{}")),
      snapshot,
    );
  } catch {
    report = fallbackAccountantReport(snapshot, input.question, input.reportType);
  }

  const ownerUserId = input.scope === "shared" ? null : context.user.id;
  const groupId = input.scope === "private" ? null : snapshot.activeGroupId;
  const dedupeKey =
    input.reportType === "monthly_health"
      ? `accountant:${context.user.couple_id}:${groupId ?? ownerUserId}:${input.scope}:${input.month}`
      : `accountant:manual:${randomUUID()}`;
  const saved = await context.db
    .from("accountant_reports")
    .upsert(
      {
        couple_id: context.user.couple_id,
        group_id: groupId,
        owner_user_id: ownerUserId,
        report_type: report.reportType,
        scope: report.scope,
        month: `${input.month}-01`,
        question: input.question,
        title: report.title,
        summary: report.summary,
        facts: report.facts,
        findings: report.findings,
        suggestions: report.suggestions,
        source: report.source,
        dedupe_key: dedupeKey,
      },
      { onConflict: "dedupe_key" },
    )
    .select(accountantReportSelect())
    .single();
  if (saved.error) throw new Error("accountant report save failed");
  return accountantReportRowSchema.parse(saved.data);
}

async function loadAccountantSnapshot(
  context: ServerContext,
  scope: "shared" | "private" | "combined",
  month: string,
  groupIdOverride?: string,
) {
  const groupId = groupIdOverride ?? (await activeGroupId(context));
  const start = `${month}-01`;
  const end = `${shiftMonth(month, 1)}-01`;
  const startPrev = `${shiftMonth(month, -1)}-01`;
  const endPrev = `${month}-01`;

  const queries = [];
  if (scope !== "private") {
    queries.push(
      context.db
        .from("expenses")
        .select(EXPENSE_SELECT)
        .eq("group_id", groupId)
        .gte("expense_date", start)
        .lt("expense_date", end)
        .order("expense_date", { ascending: false }),
    );
  }
  if (scope !== "shared") {
    queries.push(
      context.db
        .from("expenses")
        .select(EXPENSE_SELECT)
        .eq("ledger", "private")
        .eq("created_by_user_id", context.user.id)
        .gte("expense_date", start)
        .lt("expense_date", end)
        .order("expense_date", { ascending: false }),
    );
  }

  const prevSharedQuery = scope !== "private"
    ? context.db
        .from("expenses")
        .select("amount_twd")
        .eq("group_id", groupId)
        .is("deleted_at", null)
        .gte("expense_date", startPrev)
        .lt("expense_date", endPrev)
    : Promise.resolve({ data: [] as { amount_twd: number }[], error: null });

  const prevPrivateQuery = scope !== "shared"
    ? context.db
        .from("expenses")
        .select("amount_twd")
        .eq("ledger", "private")
        .eq("created_by_user_id", context.user.id)
        .is("deleted_at", null)
        .gte("expense_date", startPrev)
        .lt("expense_date", endPrev)
    : Promise.resolve({ data: [] as { amount_twd: number }[], error: null });

  const [balances, budgets, prevSharedRes, prevPrivateRes, ...expenseResults] = await Promise.all([
    context.db.rpc("group_balances", { p_group_id: groupId }),
    context.db
      .from("budgets")
      .select("category, limit_twd")
      .eq("group_id", groupId)
      .eq("month", start),
    prevSharedQuery,
    prevPrivateQuery,
    ...queries,
  ]);
  if (
    balances.error ||
    budgets.error ||
    prevSharedRes.error ||
    prevPrivateRes.error ||
    expenseResults.some((result) => result.error)
  )
    throw new Error("accountant snapshot lookup failed");

  const prevSharedTotal = prevSharedRes.data?.reduce((sum, e) => sum + e.amount_twd, 0) ?? 0;
  const prevPrivateTotal = prevPrivateRes.data?.reduce((sum, e) => sum + e.amount_twd, 0) ?? 0;
  const previousMonthTotalTwd = prevSharedTotal + prevPrivateTotal;

  const expenses = z
    .array(expenseSchema)
    .parse(expenseResults.flatMap((result) => result.data ?? []))
    .map(toAccountantExpense);
  return buildAccountantSnapshot({
    activeGroupId: groupId,
    balances: z
      .array(z.object({ user_id: z.string().uuid(), balance_twd: z.coerce.number().int() }))
      .parse(balances.data),
    budgets: z
      .array(z.object({ category: z.enum(categories).nullable(), limit_twd: z.coerce.number().int() }))
      .parse(budgets.data),
    expenses,
    month,
    scope,
    userId: context.user.id,
    previousMonthTotalTwd,
  });
}

function accountantPrompt(question: string, snapshot: Awaited<ReturnType<typeof loadAccountantSnapshot>>) {
  return {
    question,
    facts: snapshot.facts,
    categoryTotals: snapshot.categoryTotals,
    budgetUsages: snapshot.budgetUsages,
    duplicateCandidates: snapshot.duplicateCandidates.map((items) =>
      items.map((expense) => ({
        id: expense.id,
        description: expense.description,
        amountTwd: expense.amount_twd,
        date: expense.expense_date,
        version: expense.version,
      })),
    ),
    expenses: snapshot.expenses.slice(0, 60).map((expense) => ({
      id: expense.id,
      ledger: expense.ledger,
      description: expense.description,
      merchant: expense.merchant,
      category: expense.category,
      amountTwd: expense.amount_twd,
      date: expense.expense_date,
      splitMethod: expense.split_method,
      version: expense.version,
    })),
  };
}

function toAccountantExpense(expense: AppExpense): AccountantExpense {
  return {
    id: expense.id,
    group_id: expense.group_id,
    ledger: expense.ledger,
    description: expense.description,
    merchant: expense.merchant,
    notes: expense.notes,
    category: expense.category,
    category_label: expense.category_label,
    amount_twd: expense.amount_twd,
    paid_by_user_id: expense.paid_by_user_id,
    created_by_user_id: expense.created_by_user_id,
    expense_date: expense.expense_date,
    split_method: expense.split_method,
    version: expense.version,
    deleted_at: expense.deleted_at,
    expense_splits: expense.expense_splits,
  };
}

async function loadAgentExpenses(
  context: ServerContext,
  groupId: string,
): Promise<AgentExpense[]> {
  const [sharedResult, privateResult] = await Promise.all([
    context.db
      .from("expenses")
      .select(EXPENSE_SELECT)
      .eq("group_id", groupId)
      .order("expense_date", { ascending: false })
      .limit(2_000),
    context.db
      .from("expenses")
      .select(EXPENSE_SELECT)
      .eq("ledger", "private")
      .eq("created_by_user_id", context.user.id)
      .order("expense_date", { ascending: false })
      .limit(2_000),
  ]);
  if (sharedResult.error || privateResult.error)
    throw new Error("agent expense lookup failed");
  return z
    .array(expenseSchema)
    .parse([...(sharedResult.data ?? []), ...(privateResult.data ?? [])])
    .map(toAgentExpense);
}

function toAgentExpense(expense: AppExpense): AgentExpense {
  return {
    id: expense.id,
    group_id: expense.group_id,
    ledger: expense.ledger,
    description: expense.description,
    merchant: expense.merchant,
    category: expense.category,
    category_label: expense.category_label,
    mirror_kind: expense.mirror_kind,
    mirror_source_expense_id: expense.mirror_source_expense_id,
    amount_twd: expense.amount_twd,
    paid_by_user_id: expense.paid_by_user_id,
    created_by_user_id: expense.created_by_user_id,
    expense_date: expense.expense_date,
    version: expense.version,
    deleted_at: expense.deleted_at,
  };
}

async function answerWithGemini(
  context: ServerContext,
  input: {
    message: string;
    scope: AgentScope;
    timeRange: AgentTimeRange;
    aggregate: ReturnType<typeof aggregateAgentExpenses>;
    categories: ReturnType<typeof rankCategoryLabels>;
    duplicateCount: number;
    cleanupCount: number;
  },
  fallbackAnswer: string,
): Promise<{ answer: string; source: "llm" | "fallback" }> {
  const expectedFacts = {
    totalTwd: input.aggregate.totalTwd,
    transactionCount: input.aggregate.transactionCount,
    topCategoryLabel: input.categories[0]?.label ?? null,
    topCategoryTotalTwd: input.categories[0]?.totalTwd ?? null,
  };
  try {
    const gemini = new GoogleGenAI({ apiKey: context.env.GEMINI_API_KEY });
    const response = await gemini.models.generateContent({
      model: MODEL,
      contents: JSON.stringify({
        question: input.message,
        scope: input.scope,
        timeRange: input.timeRange,
        facts: expectedFacts,
        aggregate: input.aggregate,
        categoryRanking: input.categories.slice(0, 10),
        duplicateCount: input.duplicateCount,
        cleanupCount: input.cleanupCount,
      }),
      config: {
        systemInstruction:
          "你是帳務專用 AI 會計師的回覆層。只能根據提供的工具結果回答；不能新增金額、不能假設不存在的帳務、不能要求使用者打開 LIFF 才知道答案。facts 必須逐字等於輸入 facts。若有操作建議，只能描述需使用者確認。",
        responseMimeType: "application/json",
        responseJsonSchema: geminiAgentAnswerJsonSchema,
        temperature: 0.2,
        maxOutputTokens: 900,
      },
    });
    const parsed = agentLlmAnswerSchema.parse(
      JSON.parse(response.text ?? "{}"),
    );
    if (
      parsed.facts.totalTwd !== expectedFacts.totalTwd ||
      parsed.facts.transactionCount !== expectedFacts.transactionCount ||
      parsed.facts.topCategoryLabel !== expectedFacts.topCategoryLabel ||
      parsed.facts.topCategoryTotalTwd !== expectedFacts.topCategoryTotalTwd
    ) {
      return { answer: fallbackAnswer, source: "fallback" };
    }
    return { answer: parsed.answer, source: "llm" };
  } catch {
    return { answer: fallbackAnswer, source: "fallback" };
  }
}

function buildAgentAnswer(input: {
  message: string;
  scope: AgentScope;
  timeRange: AgentTimeRange;
  aggregate: ReturnType<typeof aggregateAgentExpenses>;
  categories: ReturnType<typeof rankCategoryLabels>;
  duplicateCount: number;
  cleanupCount: number;
}) {
  const range = agentRangeLabel(input.timeRange);
  const scope =
    input.scope === "shared"
      ? "共同帳"
      : input.scope === "private"
        ? "私人帳"
        : "合併帳";
  const top = input.categories[0];
  const ranking = input.categories
    .slice(0, 5)
    .map((item, index) => `${index + 1}. ${item.label} NT$${item.totalTwd}（${item.count}筆）`)
    .join("\n");
  const parts = [
    `${range}${scope}共 ${input.aggregate.transactionCount} 筆，總額 NT$${input.aggregate.totalTwd}。`,
  ];
  if (top) parts.push(`花最多的是「${top.label}」NT$${top.totalTwd}。`);
  if (ranking) parts.push(`分類排行：\n${ranking}`);
  if (input.duplicateCount)
    parts.push(`另外找到 ${input.duplicateCount} 組疑似重複支出，可到 LIFF 檢查。`);
  if (input.cleanupCount)
    parts.push(`有 ${input.cleanupCount} 筆「其他」可以整理成更細分類，LIFF 可批次確認。`);
  return parts.join("\n");
}

function buildAgentFindings(
  categories: ReturnType<typeof rankCategoryLabels>,
  duplicateCount: number,
) {
  const findings = [];
  const top = categories[0];
  if (top) {
    findings.push({
      severity: "info",
      title: "最大支出分類",
      body: `${top.label} 是目前最高分類，共 ${top.count} 筆。`,
      amountTwd: top.totalTwd,
    });
  }
  const other = categories.find(
    (item) => item.label === "其他" || item.label === "other",
  );
  if (other) {
    findings.push({
      severity: "warning",
      title: "其他分類仍需整理",
      body: "建議使用分類整理，把其他拆成高鐵、外食、咖啡、日用品等實際分類。",
      amountTwd: other.totalTwd,
    });
  }
  if (duplicateCount) {
    findings.push({
      severity: "warning",
      title: "疑似重複支出",
      body: `找到 ${duplicateCount} 組同日同額同描述的支出。`,
      amountTwd: null,
    });
  }
  return findings.slice(0, 8);
}

async function activeGroupId(context: ServerContext) {
  const preference = await context.db
    .from("user_preferences")
    .select("active_group_id")
    .eq("user_id", context.user.id)
    .single();
  if (preference.error) throw new Error("active group lookup failed");
  return z.object({ active_group_id: z.string().uuid() }).parse(preference.data)
    .active_group_id;
}

function accountantReportSelect() {
  return "id, group_id, owner_user_id, report_type, scope, month, question, title, summary, facts, findings, suggestions, source, created_at";
}

const expenseInputSchema = z.object({
  ledger: z.enum(["shared", "private"]),
  groupId: z.string().uuid().nullable(),
  description: z.string().trim().min(1).max(100),
  merchant: z.string().trim().max(100).nullable().default(null),
  notes: z.string().trim().max(500).nullable().default(null),
  category: z.enum(categories),
  categoryLabel: z.string().trim().min(1).max(40).nullable().default(null),
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
    type: z.literal("batch_create_expenses"),
    expenses: z.array(expenseInputSchema).min(1).max(50),
  }),
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
  z.object({
    type: z.literal("batch_update_expenses"),
    updates: z.array(batchCategoryUpdateSchema).min(1).max(50),
  }),
]);

const pendingRetargetInputSchema = z.object({
  ledger: z.literal("private"),
  category: z.literal("transport"),
  categoryLabel: z.literal("交通"),
});

type PendingRetargetInput = z.infer<typeof pendingRetargetInputSchema>;
type CreateExpenseActionInput = Extract<
  z.infer<typeof actionInputSchema>,
  { type: "create_expense" }
>;

export function receiptExpenseInputs(input: {
  activeGroupId: string;
  receiptId: string;
  today: string;
  extraction: z.infer<typeof receiptExtractionSchema>;
}): CreateExpenseActionInput[] {
  const items = input.extraction.items.length
    ? input.extraction.items
    : [
        {
          merchant: input.extraction.merchant,
          description: input.extraction.merchant,
          expenseDate: input.extraction.expenseDate,
          amountTwd: input.extraction.amountTwd,
        },
      ];
  const validItems = items.flatMap((item) => {
    const amountTwd = item.amountTwd;
    return Number.isSafeInteger(amountTwd) && amountTwd !== null && amountTwd > 0
      ? [{ ...item, amountTwd }]
      : [];
  });
  const receiptId = validItems.length === 1 ? input.receiptId : null;
  return validItems.map((item) => {
    const merchant = item.merchant ?? input.extraction.merchant ?? null;
    const description = item.description ?? merchant ?? "收據支出";
    const text = `${merchant ?? ""} ${description}`.toLowerCase();
    const isTransport =
      /^(enq|emf|ewx)-\d+/i.test(merchant ?? description) ||
      /停車|車資|行程|旅程|搭車|高鐵|台鐵|捷運|公車|客運|uber|taxi|計程車/i.test(text);
    return {
      type: "create_expense",
      expense: {
        ledger: "shared",
        groupId: input.activeGroupId,
        description,
        merchant,
        notes: "由 LINE 圖片辨識建立",
        category: isTransport ? "transport" : "other",
        categoryLabel: isTransport
          ? /停車/.test(text)
            ? "停車費"
            : "車資"
          : null,
        amountTwd: item.amountTwd,
        paidBy: "self",
        expenseDate: item.expenseDate ?? input.extraction.expenseDate ?? input.today,
        splitMethod: "equal",
        selfValue: null,
        partnerValue: null,
        receiptId,
      },
    };
  });
}

export function batchCreatePayloadFromActions(actions: CreateExpenseActionInput[]) {
  return { items: actions.map((action) => action.expense) };
}

export function retargetPendingActionPayload(
  payload: Record<string, unknown>,
  userId: string,
  input: PendingRetargetInput,
): Record<string, unknown> {
  if (Array.isArray(payload.items)) {
    return {
      items: payload.items.map((item) =>
        retargetPendingActionPayload(
          z.record(z.string(), z.unknown()).parse(item),
          userId,
          input,
        ),
      ),
    };
  }
  const rest = { ...payload };
  delete rest.splits;
  return {
    ...rest,
    ledger: input.ledger,
    group_id: null,
    paid_by_user_id: userId,
    category: input.category,
    category_label: input.categoryLabel,
    split_method: "equal",
  };
}

export async function retargetPendingActions(
  context: Pick<ServerContext, "db" | "user">,
  input: unknown,
) {
  const parsed = pendingRetargetInputSchema.parse(input);
  const rows = await context.db
    .from("pending_actions")
    .select("id, action_type, payload, idempotency_key")
    .eq("requested_by_user_id", context.user.id)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(30);
  if (rows.error) throw new Error("pending action lookup failed");
  const actions = z
    .array(
      z.object({
        id: z.string().uuid(),
        action_type: z.string(),
        payload: z.record(z.string(), z.unknown()),
        idempotency_key: z.string().nullable(),
      }),
    )
    .parse(rows.data ?? [])
    .filter(
      (row) =>
        ["create_expense", "batch_create_expenses"].includes(row.action_type) &&
        row.idempotency_key?.startsWith("receipt"),
    );
  let count = 0;
  for (const action of actions) {
    const payload = retargetPendingActionPayload(
      action.payload,
      context.user.id,
      parsed,
    );
    const update = await context.db
      .from("pending_actions")
      .update({
        group_id: null,
        payload,
      })
      .eq("id", action.id)
      .eq("status", "pending");
    if (!update.error)
      count += Array.isArray(payload.items) ? payload.items.length : 1;
  }
  return { count };
}

export async function retargetPendingActionById(
  context: Pick<ServerContext, "db" | "user">,
  actionId: string,
  input: unknown,
) {
  const parsed = pendingRetargetInputSchema.parse(input);
  const action = await context.db
    .from("pending_actions")
    .select("id, action_type, payload")
    .eq("id", z.string().uuid().parse(actionId))
    .eq("requested_by_user_id", context.user.id)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .single();
  if (action.error) throw new HttpError(404, "找不到待確認草稿");
  const row = z
    .object({
      id: z.string().uuid(),
      action_type: z.string(),
      payload: z.record(z.string(), z.unknown()),
    })
    .parse(action.data);
  if (!["create_expense", "batch_create_expenses"].includes(row.action_type))
    throw new HttpError(400, "這個草稿不能改帳本");
  const payload = retargetPendingActionPayload(
    row.payload,
    context.user.id,
    parsed,
  );
  const update = await context.db
    .from("pending_actions")
    .update({ group_id: null, payload })
    .eq("id", row.id)
    .eq("status", "pending");
  if (update.error) throw new Error("pending action update failed");
  return { count: Array.isArray(payload.items) ? payload.items.length : 1 };
}

export async function proposeAction(
  context: ServerContext,
  input: unknown,
  idempotencyKey?: string,
) {
  const parsed = actionInputSchema.parse(input);
  if (parsed.type === "batch_create_expenses")
    return proposeBatchCreateExpenses(
      context,
      parsed.expenses.map((expense) => ({ type: "create_expense", expense })),
      idempotencyKey,
    );
  if (parsed.type === "batch_update_expenses")
    return createCategoryCleanup(context, { updates: parsed.updates }, idempotencyKey);
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
    if (parsed.type === "update_expense") {
      await assertEditableExpense(context, parsed.expenseId);
      // Block shared→private conversion when settlements exist
      if (parsed.expense.ledger === "private") {
        const check = await checkExpenseInSettlements(context, parsed.expenseId);
        if (check.settled)
          throw new HttpError(409, check.message);
      }
    }
    const prepared = await prepareExpense(context, parsed.expense, partner);
    groupId = prepared.groupId;
    payload = prepared.payload;
    preview = `${parsed.type === "create_expense" ? "新增" : "修改"} ${prepared.groupName}\n${parsed.expense.description} NT$${parsed.expense.amountTwd}\n${splitLabel(parsed.expense.splitMethod)} · ${categoryLabel(prepared.category)}`;
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
        "id, group_id, ledger, description, amount_twd, version, deleted_at, created_by_user_id, mirror_kind",
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
        mirror_kind: z.enum(["shared_share"]).nullable().default(null),
      })
      .parse(expenseResult.data);
    if (expense.mirror_kind)
      throw new HttpError(403, "共同分攤紀錄請修改來源共同帳");
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

export async function proposeBatchCreateExpenses(
  context: ServerContext,
  inputs: CreateExpenseActionInput[],
  idempotencyKey?: string,
) {
  const parsed = z.array(
    z.object({ type: z.literal("create_expense"), expense: expenseInputSchema }),
  ).min(1).max(50).parse(inputs);
  const usersResult = await context.db
    .from("users")
    .select("id, couple_id, line_user_id, role")
    .eq("couple_id", context.user.couple_id)
    .order("role");
  if (usersResult.error) throw new Error("users lookup failed");
  const users = z.array(userSchema).parse(usersResult.data);
  const partner = users.find((user) => user.id !== context.user.id);
  if (!partner) throw new HttpError(409, "請先讓另一半加入");

  const items = [];
  const lines = [];
  let groupId: string | null = null;
  let groupName = "";
  let totalTwd = 0;
  for (const input of parsed) {
    const prepared = await prepareExpense(context, input.expense, partner);
    items.push(prepared.payload);
    totalTwd += input.expense.amountTwd;
    groupId = groupId === null ? prepared.groupId : groupId;
    groupName = groupName || prepared.groupName;
    lines.push(
      `${input.expense.expenseDate} ${input.expense.description} NT$${input.expense.amountTwd}`,
    );
  }
  const mixedGroups = items.some(
    (item) => (item.group_id as string | null) !== groupId,
  );
  const sourceEventId = `batch:${randomUUID()}`;
  const insert = await context.db
    .from("pending_actions")
    .insert({
      couple_id: context.user.couple_id,
      group_id: mixedGroups ? null : groupId,
      requested_by_user_id: context.user.id,
      action_type: "batch_create_expenses",
      payload: { items },
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
      if (!existing.error)
        return {
          actionId: z.object({ id: z.string().uuid() }).parse(existing.data).id,
          preview: batchPreview(groupName, parsed.length, totalTwd, lines),
          count: parsed.length,
          totalTwd,
        };
    }
    throw new Error("batch pending action insert failed");
  }
  return {
    actionId: z.object({ id: z.string().uuid() }).parse(insert.data).id,
    preview: batchPreview(groupName, parsed.length, totalTwd, lines),
    count: parsed.length,
    totalTwd,
  };
}

function batchPreview(
  groupName: string,
  count: number,
  totalTwd: number,
  lines: string[],
) {
  return [
    `收據辨識完成，請確認 ${count} 筆記帳`,
    `${groupName || "批次草稿"}｜總額 NT$${totalTwd}`,
    "",
    ...lines.slice(0, 25),
  ].join("\n");
}

async function assertEditableExpense(context: ServerContext, expenseId: string) {
  const result = await context.db
    .from("expenses")
    .select("id, ledger, created_by_user_id, mirror_kind")
    .eq("id", expenseId)
    .eq("couple_id", context.user.couple_id)
    .single();
  if (result.error) throw new HttpError(404, "找不到支出");
  const expense = z
    .object({
      ledger: z.enum(["shared", "private"]),
      created_by_user_id: z.string().uuid(),
      mirror_kind: z.enum(["shared_share"]).nullable().default(null),
    })
    .parse(result.data);
  if (expense.mirror_kind)
    throw new HttpError(403, "共同分攤紀錄請修改來源共同帳");
  if (expense.ledger === "private" && expense.created_by_user_id !== context.user.id)
    throw new HttpError(403, "無權操作私人支出");
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
  const classification = await classifyPreparedExpense(context, expense, group);
  const category = classification.category;
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
  const categoryLabelValue = expense.categoryLabel ?? classification.categoryLabel;
  return {
    groupId: group?.id ?? null,
    groupName: expense.ledger === "private" ? "私人帳" : group!.name,
    category,
    payload: {
      group_id: group?.id ?? null,
      ledger: expense.ledger,
      description: expense.description,
      merchant: expense.merchant,
      notes: expense.notes,
      category,
      category_label: categoryLabelValue,
      amount_twd: expense.amountTwd,
      paid_by_user_id: expense.ledger === "private" ? context.user.id : payerId,
      expense_date: expense.expenseDate,
      split_method: expense.splitMethod,
      splits,
      receipt_id: expense.receiptId,
    },
  };
}

async function classifyPreparedExpense(
  context: ServerContext,
  expense: z.infer<typeof expenseInputSchema>,
  group: { id: string; name: string } | null,
) {
  const [historyResult, canonicalLabels] = await Promise.all([
    (() => {
      const query = context.db
        .from("expenses")
        .select("category, category_label, description, merchant")
        .eq("couple_id", context.user.couple_id)
        .eq("ledger", expense.ledger)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(80);
      return expense.ledger === "shared"
        ? query.eq("group_id", group?.id ?? "")
        : query.eq("created_by_user_id", context.user.id);
    })(),
    getCanonicalLabels(
      context.db,
      expense.ledger === "shared" ? (group?.id ?? null) : null,
      expense.category,
    ),
  ]);
  const history: CategoryClassificationInput["history"] = historyResult.error
    ? []
    : z
        .array(
          z.object({
            category: z.enum(categories),
            category_label: z.string(),
            description: z.string(),
            merchant: z.string().nullable(),
          }),
        )
        .parse(historyResult.data)
        .filter((row) => !isLegacyCategoryLabel(row.category_label))
        .map((row) => ({
          category: row.category,
          categoryLabel: row.category_label,
          description: row.description,
          merchant: row.merchant,
        }));
  const result = await classifyExpenseCategory(
    {
      description: expense.description,
      merchant: expense.merchant,
      groupName: group?.name ?? "私人帳",
      fallbackCategory: expense.category,
      canonicalLabels,
      history,
    },
    new GoogleGenAI({ apiKey: context.env.GEMINI_API_KEY }),
  );
  // Auto-insert new canonical labels
  void autoInsertCanonicalLabel(
    context.db,
    expense.ledger === "shared" ? (group?.id ?? null) : null,
    result.category,
    result.categoryLabel,
  );
  return result;
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
  const action = await context.db
    .from("pending_actions")
    .select("action_type")
    .eq("id", id)
    .eq("requested_by_user_id", context.user.id)
    .maybeSingle();
  if (action.error) throw new Error("pending action lookup failed");
  let result;
  if (action.data?.action_type === "batch_update_expenses") {
    result = await context.db.rpc("confirm_batch_update_expenses", {
      p_action_id: id,
      p_line_user_id: context.user.line_user_id,
      p_confirm: confirm,
    });
  } else if (action.data?.action_type === "batch_create_expenses") {
    result = await context.db.rpc("confirm_batch_create_expenses", {
      p_action_id: id,
      p_line_user_id: context.user.line_user_id,
      p_confirm: confirm,
    });
  } else {
    result = await context.db.rpc("confirm_pending_action", {
      p_action_id: id,
      p_line_user_id: context.user.line_user_id,
      p_confirm: confirm,
    });
  }
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
      created_count: z.number().int().optional(),
    })
    .parse(result.data);
  if (value.result === "confirmed") {
    await applyConfirmedActionSideEffects(context, id);
    await createBudgetAlerts(context);
    await deliverNotifications(context);
  }
  return value;
}

export async function applyConfirmedActionSideEffects(
  context: ServerContext,
  actionId: string,
) {
  const result = await context.db
    .from("pending_actions")
    .select("action_type, payload, group_id")
    .eq("id", actionId)
    .eq("couple_id", context.user.couple_id)
    .single();
  if (result.error) return;
  const row = z
    .object({
      action_type: z.string(),
      payload: z.record(z.string(), z.unknown()),
      group_id: z.string().uuid().nullable().optional(),
    })
    .parse(result.data);

  if (row.action_type === "batch_update_expenses" && row.payload.merge) {
    const merge = z
      .object({
        targetLabel: z.string().trim().min(1).max(40),
        sourceLabels: z.array(z.string().trim().min(1).max(40)),
        category: z.string(),
      })
      .parse(row.payload.merge);
    const groupId = row.group_id ?? null;

    const existing = await context.db
      .from("canonical_labels")
      .select("id, aliases")
      .eq("group_id", groupId)
      .eq("category", merge.category)
      .eq("label", merge.targetLabel)
      .maybeSingle();

    const currentAliases: string[] = existing.data?.aliases ?? [];
    const newAliases = [...new Set([...currentAliases, ...merge.sourceLabels])];

    if (existing.data) {
      await context.db
        .from("canonical_labels")
        .update({ aliases: newAliases })
        .eq("id", existing.data.id);
    } else {
      await context.db.from("canonical_labels").insert({
        group_id: groupId,
        category: merge.category,
        label: merge.targetLabel,
        aliases: newAliases,
      });
    }

    await context.db
      .from("canonical_labels")
      .delete()
      .eq("group_id", groupId)
      .eq("category", merge.category)
      .in("label", merge.sourceLabels);
    return;
  }

  if (
    !["create_expense", "update_expense"].includes(row.action_type) ||
    typeof row.payload.category_label !== "string"
  ) {
    return;
  }
  const label = cleanCategoryLabel(row.payload.category_label);
  if (!label) return;
  const base = context.db
    .from("expenses")
    .update({ category_label: label })
    .eq("couple_id", context.user.couple_id);
  const expenseId =
    typeof row.payload.expense_id === "string" ? row.payload.expense_id : null;
  const update = expenseId
    ? await base.eq("id", expenseId)
    : await base.eq("source_action_id", actionId);
  if (update.error) throw new Error("category label side effect failed");
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
  const deleteOp = z
    .object({
      operation: z.literal("delete"),
      id: z.string().uuid(),
    })
    .safeParse(input);
  if (deleteOp.success) {
    const before = await context.db.from("recurring_expenses").select("id, group_id, description").eq("id", deleteOp.data.id).eq("couple_id", context.user.couple_id).single();
    if (before.error || !before.data) throw new HttpError(404, "Not found");
    const result = await context.db
      .from("recurring_expenses")
      .delete()
      .eq("id", deleteOp.data.id)
      .eq("couple_id", context.user.couple_id);
    if (result.error) throw new Error("recurring delete failed");
    await appendActivity(context, "recurring", deleteOp.data.id, "delete", before.data.group_id ?? null, before.data, null);
    await notifyPartner(context, "recurring", "週期支出已刪除", `已刪除週期支出：「${before.data.description}」`, before.data.group_id ?? null, "recurring", deleteOp.data.id);
    await deliverNotifications(context);
    return { ok: true };
  }

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
          text: "辨識這張台灣收據、付款紀錄或叫車/行程截圖。若畫面只有一筆消費，填 merchant、expenseDate、amountTwd 與 confidence；若畫面有多筆交易，items 逐筆列出 merchant/代碼、expenseDate、amountTwd、description。金額只取實際付款的 TWD 整數，忽略 NT$0、折抵、退款與看不清楚的項目；看不清楚欄位用 null。",
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: geminiReceiptJsonSchema,
        temperature: 0,
        maxOutputTokens: 1_000,
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
  lineClient: Pick<LineBotClient, "getMessageContent" | "pushMessage">,
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
    const actionInputs = receiptExpenseInputs({
      activeGroupId: preference.data.active_group_id as string,
      receiptId,
      today: taipeiToday(),
      extraction,
    });
    if (actionInputs.length) {
      const action = await proposeBatchCreateExpenses(
        context,
        actionInputs,
        `receipt-batch:${receiptId}`,
      );
      await pushReceiptBatchConfirmation(lineClient, user.line_user_id, action);
      return;
    }
    await lineClient.pushMessage({
      to: user.line_user_id,
      messages: [
        {
          type: "text",
          text: `收據辨識完成\n${extraction.merchant ?? "未知商家"} 金額待確認\n請打開圖形化帳本補金額：${env.APP_URL}/?receipt=${receiptId}`,
        },
      ],
    });
  } catch {
    await lineClient.pushMessage(
      {
        to: user.line_user_id,
        messages: [
          {
            type: "text",
            text: "收據辨識失敗，請重新拍清楚一點，或到圖形化帳本手動新增。",
          },
        ],
      },
    );
  }
}

async function pushReceiptBatchConfirmation(
  lineClient: Pick<LineBotClient, "pushMessage">,
  lineUserId: string,
  action: { actionId: string; preview: string; count: number },
) {
  const message: messagingApi.TextMessage = {
    type: "text",
    text: action.preview,
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: action.count === 1 ? "確認" : "確認全部",
            data: `decision=confirm&id=${action.actionId}`,
            displayText: action.count === 1 ? "確認" : "確認全部",
          },
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "改私人交通",
            data: `edit=private_transport&id=${action.actionId}`,
            displayText: "改成私人帳交通",
          },
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "取消",
            data: `decision=cancel&id=${action.actionId}`,
            displayText: "取消",
          },
        },
      ],
    },
  };
  await lineClient.pushMessage({ to: lineUserId, messages: [message] });
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
      "id, group_id, kind, recipient_user_id, title, body, entity_type, entity_id, users!notifications_recipient_user_id_fkey(line_user_id)",
    )
    .eq("line_status", "pending")
    .order("created_at")
    .limit(20);
  if (pending.error || !pending.data?.length) return;
  for (const notification of pending.data) {
    const claim = await context.db
      .from("notifications")
      .update({ line_status: "sending" })
      .eq("id", notification.id)
      .eq("line_status", "pending")
      .select("id");
    if (claim.error || !claim.data?.length) continue;
    const userRelation = notification.users as unknown;
    const lineUserId = z
      .union([
        z.object({ line_user_id: z.string() }),
        z
          .array(z.object({ line_user_id: z.string() }))
          .transform((rows) => rows[0]),
      ])
      .parse(userRelation)?.line_user_id;
    let status = lineUserId ? "failed" : "skipped";
    if (lineUserId) {
      const text = await lineNotificationText(context, notification);
      try {
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
                text,
              },
            ],
          }),
        });
        status = response.ok ? "sent" : "failed";
      } catch {
        status = "failed";
      }
    }
    await context.db
      .from("notifications")
      .update({ line_status: status })
      .eq("id", notification.id);
  }
}

async function lineNotificationText(
  context: ServerContext,
  notification: {
    title: string;
    body: string;
    kind?: string | null;
    group_id?: string | null;
    entity_type?: string | null;
    entity_id?: string | null;
  },
) {
  if (
    notification.kind === "expense" &&
    notification.entity_type === "expense" &&
    z.string().uuid().safeParse(notification.entity_id).success
  ) {
    const [expenseResult, groupResult] = await Promise.all([
      context.db
        .from("expenses")
        .select("description, amount_twd, expense_date, category, category_label")
        .eq("id", notification.entity_id)
        .single(),
      notification.group_id
        ? context.db
            .from("groups")
            .select("name")
            .eq("id", notification.group_id)
            .single()
        : Promise.resolve({ data: null, error: null }),
    ]);
    const expense = z
      .object({
        description: z.string(),
        amount_twd: z.coerce.number().int(),
        expense_date: z.string(),
        category: z.enum(categories),
        category_label: z.string().nullable().optional(),
      })
      .safeParse(expenseResult.data);
    const group = z.object({ name: z.string() }).nullable().safeParse(groupResult.data);
    if (!expenseResult.error && expense.success) {
      const groupName = group.success && group.data ? ` ${group.data.name}` : "";
      const label = expense.data.category_label || categoryLabel(expense.data.category);
      return `${notification.body}${groupName}\n${expense.data.description} ${notificationMoney(expense.data.amount_twd)}｜${expense.data.expense_date}｜${label}`;
    }
  }
  return notification.title ? `${notification.title}\n${notification.body}` : notification.body;
}

function notificationMoney(amount: number) {
  return `NT$${amount.toLocaleString("en-US")}`;
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
  let accountantReports = 0;
  if (today.endsWith("-01")) {
    accountantReports = await generateMonthlyAccountantReports(env, db, shiftMonth(today.slice(0, 7), -1));
    const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const groupsResult = await db.from("groups").select("id, couple_id").is("archived_at", null);
    if (!groupsResult.error && groupsResult.data) {
      for (const group of groupsResult.data) {
        const merges = await suggestCanonicalLabelMerges(db, group.id, gemini);
        if (merges && merges.length > 0) {
          const usersResult = await db.from("users").select("id").eq("couple_id", group.couple_id);
          if (!usersResult.error && usersResult.data) {
            for (const u of usersResult.data) {
              await db.from("notifications").upsert({
                recipient_user_id: u.id,
                group_id: group.id,
                kind: "recurring",
                title: "分類標籤合併建議",
                body: `發現相似標籤「${merges[0]!.source}」與「${merges[0]!.target}」，建議前往 LIFF 進行合併整理。`,
                entity_type: "recurring",
                entity_id: group.id,
                dedupe_key: `label-merge-suggest:${group.id}:${today}`,
              }, { onConflict: "dedupe_key", ignoreDuplicates: true });
            }
          }
        }
      }
    }
  }

  const users = await db
    .from("users")
    .select("id, couple_id, line_user_id, role")
    .limit(1);
  const firstUser = z.array(userSchema).parse(users.data ?? [])[0];
  if (firstUser) await deliverNotifications({ env, db, user: firstUser });
  return { drafts, purgedReceipts: expiredReceipts.data?.length ?? 0, accountantReports };
}

async function suggestCanonicalLabelMerges(
  db: SupabaseClient,
  groupId: string,
  gemini: GoogleGenAI,
) {
  const labelsResult = await db
    .from("canonical_labels")
    .select("label, category")
    .eq("group_id", groupId);
  if (labelsResult.error || !labelsResult.data || labelsResult.data.length < 2) return [];

  const labels = labelsResult.data;
  const prompt = `以下是我們資料庫中某個群組的常用分類標籤清單：
${labels.map((l) => `- [${l.category}] ${l.label}`).join("\n")}

請找出其中語意高度相似、可能是重複建立的標籤（例如：「捷運」與「台北捷運」、「7-11」與「7-Eleven」）。
請為每一組相似的標籤建議一個合併的目標（選擇其中較簡短或較常見的一個）。
請嚴格以 JSON 陣列格式回傳，不要包含 markdown 標籤或說明文字：
[
  {"source": "相似的舊標籤", "target": "保留的新標籤", "category": "該大分類名稱"}
]
如果沒有發現任何需要合併的相似標籤，回傳空陣列 []。`;

  try {
    const response = await gemini.models.generateContent({
      model: AGENT_MODEL,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    });
    const text = response.text?.trim() ?? "[]";
    const suggestions = JSON.parse(text) as Array<{ source: string; target: string; category: string }>;
    
    return suggestions.filter((s) => 
      labels.some((l) => l.label === s.source && l.category === s.category) &&
      labels.some((l) => l.label === s.target && l.category === s.category)
    );
  } catch (err) {
    console.error("Failed to suggest canonical label merges:", err);
    return [];
  }
}

async function generateMonthlyAccountantReports(
  env: z.infer<typeof envSchema>,
  db: SupabaseClient,
  month: string,
) {
  const [usersResult, groupsResult] = await Promise.all([
    db.from("users").select("id, couple_id, line_user_id, role").order("role"),
    db.from("groups").select("id, couple_id").is("archived_at", null),
  ]);
  if (usersResult.error || groupsResult.error) return 0;
  const users = z.array(userSchema).parse(usersResult.data);
  let count = 0;
  for (const group of groupsResult.data ?? []) {
    const user = users.find((item) => item.couple_id === group.couple_id);
    if (!user) continue;
    const context = { env, db, user } satisfies ServerContext;
    try {
      const report = await generateAccountantReport(context, {
        question: `${month} 共同帳月報`,
        scope: "shared",
        month,
        reportType: "monthly_health",
        groupId: String(group.id),
      });
      count += 1;
      for (const recipient of users.filter((item) => item.couple_id === user.couple_id)) {
        await db.from("notifications").upsert(
          {
            recipient_user_id: recipient.id,
            group_id: group.id,
            kind: "accountant",
            title: "AI 會計師月報",
            body: `${report.title}\n${env.APP_URL}/?tab=accountant`,
            entity_type: "accountant_report",
            entity_id: report.id,
            dedupe_key: `accountant-report:${report.id}:user:${recipient.id}`,
          },
          { onConflict: "dedupe_key", ignoreDuplicates: true },
        );
      }
    } catch {
      /* keep cron best-effort */
    }
  }
  for (const user of users) {
    const context = { env, db, user } satisfies ServerContext;
    try {
      const report = await generateAccountantReport(context, {
        question: `${month} 私人帳月報`,
        scope: "private",
        month,
        reportType: "monthly_health",
      });
      count += 1;
      await db.from("notifications").upsert(
        {
          recipient_user_id: user.id,
          group_id: null,
          kind: "accountant",
          title: "AI 私人帳月報",
          body: `${report.title}\n${env.APP_URL}/?tab=accountant`,
          entity_type: "accountant_report",
          entity_id: report.id,
          dedupe_key: `accountant-report:${report.id}:user:${user.id}`,
        },
        { onConflict: "dedupe_key", ignoreDuplicates: true },
      );
    } catch {
      /* keep cron best-effort */
    }
  }
  return count;
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
  action: "create" | "update" | "delete" | "restore" | "archive" | "settle",
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

function cleanCategoryLabel(value: string) {
  return value
    .normalize("NFKC")
    .replace(/nt\$?/gi, "")
    .replace(/[0-9,]+/g, "")
    .replace(/我付|你付|他付|她付|付款|付|元|塊/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 40);
}

/* ─── Projection (month-end spend prediction) ─── */

export function buildProjection(
  expenses: AppExpense[],
  month: string,
  today: string,
  budgets: Array<{ category?: string | null; limit_twd: number }>,
) {
  const daysElapsed = Number(today.slice(8, 10));
  const daysTotal = new Date(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)),
    0,
  ).getDate();

  if (daysElapsed < 4) return null;

  const thisMonthExpenses = expenses.filter((e) =>
    e.expense_date.startsWith(month),
  );
  const spentSoFar = thisMonthExpenses.reduce(
    (sum, e) => sum + e.amount_twd,
    0,
  );
  const projectedTotal = Math.round((spentSoFar / daysElapsed) * daysTotal);

  const totalBudget = budgets.find((b) => !b.category);
  const categoryProjections = budgets
    .filter((b) => b.category)
    .map((budget) => {
      const catSpent = thisMonthExpenses
        .filter((e) => e.category === budget.category)
        .reduce((sum, e) => sum + e.amount_twd, 0);
      const catProjected = Math.round((catSpent / daysElapsed) * daysTotal);
      return {
        category: budget.category,
        spentSoFar: catSpent,
        projectedTotal: catProjected,
        budget: budget.limit_twd,
        projectedOverrun: catProjected - budget.limit_twd,
      };
    })
    .filter((p) => p.projectedOverrun > 0);

  return {
    daysElapsed,
    daysTotal,
    spentSoFar,
    projectedTotal,
    budget: totalBudget?.limit_twd ?? null,
    projectedOverrun: totalBudget
      ? projectedTotal - totalBudget.limit_twd
      : null,
    categoryProjections,
  };
}

/* ─── Canonical Labels ─── */

export async function getCanonicalLabels(
  db: SupabaseClient,
  groupId: string | null,
  category?: string,
): Promise<string[]> {
  let query = db.from("canonical_labels").select("label");
  if (groupId) {
    query = query.eq("group_id", groupId);
  } else {
    query = query.is("group_id", null);
  }
  if (category) query = query.eq("category", category);
  const result = await query.order("created_at").limit(50);
  if (result.error) return [];
  return z
    .array(z.object({ label: z.string() }))
    .parse(result.data)
    .map((row) => row.label);
}

export async function autoInsertCanonicalLabel(
  db: SupabaseClient,
  groupId: string | null,
  category: string,
  label: string,
) {
  if (!label || label === "其他" || label === "other") return;
  await db.from("canonical_labels").upsert(
    {
      group_id: groupId,
      category,
      label: label.trim().slice(0, 40),
    },
    { onConflict: groupId ? "group_id,category,label" : "category,label", ignoreDuplicates: true },
  );
}

export async function listCanonicalLabels(context: ServerContext) {
  const groupId = await activeGroupId(context);
  const result = await context.db
    .from("canonical_labels")
    .select("id, group_id, category, label, aliases, created_at")
    .eq("group_id", groupId)
    .order("category")
    .order("label");
  if (result.error) throw new Error("canonical labels lookup failed");
  return result.data;
}

export async function mergeCanonicalLabels(
  context: ServerContext,
  input: unknown,
) {
  const parsed = z
    .object({
      targetLabel: z.string().trim().min(1).max(40),
      sourceLabels: z.array(z.string().trim().min(1).max(40)).min(1).max(20),
      category: z.string().min(1),
    })
    .parse(input);
  const groupId = await activeGroupId(context);

  // Find matching active expenses in the group
  const expensesResult = await context.db
    .from("expenses")
    .select("id, version, category_label")
    .eq("group_id", groupId)
    .eq("category", parsed.category)
    .in("category_label", parsed.sourceLabels)
    .is("deleted_at", null);

  if (expensesResult.error) throw new Error("expenses lookup failed");
  const matchingExpenses = expensesResult.data ?? [];

  if (matchingExpenses.length === 0) {
    // No expenses are using this label, update the dictionary directly
    const existing = await context.db
      .from("canonical_labels")
      .select("id, aliases")
      .eq("group_id", groupId)
      .eq("category", parsed.category)
      .eq("label", parsed.targetLabel)
      .maybeSingle();

    const currentAliases: string[] = existing.data?.aliases ?? [];
    const newAliases = [...new Set([...currentAliases, ...parsed.sourceLabels])];

    if (existing.data) {
      await context.db
        .from("canonical_labels")
        .update({ aliases: newAliases })
        .eq("id", existing.data.id);
    } else {
      await context.db.from("canonical_labels").insert({
        group_id: groupId,
        category: parsed.category,
        label: parsed.targetLabel,
        aliases: newAliases,
      });
    }

    await context.db
      .from("canonical_labels")
      .delete()
      .eq("group_id", groupId)
      .eq("category", parsed.category)
      .in("label", parsed.sourceLabels);

    return {
      actionId: null,
      preview: `已合併標籤為「${parsed.targetLabel}」（0 筆收據受影響）`,
    };
  }

  const updates = matchingExpenses.map((e) => ({
    expense_id: e.id,
    expected_version: e.version,
    category_label: parsed.targetLabel,
  }));

  const insert = await context.db
    .from("pending_actions")
    .insert({
      couple_id: context.user.couple_id,
      group_id: groupId,
      requested_by_user_id: context.user.id,
      action_type: "batch_update_expenses",
      payload: {
        updates,
        merge: {
          targetLabel: parsed.targetLabel,
          sourceLabels: parsed.sourceLabels,
          category: parsed.category,
        },
      },
      source_event_id: `liff:merge-labels:${randomUUID()}`,
      idempotency_key: null,
      expires_at: new Date(Date.now() + ACTION_SECONDS * 1_000).toISOString(),
    })
    .select("id")
    .single();

  if (insert.error) throw new Error("failed to propose merge action");
  const actionId = z.object({ id: z.string().uuid() }).parse(insert.data).id;

  return {
    actionId,
    preview: `合併標籤為「${parsed.targetLabel}」（影響 ${matchingExpenses.length} 筆收據）`,
  };
}

/* ─── Settlement check ─── */

export async function checkExpenseInSettlements(
  context: ServerContext,
  expenseId: string,
): Promise<{ settled: boolean; message: string }> {
  const expense = await context.db
    .from("expenses")
    .select("id, group_id, ledger")
    .eq("id", z.string().uuid().parse(expenseId))
    .eq("couple_id", context.user.couple_id)
    .single();
  if (expense.error) throw new HttpError(404, "找不到支出");
  if (expense.data.ledger !== "shared") {
    return { settled: false, message: "" };
  }
  // Check if this couple has any settlements at all
  const settlements = await context.db
    .from("settlements")
    .select("id", { count: "exact", head: true })
    .eq("couple_id", context.user.couple_id);
  const hasSettlements =
    !settlements.error && (settlements.count ?? 0) > 0;
  return {
    settled: hasSettlements,
    message: hasSettlements
      ? "此帳已包含在結清紀錄中，無法改為私人帳。請先復原該筆結清才能修改。"
      : "",
  };
}

/* ─── Agentic Accountant Chat ─── */

const chatInputSchema = z.object({
  sessionId: z.string().uuid().nullable().optional(),
  message: z.string().trim().min(1).max(500),
});

type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
  tool_results?: Array<{ name: string; result: unknown }>;
};

export async function agentChat(context: ServerContext, input: unknown) {
  const parsed = chatInputSchema.parse(input);
  const groupId = await activeGroupId(context);
  const gemini = new GoogleGenAI({ apiKey: context.env.GEMINI_API_KEY });

  // Load or create session
  let sessionId = parsed.sessionId ?? null;
  let messages: ChatMessage[] = [];

  if (sessionId) {
    const session = await context.db
      .from("accountant_sessions")
      .select("id, messages, last_active_at")
      .eq("id", sessionId)
      .eq("user_id", context.user.id)
      .single();

    if (
      !session.error &&
      new Date(session.data.last_active_at).getTime() >
        Date.now() - SESSION_EXPIRE_MS
    ) {
      messages = z.array(z.any()).parse(session.data.messages) as ChatMessage[];
    } else {
      // Session expired or not found — start fresh
      sessionId = null;
    }
  }

  if (!sessionId) {
    const insert = await context.db
      .from("accountant_sessions")
      .insert({
        couple_id: context.user.couple_id,
        group_id: groupId,
        user_id: context.user.id,
      })
      .select("id")
      .single();
    if (insert.error) throw new Error("session create failed");
    sessionId = z.object({ id: z.string().uuid() }).parse(insert.data).id;
  }

  // Append user message
  messages.push({ role: "user", content: parsed.message });

  // Build Gemini contents from message history
  const toolCtx: ToolContext = {
    db: context.db,
    groupId,
    userId: context.user.id,
    coupleId: context.user.couple_id,
  };

  const MAX_TOOL_CALLS = 8;
  let toolCallCount = 0;
  let assistantResponse = "";

  // Agent loop
  const geminiContents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      geminiContents.push({
        role: "user",
        parts: [{ text: msg.content }],
      });
    } else if (msg.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            functionCall: { name: tc.name, args: tc.args },
          });
        }
      }
      geminiContents.push({ role: "model", parts });
    } else if (msg.role === "tool" && msg.tool_results) {
      geminiContents.push({
        role: "user",
        parts: msg.tool_results.map((tr) => ({
          functionResponse: {
            name: tr.name,
            response: tr.result,
          },
        })),
      });
    }
  }

  // Loop: call Gemini, handle tool calls
  for (let iteration = 0; iteration < MAX_TOOL_CALLS + 1; iteration++) {
    const response = await gemini.models.generateContent({
      model: AGENT_MODEL,
      contents: geminiContents,
      config: {
        systemInstruction:
          "你是台灣情侶帳本的 AI 會計師。你有工具可以查詢帳務資料。" +
          "根據使用者的問題，自己決定需要查什麼資料，用工具查詢後再回答。" +
          "回答用繁體中文、口語、簡短。數字要具體。" +
          "你只能讀取資料，不能修改帳務。如果使用者要改帳，告訴他到 LIFF 操作。" +
          "不要捏造數字，所有數字都必須來自工具查詢結果。",
        tools: [{ functionDeclarations: toolDeclarations }],
        temperature: 0.3,
        maxOutputTokens: 1_200,
      },
    });

    // Check if response has function calls
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const functionCalls = parts.filter(
      (p): p is { functionCall: { name: string; args: Record<string, unknown> } } =>
        "functionCall" in p,
    );
    const textParts = parts.filter(
      (p): p is { text: string } => "text" in p,
    );

    if (functionCalls.length > 0 && toolCallCount < MAX_TOOL_CALLS) {
      // Execute tool calls
      const toolResults: Array<{ name: string; result: unknown }> = [];
      const toolCallsLog: Array<{ name: string; args: Record<string, unknown> }> = [];

      for (const fc of functionCalls) {
        toolCallCount++;
        const toolName = fc.functionCall.name;
        const toolArgs = fc.functionCall.args ?? {};
        toolCallsLog.push({ name: toolName, args: toolArgs });

        try {
          const result = await executeTool(toolName, toolArgs, toolCtx);
          toolResults.push({ name: toolName, result });
        } catch {
          toolResults.push({
            name: toolName,
            result: { error: "tool execution failed" },
          });
        }
      }

      // Append assistant message with tool calls
      messages.push({
        role: "assistant",
        content: textParts.map((p) => p.text).join(""),
        tool_calls: toolCallsLog,
      });
      geminiContents.push({
        role: "model",
        parts: functionCalls.map((fc) => ({
          functionCall: fc.functionCall,
        })),
      });

      // Append tool results
      messages.push({
        role: "tool",
        content: "",
        tool_results: toolResults,
      });
      geminiContents.push({
        role: "user",
        parts: toolResults.map((tr) => ({
          functionResponse: {
            name: tr.name,
            response: tr.result,
          },
        })),
      });

      continue;
    }

    // Text response — done
    assistantResponse = textParts.map((p) => p.text).join("");
    if (!assistantResponse && toolCallCount >= MAX_TOOL_CALLS) {
      assistantResponse = "資料量較大，這是目前查到的結果。請縮小範圍再問一次。";
    }
    break;
  }

  if (!assistantResponse) {
    assistantResponse = "抱歉，我暫時無法回答這個問題。請換個方式問問看。";
  }

  // Append final assistant message
  messages.push({ role: "assistant", content: assistantResponse });

  // Save session (trim to last 30 messages to prevent unbounded growth)
  const trimmedMessages = messages.slice(-30);
  await context.db
    .from("accountant_sessions")
    .update({
      messages: trimmedMessages,
      last_active_at: new Date().toISOString(),
    })
    .eq("id", sessionId);

  return {
    sessionId,
    answer: assistantResponse,
    toolCallCount,
  };
}

/* ─── Audio transcription ─── */

export async function transcribeAudio(
  audioBytes: Buffer,
  mimeType: string,
  gemini: GoogleGenAI,
): Promise<string> {
  const response = await gemini.models.generateContent({
    model: AGENT_MODEL,
    contents: [
      {
        inlineData: {
          mimeType,
          data: audioBytes.toString("base64"),
        },
      },
      {
        text: "把這段語音轉成文字。只輸出辨識到的文字內容，不加任何前綴或說明。如果聽不清楚，回傳空字串。",
      },
    ],
    config: {
      temperature: 0,
      maxOutputTokens: 500,
    },
  });
  return (response.text ?? "").trim();
}

/* ─── Utility functions ─── */

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

