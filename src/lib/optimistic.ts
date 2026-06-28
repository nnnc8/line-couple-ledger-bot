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
  receipts: Array<{ id: string; status: string }>;
  expense_splits: Array<{ user_id: string; amount_twd: number }>;
  _optimistic?: boolean;
};

type BootstrapLike = {
  user: { id: string };
  users: Array<{ id: string; label: string }>;
  activeGroupId: string;
  month: string;
  expenses: OptimisticExpense[];
  sharedExpenses: OptimisticExpense[];
  privateExpenses: OptimisticExpense[];
  balances: Array<{ user_id: string; balance_twd: number }>;
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
  receiptId?: string | null;
};

export type PendingActionInput =
  | { type: "create_expense"; expense: ExpenseInput }
  | {
      type: "update_expense";
      expenseId: string;
      expectedVersion: number;
      expense: ExpenseInput;
    }
  | {
      type: "delete_expense";
      expenseId: string;
      expectedVersion: number;
    }
  | {
      type: "restore_expense";
      expenseId: string;
      expectedVersion: number;
    }
  | { type: "settle"; groupId: string; amountTwd: number }
  | { type: "batch_create_expenses"; expenses: ExpenseInput[] };

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
      return settleBalance(data, action.amountTwd);
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
  return refreshDashboards(next, expense);
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
    receipts: input.receiptId ? [{ id: input.receiptId, status: "ready" }] : [],
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
  const next = {
    ...data,
    expenses: mapList(data.expenses),
    sharedExpenses: mapList(data.sharedExpenses),
    privateExpenses: mapList(data.privateExpenses),
  };
  const updated = next.expenses.find((item) => item.id === expenseId);
  return updated ? refreshDashboards(next, updated) : next;
}

function settleBalance(data: BootstrapLike, amountTwd: number): BootstrapLike {
  const mine =
    data.balances.find((item) => item.user_id === data.user.id)?.balance_twd ??
    0;
  const partnerId = data.users.find((user) => user.id !== data.user.id)?.id;
  if (!partnerId || mine === 0) return data;
  const nextMine =
    mine > 0 ? Math.max(0, mine - amountTwd) : Math.min(0, mine + amountTwd);
  const nextPartner = -nextMine;
  return {
    ...data,
    balances: data.balances.map((item) => {
      if (item.user_id === data.user.id) return { ...item, balance_twd: nextMine };
      if (item.user_id === partnerId)
        return { ...item, balance_twd: nextPartner };
      return item;
    }),
  };
}

function refreshDashboards(
  data: BootstrapLike,
  expense: OptimisticExpense,
): BootstrapLike {
  const activeShared = data.sharedExpenses.filter((item) => !item.deleted_at);
  const activePrivate = data.privateExpenses.filter((item) => !item.deleted_at);
  return {
    ...data,
    dashboard: buildDashboard(activeShared, data.month),
    privateDashboard: buildDashboard(activePrivate, data.month),
    balances: adjustBalanceForExpense(data, expense),
  };
}

function adjustBalanceForExpense(
  data: BootstrapLike,
  expense: OptimisticExpense,
): BootstrapLike["balances"] {
  if (expense.ledger !== "shared" || expense.deleted_at) return data.balances;
  const partnerId = data.users.find((user) => user.id !== data.user.id)?.id;
  if (!partnerId) return data.balances;
  const mySplit =
    expense.expense_splits.find((split) => split.user_id === data.user.id)
      ?.amount_twd ?? 0;
  const partnerSplit =
    expense.expense_splits.find((split) => split.user_id === partnerId)
      ?.amount_twd ?? 0;
  const delta =
    expense.paid_by_user_id === data.user.id ? partnerSplit : -mySplit;
  return data.balances.map((item) =>
    item.user_id === data.user.id
      ? { ...item, balance_twd: item.balance_twd + delta }
      : item,
  );
}

function buildDashboard(
  expenses: OptimisticExpense[],
  month: string,
): BootstrapLike["dashboard"] {
  const trend = Array.from({ length: 6 }, (_, index) => ({
    month: shiftMonth(month, index - 5),
    totalTwd: 0,
  }));
  const categoryTotals: Record<string, number> = {};
  for (const expense of expenses) {
    const expenseMonth = expense.expense_date.slice(0, 7);
    const point = trend.find((item) => item.month === expenseMonth);
    if (point) point.totalTwd += expense.amount_twd;
    if (expenseMonth === month) {
      const label = expense.tag || "其他";
      categoryTotals[label] = (categoryTotals[label] ?? 0) + expense.amount_twd;
    }
  }
  const thisMonth = expenses.filter((expense) =>
    expense.expense_date.startsWith(month),
  );
  return {
    monthlyTotalTwd: thisMonth.reduce(
      (sum, expense) => sum + expense.amount_twd,
      0,
    ),
    monthlyCount: thisMonth.length,
    categoryTotals,
    trend,
    recent: expenses.slice(0, 8),
  };
}

function shiftMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year!, monthNumber! - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function tempId(prefix: string): string {
  return `temp_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
