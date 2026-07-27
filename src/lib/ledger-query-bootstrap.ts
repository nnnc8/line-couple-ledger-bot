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
import { getOpenTasks } from "./secretary-tasks";
import { getRecentEvents } from "./agent-event-service";

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
    groupBalancesResult,
    settlementsResult,
    recurringResult,
    notificationsResult,
    openTasks,
    recentEvents,
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
    Promise.all(
      groups
        .filter((group) => !group.archived_at)
        .map(async (group) => [group.id, await loadGroupBalances(db, group.id)] as const),
    )
      .then((entries) => ({ data: Object.fromEntries(entries), error: null as null }))
      .catch((error: unknown) => ({
        data: null as Record<
          string,
          Array<{ userId: string; balanceTwd: number }>
        > | null,
        error: error instanceof Error ? error : new Error(String(error)),
      })),
    db
      .from("settlements")
      .select(
        "id, group_id, from_user_id, to_user_id, amount_twd, intent, occurred_on, notes, voided_at, voided_by_user_id, version, created_at, source_action:pending_actions!settlements_source_action_id_fkey(requested_by_user_id)",
      )
      .eq("couple_id", user.couple_id)
      .eq("group_id", activeGroupId)
      .order("created_at", { ascending: false })
      .limit(200),
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
    getOpenTasks(db, { coupleId: user.couple_id, limit: 10 })
      .then((data) => ({ data, error: null as null }))
      .catch((error: unknown) => ({
        data: null as Awaited<ReturnType<typeof getOpenTasks>> | null,
        error: error instanceof Error ? error : new Error(String(error)),
      })),
    getRecentEvents(db, user.couple_id, { limit: 10 })
      .then((data) => ({ data, error: null as null }))
      .catch((error: unknown) => ({
        data: null as Awaited<ReturnType<typeof getRecentEvents>> | null,
        error: error instanceof Error ? error : new Error(String(error)),
      })),
  ]);
  if (
    sharedResult.error ||
    privateResult.error ||
    groupBalancesResult.error ||
    settlementsResult.error ||
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
  const groupBalances: Record<
    string,
    Array<{ user_id: string; balance_twd: number }>
  > = Object.fromEntries(
    Object.entries(groupBalancesResult.data ?? {}).map(([groupId, rows]) => [
      groupId,
      rows.map((row) => ({
        user_id: row.userId,
        balance_twd: row.balanceTwd,
      })),
    ]),
  );
  const balances = groupBalances[activeGroupId] ?? [];
  const settlements = z
    .array(z.object({
      id: z.string().uuid(),
      group_id: z.string().uuid(),
      from_user_id: z.string().uuid(),
      to_user_id: z.string().uuid(),
      amount_twd: z.coerce.number().int().positive(),
      intent: z.enum(["settle", "transfer"]),
      occurred_on: z.iso.date(),
      notes: z.string().nullable(),
      voided_at: z.string().nullable(),
      voided_by_user_id: z.string().uuid().nullable(),
      version: z.coerce.number().int().positive(),
      created_at: z.string(),
      source_action: z
        .object({ requested_by_user_id: z.string().uuid() })
        .nullable(),
    }))
    .parse(settlementsResult.data ?? [])
    .map(({ source_action: sourceAction, ...settlement }) => ({
      ...settlement,
      recorded_by_user_id: sourceAction?.requested_by_user_id ?? null,
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
    groupBalances,
    settlements,
    recurring: recurringResult.data,
    notifications: notificationsResult.data,
    dashboard: buildDashboard(activeShared, month),
    privateDashboard: buildDashboard(activePrivate, month),
    openTasks: openTasks.data ?? [],
    recentEvents: recentEvents.data ?? [],
  };
}
