/**
 * ledger-query — thin orchestration facade.
 *
 * The actual logic for each read-side method lives in one of:
 *   - `./ledger-query-core`     (row schemas, types, helpers)
 *   - `./ledger-query-read`     (queryExpenses, balanceSummary,
 *                                recentExpenses, recurringList,
 *                                listAccessibleExpenses)
 *   - `./ledger-query-bootstrap` (loadBootstrap)
 *   - `./ledger-query-search`   (searchExpenses, categoryExpenses,
 *                                checkExpenseInSettlements,
 *                                activeGroupId)
 *
 * This file only re-exports the public types / values that callers
 * were already reaching for here, and exposes a `LedgerQueryService`
 * class whose methods are one-line delegations to the modules above.
 *
 * The date helpers `taipeiToday` and `shiftMonth` used to live here
 * too, but they have been removed in favor of the canonical
 * `ledger-shared` versions.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  balanceSummary as balanceSummaryImpl,
  listAccessibleExpenses as listAccessibleExpensesImpl,
  queryExpenses as queryExpensesImpl,
  recentExpenses as recentExpensesImpl,
  recurringList as recurringListImpl,
} from "./ledger-query-read";
import { loadBootstrap as loadBootstrapImpl } from "./ledger-query-bootstrap";
import {
  activeGroupId as activeGroupIdImpl,
  categoryExpenses as categoryExpensesImpl,
  checkExpenseInSettlements as checkExpenseInSettlementsImpl,
  searchExpenses as searchExpensesImpl,
} from "./ledger-query-search";

/* -------------------------------------------------------------------------
 * Re-exports of public types and helpers
 *
 * External callers (e.g. `app-server.ts`, `accountant-loaders.ts`,
 * `/api/app/[...path]/route.ts`, `ledger-shared.ts`) have been
 * reaching these from `ledger-query.ts` historically. We keep the
 * path stable so no caller has to change its import.
 * ------------------------------------------------------------------------- */

export {
  ledgerVisibleExpenseSchema,
  ledgerVisibleExpenseQuerySchema,
  type LedgerVisibleExpense,
  type AppUser,
  type AppExpense,
  type QueryExpensesInput,
  type QueryExpensesSummary,
  type QueryExpensesItem,
  type BalanceSummary,
  type RecurringListResult,
  type RecurringItem,
  type RecentExpensesInput,
  type RecentExpensesResult,
  type RecentExpenseItem,
  expensesCsv,
} from "./ledger-query-core";

/* -------------------------------------------------------------------------
 * Service facade
 * ------------------------------------------------------------------------- */

export class LedgerQueryService {
  // ---- Read tools (delegate to ./ledger-query-read) -------------------------
  queryExpenses(
    context: { db: SupabaseClient; groupId: string; userId: string },
    rawInput: Parameters<typeof queryExpensesImpl>[1],
  ) {
    return queryExpensesImpl(context, rawInput);
  }

  balanceSummary(
    context: { db: SupabaseClient; groupId: string; userId: string },
  ) {
    return balanceSummaryImpl(context);
  }

  recentExpenses(
    context: { db: SupabaseClient; groupId: string; userId: string },
    rawInput: Parameters<typeof recentExpensesImpl>[1],
  ) {
    return recentExpensesImpl(context, rawInput);
  }

  recurringList(
    context: { db: SupabaseClient; coupleId: number },
  ) {
    return recurringListImpl(context);
  }

  listAccessibleExpenses(
    db: SupabaseClient,
    input: z.input<
      typeof import("./ledger-query-core").ledgerVisibleExpenseQuerySchema
    >,
  ) {
    return listAccessibleExpensesImpl(db, input);
  }

  // ---- Bootstrap (delegate to ./ledger-query-bootstrap) --------------------
  loadBootstrap(
    context: {
      db: SupabaseClient;
      user: import("./ledger-query-core").AppUser;
    },
  ) {
    return loadBootstrapImpl(context);
  }

  // ---- Search / category / guards (delegate to ./ledger-query-search) -----
  searchExpenses(
    context: { db: SupabaseClient; user: { id: string } },
    searchParams: URLSearchParams,
  ) {
    return searchExpensesImpl(context, searchParams);
  }

  categoryExpenses(
    context: { db: SupabaseClient; user: { id: string } },
    params: URLSearchParams,
  ) {
    return categoryExpensesImpl(context, params);
  }

  checkExpenseInSettlements(
    context: { db: SupabaseClient; user: { couple_id: number } },
    expenseId: string,
  ) {
    return checkExpenseInSettlementsImpl(context, expenseId);
  }
}
