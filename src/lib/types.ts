export type User = { id: string; role: "owner" | "partner"; label: string };

export type Group = {
  id: string;
  name: string;
  color: string;
  archived_at: string | null;
};

export type V2LedgerSummary = {
  id: string;
  name: string;
  color: string;
  status: "active" | "archived";
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type V2AppContext = {
  today: string;
  user: User;
  users: User[];
};

export type V2NextPayer = {
  payerUserId: string;
  payeeUserId: string;
  amountTwd: string;
};

export type V2LedgerBootstrap = {
  ledger: V2LedgerSummary & {
    coupleId: number;
    members: Array<{ userId: string; role: "owner" | "partner" }>;
    defaultShares: Record<string, string>;
  };
  transactions: Array<{
    id: string;
    ledgerId: string;
    type: "expense" | "income" | "transfer";
    amountTwd: string;
    payments: Array<{ userId: string; amountTwd: string }>;
    shares: Array<{ userId: string; amountTwd: string }>;
    status: "posted" | "voided" | "deleted";
    occurredOn?: string;
    description?: string;
    category?: string | null;
    note?: string | null;
    splitMethod?: "none" | "equal" | "exact" | "percentage" | "weights";
    createdAt?: string;
    version?: number;
  }>;
  balance: Record<string, string>;
  nextPayer: V2NextPayer | null;
};

export type V2RecurringRule = {
  id: string;
  ledgerId: string;
  name: string;
  amountTwd: string;
  frequency: "weekly" | "monthly" | "yearly";
  anchorDay: number;
  nextRunDate: string;
  endDate: string | null;
  active: boolean;
  splitMethod: "equal" | "exact" | "percentage" | "weights";
  payments: Array<{ userId: string; amountTwd: string }>;
  shares: Array<{ userId: string; amountTwd: string }>;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type V2Attachment = {
  id: string;
  ledgerId: string;
  transactionId: string | null;
  mimeType: string;
  sizeBytes: number;
  status: "uploaded" | "ready" | "failed" | "deleted";
  createdAt: string;
  url: string | null;
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
  intent: "settle" | "transfer";
  occurred_on: string;
  notes: string | null;
  recorded_by_user_id: string | null;
  voided_at: string | null;
  voided_by_user_id: string | null;
  version: number;
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
  groupBalances: Record<
    string,
    Array<{ user_id: string; balance_twd: number }>
  >;
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
