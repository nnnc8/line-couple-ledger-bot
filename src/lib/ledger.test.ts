import assert from "node:assert/strict";
import test from "node:test";

import { parseFixedIntent, safeSecretEqual } from "./bot";
import { expensesCsv, type AppExpense } from "./app-server";
import {
  accountantFactsMatch,
  buildAccountantSnapshot,
  parseAccountantCommand,
  safeSuggestionAction,
  type AccountantExpense,
} from "./accountant";
import { detectReceiptMime, signSession, verifySession } from "./security";
import {
  calculateBalances,
  crossedBudgetThresholds,
  geminiIntentJsonSchema,
  learnCategoryFromHistory,
  monthlySummary,
  nextRecurringDate,
  parsedIntentSchema,
  receiptExtractionSchema,
  splitEqual,
  splitExact,
  splitPercentage,
  type LedgerExpense,
} from "./ledger";

const OWNER = "owner";
const PARTNER = "partner";
const GROUP = "00000000-0000-4000-8000-000000000003";

test("routes fixed commands without calling the LLM", () => {
  assert.equal(parseFixedIntent("誰欠誰")?.intent, "balance");
  assert.equal(parseFixedIntent("本月共同支出")?.intent, "shared_monthly");
  assert.equal(parseFixedIntent("本月私人支出")?.intent, "private_monthly");
  assert.equal(parseFixedIntent("刪除剛剛那筆")?.intent, "delete_last");
  assert.equal(parseFixedIntent("結清")?.intent, "settle");
  assert.equal(parseFixedIntent("晚餐 860 我付"), null);
});

test("routes accountant commands before the expense parser", () => {
  assert.deepEqual(parseAccountantCommand("會計師 本月哪裡花太多"), {
    question: "本月哪裡花太多",
    scope: "combined",
  });
  assert.deepEqual(parseAccountantCommand("分析 私人 這月花費"), {
    question: "私人 這月花費",
    scope: "private",
  });
  assert.equal(parseAccountantCommand("晚餐 860 我付"), null);
});

test("compares setup codes without accepting different lengths", () => {
  assert.equal(safeSecretEqual("correct-code", "correct-code"), true);
  assert.equal(safeSecretEqual("correct-code", "wrong"), false);
});

test("rejects tampered and expired application sessions", () => {
  const secret = "x".repeat(32);
  const token = signSession(
    { userId: "user", lineUserId: "line", expiresAt: 2_000 },
    secret,
  );
  assert.equal(verifySession(token, secret, 1_999)?.userId, "user");
  assert.equal(verifySession(`${token}x`, secret, 1_999), null);
  assert.equal(verifySession(token, secret, 2_001), null);
});

test("accepts receipt formats by bytes instead of browser MIME claims", () => {
  assert.equal(detectReceiptMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(
    detectReceiptMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "image/png",
  );
  assert.equal(detectReceiptMime(Buffer.from("not an image")), null);
});

test("neutralizes spreadsheet formulas in CSV exports", () => {
  const row: AppExpense = {
    id: "00000000-0000-4000-8000-000000000001",
    group_id: "00000000-0000-4000-8000-000000000002",
    ledger: "shared",
    description: "=HYPERLINK(\"https://evil\")",
    merchant: null,
    notes: null,
    category: "other",
    amount_twd: 1,
    paid_by_user_id: "00000000-0000-4000-8000-000000000003",
    created_by_user_id: "00000000-0000-4000-8000-000000000003",
    expense_date: "2026-06-22",
    split_method: "equal",
    version: 1,
    deleted_at: null,
    created_at: "2026-06-22T00:00:00Z",
    expense_splits: [],
    receipts: [],
  };
  assert.match(expensesCsv([row], [{ id: row.paid_by_user_id, label: "你" }]), /"'=HYPERLINK/);
});

test("splits even and odd TWD amounts with the payer taking the remainder", () => {
  assert.deepEqual(splitEqual(860, OWNER, PARTNER), {
    [OWNER]: 430,
    [PARTNER]: 430,
  });
  assert.deepEqual(splitEqual(861, OWNER, PARTNER), {
    [OWNER]: 431,
    [PARTNER]: 430,
  });
});

test("validates exact shares and percentage rounding", () => {
  assert.deepEqual(splitExact(861, { [OWNER]: 500, [PARTNER]: 361 }), {
    [OWNER]: 500,
    [PARTNER]: 361,
  });
  assert.throws(() => splitExact(861, { [OWNER]: 500, [PARTNER]: 360 }));
  assert.deepEqual(
    splitPercentage(861, OWNER, { [OWNER]: 50, [PARTNER]: 50 }),
    { [OWNER]: 431, [PARTNER]: 430 },
  );
  assert.deepEqual(
    splitPercentage(100, PARTNER, { [OWNER]: 33.33, [PARTNER]: 66.67 }),
    { [OWNER]: 33, [PARTNER]: 67 },
  );
  assert.throws(() =>
    splitPercentage(100, OWNER, { [OWNER]: 60, [PARTNER]: 30 }),
  );
});

test("reports each crossed budget threshold once", () => {
  assert.deepEqual(crossedBudgetThresholds(790, 810, 1_000), [80]);
  assert.deepEqual(crossedBudgetThresholds(790, 1_010, 1_000), [80, 100]);
  assert.deepEqual(crossedBudgetThresholds(810, 900, 1_000), []);
});

test("accountant snapshot does not leak the partner private ledger", () => {
  const snapshot = buildAccountantSnapshot({
    activeGroupId: GROUP,
    balances: [{ user_id: OWNER, balance_twd: 430 }],
    budgets: [],
    expenses: [
      accountantExpense("shared", 860, OWNER, "2026-06-01", GROUP),
      accountantExpense("private", 120, OWNER, "2026-06-02", null),
      accountantExpense("private", 9999, PARTNER, "2026-06-03", null),
    ],
    month: "2026-06",
    scope: "combined",
    userId: OWNER,
  });

  assert.equal(snapshot.facts.sharedTotalTwd, 860);
  assert.equal(snapshot.facts.privateTotalTwd, 120);
  assert.equal(snapshot.facts.totalTwd, 980);
  assert.equal(JSON.stringify(snapshot).includes("9999"), false);
});

test("rejects accountant reports whose facts do not match the ledger snapshot", () => {
  const snapshot = buildAccountantSnapshot({
    activeGroupId: GROUP,
    balances: [{ user_id: OWNER, balance_twd: 430 }],
    budgets: [],
    expenses: [accountantExpense("shared", 860, OWNER, "2026-06-01", GROUP)],
    month: "2026-06",
    scope: "shared",
    userId: OWNER,
  });

  assert.equal(accountantFactsMatch(snapshot.facts, snapshot.facts), true);
  assert.equal(
    accountantFactsMatch(
      { ...snapshot.facts, totalTwd: snapshot.facts.totalTwd + 1 },
      snapshot.facts,
    ),
    false,
  );
});

test("only safe accountant suggestions can become pending actions", () => {
  const snapshot = buildAccountantSnapshot({
    activeGroupId: GROUP,
    balances: [{ user_id: OWNER, balance_twd: -430 }],
    budgets: [],
    expenses: [accountantExpense("shared", 860, OWNER, "2026-06-01", GROUP)],
    month: "2026-06",
    scope: "shared",
    userId: OWNER,
  });

  assert.deepEqual(
    safeSuggestionAction({ type: "settle", amountTwd: 430 }, snapshot),
    { type: "settle", groupId: GROUP, amountTwd: 430 },
  );
  assert.equal(
    safeSuggestionAction({ type: "save_budget", amountTwd: 20_000 }, snapshot),
    null,
  );
});

test("learns an other category from matching historical merchants and descriptions", () => {
  assert.equal(
    learnCategoryFromHistory(
      { category: "other", description: "晚餐", merchant: "高鐵便當" },
      [
        { category: "food", description: "晚餐", merchant: "高鐵便當" },
        { category: "transport", description: "高鐵", merchant: "台灣高鐵" },
        { category: "food", description: "午餐", merchant: "高鐵便當" },
      ],
    ),
    "food",
  );
});

test("advances recurring dates without drifting month end", () => {
  assert.equal(nextRecurringDate("2026-01-31", "monthly", 31), "2026-02-28");
  assert.equal(nextRecurringDate("2026-02-28", "monthly", 31), "2026-03-31");
  assert.equal(nextRecurringDate("2026-06-22", "weekly"), "2026-06-29");
  assert.equal(nextRecurringDate("2024-02-29", "yearly", 29), "2025-02-28");
});

test("rejects unsafe receipt extraction values", () => {
  assert.equal(
    receiptExtractionSchema.safeParse({
      merchant: "小吃店",
      expenseDate: "2026-06-22",
      amountTwd: 860,
      confidence: 0.92,
    }).success,
    true,
  );
  assert.equal(
    receiptExtractionSchema.safeParse({
      merchant: "小吃店",
      expenseDate: "2026-99-99",
      amountTwd: -1,
      confidence: 2,
    }).success,
    false,
  );
});

test("calculates who owes whom and applies settlements", () => {
  const expenses: LedgerExpense[] = [
    {
      id: "dinner",
      ledger: "shared",
      amountTwd: 860,
      paidByUserId: OWNER,
      createdByUserId: OWNER,
      expenseDate: "2026-06-01",
      deleted: false,
      splits: { [OWNER]: 430, [PARTNER]: 430 },
    },
    {
      id: "taxi",
      ledger: "shared",
      amountTwd: 200,
      paidByUserId: PARTNER,
      createdByUserId: PARTNER,
      expenseDate: "2026-06-02",
      deleted: false,
      splits: { [OWNER]: 100, [PARTNER]: 100 },
    },
  ];

  assert.deepEqual(calculateBalances(expenses, []), {
    [OWNER]: 330,
    [PARTNER]: -330,
  });
  assert.deepEqual(
    calculateBalances(expenses, [
      { fromUserId: PARTNER, toUserId: OWNER, amountTwd: 330 },
    ]),
    { [OWNER]: 0, [PARTNER]: 0 },
  );
});

test("monthly totals exclude private, deleted, other users, and other months", () => {
  const expenses: LedgerExpense[] = [
    expense("shared", 860, OWNER, "2026-06-01"),
    expense("shared", 200, OWNER, "2026-05-31"),
    expense("private", 120, OWNER, "2026-06-30"),
    expense("private", 90, PARTNER, "2026-06-15"),
    { ...expense("shared", 50, OWNER, "2026-06-20"), deleted: true },
  ];

  assert.deepEqual(monthlySummary(expenses, "shared", OWNER, "2026-06"), {
    count: 1,
    totalTwd: 860,
  });
  assert.deepEqual(monthlySummary(expenses, "private", OWNER, "2026-06"), {
    count: 1,
    totalTwd: 120,
  });
});

test("rejects malformed Gemini structured output", () => {
  assert.equal(
    parsedIntentSchema.safeParse({
      intent: "record_expense",
      amountTwd: -1,
      description: "晚餐",
      ledger: "shared",
      paidBy: "self",
      expenseDate: "not-a-date",
      category: "food",
    }).success,
    false,
  );
  assert.equal(
    parsedIntentSchema.safeParse({
      intent: "record_expense",
      amountTwd: 860,
      description: "晚餐",
      ledger: "shared",
      paidBy: "self",
      expenseDate: "2026-99-99",
      category: "food",
    }).success,
    false,
  );
});

test("Gemini JSON schema only contains supported top-level keys", () => {
  assert.equal("$schema" in geminiIntentJsonSchema, false);
});

function expense(
  ledger: "shared" | "private",
  amountTwd: number,
  createdByUserId: string,
  expenseDate: string,
): LedgerExpense {
  return {
    id: `${ledger}-${amountTwd}-${createdByUserId}-${expenseDate}`,
    ledger,
    amountTwd,
    paidByUserId: createdByUserId,
    createdByUserId,
    expenseDate,
    deleted: false,
    splits: { [createdByUserId]: amountTwd },
  };
}

function accountantExpense(
  ledger: "shared" | "private",
  amountTwd: number,
  createdByUserId: string,
  expenseDate: string,
  groupId: string | null,
): AccountantExpense {
  return {
    id: `00000000-0000-4000-8000-${String(amountTwd).padStart(12, "0")}`,
    group_id: groupId,
    ledger,
    description: `${ledger}-${amountTwd}`,
    merchant: null,
    notes: null,
    category: ledger === "shared" ? "food" : "other",
    amount_twd: amountTwd,
    paid_by_user_id: createdByUserId,
    created_by_user_id: createdByUserId,
    expense_date: expenseDate,
    split_method: "equal",
    version: 1,
    deleted_at: null,
    expense_splits: [{ user_id: createdByUserId, amount_twd: amountTwd }],
  };
}
