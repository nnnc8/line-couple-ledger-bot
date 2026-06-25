export type BalanceContribution = {
  expenseId: string;
  description: string;
  amountTwd: number;
  expenseDate: string;
};

type SplitExpense = {
  id: string;
  description: string;
  amount_twd: number;
  expense_date: string;
  paid_by_user_id: string;
  deleted_at: string | null;
  ledger: "shared" | "private";
  expense_splits: Array<{ user_id: string; amount_twd: number }>;
};

/** Expenses that contribute to the current balance, sorted by amount desc. */
export function balanceContributions(
  expenses: SplitExpense[],
  userId: string,
  myBalance: number,
): BalanceContribution[] {
  if (myBalance === 0) return [];

  const items: BalanceContribution[] = [];
  for (const expense of expenses) {
    if (expense.deleted_at || expense.ledger !== "shared") continue;
    const mySplit =
      expense.expense_splits.find((split) => split.user_id === userId)
        ?.amount_twd ?? 0;
    const partnerSplit = expense.expense_splits
      .filter((split) => split.user_id !== userId)
      .reduce((sum, split) => sum + split.amount_twd, 0);
    const paidByMe = expense.paid_by_user_id === userId;
    const contribution = paidByMe ? partnerSplit : -mySplit;
    if (contribution === 0) continue;
    if (myBalance > 0 && contribution <= 0) continue;
    if (myBalance < 0 && contribution >= 0) continue;
    items.push({
      expenseId: expense.id,
      description: expense.description,
      amountTwd: Math.abs(contribution),
      expenseDate: expense.expense_date,
    });
  }

  return items.sort((a, b) => b.amountTwd - a.amountTwd).slice(0, 8);
}
