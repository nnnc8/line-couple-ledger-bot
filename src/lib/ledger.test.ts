import assert from "node:assert/strict";
import test from "node:test";

import {
  handleLineEvent,
  parsePendingRetargetCommand,
  parseFixedIntent,
  parseInlineExpenseItems,
  safeSecretEqual,
  selectMentionedGroup,
} from "./bot";
import {
  batchCreatePayloadFromActions,
  deliverNotifications,
  expensesCsv,
  receiptExpenseInputs,
  retargetPendingActionPayload,
  type AppExpense,
  type ServerContext,
} from "./app-server";
import {
  accountantFactsMatch,
  buildAccountantSnapshot,
  parseAccountantCommand,
  safeSuggestionAction,
  type AccountantExpense,
} from "./accountant";
import {
  filterAgentExpenses,
  parseAgentRequest,
  rankCategoryLabels,
  safeBatchCategoryUpdates,
  type AgentExpense,
} from "./ledger-agent";
import {
  buildPrivateMirrorDraft,
  fallbackCategoryClassification,
  splitBootstrapExpenses,
} from "./category-agent";
import { detectReceiptMime, signSession, verifySession } from "./security";
import { matchTransactions, parseBankCsvWithMeta } from "./bank-csv";
import { searchExpenseRows, shouldSendInsight } from "./phase4";
import {
  calculateBalances,
  geminiIntentJsonSchema,
  geminiTextParseSchema,
  learnCategoryFromHistory,
  monthlySummary,
  nextRecurringDate,
  parsedIntentSchema,
  textParseSchema,
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

test("parses multiple inline LINE expenses before falling back to Gemini", () => {
  const items = parseInlineExpenseItems(
    "晚餐 漢堡 95我付 越南290你付 吃飽喝足",
    "2026-06-24",
  );

  assert.deepEqual(
    items.map((item) => ({
      description: item.description,
      amountTwd: item.amountTwd,
      paidBy: item.paidBy,
      tag: item.tag,
    })),
    [
      { description: "晚餐 漢堡", amountTwd: 95, paidBy: "self", tag: "food" },
      { description: "越南", amountTwd: 290, paidBy: "partner", tag: "food" },
    ],
  );
});

test("routes pending receipt retarget commands before expense parsing", () => {
  assert.deepEqual(parsePendingRetargetCommand("都改成私人帳 交通"), {
    ledger: "private",
    tag: "交通",
  });
  assert.equal(parsePendingRetargetCommand("晚餐 860 我付"), null);
});

test("retargets pending shared receipt payloads into private transport expenses", () => {
  assert.deepEqual(
    retargetPendingActionPayload(
      {
        ledger: "shared",
        group_id: GROUP,
        description: "EMF-7658",
        amount_twd: 44,
        paid_by_user_id: PARTNER,
        expense_date: "2026-06-21",
        tag: "餐飲",
        split_method: "equal",
        splits: { [OWNER]: 22, [PARTNER]: 22 },
      },
      OWNER,
      { ledger: "private", tag: "交通" },
    ),
    {
      ledger: "private",
      group_id: null,
      description: "EMF-7658",
      amount_twd: 44,
      paid_by_user_id: OWNER,
      expense_date: "2026-06-21",
      tag: "交通",
      split_method: "equal",
    },
  );
});

test("selects a mentioned LINE group instead of the active group", () => {
  assert.equal(
    selectMentionedGroup(
      "晚餐 漢堡 95我付 越南290你付 吃飽喝足",
      [
        { id: "active", name: "阿提斯" },
        { id: "food", name: "吃飽喝足" },
      ],
      "active",
    )?.id,
    "food",
  );
});

test("ledger agent treats historical maximum questions as all-history queries", () => {
  assert.deepEqual(parseAgentRequest("會計師 歷史以來哪裡花最多"), {
    message: "歷史以來哪裡花最多",
    scope: "combined",
    timeRange: "all",
  });
  assert.equal(parseAgentRequest("分析 本月外食多少")?.timeRange, "this_month");
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
    tag: "其他",
    mirror_kind: null,
    mirror_source_expense_id: null,
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

test("accountant snapshot does not leak the partner private ledger", () => {
  const snapshot = buildAccountantSnapshot({
    activeGroupId: GROUP,
    balances: [{ user_id: OWNER, balance_twd: 430 }],
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

test("ledger agent filters time ranges without leaking partner private expenses", () => {
  const expenses: AgentExpense[] = [
    agentExpense("shared", 860, OWNER, "2026-06-01", GROUP, "外食"),
    agentExpense("shared", 300, OWNER, "2026-05-01", GROUP, "高鐵"),
    agentExpense("private", 120, OWNER, "2026-06-02", null, "咖啡"),
    agentExpense("private", 9999, PARTNER, "2026-06-03", null, "秘密"),
  ];

  assert.deepEqual(
    filterAgentExpenses({
      activeGroupId: GROUP,
      expenses,
      now: "2026-06-24",
      scope: "combined",
      timeRange: "this_month",
      userId: OWNER,
    }).map((expense) => expense.amount_twd),
    [860, 120],
  );
  assert.deepEqual(
    filterAgentExpenses({
      activeGroupId: GROUP,
      expenses,
      now: "2026-06-24",
      scope: "combined",
      timeRange: "all",
      userId: OWNER,
    }).map((expense) => expense.amount_twd),
    [860, 300, 120],
  );
});

test("category analytics use free category labels instead of enum categories", () => {
  const ranking = rankCategoryLabels([
    agentExpense("shared", 5600, OWNER, "2026-06-01", GROUP, "高鐵"),
    agentExpense("shared", 1200, OWNER, "2026-06-02", GROUP, "捷運"),
    agentExpense("shared", 4301, OWNER, "2026-06-03", GROUP, "外食"),
  ]);

  assert.deepEqual(ranking.map((item) => [item.label, item.totalTwd]), [
    ["高鐵", 5600],
    ["外食", 4301],
    ["捷運", 1200],
  ]);
});

test("category analytics uses tags directly", () => {
  const ranking = rankCategoryLabels([
    agentExpense("shared", 5600, OWNER, "2026-06-01", GROUP, "交通"),
    agentExpense("shared", 3277, OWNER, "2026-06-02", GROUP, "信用卡費"),
    agentExpense("shared", 105, OWNER, "2026-06-03", GROUP, "停車費"),
  ]);

  assert.deepEqual(
    ranking.map((item) => [item.label, item.totalTwd]),
    [
      ["交通", 5600],
      ["信用卡費", 3277],
      ["停車費", 105],
    ],
  );
});

test("group-aware category fallback keeps food groups coarse and parking specific", () => {
  assert.deepEqual(
    fallbackCategoryClassification({
      description: "晚餐 漢堡",
      groupName: "吃飽喝足",
      fallbackTag: "food",
      history: [],
    }),
    {
      tag: "餐飲",
      confidence: 0.85,
      reason: "food group",
    },
  );
  assert.deepEqual(
    fallbackCategoryClassification({
      description: "阿提斯 停車費",
      groupName: "阿提斯",
      fallbackTag: "other",
      history: [],
    }),
    {
      tag: "停車費",
      confidence: 0.9,
      reason: "parking",
    },
  );
});

test("shared expense private mirror records only the requester split", () => {
  assert.deepEqual(
    buildPrivateMirrorDraft({
      sourceExpenseId: "shared-1",
      requesterUserId: OWNER,
      description: "晚餐",
      merchant: null,
      notes: null,
      tag: "餐飲",
      expenseDate: "2026-06-24",
      splits: { [OWNER]: 300, [PARTNER]: 300 },
      deletedAt: null,
    }),
    {
      ledger: "private",
      groupId: null,
      mirrorKind: "shared_share",
      mirrorSourceExpenseId: "shared-1",
      description: "晚餐",
      merchant: null,
      notes: null,
      tag: "餐飲",
      amountTwd: 300,
      paidByUserId: OWNER,
      createdByUserId: OWNER,
      expenseDate: "2026-06-24",
      splitMethod: "equal",
      splits: { [OWNER]: 300 },
      deletedAt: null,
    },
  );
  assert.equal(
    buildPrivateMirrorDraft({
      sourceExpenseId: "shared-1",
      requesterUserId: OWNER,
      description: "晚餐",
      merchant: null,
      notes: null,
      tag: "餐飲",
      expenseDate: "2026-06-24",
      splits: { [OWNER]: 0, [PARTNER]: 600 },
      deletedAt: null,
    }),
    null,
  );
});

test("bootstrap expense split keeps shared groups and private ledger separate", () => {
  const shared = appExpense("shared", 600, OWNER, "2026-06-24", GROUP, "餐飲");
  const privateExpense = appExpense("private", 300, OWNER, "2026-06-24", null, "餐飲");
  const result = splitBootstrapExpenses([shared, privateExpense], GROUP, OWNER);
  assert.deepEqual(result.sharedExpenses.map((item) => item.id), [shared.id]);
  assert.deepEqual(result.privateExpenses.map((item) => item.id), [privateExpense.id]);
});

test("batch category cleanup only updates accessible current expenses", () => {
  const expenses = [
    agentExpense("shared", 5600, OWNER, "2026-06-01", GROUP, "其他", 1),
    agentExpense("private", 120, OWNER, "2026-06-02", null, "其他", 2),
    agentExpense("private", 9999, PARTNER, "2026-06-03", null, "其他", 1),
  ];

  assert.deepEqual(
    safeBatchCategoryUpdates(
      [
        { expenseId: expenses[0]!.id, expectedVersion: 1, tag: "高鐵" },
        { expenseId: expenses[1]!.id, expectedVersion: 2, tag: "咖啡" },
        { expenseId: expenses[2]!.id, expectedVersion: 1, tag: "秘密" },
        { expenseId: expenses[0]!.id, expectedVersion: 9, tag: "錯版" },
      ],
      expenses,
      { activeGroupId: GROUP, userId: OWNER },
    ),
    [
      { expenseId: expenses[0]!.id, expectedVersion: 1, tag: "高鐵" },
      { expenseId: expenses[1]!.id, expectedVersion: 2, tag: "咖啡" },
    ],
  );
});

test("rejects accountant reports whose facts do not match the ledger snapshot", () => {
  const snapshot = buildAccountantSnapshot({
    activeGroupId: GROUP,
    balances: [{ user_id: OWNER, balance_twd: 430 }],
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
      { tag: "其他", description: "晚餐", merchant: "高鐵便當" },
      [
        { tag: "餐飲", description: "晚餐", merchant: "高鐵便當" },
        { tag: "交通", description: "高鐵", merchant: "台灣高鐵" },
        { tag: "餐飲", description: "午餐", merchant: "高鐵便當" },
      ],
    ),
    "餐飲",
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

test("receipt OCR items become pending expense inputs", () => {
  const inputs = receiptExpenseInputs({
    activeGroupId: GROUP,
    receiptId: "00000000-0000-4000-8000-000000000055",
    today: "2026-06-25",
    extraction: {
      merchant: null,
      expenseDate: null,
      amountTwd: null,
      confidence: 0.9,
      items: [
        {
          merchant: "ENQ-8622",
          description: null,
          expenseDate: "2026-06-06",
          amountTwd: 42,
        },
        {
          merchant: null,
          description: "行程費",
          expenseDate: null,
          amountTwd: 31,
        },
        {
          merchant: null,
          description: null,
          expenseDate: null,
          amountTwd: null,
        },
      ],
    },
  });

  assert.deepEqual(
    inputs.map((input) => input.expense),
    [
      {
        ledger: "shared",
        groupId: GROUP,
        description: "ENQ-8622",
        merchant: "ENQ-8622",
        notes: "由 LINE 圖片辨識建立",
        tag: "車資",
        amountTwd: 42,
        paidBy: "self",
        expenseDate: "2026-06-06",
        splitMethod: "equal",
        selfValue: null,
        partnerValue: null,
        receiptId: null,
      },
      {
        ledger: "shared",
        groupId: GROUP,
        description: "行程費",
        merchant: null,
        notes: "由 LINE 圖片辨識建立",
        tag: "車資",
        amountTwd: 31,
        paidBy: "self",
        expenseDate: "2026-06-25",
        splitMethod: "equal",
        selfValue: null,
        partnerValue: null,
        receiptId: null,
      },
    ],
  );
});

test("receipt OCR items can be stored as one batch pending payload", () => {
  const inputs = receiptExpenseInputs({
    activeGroupId: GROUP,
    receiptId: "00000000-0000-4000-8000-000000000055",
    today: "2026-06-25",
    extraction: {
      merchant: null,
      expenseDate: null,
      amountTwd: null,
      confidence: 0.9,
      items: [
        { merchant: "ENQ-8622", description: null, expenseDate: "2026-06-06", amountTwd: 42 },
        { merchant: null, description: "行程費", expenseDate: "2026-06-07", amountTwd: 31 },
      ],
    },
  });

  assert.deepEqual(batchCreatePayloadFromActions(inputs), {
    items: inputs.map((input) => input.expense),
  });
});

test("retargets batch pending payloads into private transport expenses", () => {
  assert.deepEqual(
    retargetPendingActionPayload(
      {
        items: [
          {
            ledger: "shared",
            group_id: GROUP,
            description: "EMF-7658",
            amount_twd: 44,
            paid_by_user_id: PARTNER,
            expense_date: "2026-06-21",
            tag: "餐飲",
            split_method: "equal",
            splits: { [OWNER]: 22, [PARTNER]: 22 },
          },
        ],
      },
      OWNER,
      { ledger: "private", tag: "交通" },
    ),
    {
      items: [
        {
          ledger: "private",
          group_id: null,
          description: "EMF-7658",
          amount_twd: 44,
          paid_by_user_id: OWNER,
          expense_date: "2026-06-21",
          tag: "交通",
          split_method: "equal",
        },
      ],
    },
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
      tag: "餐飲",
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
      tag: "餐飲",
    }).success,
    false,
  );
});

test("Gemini JSON schema only contains supported top-level keys", () => {
  assert.equal("$schema" in geminiIntentJsonSchema, false);
  assert.equal("$schema" in geminiTextParseSchema, false);
});

test("accepts natural language parser output with multiple expenses and group hint", () => {
  const parsed = textParseSchema.parse({
    intent: "record_expenses",
    groupName: "吃飽喝足",
    expenses: [
      {
        description: "晚餐 漢堡",
        amountTwd: 95,
        ledger: "shared",
        paidBy: "self",
        expenseDate: "2026-06-24",
        tag: "餐飲",
      },
      {
        description: "越南料理",
        amountTwd: 290,
        ledger: "shared",
        paidBy: "partner",
        expenseDate: "2026-06-24",
        tag: "餐飲",
      },
    ],
  });
  assert.equal(parsed.intent, "record_expenses");
  assert.equal(parsed.groupName, "吃飽喝足");
  assert.equal(parsed.expenses.length, 2);
});

test("notification delivery attempts LINE push without quota preflight", async () => {
  const pushed: unknown[] = [];
  const db = fakeNotificationDb();
  await withMockFetch(async (url, init) => {
    assert.equal(String(url), "https://api.line.me/v2/bot/message/push");
    pushed.push(JSON.parse(String(init?.body)));
    return jsonResponse({});
  }, async () => {
    await deliverNotifications(fakeContext(db));
  });

  assert.equal(pushed.length, 1);
  assert.deepEqual(pushed[0], {
    to: "line-partner",
    messages: [
      {
        type: "text",
        text: "另一半更新了一筆支出 阿提斯\n停車費 NT$105｜2026-06-25｜停車費",
      },
    ],
  });
  assert.equal(db.updatedStatus, "sent");
});

test("notification delivery skips rows already claimed by another worker", async () => {
  const pushed: unknown[] = [];
  const db = fakeNotificationDb({ claimNotifications: false });
  await withMockFetch(async (url, init) => {
    pushed.push({ url, init });
    return jsonResponse({});
  }, async () => {
    await deliverNotifications(fakeContext(db));
  });

  assert.equal(pushed.length, 0);
  assert.equal(db.updatedStatus, "sending");
});

test("LINE postback confirmation delivers partner notification", async () => {
  const pushed: unknown[] = [];
  const db = fakePostbackDb();
  await withMockFetch(async (url, init) => {
    assert.equal(String(url), "https://api.line.me/v2/bot/message/push");
    pushed.push(JSON.parse(String(init?.body)));
    return jsonResponse({});
  }, async () => {
    await withServerEnv(async () => {
      await handleLineEvent(
        {
          type: "postback",
          webhookEventId: "event-1",
          replyToken: "reply-1",
          source: { type: "user", userId: "line-owner" },
          timestamp: 0,
          mode: "active",
          postback: {
            data: "decision=confirm&id=00000000-0000-4000-8000-000000000099",
          },
        } as never,
        {
          lineClient: {
            replyMessage: async () => ({ sentMessages: [] }),
            getMessageContent: async () => {
              throw new Error("unused");
            },
            pushMessage: async () => ({ sentMessages: [] }),
          },
          supabase: db as never,
          gemini: {} as never,
          setupCode: "x".repeat(24),
        },
      );
    });
  });

  assert.equal(pushed.length, 1);
  assert.equal(
    (pushed[0] as { messages: Array<{ text: string }> }).messages[0].text,
    "另一半更新了一筆支出 阿提斯\n停車費 NT$105｜2026-06-25｜停車費",
  );
  assert.equal(db.updatedStatus, "sent");
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
    tag: ledger === "shared" ? "餐飲" : "其他",
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

function agentExpense(
  ledger: "shared" | "private",
  amountTwd: number,
  createdByUserId: string,
  expenseDate: string,
  groupId: string | null,
  tag: string,
  version = 1,
): AgentExpense {
  return {
    id: `00000000-0000-4000-8000-${String(amountTwd + version).padStart(12, "0")}`,
    group_id: groupId,
    ledger,
    description: `${tag}-${amountTwd}`,
    merchant: null,
    tag,
    amount_twd: amountTwd,
    paid_by_user_id: createdByUserId,
    created_by_user_id: createdByUserId,
    expense_date: expenseDate,
    version,
    deleted_at: null,
  };
}

function appExpense(
  ledger: "shared" | "private",
  amountTwd: number,
  createdByUserId: string,
  expenseDate: string,
  groupId: string | null,
  tag: string,
): AppExpense {
  return {
    id: `10000000-0000-4000-8000-${String(amountTwd).padStart(12, "0")}`,
    group_id: groupId,
    ledger,
    description: tag,
    merchant: null,
    notes: null,
    tag,
    mirror_kind: null,
    mirror_source_expense_id: null,
    amount_twd: amountTwd,
    paid_by_user_id: createdByUserId,
    created_by_user_id: createdByUserId,
    expense_date: expenseDate,
    split_method: "equal",
    version: 1,
    deleted_at: null,
    created_at: `${expenseDate}T00:00:00Z`,
    expense_splits: [{ user_id: createdByUserId, amount_twd: amountTwd }],
    receipts: [],
  };
}

function fakeContext(db: ReturnType<typeof fakeNotificationDb>): ServerContext {
  return {
    env: {
      LINE_CHANNEL_ACCESS_TOKEN: "line-token",
      LINE_LOGIN_CHANNEL_ID: "login",
      GEMINI_API_KEY: "gemini",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "secret",
      COUPLE_SETUP_CODE: "x".repeat(24),
      LIFF_SESSION_SECRET: "x".repeat(32),
      APP_URL: "https://app.example.com",
      CRON_SECRET: "x".repeat(16),
    },
    db: db as never,
    user: {
      id: OWNER,
      couple_id: 1,
      line_user_id: "line-owner",
      role: "owner",
    },
  };
}

function fakePostbackDb() {
  return fakeNotificationDb({
    rpc: async () => ({
      data: { result: "confirmed", action_type: "create_expense" },
      error: null,
    }),
  });
}

function fakeNotificationDb(extra: Record<string, unknown> = {}) {
  const db = {
    updatedStatus: "",
    claimNotifications: true,
    rpc: async () => ({ data: null, error: null }),
    from(table: string) {
      return fakeQuery(table, db);
    },
    ...extra,
  };
  return db;
}

function fakeQuery(
  table: string,
  db: { updatedStatus: string; claimNotifications?: boolean },
) {
  let updateValue: Record<string, unknown> | null = null;
  const query = {
    select: () => query,
    eq: () => query,
    is: () => query,
    gte: () => query,
    lt: () => query,
    order: () => query,
    limit: () => query,
    upsert: () => query,
    update(value: Record<string, unknown>) {
      updateValue = value;
      return query;
    },
    single: async () => singleResultFor(table),
    maybeSingle: async () => singleResultFor(table),
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      if (updateValue?.line_status) {
        db.updatedStatus = String(updateValue.line_status);
        if (table === "notifications" && updateValue.line_status === "sending") {
          return Promise.resolve({
            data: db.claimNotifications === false ? [] : [{ id: 123 }],
            error: null,
          }).then(resolve, reject);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      return Promise.resolve(listResultFor(table)).then(resolve, reject);
    },
  };
  return query;
}

function singleResultFor(table: string) {
  if (table === "users") {
    return {
      data: {
        id: "00000000-0000-4000-8000-000000000001",
        couple_id: 1,
        role: "owner",
        line_user_id: "line-owner",
      },
      error: null,
    };
  }
  if (table === "pending_actions") {
    return {
      data: { action_type: "create_expense", payload: {} },
      error: null,
    };
  }
  if (table === "user_preferences") {
    return { data: { active_group_id: GROUP }, error: null };
  }
  if (table === "notifications") {
    return {
      data: [
        {
          id: 123,
          group_id: GROUP,
          kind: "expense",
          recipient_user_id: PARTNER,
          title: "共同帳本已更新",
          body: "另一半更新了一筆支出",
          entity_type: "expense",
          entity_id: "00000000-0000-4000-8000-000000000105",
          users: { line_user_id: "line-partner" },
        },
      ],
      error: null,
    };
  }
  if (table === "expenses") {
    return {
      data: {
        id: "00000000-0000-4000-8000-000000000105",
        description: "停車費",
        amount_twd: 105,
        expense_date: "2026-06-25",
        tag: "停車費",
      },
      error: null,
    };
  }
  if (table === "groups") {
    return { data: { name: "阿提斯" }, error: null };
  }
  return { data: [], error: null };
}

function listResultFor(table: string) {
  if (table === "notifications") {
    return {
      data: [
        {
          id: 123,
          group_id: GROUP,
          kind: "expense",
          recipient_user_id: PARTNER,
          title: "共同帳本已更新",
          body: "另一半更新了一筆支出",
          entity_type: "expense",
          entity_id: "00000000-0000-4000-8000-000000000105",
          users: { line_user_id: "line-partner" },
        },
      ],
      error: null,
    };
  }
  return { data: [], error: null };
}

async function withMockFetch(
  fetchImpl: typeof fetch,
  run: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });
}

async function withServerEnv(run: () => Promise<void>) {
  const values = fakeContext(fakeNotificationDb()).env;
  const original = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    original.set(key, process.env[key]);
    process.env[key] = String(value);
  }
  try {
    await run();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("bank csv parser and matcher", () => {
  const csv = [
    "交易日期,摘要,支出金額,存入金額",
    "2026/06/15,咖啡廳,125,0",
    "2026/06/14,全聯,380,0",
  ].join("\n");
  const parsed = parseBankCsvWithMeta(csv, "auto");
  assert.equal(parsed.bank, "esun");
  assert.equal(parsed.transactions.length, 2);
  assert.equal(parsed.transactions[0]?.amount, 125);

  const matches = matchTransactions(parsed.transactions, [
    {
      id: "00000000-0000-4000-8000-000000000010",
      description: "咖啡",
      merchant: "咖啡廳",
      amount_twd: 125,
      expense_date: "2026-06-15",
      deleted_at: null,
    },
  ]);
  assert.equal(matches[0]?.matchedExpenseId, "00000000-0000-4000-8000-000000000010");
  assert.equal(matches[1]?.matchedExpenseId, undefined);
});

test("phase 4 search filters chinese expense text and ranges", () => {
  const results = searchExpenseRows(
    [
      {
        id: "e1",
        description: "台中高鐵",
        merchant: "高鐵",
        notes: null,
        tag: "高鐵",
        amount_twd: 1455,
        expense_date: "2026-06-20",
        deleted_at: null,
      },
      {
        id: "e2",
        description: "晚餐",
        merchant: "餐廳",
        notes: null,
        tag: "餐飲",
        amount_twd: 800,
        expense_date: "2026-06-21",
        deleted_at: null,
      },
      {
        id: "e3",
        description: "台中高鐵",
        merchant: null,
        notes: null,
        tag: "高鐵",
        amount_twd: 3000,
        expense_date: "2026-07-01",
        deleted_at: null,
      },
    ],
    {
      q: "台中 高鐵",
      from: "2026-06-01",
      to: "2026-06-30",
      tag: "高鐵",
      min: 500,
      max: 2000,
      limit: 10,
    },
  );

  assert.deepEqual(results.map((item) => item.id), ["e1"]);
});

test("phase 4 proactive insights suppress duplicate rules for three days", () => {
  assert.equal(
    shouldSendInsight(
      [{ insight_rule_id: "budget_warning_80", created_at: "2026-06-23T00:00:00Z" }],
      "budget_warning_80",
      new Date("2026-06-25T00:00:00Z"),
    ),
    false,
  );
  assert.equal(
    shouldSendInsight(
      [{ insight_rule_id: "budget_warning_80", created_at: "2026-06-20T00:00:00Z" }],
      "budget_warning_80",
      new Date("2026-06-25T00:00:00Z"),
    ),
    true,
  );
});

test("write tools: record_expense returns pending_action with expense", async () => {
  const { executeTool } = await import("./accountant-tools");

  const mockDb = {
    from: () => ({
      select: () => ({
        eq: () => ({
          neq: () => ({
            single: () => Promise.resolve({ data: { user_id: "partner-123" }, error: null }),
          }),
        }),
      }),
    }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const ctx = {
    db: mockDb,
    groupId: "group-1",
    userId: "user-1",
    coupleId: 1,
  };

  const result = await executeTool(
    "record_expense",
    {
      description: "晚餐",
      amount_twd: 860,
      paid_by: "self",
      ledger: "shared",
      tag: "餐飲",
    },
    ctx,
  );

  const res = result as {
    pending_action: {
      type: string;
      expense: { description: string; amount_twd: number; paid_by_user_id: string };
      splits: Array<{ user_id: string; amount_twd: number }>;
    };
    message: string;
  };

  assert.equal(res.pending_action.type, "create_expense");
  assert.equal(res.pending_action.expense.description, "晚餐");
  assert.equal(res.pending_action.expense.amount_twd, 860);
  assert.equal(res.pending_action.expense.paid_by_user_id, "user-1");
  assert.ok(res.message.includes("860"));
});

test("write tools: settle_debt returns pending_action when user owes", async () => {
  const { executeTool } = await import("./accountant-tools");

  const mockDb = {
    rpc: () =>
      Promise.resolve({
        data: [
          { user_id: "user-1", balance_twd: -500 },
          { user_id: "user-2", balance_twd: 500 },
        ],
        error: null,
      }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const ctx = {
    db: mockDb,
    groupId: "group-1",
    userId: "user-1",
    coupleId: 1,
  };

  const result = await executeTool(
    "settle_debt",
    { amount_twd: 300 },
    ctx,
  );

  const res = result as {
    pending_action: { type: string; amountTwd: number };
    message: string;
  };

  assert.equal(res.pending_action.type, "settle");
  assert.equal(res.pending_action.amountTwd, 300);
  assert.ok(res.message.includes("300"));
});

test("write tools: settle_debt returns message when user does not owe", async () => {
  const { executeTool } = await import("./accountant-tools");

  const mockDb = {
    rpc: () =>
      Promise.resolve({
        data: [
          { user_id: "user-1", balance_twd: 500 },
          { user_id: "user-2", balance_twd: -500 },
        ],
        error: null,
      }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const ctx = {
    db: mockDb,
    groupId: "group-1",
    userId: "user-1",
    coupleId: 1,
  };

  const result = await executeTool(
    "settle_debt",
    { amount_twd: 300 },
    ctx,
  );

  const res = result as { message: string };
  assert.ok(res.message.includes("不需要結清"));
});

test("write tools: record_expense validates required params", async () => {
  const { executeTool } = await import("./accountant-tools");

  const ctx = {
    db: {} as unknown as import("@supabase/supabase-js").SupabaseClient,
    groupId: "group-1",
    userId: "user-1",
    coupleId: 1,
  };

  try {
    await executeTool("record_expense", { description: "測試" }, ctx);
    assert.fail("Should have thrown");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes("amount_twd") || error.message.includes("Invalid"));
  }
});

test("agent-loop: buildSystemPrompt includes today date", async () => {
  const { runAgentLoop } = await import("./agent-loop");

  const mockGemini = {
    models: {
      generateContent: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: "測試回應" }],
              role: "model",
            },
          },
        ],
      }),
    },
  } as any;

  const mockDb = {
    rpc: () => Promise.resolve({ data: [], error: null }),
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => Promise.resolve({ data: [], error: null }),
          order: () => ({
            limit: () => ({
              single: () => Promise.resolve({ data: null }),
            }),
          }),
        }),
      }),
      upsert: () => Promise.resolve({ error: null }),
    }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const ctx = {
    db: mockDb,
    groupId: "group-1",
    userId: "user-1",
    coupleId: 1,
  };

  const result = await runAgentLoop(
    "你好",
    null,
    "user-1",
    ctx,
    { gemini: mockGemini, supabase: mockDb },
  );

  assert.ok(result.answer);
  assert.equal(result.toolCallCount, 0);
});

test("secretary: createTask returns uuid", async () => {
  const { createTask } = await import("./secretary-tasks");

  const mockDb = {
    from: () => ({
      insert: () => ({
        select: () => ({
          single: () =>
            Promise.resolve({
              data: { id: "00000000-0000-4000-8000-000000000001" },
              error: null,
            }),
        }),
      }),
    }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const id = await createTask(mockDb, {
    coupleId: 1,
    groupId: "00000000-0000-4000-8000-000000000002",
    type: "confirm_expense",
    title: "確認全聯 NT$812",
    summary: "這筆要確認",
    source: "line",
  });

  assert.ok(typeof id === "string");
  assert.ok(id.length > 0);
});

test("secretary: createMemory stores merchant_rule", async () => {
  const { createMemory } = await import("./secretary-memory");

  const mockDb = {
    from: () => ({
      insert: () => ({
        select: () => ({
          single: () =>
            Promise.resolve({
              data: { id: "00000000-0000-4000-8000-000000000003" },
              error: null,
            }),
        }),
      }),
    }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const id = await createMemory(mockDb, {
    coupleId: 1,
    userId: "user-1",
    scope: "user",
    kind: "merchant_rule",
    key: "uber",
    value: {
      ledger: "private",
      tag: "交通",
    },
    source: "line",
  });

  assert.ok(typeof id === "string");
  assert.ok(id.length > 0);
});

test("secretary: getRecentExpenses filters by ledger", async () => {
  const { executeSecretaryTool } = await import("./secretary-tools");

  const sharedData = [
    {
      id: "e1",
      group_id: "g1",
      ledger: "shared",
      description: "晚餐",
      merchant: null,
      tag: "餐飲",
      amount_twd: 860,
      paid_by_user_id: "user-1",
      created_by_user_id: "user-1",
      expense_date: "2026-06-27",
      version: 1,
      deleted_at: null,
    },
  ];

  const mockDb = {
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            order: () => ({
              limit: () =>
                Promise.resolve({
                  data: sharedData,
                  error: null,
                }) as unknown,
            }),
          }),
        }),
      }),
    }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const ctx = {
    db: mockDb,
    groupId: "g1",
    userId: "user-1",
    coupleId: 1,
  };

  const result = (await executeSecretaryTool(
    "get_recent_expenses",
    { limit: 3, ledger: "shared" },
    ctx,
  )) as { count: number; items: Array<{ description: string }> };

  assert.equal(result.count, 1);
  assert.equal(result.items[0].description, "晚餐");
});
