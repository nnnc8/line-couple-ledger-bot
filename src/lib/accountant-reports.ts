/**
 * accountant-reports — LLM report generation + monthly cron + listing.
 *
 * Three entry points:
 *   - `listReports` — LIFF dashboard, both shared and own
 *   - `generateReport` — one report for a (scope, month) pair, with
 *     LLM call and a deterministic fallback if the model returns
 *     mismatched facts
 *   - `generateMonthlyReports` — cron entry point, fan out across
 *     every (user, group) pair, and write accountant notifications
 *     with a stable dedupe_key so repeat runs are idempotent
 */
import { randomUUID } from "node:crypto";

import { generateObject } from "ai";
import { z } from "zod";

import {
  type AccountantReport,
  accountantLlmReportSchema,
  accountantReportFromLlm,
  fallbackAccountantReport,
} from "./accountant";
import {
  accountantReportRowSchema,
  accountantReportSelect,
  activeGroupId,
  groupRowSchema,
  loadAccountantSnapshot,
  userRowSchema,
} from "./accountant-loaders";
import { getModel } from "./model-provider";
import type { ServerContext } from "./server-runtime";

const MODEL = "gemini-3.1-flash-lite";

/**
 * Read-side: shared reports (for the active group) + own private
 * reports, merged and sorted newest first. Mirrors the contract
 * `AccountantService.listReports` historically exposed.
 */
export async function listReports(context: ServerContext) {
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
  if (shared.error || own.error) {
    throw new Error("accountant reports lookup failed");
  }
  return z
    .array(accountantReportRowSchema)
    .parse([...(shared.data ?? []), ...(own.data ?? [])])
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, 30);
}

/**
 * One report for the (scope, month) pair. The LLM gets the same prompt
 * regardless of caller (manual question vs. monthly cron); the dedupe
 * key changes so a manual `runReport` and a monthly cron run don't
 * collide.
 */
export async function generateReport(
  context: ServerContext,
  input: {
    question: string;
    scope: "shared" | "private" | "combined";
    month: string;
    reportType: "manual_question" | "monthly_health" | "cleanup_review";
    groupId?: string;
  },
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
    const response = await generateObject({
      model: getModel(MODEL),
      system:
        "你是台灣情侶帳本的會計師。只能根據提供的 snapshot 分析。facts 必須逐字等於 snapshot.facts；不能自行改金額、改權限或假設不存在的帳務。可給建議，建議中的改帳動作會直接執行。你只能根據提供的 snapshot 資料中出現的 merchant 或 description 進行字面推論，絕對禁止憑空捏造 snapshot 中沒有明確指出的具體事件、活動或情境（例如捏造出去某個商圈逛街、參加某種生日聚會、出遊等）。如果資料中沒有明確的商家或備註，僅能說明『主要來自大額支出』，不得虛構原因！",
      messages: [
        {
          role: "user",
          content: JSON.stringify(accountantPrompt(input.question, snapshot)),
        },
      ],
      temperature: 0.2,
      schema: accountantLlmReportSchema,
    });
    report = accountantReportFromLlm(response.object, snapshot);
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

/**
 * Cron entry: for every group, generate the shared monthly report
 * (notified to both partners in the couple) and for every user
 * generate the private monthly report (notified to the user alone).
 *
 * Errors on a single report are swallowed because the cron should be
 * best-effort; one bad group should not abort the rest of the loop.
 *
 * `generateReportOverride` lets the facade route through its own
 * `generateReport` method (so existing test seams that override the
 * method on the service instance keep working). When omitted, this
 * function uses the local `generateReport`.
 */
export async function generateMonthlyReports(
  env: ServerContext["env"],
  db: ServerContext["db"],
  month: string,
  generateReportOverride?: (
    context: ServerContext,
    input: Parameters<typeof generateReport>[1],
  ) => ReturnType<typeof generateReport>,
) {
  const [usersResult, groupsResult] = await Promise.all([
    db.from("users").select("id, couple_id, line_user_id, role").order("role"),
    db.from("groups").select("id, couple_id").is("archived_at", null),
  ]);
  if (usersResult.error || groupsResult.error) return 0;
  const users = z.array(userRowSchema).parse(usersResult.data ?? []);
  const groups = z.array(groupRowSchema).parse(groupsResult.data ?? []);
  let count = 0;

  for (const group of groups) {
    const user = users.find((item) => item.couple_id === group.couple_id);
    if (!user) continue;
    try {
      const report = await (generateReportOverride ?? generateReport)(
        { env, db, user },
        {
          question: `${month} 共同帳月報`,
          scope: "shared",
          month,
          reportType: "monthly_health",
          groupId: group.id,
        },
      );
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
    try {
      const report = await (generateReportOverride ?? generateReport)(
        { env, db, user },
        {
          question: `${month} 私人帳月報`,
          scope: "private",
          month,
          reportType: "monthly_health",
        },
      );
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

/**
 * The exact prompt the LLM sees when generating a report. It is
 * deliberately structured to match `accountantLlmReportSchema` and to
 * carry the snapshot's `facts` so the LLM cannot fabricate new
 * numbers.
 */
function accountantPrompt(
  question: string,
  snapshot: Awaited<ReturnType<typeof loadAccountantSnapshot>>,
) {
  return {
    question,
    facts: snapshot.facts,
    categoryTotals: snapshot.categoryTotals,
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
      tag: expense.tag,
      amountTwd: expense.amount_twd,
      date: expense.expense_date,
      splitMethod: expense.split_method,
      version: expense.version,
    })),
  };
}
