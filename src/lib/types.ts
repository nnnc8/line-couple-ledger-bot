export type User = { id: string; role: "owner" | "partner"; label: string };

export type Group = {
  id: string;
  name: string;
  color: string;
  archived_at: string | null;
};

export type Expense = {
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

export type DashboardData = {
  monthlyTotalTwd: number;
  monthlyCount: number;
  categoryTotals: Record<string, number>;
  trend: Array<{ month: string; totalTwd: number }>;
  recent: Expense[];
};

export type SettlementView = {
  id: string;
  group_id: string;
  from_user_id: string;
  to_user_id: string;
  amount_twd: number;
  created_at: string;
};

export type Bootstrap = {
  today: string;
  month: string;
  user: User;
  users: User[];
  groups: Group[];
  activeGroupId: string;
  expenses: Expense[];
  sharedExpenses: Expense[];
  privateExpenses: Expense[];
  balances: Array<{ user_id: string; balance_twd: number }>;
  settlements: SettlementView[];
  recurring: Array<{
    id: string;
    description: string;
    amount_twd: number;
    frequency: string;
    next_run_date: string;
    active: boolean;
  }>;
  dashboard: DashboardData;
  privateDashboard: DashboardData;
  openTasks: Array<{
    id: string;
    type: string;
    title: string;
    summary: string | null;
    priority: "low" | "normal" | "high";
    status: string;
  }>;
  recentEvents: Array<{
    id: string;
    kind: string;
    status: string;
    input_text: string | null;
    reply_text: string | null;
    created_at: string;
  }>;
};

export type CategoryAnalytics = {
  range: "this_month" | "six_months" | "all";
  scope: "shared" | "private" | "combined";
  totalTwd: number;
  count: number;
  categories: Array<{
    tag: string;
    totalTwd: number;
    count: number;
    percent: number;
  }>;
};
