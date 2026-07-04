/**
 * ledger-query-bootstrap — single round-trip loader for the LIFF
 * dashboard. Resolves users, groups, active group, six months of
 * shared + private expenses, balances, recurring list, and recent
 * notifications, then assembles the bootstrap payload (including
 * shared / private dashboards).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { splitBootstrapExpenses } from "./category-agent";
import { HttpError } from "./http-error";
import { loadGroupBalances } from "./balance-loader";
import { shiftMonth, taipeiToday } from "./ledger-shared";
import {
  buildDashboard,
  expenseSchema,
  EXPENSE_SELECT,
  groupSchema,
  publicUser,
  userSchema,
  type AppUser,
} from "./ledger-query-core";

export async function loadBootstrap(context: {
  db: SupabaseClient;
  user: AppUser;
}) {
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
    loadGroupBalances(db, activeGroupId)
      .then((data) => ({ data, error: null as null }))
      .catch((error: unknown) => ({
        data: null as Array<{ userId: string; balanceTwd: number }> | null,
        error: error instanceof Error ? error : new Error(String(error)),
      })),
    db
      .from("recurring_expenses")
      .select(
        "id, group_id, ledger, description, tag, amount_twd, frequency, next_run_date, active",
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
  const balances = (balancesResult.data ?? []).map((row) => ({
    user_id: row.userId,
    balance_twd: row.balanceTwd,
  }));
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
    recurring: recurringResult.data,
    notifications: notificationsResult.data,
    dashboard: buildDashboard(activeShared, month),
    privateDashboard: buildDashboard(activePrivate, month),
  };
}
