/**
 * accountant-analytics — read-side analytics tools.
 *
 * Each function in this file corresponds 1:1 to a tool the AI agent
 * can call (`get_category_breakdown`, `compare_period`, etc.). They all
 * share the same shape:
 *   1. list the relevant expenses through `listToolExpenses`
 *   2. compute the requested aggregation
 *   3. return a JSON-serializable summary
 *
 * The owning class on `accountant-service.ts` re-exports these as
 * methods; the underlying contracts are unchanged.
 */
import { loadGroupBalances } from "./balance-loader";
import type { AgentExpense } from "./ledger-agent";
import { detectDuplicateAgentExpenses } from "./ledger-agent";
import type { LedgerVisibleExpense } from "./ledger-query";
import {
  breakdownByKey,
  listToolExpenses,
  shiftMonth,
  taipeiToday,
} from "./accountant-loaders";

export interface AccountantToolContext {
  db: import("@supabase/supabase-js").SupabaseClient;
  groupId: string;
  userId: string;
  coupleId: number;
}

function toToolAgentExpense(
  expense: LedgerVisibleExpense,
  context: AccountantToolContext,
): AgentExpense {
  return {
    id: expense.id,
    group_id: expense.ledger === "private" ? null : context.groupId,
    ledger: expense.ledger,
    description: expense.description,
    merchant: expense.merchant,
    tag: expense.tag,
    mirror_kind: null,
    mirror_source_expense_id: null,
    amount_twd: expense.amount_twd,
    paid_by_user_id: expense.paid_by_user_id,
    created_by_user_id: context.userId,
    expense_date: expense.expense_date,
    version: 1,
    deleted_at: null,
  };
}

export async function categoryBreakdown(
  context: AccountantToolContext,
  params: { dateFrom: string; dateTo: string },
) {
  const expenses = await listToolExpenses(context, {
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    limitPerLedger: 500,
  });
  const totals = new Map<string, { total: number; count: number }>();
  for (const e of expenses) {
    const key = e.tag;
    const current = totals.get(key) ?? { total: 0, count: 0 };
    current.total += e.amount_twd;
    current.count += 1;
    totals.set(key, current);
  }
  const grand = expenses.reduce((sum, e) => sum + e.amount_twd, 0);
  return {
    total: grand,
    count: expenses.length,
    breakdown: [...totals.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 15)
      .map(([label, data]) => ({
        label,
        total: data.total,
        count: data.count,
        percent: grand ? Math.round((data.total / grand) * 100) : 0,
      })),
  };
}

export async function comparePeriods(
  context: AccountantToolContext,
  params: {
    periodA: { from: string; to: string };
    periodB: { from: string; to: string };
  },
) {
  const [expA, expB] = await Promise.all([
    listToolExpenses(context, {
      dateFrom: params.periodA.from,
      dateTo: params.periodA.to,
      limitPerLedger: 500,
    }),
    listToolExpenses(context, {
      dateFrom: params.periodB.from,
      dateTo: params.periodB.to,
      limitPerLedger: 500,
    }),
  ]);

  const totalA = expA.reduce((s, e) => s + e.amount_twd, 0);
  const totalB = expB.reduce((s, e) => s + e.amount_twd, 0);

  const aMap = breakdownByKey(expA);
  const bMap = breakdownByKey(expB);
  const allKeys = new Set([...aMap.keys(), ...bMap.keys()]);
  const comparison = [...allKeys]
    .map((label) => ({
      label,
      period_a: aMap.get(label) ?? 0,
      period_b: bMap.get(label) ?? 0,
      change: (aMap.get(label) ?? 0) - (bMap.get(label) ?? 0),
    }))
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, 10);

  return {
    period_a: { total: totalA, count: expA.length },
    period_b: { total: totalB, count: expB.length },
    change_percent: totalB
      ? Math.round(((totalA - totalB) / totalB) * 100)
      : null,
    comparison,
  };
}

export async function anomalies(
  context: AccountantToolContext,
  params: { dateFrom?: string; dateTo?: string },
) {
  const expenses = await listToolExpenses(context, {
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    limitPerLedger: 500,
  });
  const agentExpenses = expenses.map((e) => toToolAgentExpense(e, context));
  const duplicates = detectDuplicateAgentExpenses(agentExpenses);
  return {
    duplicate_groups: duplicates.slice(0, 5).map((group) =>
      group.map((e) => ({
        id: e.id,
        description: e.description,
        amount: e.amount_twd,
        date: e.expense_date,
      })),
    ),
    total_groups: duplicates.length,
  };
}

export async function categoryTrend(
  context: AccountantToolContext,
  params: { tag: string; months: number },
) {
  const today = taipeiToday();
  const currentMonth = today.slice(0, 7);
  const months: string[] = [];
  for (let i = params.months - 1; i >= 0; i--) {
    months.push(shiftMonth(currentMonth, -i));
  }
  const startDate = `${months[0]}-01`;
  const endDate = `${shiftMonth(currentMonth, 1)}-01`;

  const expenses = await listToolExpenses(context, {
    dateFrom: startDate,
    dateTo: endDate,
    tag: params.tag,
    limitPerLedger: 500,
  });

  const trend = months.map((m) => {
    const monthExpenses = expenses.filter((e) =>
      e.expense_date.startsWith(`${m}-`),
    );
    return {
      month: m,
      total: monthExpenses.reduce((s, e) => s + e.amount_twd, 0),
      count: monthExpenses.length,
    };
  });

  return { tag: params.tag, trend };
}

export async function predictMonthEnd(
  context: AccountantToolContext,
  params: { tag?: string },
) {
  const today = taipeiToday();
  const month = today.slice(0, 7);
  const daysElapsed = Number(today.slice(8, 10));
  const daysTotal = new Date(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)),
    0,
  ).getDate();

  if (daysElapsed < 4) {
    return {
      message: "月初資料不足，無法預測",
      days_elapsed: daysElapsed,
      days_total: daysTotal,
    };
  }

  const expenses = await listToolExpenses(context, {
    dateFrom: `${month}-01`,
    dateTo: `${shiftMonth(month, 1)}-01`,
    tag: params.tag,
    limitPerLedger: 500,
  });

  const spentSoFar = expenses.reduce((s, e) => s + e.amount_twd, 0);
  const projectedTotal = Math.round((spentSoFar / daysElapsed) * daysTotal);

  return {
    days_elapsed: daysElapsed,
    days_total: daysTotal,
    spent_so_far: spentSoFar,
    projected_total: projectedTotal,
  };
}

export async function analyzeSpending(
  context: AccountantToolContext,
  params: { dateFrom?: string; dateTo?: string },
) {
  const today = taipeiToday();
  const monthStart = today.slice(0, 7) + "-01";
  const dateFrom = params.dateFrom ?? monthStart;
  const dateTo = params.dateTo ?? today;

  const [expenses, balanceResult, lastMonthExpenses] = await Promise.all([
    listToolExpenses(context, {
      dateFrom,
      dateTo,
      type: "shared",
      limitPerLedger: 500,
    }),
    loadGroupBalances(context.db, context.groupId)
      .then((data) => ({ data, error: null as null }))
      .catch((error: unknown) => ({
        data: null as Array<{ userId: string; balanceTwd: number }> | null,
        error: error instanceof Error ? error : new Error(String(error)),
      })),
    loadLastMonthExpenses(context, dateFrom),
  ]);

  const agentExpenses = expenses.map((e) => toToolAgentExpense(e, context));
  const anomalies = detectDuplicateAgentExpenses(agentExpenses);

  const total = expenses.reduce((s, e) => s + e.amount_twd, 0);
  const byTag = breakdownByKey(expenses);

  const topTags = [...byTag.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, amount]) => ({
      label,
      amount,
      percent: total > 0 ? Math.round((amount / total) * 100) : 0,
    }));

  const daysElapsed = Math.max(
    1,
    Math.floor(
      (new Date(dateTo).getTime() - new Date(dateFrom).getTime()) /
        (1000 * 60 * 60 * 24),
    ) + 1,
  );
  const daysInMonth = new Date(
    new Date(dateFrom).getFullYear(),
    new Date(dateFrom).getMonth() + 1,
    0,
  ).getDate();
  const dailyAvg = Math.round(total / daysElapsed);
  const projected = dailyAvg * daysInMonth;

  const highestSingle = expenses.length > 0
    ? Math.max(...expenses.map((e) => e.amount_twd))
    : 0;

  const merchantCounts = new Map<string, number>();
  for (const e of expenses) {
    if (e.merchant) {
      merchantCounts.set(e.merchant, (merchantCounts.get(e.merchant) ?? 0) + 1);
    }
  }
  const mostFrequentMerchant = merchantCounts.size > 0
    ? [...merchantCounts.entries()]
        .sort((a, b) => b[1] - a[1])[0]
    : null;

  const lastMonthTotal = lastMonthExpenses.reduce((s, e) => s + e.amount_twd, 0);
  const vsLastMonthPercent = lastMonthTotal > 0
    ? Math.round(((total - lastMonthTotal) / lastMonthTotal) * 100)
    : undefined;

  return {
    period: { from: dateFrom, to: dateTo },
    total,
    transaction_count: expenses.length,
    daily_average: dailyAvg,
    projected_month_end: projected,
    top_tags: topTags,
    highest_single: highestSingle,
    most_frequent_merchant: mostFrequentMerchant
      ? { name: mostFrequentMerchant[0], count: mostFrequentMerchant[1] }
      : undefined,
    vs_last_month_percent: vsLastMonthPercent,
    anomalies: anomalies.length > 0 ? anomalies.slice(0, 3) : undefined,
    balance: !balanceResult.error && balanceResult.data
      ? balanceResult.data.map((row) => ({
          user_id: row.userId,
          balance_twd: row.balanceTwd,
        }))
      : undefined,
  };
}

async function loadLastMonthExpenses(
  context: AccountantToolContext,
  currentDateFrom: string,
) {
  try {
    const fromDate = new Date(currentDateFrom);
    const lastMonthStart = new Date(
      fromDate.getFullYear(),
      fromDate.getMonth() - 1,
      1,
    );
    const lastMonthEnd = new Date(fromDate.getFullYear(), fromDate.getMonth(), 0);
    const fromStr = lastMonthStart.toISOString().slice(0, 10);
    const toStr = lastMonthEnd.toISOString().slice(0, 10);
    return listToolExpenses(context, {
      dateFrom: fromStr,
      dateTo: toStr,
      type: "shared",
      limitPerLedger: 500,
    });
  } catch {
    return [];
  }
}
