export type ExpenseSearchRow = {
  id: string;
  description: string;
  merchant?: string | null;
  notes?: string | null;
  category?: string | null;
  category_label?: string | null;
  amount_twd: number;
  expense_date: string;
  deleted_at?: string | null;
};

export type ExpenseSearchInput = {
  q?: string | null;
  from?: string | null;
  to?: string | null;
  category?: string | null;
  min?: number | null;
  max?: number | null;
  limit?: number | null;
};

export function searchExpenseRows<T extends ExpenseSearchRow>(
  rows: T[],
  input: ExpenseSearchInput,
): T[] {
  const terms = normalize(input.q)
    .split(/\s+/)
    .filter(Boolean);
  const category = normalize(input.category);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  return rows
    .filter((row) => {
      if (row.deleted_at) return false;
      if (input.from && row.expense_date < input.from) return false;
      if (input.to && row.expense_date > input.to) return false;
      if (input.min != null && row.amount_twd < input.min) return false;
      if (input.max != null && row.amount_twd > input.max) return false;
      const haystack = normalize(
        [
          row.description,
          row.merchant,
          row.notes,
          row.category,
          row.category_label,
        ].join(" "),
      );
      if (terms.length && !terms.every((term) => haystack.includes(term)))
        return false;
      if (
        category &&
        normalize(`${row.category ?? ""} ${row.category_label ?? ""}`) !==
          category &&
        !normalize(`${row.category ?? ""} ${row.category_label ?? ""}`).includes(
          category,
        )
      )
        return false;
      return true;
    })
    .sort((a, b) => b.expense_date.localeCompare(a.expense_date))
    .slice(0, limit);
}

export function shouldSendInsight(
  recent: Array<{ insight_rule_id?: string | null; created_at: string }>,
  ruleId: string,
  now = new Date(),
): boolean {
  const cutoff = now.getTime() - 3 * 24 * 60 * 60 * 1_000;
  return !recent.some(
    (item) =>
      item.insight_rule_id === ruleId &&
      new Date(item.created_at).getTime() > cutoff,
  );
}

function normalize(value?: string | null): string {
  return (value ?? "").trim().toLowerCase();
}
