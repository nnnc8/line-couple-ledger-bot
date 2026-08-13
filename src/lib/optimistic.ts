import type { ActionInput } from "./pending-action-types";
import { splitEqual } from "./ledger";

export type OptimisticExpense = {
  id: string;
  group_id: string | null;
  ledger: "shared" | "private";
  description: string;
  merchant: string | null;
  notes: string | null;
  tag: string;
  mirror_kind: "shared_share" | null;
  mirror_source_expense_id: string | null;
  amount_twd: number;
  paid_by_user_id: string;
  created_by_user_id: string;
  expense_date: string;
  split_method: "equal" | "exact" | "percentage";
  version: number;
  deleted_at: string | null;
  expense_splits: Array<{ user_id: string; amount_twd: number }>;
  _optimistic?: boolean;
};

export type BootstrapLike = {
  user: { id: string };
  users: Array<{ id: string; label: string }>;
  activeGroupId: string;
  month: string;
  expenses: OptimisticExpense[];
  sharedExpenses: OptimisticExpense[];
  privateExpenses: OptimisticExpense[];
  balances: Array<{ user_id: string; balance_twd: number }>;
  groupBalances: Record<string, Array<{ user_id: string; balance_twd: number }>>;
  dashboard: {
    monthlyTotalTwd: number;
    monthlyCount: number;
    categoryTotals: Record<string, number>;
    trend: Array<{ month: string; totalTwd: number }>;
    recent: OptimisticExpense[];
  };
  privateDashboard: BootstrapLike["dashboard"];
};

export type ExpenseInput = {
  ledger: "shared" | "private";
  groupId: string | null;
  description: string;
  merchant: string | null;
  notes: string | null;
  tag: string;
  amountTwd: number;
  paidBy: "self" | "partner";
  expenseDate: string;
  splitMethod: "equal" | "exact" | "percentage";
  selfValue?: number | null;
  partnerValue?: number | null;
};

export type PendingActionInput = ActionInput;

export function applyOptimistic(
  data: BootstrapLike,
  action: PendingActionInput,
): BootstrapLike {
  switch (action.type) {
    case "create_expense":
      return addExpense(data, action.expense, tempId("create"));
    case "batch_create_expenses":
      return action.expenses.reduce(
        (current, expense, index) =>
          addExpense(current, expense, tempId(`batch-${index}`)),
        data,
      );
    case "update_expense":
      return patchExpense(data, action.expenseId, (expense) =>
        buildExpenseFromInput(
          data,
          action.expense,
          expense.id,
          action.expectedVersion + 1,
        ),
      );
    case "delete_expense":
      return patchExpense(data, action.expenseId, (expense) => ({
        ...expense,
        deleted_at: new Date().toISOString(),
        version: expense.version + 1,
      }));
    case "restore_expense":
      return patchExpense(data, action.expenseId, (expense) => ({
        ...expense,
        deleted_at: null,
        version: expense.version + 1,
      }));
    case "settle":
    case "transfer":
    case "void_settlement":
      // Balance-changing actions are reloaded from the authoritative result;
      // optimistic math would be wrong for full settle and concurrent writes.
      return data;
    default:
      return data;
  }
}

function addExpense(
  data: BootstrapLike,
  input: ExpenseInput,
  id: string,
): BootstrapLike {
  const expense = buildExpenseFromInput(data, input, id, 1);
  expense._optimistic = true;
  const next = {
    ...data,
    expenses: [expense, ...data.expenses],
    sharedExpenses:
      expense.ledger === "shared"
        ? [expense, ...data.sharedExpenses]
        : data.sharedExpenses,
    privateExpenses:
      expense.ledger === "private"
        ? [expense, ...data.privateExpenses]
        : data.privateExpenses,
  };
  return applyExpenseBalanceDelta(next, null, expense);
}

function buildExpenseFromInput(
  data: BootstrapLike,
  input: ExpenseInput,
  id: string,
  version: number,
): OptimisticExpense {
  const partner = data.users.find((user) => user.id !== data.user.id);
  const payerId =
    input.ledger === "private"
      ? data.user.id
      : input.paidBy === "self"
        ? data.user.id
        : partner?.id ?? data.user.id;
  const splits =
    input.ledger === "private"
      ? [{ user_id: data.user.id, amount_twd: input.amountTwd }]
      : input.splitMethod === "equal"
        ? Object.entries(
            splitEqual(input.amountTwd, payerId, partner?.id ?? payerId),
          ).map(([user_id, amount_twd]) => ({ user_id, amount_twd }))
        : [
            {
              user_id: data.user.id,
              amount_twd: input.selfValue ?? 0,
            },
            {
              user_id: partner?.id ?? data.user.id,
              amount_twd: input.partnerValue ?? 0,
            },
          ];
  return {
    id,
    group_id: input.ledger === "shared" ? input.groupId : null,
    ledger: input.ledger,
    description: input.description,
    merchant: input.merchant,
    notes: input.notes,
    tag: input.tag || "其他",
    mirror_kind: null,
    mirror_source_expense_id: null,
    amount_twd: input.amountTwd,
    paid_by_user_id: payerId,
    created_by_user_id: data.user.id,
    expense_date: input.expenseDate,
    split_method: input.splitMethod,
    version,
    deleted_at: null,
    expense_splits: splits,
  };
}

function patchExpense(
  data: BootstrapLike,
  expenseId: string,
  updater: (expense: OptimisticExpense) => OptimisticExpense,
): BootstrapLike {
  const mapList = (items: OptimisticExpense[]) =>
    items.map((item) => (item.id === expenseId ? updater(item) : item));
  const previous = data.expenses.find((item) => item.id === expenseId) ?? null;
  const next = {
    ...data,
    expenses: mapList(data.expenses),
    sharedExpenses: mapList(data.sharedExpenses),
    privateExpenses: mapList(data.privateExpenses),
  };
  const updated = next.expenses.find((item) => item.id === expenseId);
  if (updated) updated._optimistic = true;
  return updated ? applyExpenseBalanceDelta(next, previous, updated) : next;
}

/**
 * Keep the legacy UI's visible balance projection in sync with an optimistic
 * expense mutation. The server remains authoritative; this only applies the
 * exact payment-minus-share delta for the affected shared group.
 */
export function applyExpenseBalanceDelta(
  data: BootstrapLike,
  before: OptimisticExpense | null,
  after: OptimisticExpense | null,
): BootstrapLike {
  const deltasByGroup = new Map<string, Map<string, number>>();
  const add = (expense: OptimisticExpense | null, sign: number) => {
    if (!expense || expense.ledger !== "shared" || expense.deleted_at || !expense.group_id) return;
    const delta = deltasByGroup.get(expense.group_id) ?? new Map<string, number>();
    delta.set(expense.paid_by_user_id, (delta.get(expense.paid_by_user_id) ?? 0) + sign * expense.amount_twd);
    for (const split of expense.expense_splits) {
      delta.set(split.user_id, (delta.get(split.user_id) ?? 0) - sign * split.amount_twd);
    }
    deltasByGroup.set(expense.group_id, delta);
  };
  add(before, -1);
  add(after, 1);
  if (!deltasByGroup.size) return data;

  const groupBalances = { ...data.groupBalances };
  const affectedGroups = new Set([before?.group_id, after?.group_id].filter((value): value is string => Boolean(value)));
  for (const groupId of affectedGroups) {
    const current = groupBalances[groupId] ?? [];
    const delta = deltasByGroup.get(groupId) ?? new Map<string, number>();
    groupBalances[groupId] = current.map((row) => ({
      ...row,
      balance_twd: row.balance_twd + (delta.get(row.user_id) ?? 0),
    }));
  }
  const activeDelta = data.activeGroupId ? deltasByGroup.get(data.activeGroupId) : null;
  const balances = activeDelta
    ? data.balances.map((row) => ({ ...row, balance_twd: row.balance_twd + (activeDelta.get(row.user_id) ?? 0) }))
    : data.balances;
  return { ...data, balances, groupBalances };
}

function tempId(prefix: string): string {
  return `temp_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
