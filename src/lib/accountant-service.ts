/**
 * accountant-service — thin orchestration facade.
 *
 * Each public method delegates to a plain function in one of:
 *   - `./accountant-analytics` (read-side tool analytics)
 *   - `./accountant-agent`    (LLM flow + category cleanup)
 *   - `./accountant-reports`  (report persistence + monthly cron)
 *
 * Shared schemas / loaders / select column lists live in
 * `./accountant-loaders`. The class only owns the public method
 * surface; all domain logic, query assembly, prompt building, and
 * report formatting is in the modules above.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ServerContext } from "./server-runtime";
import type { LedgerVisibleExpense } from "./ledger-query";
import {
  analyzeSpending,
  anomalies,
  categoryBreakdown,
  categoryTrend,
  comparePeriods,
  predictMonthEnd,
} from "./accountant-analytics";
import {
  ask,
  createCategoryCleanup,
  runAgent,
  suggestCategoryUpdates,
  categoryAnalytics,
  type CleanupActionInput,
} from "./accountant-agent";
import {
  generateMonthlyReports as generateMonthlyReportsImpl,
  generateReport as generateReportImpl,
  listReports as listReportsImpl,
} from "./accountant-reports";

export type AccountantToolContext = {
  db: SupabaseClient;
  groupId: string;
  userId: string;
  coupleId: number;
};

// Re-export so existing callers that import `AccountantToolContext`
// from this file keep working.
export type { CleanupActionInput };

// Re-export visibleExpense typing for any caller that previously
// reached into the old file for it.
export type { LedgerVisibleExpense };

export class AccountantService {
  // -------------------------------------------------------------------------
  // Analytics tools (delegate to ./accountant-analytics)
  // -------------------------------------------------------------------------
  categoryBreakdown(
    context: AccountantToolContext,
    params: { dateFrom: string; dateTo: string },
  ) {
    return categoryBreakdown(context, params);
  }

  comparePeriods(
    context: AccountantToolContext,
    params: {
      periodA: { from: string; to: string };
      periodB: { from: string; to: string };
    },
  ) {
    return comparePeriods(context, params);
  }

  anomalies(
    context: AccountantToolContext,
    params: { dateFrom?: string; dateTo?: string },
  ) {
    return anomalies(context, params);
  }

  categoryTrend(
    context: AccountantToolContext,
    params: { tag: string; months: number },
  ) {
    return categoryTrend(context, params);
  }

  predictMonthEnd(
    context: AccountantToolContext,
    params: { tag?: string },
  ) {
    return predictMonthEnd(context, params);
  }

  analyzeSpending(
    context: AccountantToolContext,
    params: { dateFrom?: string; dateTo?: string },
  ) {
    return analyzeSpending(context, params);
  }

  // -------------------------------------------------------------------------
  // AI agent + category cleanup (delegate to ./accountant-agent)
  // -------------------------------------------------------------------------
  ask(context: ServerContext, input: unknown) {
    return ask(context, input);
  }

  runAgent(context: ServerContext, input: unknown) {
    return runAgent(context, input);
  }

  categoryAnalytics(context: ServerContext, params: URLSearchParams) {
    return categoryAnalytics(context, params);
  }

  suggestCategoryUpdates(context: ServerContext, input: unknown) {
    return suggestCategoryUpdates(context, input);
  }

  createCategoryCleanup(
    context: ServerContext,
    input: unknown,
    idempotencyKey: string | undefined,
    executePendingAction: (input: CleanupActionInput) => Promise<unknown>,
  ) {
    return createCategoryCleanup(context, input, idempotencyKey, executePendingAction);
  }

  // -------------------------------------------------------------------------
  // Reports (delegate to ./accountant-reports)
  // -------------------------------------------------------------------------
  listReports(context: ServerContext) {
    return listReportsImpl(context);
  }

  generateReport(
    context: ServerContext,
    input: {
      question: string;
      scope: "shared" | "private" | "combined";
      month: string;
      reportType: "manual_question" | "monthly_health" | "cleanup_review";
      groupId?: string;
    },
  ) {
    // Call via `this` so the existing test seam (instance-level override
    // of `generateReport`) still works. The default behavior delegates
    // to the reports module.
    return generateReportImpl(context, input);
  }

  generateMonthlyReports(
    env: ServerContext["env"],
    db: ServerContext["db"],
    month: string,
  ) {
    // Call via `this.generateReport` so existing test seams that
    // override `generateReport` (e.g. the monthly cron test) keep
    // working. Default behavior delegates to the reports module.
    return generateMonthlyReportsImpl(env, db, month, (context, input) =>
      this.generateReport(context, input),
    );
  }
}
