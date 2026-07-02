import assert from "node:assert/strict";
import test from "node:test";

import {
  actionResultMessage,
  handleLineEvent,
  parsePendingRetargetCommand,
  parseFixedIntent,
  parseInlineExpenseItems,
  selectMentionedGroup,
} from "./bot";
import {
  deliverNotifications,
  expensesCsv,
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
import type { AgentDeps } from "./agent-loop";
import {
  buildPrivateMirrorDraft,
  fallbackCategoryClassification,
  splitBootstrapExpenses,
} from "./category-agent";
import { detectReceiptMime, safeSecretEqual, signSession, verifySession } from "./security";
import { matchTransactions, parseBankCsvWithMeta } from "./bank-csv";
import { setMockWithTx } from "./db/tx";
import { TransactionStaleError } from "./pending-action-executor";

export interface FakeTxCall {
  query: string;
  params?: any[];
}

export class FakeTxClient {
  calls: FakeTxCall[] = [];
  mockResults: Array<{ pattern: string | RegExp; result: any }> = [];

  async query(sql: string, params?: any[]) {
    const cleanSql = sql.replace(/\s+/g, " ").trim();
    this.calls.push({ query: cleanSql, params });

    for (const item of this.mockResults) {
      if (typeof item.pattern === "string") {
        if (cleanSql.includes(item.pattern)) {
          return item.result;
        }
      } else if (item.pattern.test(cleanSql)) {
        return item.result;
      }
    }
    return { rowCount: 1, rows: [] };
  }
}

export let activeTxClient: FakeTxClient | null = null;
export let activeTxError: Error | null = null;

setMockWithTx(async (callback) => {
  if (activeTxError) {
    throw activeTxError;
  }
  const client = activeTxClient || new FakeTxClient();
  if (client.mockResults.length === 0) {
    client.mockResults.push({
      pattern: /SELECT.*FROM.*pending_actions.*FOR UPDATE/i,
      result: {
        rowCount: 1,
        rows: [
          {
            status: "pending",
            expires_at: "2099-01-01T00:00:00.000Z",
            action_type: "create_expense",
          },
        ],
      },
    });
  }
  return await callback(client as any);
});

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
import {
  LedgerCommandService,
  pendingActionCommandFromPayload,
  pendingActionEnvelopeSchema,
} from "./ledger-core";
import {
  PendingActionService,
  type CreateExpenseActionInput,
} from "./pending-action-service";
import { registerPendingActionService } from "./pending-action-builders";
import { SecretaryService } from "./secretary-service";
import { ReceiptService } from "./receipt-service";
import { HttpError } from "./http-error";

const defaultPendingService = new PendingActionService({
  actionSeconds: 60,
  deliverNotifications: async () => {},
});
registerPendingActionService(defaultPendingService);

const OWNER = "owner";
const PARTNER = "partner";
const GROUP = "00000000-0000-4000-8000-000000000003";
const CORE_OWNER = "00000000-0000-4000-8000-000000000011";
const CORE_PARTNER = "00000000-0000-4000-8000-000000000012";

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

test("ledger core normalizes private expense drafts", () => {
  const service = new LedgerCommandService();
  const draft = service.buildExpenseDraft(
    {
      ledger: "private",
      groupId: GROUP,
      description: "共享機車",
      merchant: null,
      notes: null,
      tag: "交通",
      amountTwd: 185,
      paidBy: "self",
      expenseDate: "2026-06-30",
      splitMethod: "equal",
      selfValue: null,
      partnerValue: null,
      receiptId: null,
    },
    {
      actorUserId: CORE_OWNER,
      partnerUserId: CORE_PARTNER,
    },
  );

  assert.equal(draft.groupId, null);
  assert.equal(draft.paidByUserId, CORE_OWNER);
  assert.deepEqual(draft.splits, { [CORE_OWNER]: 185 });
});

test("ledger core rejects private expenses paid by partner", () => {
  const service = new LedgerCommandService();

  assert.throws(
    () =>
      service.buildExpenseDraft(
        {
          ledger: "private",
          groupId: null,
          description: "私人晚餐",
          merchant: null,
          notes: null,
          tag: "餐飲",
          amountTwd: 200,
          paidBy: "partner",
          expenseDate: "2026-06-30",
          splitMethod: "equal",
          selfValue: null,
          partnerValue: null,
          receiptId: null,
        },
        {
          actorUserId: CORE_OWNER,
          partnerUserId: CORE_PARTNER,
        },
      ),
    /私人支出只能由本人付款/,
  );
});

test("ledger core builds settlement drafts from balances", () => {
  const service = new LedgerCommandService();
  const draft = service.buildSettlementDraft(
    {
      type: "settle",
      groupId: GROUP,
      amountTwd: 300,
    },
    {
      balances: [
        { userId: CORE_OWNER, balanceTwd: -500 },
        { userId: CORE_PARTNER, balanceTwd: 500 },
      ],
      actorUserId: CORE_OWNER,
    },
  );

  assert.deepEqual(draft, {
    groupId: GROUP,
    fromUserId: CORE_OWNER,
    toUserId: CORE_PARTNER,
    amountTwd: 300,
    expectedBalanceTwd: -500,
  });
});

test("ledger core creates versioned pending-action envelopes", () => {
  const service = new LedgerCommandService();
  const envelope = service.createPendingActionEnvelope(
    {
      type: "create_expense",
      expense: {
        ledger: "shared",
        groupId: GROUP,
        description: "晚餐",
        merchant: null,
        notes: null,
        tag: "餐飲",
        amountTwd: 860,
        paidBy: "self",
        expenseDate: "2026-06-30",
        splitMethod: "equal",
        selfValue: null,
        partnerValue: null,
        receiptId: null,
      },
    },
    {
      source: "liff",
      actorUserId: CORE_OWNER,
      idempotencyKey: "liff:expense-1",
    },
    {
      ledger: "shared",
      group_id: GROUP,
      description: "晚餐",
      amount_twd: 860,
    },
  );

  assert.deepEqual(pendingActionEnvelopeSchema.parse(envelope), envelope);
  assert.equal(envelope.kind, "ledger_command");
  assert.equal(envelope.ledger, "shared");
  assert.equal(envelope.group_id, GROUP);
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

test("retarget updates envelope command alongside legacy payload", () => {
  const service = new LedgerCommandService();
  const payload = service.createPendingActionEnvelope(
    {
      type: "create_expense",
      expense: {
        ledger: "shared",
        groupId: GROUP,
        description: "EMF-7658",
        merchant: "EMF-7658",
        notes: null,
        tag: "餐飲",
        amountTwd: 44,
        paidBy: "partner",
        expenseDate: "2026-06-21",
        splitMethod: "equal",
        selfValue: null,
        partnerValue: null,
        receiptId: null,
      },
    },
    {
      source: "line",
      actorUserId: CORE_OWNER,
      idempotencyKey: "receipt-1",
    },
    {
      ledger: "shared",
      group_id: GROUP,
      description: "EMF-7658",
      amount_twd: 44,
      paid_by_user_id: CORE_PARTNER,
      expense_date: "2026-06-21",
      tag: "餐飲",
      split_method: "equal",
      splits: { [CORE_OWNER]: 22, [CORE_PARTNER]: 22 },
    },
  );

  const retargeted = retargetPendingActionPayload(payload, CORE_OWNER, {
    ledger: "private",
    tag: "交通",
  });
  const command = pendingActionCommandFromPayload(retargeted);

  assert.equal(retargeted.ledger, "private");
  assert.equal(retargeted.group_id, null);
  assert.equal(retargeted.tag, "交通");
  assert.deepEqual(command, {
    type: "create_expense",
    expense: {
      ledger: "private",
      groupId: null,
      description: "EMF-7658",
      merchant: "EMF-7658",
      notes: null,
      tag: "交通",
      amountTwd: 44,
      paidBy: "self",
      expenseDate: "2026-06-21",
      splitMethod: "equal",
      selfValue: null,
      partnerValue: null,
      receiptId: null,
    },
  });
});



test("receipt service purges expired deleted receipts from storage and db", async () => {
  const service = new ReceiptService();
  let removedPaths: string[] | null = null;
  let deletedIds: string[] | null = null;

  const db = {
    from: (table: string) => {
      assert.equal(table, "receipts");
      return {
        select: () => ({
          lt: () =>
            Promise.resolve({
              data: [
                {
                  id: "00000000-0000-4000-8000-000000000301",
                  storage_path: "1/u/a.jpg",
                },
                {
                  id: "00000000-0000-4000-8000-000000000302",
                  storage_path: "1/u/b.jpg",
                },
              ],
              error: null,
            }),
        }),
        delete: () => ({
          in: (_field: string, ids: string[]) => {
            deletedIds = ids;
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
    storage: {
      from: (bucket: string) => {
        assert.equal(bucket, "receipts");
        return {
          remove: (paths: string[]) => {
            removedPaths = paths;
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const count = await (service as unknown as {
    purgeDeleted: (
      db: import("@supabase/supabase-js").SupabaseClient,
      now?: Date,
    ) => Promise<number>;
  }).purgeDeleted(db, new Date("2026-07-31T00:00:00.000Z"));

  assert.equal(count, 2);
  assert.deepEqual(removedPaths, ["1/u/a.jpg", "1/u/b.jpg"]);
  assert.deepEqual(deletedIds, [
    "00000000-0000-4000-8000-000000000301",
    "00000000-0000-4000-8000-000000000302",
  ]);
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

test("notification flush for cron does not need a user lookup", async () => {
  const { flushQueuedNotifications } = await import("./notification-service");

  const pushed: unknown[] = [];
  const db = {
    updatedStatus: "",
    claimNotifications: true,
    from(table: string) {
      if (table === "users") {
        throw new Error("should not query users for cron notification flush");
      }
      return fakeQuery(table, db);
    },
  };

  await withMockFetch(async (url, init) => {
    assert.equal(String(url), "https://api.line.me/v2/bot/message/push");
    pushed.push(JSON.parse(String(init?.body)));
    return jsonResponse({});
  }, async () => {
    await flushQueuedNotifications({
      env: { LINE_CHANNEL_ACCESS_TOKEN: "line-token" },
      db: db as never,
    });
  });

  assert.equal(pushed.length, 1);
  assert.equal(db.updatedStatus, "sent");
});

test("LINE postback confirmation path is disabled", async () => {
  const pushed: unknown[] = [];
  const replied: unknown[] = [];
  const db = fakeNotificationDb();
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
            replyMessage: async (payload) => {
              replied.push(payload);
              return { sentMessages: [] };
            },
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

  assert.equal(pushed.length, 0);
  assert.equal(
    (replied[0] as { messages: Array<{ text: string }> }).messages[0].text,
    "這個操作已停用，請重新記帳或到圖形化帳本編輯。",
  );
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

test("notification service skips proactive insight scan when disabled", async () => {
  const { scanProactiveInsights } = await import("./notification-service");

  const mockDb = {
    from() {
      throw new Error("should not query db when insights are disabled");
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const count = await scanProactiveInsights(mockDb, "2026-07-01");
  assert.equal(count, 0);
});

test("write tools: record_expense returns pending_action with expense", async () => {
  const { executeTool } = await import("./accountant-tools");

  const mockDb = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          neq: () => ({
            single: () => Promise.resolve({ data: { user_id: "partner-123" }, error: null }),
          }),
          single: () =>
            Promise.resolve({
              data: { id: "user-1", couple_id: 1, line_user_id: "line-1", role: "owner" },
              error: null,
            }),
          order: () =>
            Promise.resolve({
              data: [
                { id: "user-1", couple_id: 1, line_user_id: "line-1", role: "owner" },
                { id: "partner-123", couple_id: 1, line_user_id: "line-2", role: "partner" },
              ],
              error: null,
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
      expense: {
        description: string;
        amount_twd: number;
        paid_by_user_id: string;
        group_id: string | null;
      };
      splits: Record<string, number>;
    };
    message: string;
  };

  assert.equal(res.pending_action.type, "create_expense");
  assert.equal(res.pending_action.expense.description, "晚餐");
  assert.equal(res.pending_action.expense.amount_twd, 860);
  assert.equal(res.pending_action.expense.paid_by_user_id, "user-1");
  assert.equal(res.pending_action.expense.group_id, "group-1");
  assert.deepEqual(res.pending_action.splits, {
    "user-1": 430,
    "partner-123": 430,
  });
  assert.ok(res.message.includes("860"));
  assert.equal(res.message.includes("請確認"), false);
});

test("write tools: record_expense keeps private expenses out of shared group payload", async () => {
  const { executeTool } = await import("./accountant-tools");

  const mockDb = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          neq: () => ({
            single: () => Promise.resolve({ data: { user_id: "partner-123" }, error: null }),
          }),
          single: () =>
            Promise.resolve({
              data: { id: "user-1", couple_id: 1, line_user_id: "line-1", role: "owner" },
              error: null,
            }),
          order: () =>
            Promise.resolve({
              data: [
                { id: "user-1", couple_id: 1, line_user_id: "line-1", role: "owner" },
                { id: "partner-123", couple_id: 1, line_user_id: "line-2", role: "partner" },
              ],
              error: null,
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
      description: "共享機車",
      amount_twd: 185,
      paid_by: "self",
      ledger: "private",
      tag: "交通",
    },
    ctx,
  );

  const res = result as {
    pending_action: {
      expense: { group_id: string | null; paid_by_user_id: string };
      splits: Record<string, number>;
    };
    message: string;
  };

  assert.equal(res.pending_action.expense.group_id, null);
  assert.equal(res.pending_action.expense.paid_by_user_id, "user-1");
  assert.deepEqual(res.pending_action.splits, { "user-1": 185 });
  assert.ok(res.message.includes("185"));
  assert.equal(res.message.includes("請確認"), false);
});

test("write tools: record_expense rejects exact split method", async () => {
  const { executeTool } = await import("./accountant-tools");

  const mockDb = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          neq: () => ({
            single: () => Promise.resolve({ data: { user_id: "partner-123" }, error: null }),
          }),
          single: () =>
            Promise.resolve({
              data: { id: "user-1", couple_id: 1, line_user_id: "line-1", role: "owner" },
              error: null,
            }),
          order: () =>
            Promise.resolve({
              data: [
                { id: "user-1", couple_id: 1, line_user_id: "line-1", role: "owner" },
                { id: "partner-123", couple_id: 1, line_user_id: "line-2", role: "partner" },
              ],
              error: null,
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
      split_method: "exact",
    },
    ctx,
  );

  const res = result as { error: string };
  assert.equal(res.error, "AI 記帳目前只支援平均分攤");
});




test("pending action service proposes batch-created expenses at couple scope when groups differ", async () => {
  const service = new PendingActionService();
  let executed:
    | {
        actionType: string;
        groupId: string | null;
        payload: Record<string, unknown>;
        sourceEventId: string;
        idempotencyKey?: string | null;
      }
    | null = null;

  (
    service as unknown as {
      execute: (
        context: unknown,
        input: {
          actionType: string;
          groupId: string | null;
          payload: Record<string, unknown>;
          sourceEventId: string;
          idempotencyKey?: string | null;
        },
      ) => Promise<unknown>;
    }
  ).execute = async (_context, input) => {
    executed = input;
    return {
      result: "confirmed",
      action_type: "batch_create_expenses",
    };
  };

  const db = {
    from(table: string) {
      if (table === "users") {
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          order() {
            return query;
          },
          then(
            resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown,
            reject?: (reason: unknown) => unknown,
          ) {
            return Promise.resolve({
              data: [
                {
                  id: CORE_OWNER,
                  couple_id: 1,
                  line_user_id: "line-owner",
                  role: "owner",
                },
                {
                  id: CORE_PARTNER,
                  couple_id: 1,
                  line_user_id: "line-partner",
                  role: "partner",
                },
              ],
              error: null,
            }).then(resolve, reject);
          },
        };
        return query;
      }
      if (table === "groups") {
        let groupId = "";
        const query = {
          select() {
            return query;
          },
          eq(_field: string, value: string | number) {
            if (_field === "id") groupId = String(value);
            return query;
          },
          is() {
            return query;
          },
          single: async () => ({
            data: { id: groupId },
            error: null,
          }),
        };
        return query;
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const result = await (
    service as unknown as {
      proposeBatchCreateExpenses: (
        context: unknown,
        inputs: CreateExpenseActionInput[],
        idempotencyKey?: string,
      ) => Promise<{ result: string; action_type: string }>;
    }
  ).proposeBatchCreateExpenses(
    {
      db,
      user: {
        id: CORE_OWNER,
        couple_id: 1,
        line_user_id: "line-owner",
        role: "owner",
      },
    },
    [
      {
        type: "create_expense",
        expense: {
          ledger: "shared",
          groupId: GROUP,
          description: "晚餐",
          merchant: null,
          notes: null,
          tag: "其他",
          amountTwd: 120,
          paidBy: "self",
          expenseDate: "2026-07-01",
          splitMethod: "equal",
          selfValue: null,
          partnerValue: null,
          receiptId: null,
        },
      },
      {
        type: "create_expense",
        expense: {
          ledger: "private",
          groupId: null,
          description: "共享機車",
          merchant: null,
          notes: null,
          tag: "交通",
          amountTwd: 185,
          paidBy: "self",
          expenseDate: "2026-07-01",
          splitMethod: "equal",
          selfValue: null,
          partnerValue: null,
          receiptId: null,
        },
      },
    ],
    "receipt-1",
  );

  assert.equal(result.result, "confirmed");
  assert.equal(result.action_type, "batch_create_expenses");
  if (!executed) throw new Error("expected execute to be called");
  const executedInput = executed as {
    actionType: string;
    groupId: string | null;
    payload: Record<string, unknown>;
    sourceEventId: string;
    idempotencyKey?: string | null;
  };
  assert.equal(executedInput.groupId, null);
  assert.equal(executedInput.actionType, "batch_create_expenses");
  assert.equal(executedInput.idempotencyKey, "receipt-1");
  assert.match(executedInput.sourceEventId, /^batch:/);
  const command = pendingActionCommandFromPayload(executedInput.payload);
  assert.equal(command?.type, "batch_create_expenses");
  assert.equal(command?.expenses.length, 2);
  assert.equal(command?.expenses[0]?.ledger, "shared");
  assert.equal(command?.expenses[1]?.ledger, "private");
});

test("pending action service proposes settlement from current group balances", async () => {
  const service = new PendingActionService();
  let executed:
    | {
        actionType: string;
        groupId: string | null;
        payload: Record<string, unknown>;
        sourceEventId: string;
        idempotencyKey?: string | null;
      }
    | null = null;

  (
    service as unknown as {
      execute: (
        context: unknown,
        input: {
          actionType: string;
          groupId: string | null;
          payload: Record<string, unknown>;
          sourceEventId: string;
          idempotencyKey?: string | null;
        },
      ) => Promise<unknown>;
    }
  ).execute = async (_context, input) => {
    executed = input;
    return {
      result: "confirmed",
      action_type: "settle",
    };
  };

  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      assert.equal(fn, "group_balances");
      assert.deepEqual(args, { p_group_id: GROUP });
      return {
        data: [
          { user_id: CORE_OWNER, balance_twd: -430 },
          { user_id: CORE_PARTNER, balance_twd: 430 },
        ],
        error: null,
      };
    },
    from(table: string) {
      if (table !== "groups") throw new Error(`unexpected table ${table}`);
      let groupId = "";
      const query = {
        select() {
          return query;
        },
        eq(_field: string, value: string | number) {
          if (_field === "id") groupId = String(value);
          return query;
        },
        is() {
          return query;
        },
        single: async () => ({
          data: { id: groupId },
          error: null,
        }),
      };
      return query;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const result = await (
    service as unknown as {
      proposeSettlement: (
        context: unknown,
        input: { type: "settle"; groupId: string; amountTwd: number },
        metadata: { source: string; idempotencyKey?: string | null },
      ) => Promise<{ result: string; action_type: string }>;
    }
  ).proposeSettlement(
    {
      db,
      user: {
        id: CORE_OWNER,
        couple_id: 1,
        line_user_id: "line-owner",
        role: "owner",
      },
    },
    {
      type: "settle",
      groupId: GROUP,
      amountTwd: 430,
    },
    {
      source: "liff",
      idempotencyKey: "settle-1",
    },
  );

  assert.equal(result.result, "confirmed");
  assert.equal(result.action_type, "settle");
  if (!executed) throw new Error("expected execute to be called");
  const executedInput = executed as {
    actionType: string;
    groupId: string | null;
    payload: Record<string, unknown>;
    sourceEventId: string;
    idempotencyKey?: string | null;
  };
  assert.equal(executedInput.actionType, "settle");
  assert.equal(executedInput.groupId, GROUP);
  assert.equal(executedInput.idempotencyKey, "settle-1");
  assert.match(executedInput.sourceEventId, /^liff:/);
  assert.partialDeepStrictEqual(executedInput.payload, {
    group_id: GROUP,
    from_user_id: CORE_OWNER,
    to_user_id: CORE_PARTNER,
    amount_twd: 430,
    expected_balance_twd: -430,
  });
  const command = pendingActionCommandFromPayload(executedInput.payload);
  assert.deepEqual(command, {
    type: "settle",
    groupId: GROUP,
    amountTwd: 430,
  });
});


test("actionResultMessage never treats stale auto-confirm as success", () => {
  assert.equal(
    actionResultMessage({ result: "stale", action_type: "create_expense" }),
    "帳目已變動，請重新操作。",
  );
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
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () =>
            Promise.resolve({
              data: { id: "user-1", couple_id: 1, line_user_id: "line-1", role: "owner" },
              error: null,
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
  assert.equal(res.message.includes("請確認"), false);
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
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () =>
            Promise.resolve({
              data: { id: "user-1", couple_id: 1, line_user_id: "line-1", role: "owner" },
              error: null,
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

test("accountant service lists shared and own reports newest first", async () => {
  const { AccountantService } = await import("./accountant-service");

  const sharedReport = {
    id: "00000000-0000-4000-8000-000000009001",
    group_id: GROUP,
    owner_user_id: null,
    report_type: "manual_question",
    scope: "shared",
    month: "2026-06-01",
    question: "共同帳哪裡花最多",
    title: "shared",
    summary: "shared summary",
    facts: {},
    findings: [],
    suggestions: [],
    source: "fallback",
    created_at: "2026-06-15T00:00:00.000Z",
  };
  const ownReport = {
    id: "00000000-0000-4000-8000-000000009002",
    group_id: null,
    owner_user_id: CORE_OWNER,
    report_type: "manual_question",
    scope: "private",
    month: "2026-06-01",
    question: "私人帳哪裡花最多",
    title: "own",
    summary: "own summary",
    facts: {},
    findings: [],
    suggestions: [],
    source: "fallback",
    created_at: "2026-06-20T00:00:00.000Z",
  };

  const mockDb = {
    from(table: string) {
      if (table === "user_preferences") {
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          single: async () => ({
            data: { active_group_id: GROUP },
            error: null,
          }),
        };
        return query;
      }
      if (table === "accountant_reports") {
        let shared = false;
        const query = {
          select() {
            return query;
          },
          eq(field: string, value: unknown) {
            if (field === "group_id" && value === GROUP) shared = true;
            return query;
          },
          is(field: string, value: unknown) {
            if (field === "owner_user_id" && value === null) shared = true;
            return query;
          },
          order() {
            return query;
          },
          limit() {
            return query;
          },
          then(
            resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown,
            reject?: (reason: unknown) => unknown,
          ) {
            return Promise.resolve({
              data: [shared ? sharedReport : ownReport],
              error: null,
            }).then(resolve, reject);
          },
        };
        return query;
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const service = new AccountantService();
  const reports = await service.listReports({
    env: {} as ServerContext["env"],
    db: mockDb,
    user: {
      id: CORE_OWNER,
      couple_id: 1,
      line_user_id: "line-owner",
      role: "owner",
    },
  });

  assert.deepEqual(
    reports.map((report: { id: string }) => report.id),
    [ownReport.id, sharedReport.id],
  );
});

test("accountant service generates monthly reports and targets notifications correctly", async () => {
  const { AccountantService } = await import("./accountant-service");

  const users = [
    {
      id: CORE_OWNER,
      couple_id: 1,
      line_user_id: "line-owner",
      role: "owner",
    },
    {
      id: CORE_PARTNER,
      couple_id: 1,
      line_user_id: "line-partner",
      role: "partner",
    },
  ];
  const groups = [{ id: GROUP, couple_id: 1 }];
  const generateCalls: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];

  const service = new AccountantService();
  const serviceWithOverrides = service as unknown as {
    generateReport: (
      context: ServerContext,
      input: Record<string, unknown>,
    ) => Promise<{ id: string; title: string }>;
    generateMonthlyReports: (
      env: ServerContext["env"],
      db: import("@supabase/supabase-js").SupabaseClient,
      month: string,
    ) => Promise<number>;
  };
  serviceWithOverrides.generateReport = async (
    context: ServerContext,
    input: Record<string, unknown>,
  ) => {
    generateCalls.push({
      userId: context.user.id,
      scope: input.scope,
      month: input.month,
      groupId: input.groupId ?? null,
    });
    const scope = String(input.scope);
    const userId = context.user.id;
    return {
      id:
        scope === "shared"
          ? "00000000-0000-4000-8000-000000009101"
          : userId === CORE_OWNER
            ? "00000000-0000-4000-8000-000000009102"
            : "00000000-0000-4000-8000-000000009103",
      title: `${scope}-${userId}`,
    };
  };

  const mockDb = {
    from(table: string) {
      if (table === "users") {
        const query = {
          select() {
            return query;
          },
          order() {
            return Promise.resolve({ data: users, error: null });
          },
        };
        return query;
      }
      if (table === "groups") {
        const query = {
          select() {
            return query;
          },
          is() {
            return Promise.resolve({ data: groups, error: null });
          },
        };
        return query;
      }
      if (table === "notifications") {
        return {
          upsert(payload: Record<string, unknown>) {
            notifications.push(payload);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const count = await serviceWithOverrides.generateMonthlyReports(
    {
      APP_URL: "https://example.com",
    } as ServerContext["env"],
    mockDb,
    "2026-06",
  );

  assert.equal(count, 3);
  assert.deepEqual(generateCalls, [
    { userId: CORE_OWNER, scope: "shared", month: "2026-06", groupId: GROUP },
    { userId: CORE_OWNER, scope: "private", month: "2026-06", groupId: null },
    { userId: CORE_PARTNER, scope: "private", month: "2026-06", groupId: null },
  ]);
  assert.deepEqual(
    notifications.map((row) => ({
      recipient_user_id: row.recipient_user_id,
      group_id: row.group_id,
      title: row.title,
    })),
    [
      { recipient_user_id: CORE_OWNER, group_id: GROUP, title: "AI 會計師月報" },
      { recipient_user_id: CORE_PARTNER, group_id: GROUP, title: "AI 會計師月報" },
      { recipient_user_id: CORE_OWNER, group_id: null, title: "AI 私人帳月報" },
      { recipient_user_id: CORE_PARTNER, group_id: null, title: "AI 私人帳月報" },
    ],
  );
});

test("agent chat service reuses active session and appends the reply", async () => {
  const { AgentChatService } = await import("./agent-chat-service");

  let updated: Record<string, unknown> | null = null;
  const service = new AgentChatService({
    generateTextImpl: async (input: Record<string, unknown>) => {
      const messages = input.messages as Array<{ role: string; content: unknown }>;
      assert.equal(messages.at(-1)?.role, "user");
      assert.equal(messages.at(-1)?.content, "今天共同帳花多少");
      return {
        steps: [],
        text: "今天共同帳花了 NT$520。",
      };
    },
  });

  const mockDb = {
    from(table: string) {
      if (table === "accountant_sessions") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve({
                    data: {
                      id: "00000000-0000-4000-8000-000000000401",
                      messages: [{ role: "assistant", content: "前一次回覆" }],
                      last_active_at: new Date().toISOString(),
                    },
                    error: null,
                  }),
              }),
            }),
          }),
          update: (row: Record<string, unknown>) => {
            updated = row;
            return {
              eq: () => Promise.resolve({ error: null }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const result = await service.chat(
    {
      db: mockDb,
      user: {
        id: CORE_OWNER,
        couple_id: 1,
      },
      getActiveGroupId: async () => GROUP,
    },
    {
      sessionId: "00000000-0000-4000-8000-000000000401",
      message: "今天共同帳花多少",
    },
  );

  assert.equal(result.sessionId, "00000000-0000-4000-8000-000000000401");
  assert.equal(result.answer, "今天共同帳花了 NT$520。");
  assert.equal(result.toolCallCount, 0);
  assert.ok(updated);
  const updatedMessages = (updated as { messages: Array<{ role: string; content: string }> }).messages;
  assert.deepEqual(updatedMessages.map((item) => item.role), [
    "assistant",
    "user",
    "assistant",
  ]);
});

test("agent chat service transcribes audio with injected generator", async () => {
  const { AgentChatService } = await import("./agent-chat-service");

  const service = new AgentChatService({
    generateTextImpl: async (input: Record<string, unknown>) => {
      const messages = input.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
      assert.equal(messages[0]?.role, "user");
      assert.equal(messages[0]?.content[0]?.mimeType, "audio/x-m4a");
      return { text: "共享機車 185 元" };
    },
  });

  const text = await service.transcribeAudio(Buffer.from("abc"), "audio/x-m4a");
  assert.equal(text, "共享機車 185 元");
});

test("agent-loop: buildSystemPrompt includes today date", async () => {
  const { runAgentLoop } = await import("./agent-loop");

  const mockGemini: AgentDeps["gemini"] = {
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
  };

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
    type: "review_unmatched_bank_items",
    title: "審查未匹配的銀行項目",
    summary: "這筆交易缺對應發票",
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

test("secretary: RuleService creates approved group merchant rule", async () => {
  const { RuleService } = await import("./rule-service");

  let inserted: Record<string, unknown> | null = null;
  const mockDb = {
    from: () => ({
      insert: (payload: Record<string, unknown>) => {
        inserted = payload;
        return {
          select: () => ({
            single: () =>
              Promise.resolve({
                data: { id: "00000000-0000-4000-8000-000000000004" },
                error: null,
              }),
          }),
        };
      },
    }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const service = new RuleService(mockDb);
  const result = await service.createMerchantRule({
    coupleId: 1,
    groupId: "00000000-0000-4000-8000-000000000010",
    userId: "00000000-0000-4000-8000-000000000011",
    merchant: "Uber",
    rule: {
      ledger: "private",
      tag: "交通",
      paidBy: "self",
    },
    source: "line",
  });

  assert.equal(result.memoryId, "00000000-0000-4000-8000-000000000004");
  assert.equal(
    result.message,
    "我記住了：之後「Uber」預設為 私人帳 / 交通 / 你付。",
  );
  assert.deepEqual(result.memory, {
    kind: "merchant_rule",
    key: "Uber",
    value: {
      ledger: "private",
      tag: "交通",
      paid_by: "self",
    },
  });
  assert.ok(inserted);
  const insertedMemory = inserted as Record<string, unknown>;
  assert.equal(insertedMemory.couple_id, 1);
  assert.equal(insertedMemory.group_id, "00000000-0000-4000-8000-000000000010");
  assert.equal(insertedMemory.user_id, "00000000-0000-4000-8000-000000000011");
  assert.equal(insertedMemory.scope, "group");
  assert.equal(insertedMemory.kind, "merchant_rule");
  assert.equal(insertedMemory.source, "line");
  assert.equal(typeof insertedMemory.approved_at, "string");
});

test("secretary: TaskService creates owner-scoped secretary task", async () => {
  const { TaskService } = await import("./task-service");

  let inserted: Record<string, unknown> | null = null;
  const mockDb = {
    from: () => ({
      insert: (payload: Record<string, unknown>) => {
        inserted = payload;
        return {
          select: () => ({
            single: () =>
              Promise.resolve({
                data: { id: "00000000-0000-4000-8000-000000000005" },
                error: null,
              }),
          }),
        };
      },
    }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const service = new TaskService(mockDb);
  const result = await service.createSecretaryTask({
    coupleId: 1,
    groupId: "00000000-0000-4000-8000-000000000020",
    userId: "00000000-0000-4000-8000-000000000021",
    type: "tag_cleanup",
    title: "整理共享機車分類",
    summary: "把最近幾筆交通分類整理一下",
    priority: "high",
    source: "line",
  });

  assert.equal(result.taskId, "00000000-0000-4000-8000-000000000005");
  assert.equal(result.message, "已建立任務：整理共享機車分類");
  assert.ok(inserted);
  const insertedTask = inserted as Record<string, unknown>;
  assert.equal(insertedTask.couple_id, 1);
  assert.equal(insertedTask.group_id, "00000000-0000-4000-8000-000000000020");
  assert.equal(insertedTask.owner_user_id, "00000000-0000-4000-8000-000000000021");
  assert.equal(insertedTask.type, "tag_cleanup");
  assert.equal(insertedTask.title, "整理共享機車分類");
  assert.equal(insertedTask.summary, "把最近幾筆交通分類整理一下");
  assert.equal(insertedTask.priority, "high");
  assert.equal(insertedTask.source, "line");
});

test("secretary workflow service aggregates tool side effects", async () => {
  const { SecretaryWorkflowService } = await import("./secretary-workflow-service");

  const calls: string[] = [];
  const ctx = {
    db: null,
    groupId: "g1",
    userId: "u1",
    coupleId: 1,
  } as unknown as import("./accountant-tools").ToolContext;

  const service = new SecretaryWorkflowService({
    executeTool: async (name: string) => {
      calls.push(name);
      if (name === "record_expense") {
        return { pending_action: { type: "create_expense", id: "pa-1" } };
      }
      if (name === "create_task") {
        return { task_id: "task-1" };
      }
      return { ok: true };
    },
  });

  await service.executeTool("record_expense", { amount_twd: 185 }, ctx);
  await service.executeTool("create_task", { title: "整理分類" }, ctx);

  const result = service.finish("已處理。");

  assert.deepEqual(calls, ["record_expense", "create_task"]);
  assert.equal(result.answer, "已處理。");
  assert.equal(result.toolCallCount, 2);
  assert.deepEqual(result.pendingActions, [{ type: "create_expense", id: "pa-1" }]);
  assert.deepEqual(result.newTasks, ["task-1"]);
  assert.equal(result.notifyPartner, false);
  assert.equal(result.partnerMessage, null);
});

test("secretary workflow service keeps partner notifications for shared changes", async () => {
  const { SecretaryWorkflowService } = await import("./secretary-workflow-service");

  const ctx = {
    db: null,
    groupId: "g1",
    userId: "u1",
    coupleId: 1,
  } as unknown as import("./accountant-tools").ToolContext;

  const service = new SecretaryWorkflowService({
    executeTool: async () => ({ ok: true }),
  });

  await service.executeTool("propose_settlement", { amount_twd: 500 }, ctx);
  const result = service.finish("已幫你建立結清。");

  assert.equal(result.answer, "已幫你建立結清。");
  assert.equal(result.notifyPartner, true);
  assert.equal(result.partnerMessage, "已幫你建立結清。");
});

test("secretary workflow service strips explicit notify tags", async () => {
  const { SecretaryWorkflowService } = await import("./secretary-workflow-service");

  const service = new SecretaryWorkflowService({
    executeTool: async () => ({ ok: true }),
  });

  const result = service.finish("商家規則已更新 [通知另一半]");

  assert.equal(result.answer, "商家規則已更新");
  assert.equal(result.notifyPartner, true);
  assert.equal(result.partnerMessage, "商家規則已更新");
});

test("secretary session service loads session and augments approved merchant rules", async () => {
  const { SecretarySessionService } = await import("./secretary-session-service");

  const existingMessages = [
    {
      role: "user" as const,
      parts: [{ text: "[小明] 昨天晚餐 300" }],
    },
  ];

  const mockDb = {
    from: (table: string) => {
      if (table === "secretary_sessions") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    single: () =>
                      Promise.resolve({
                        data: {
                          id: "session-existing",
                          messages: existingMessages,
                        },
                      }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const service = new SecretarySessionService({
    db: mockDb,
    createSessionId: () => "session-new",
    matchMerchantRule: async () => ({
      matchScore: 1,
      memory: {
        id: "mem-1",
        couple_id: 1,
        group_id: "g1",
        user_id: "u1",
        scope: "group",
        kind: "merchant_rule",
        key: "uber",
        value: {
          ledger: "private",
          tag: "交通",
          paid_by: "self",
        },
        confidence: 0.9,
        source: "line",
        approved_at: "2026-06-30T00:00:00.000Z",
        expires_at: null,
        created_at: "2026-06-30T00:00:00.000Z",
        updated_at: "2026-06-30T00:00:00.000Z",
      },
    }),
  });

  const prepared = await service.prepareTurn({
    input: { text: "幫我記 Uber 185" },
    sessionId: "session-seed",
    userId: "u1",
    coupleId: 1,
    groupId: "g1",
    userName: "小明",
  });

  assert.equal(prepared.sessionId, "session-existing");
  assert.equal(prepared.messages.length, 2);
  assert.equal(prepared.messages[0].parts[0]?.text, "[小明] 昨天晚餐 300");
  assert.equal(
    prepared.messages[1].parts[0]?.text,
    "[小明] 幫我記 Uber 185（已知規則：私人, 交通, 你付，幫我直接套用）",
  );
});

test("secretary session service trims history before saving", async () => {
  const { SecretarySessionService } = await import("./secretary-session-service");

  let upserted: Record<string, unknown> | null = null;
  const mockDb = {
    from: (table: string) => {
      if (table === "secretary_sessions") {
        return {
          upsert: (payload: Record<string, unknown>) => {
            upserted = payload;
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const service = new SecretarySessionService({
    db: mockDb,
    createSessionId: () => "session-new",
    matchMerchantRule: async () => null,
  });

  const longMessages = Array.from({ length: 70 }, (_, index) => ({
    role: (index % 2 === 0 ? "user" : "model") as "user" | "model",
    parts: [{ text: `m${index}` }],
  }));

  await service.saveTurn({
    sessionId: "session-1",
    userId: "u1",
    coupleId: 1,
    groupId: "g1",
    messages: longMessages,
    answer: "最新回覆",
  });

  assert.ok(upserted);
  const saved = upserted as Record<string, unknown>;
  assert.equal(saved.id, "session-1");
  assert.equal(saved.couple_id, 1);
  assert.equal(saved.group_id, "g1");
  assert.equal(saved.last_active_user_id, "u1");
  assert.equal(typeof saved.last_active_at, "string");
  assert.ok(Array.isArray(saved.messages));
  assert.equal((saved.messages as unknown[]).length, 60);
  const lastMessage = (saved.messages as Array<{ parts?: Array<{ text?: string }> }>).at(-1);
  assert.equal(lastMessage?.parts?.[0]?.text, "最新回覆");
});

test("secretary prompt service includes balance, task count, and approved merchant rules", async () => {
  const { SecretaryPromptService } = await import("./secretary-prompt-service");

  const service = new SecretaryPromptService({
    db: {} as import("@supabase/supabase-js").SupabaseClient,
    getBalances: async () => [
      { user_id: "u1", balance_twd: 250 },
      { user_id: "u2", balance_twd: -250 },
    ],
    taskService: {
      listOpenTasks: async () => [{ id: "task-1" }, { id: "task-2" }],
    } as unknown as Pick<import("./task-service").TaskService, "listOpenTasks">,
    ruleService: {
      listMemories: async () => [
        {
          id: "mem-1",
          couple_id: 1,
          group_id: "g1",
          user_id: "u1",
          scope: "group",
          kind: "merchant_rule",
          key: "uber",
          value: { ledger: "private", tag: "交通" },
          confidence: 0.9,
          source: "line",
          approved_at: "2026-06-30T00:00:00.000Z",
          expires_at: null,
          created_at: "2026-06-30T00:00:00.000Z",
          updated_at: "2026-06-30T00:00:00.000Z",
        },
        {
          id: "mem-2",
          couple_id: 1,
          group_id: "g1",
          user_id: "u1",
          scope: "group",
          kind: "merchant_rule",
          key: "taxi",
          value: { ledger: "shared" },
          confidence: 0.9,
          source: "line",
          approved_at: null,
          expires_at: null,
          created_at: "2026-06-30T00:00:00.000Z",
          updated_at: "2026-06-30T00:00:00.000Z",
        },
      ],
    } as Pick<import("./rule-service").RuleService, "listMemories">,
  });

  const prompt = await service.buildPrompt({
    ctx: {
      db: {} as import("@supabase/supabase-js").SupabaseClient,
      groupId: "g1",
      userId: "u1",
      coupleId: 1,
    } as import("./accountant-tools").ToolContext,
    today: "2026-06-30",
    userName: "小明",
    partnerName: "小美",
  });

  assert.match(prompt, /今天是 2026-06-30。/);
  assert.match(prompt, /目前：另一半欠 小明 NT\$250/);
  assert.match(prompt, /目前有 2 件待處理任務。/);
  assert.match(prompt, /已知商家規則：uber → \{"ledger":"private","tag":"交通"\}/);
  assert.doesNotMatch(prompt, /taxi/);
});

test("secretary prompt service omits optional sections when nothing is pending", async () => {
  const { SecretaryPromptService } = await import("./secretary-prompt-service");

  const service = new SecretaryPromptService({
    db: {} as import("@supabase/supabase-js").SupabaseClient,
    getBalances: async () => [{ user_id: "u1", balance_twd: 0 }],
    taskService: {
      listOpenTasks: async () => [],
    } as unknown as Pick<import("./task-service").TaskService, "listOpenTasks">,
    ruleService: {
      listMemories: async () => [],
    } as Pick<import("./rule-service").RuleService, "listMemories">,
  });

  const prompt = await service.buildPrompt({
    ctx: {
      db: {} as import("@supabase/supabase-js").SupabaseClient,
      groupId: "g1",
      userId: "u1",
      coupleId: 1,
    } as import("./accountant-tools").ToolContext,
    today: "2026-06-30",
    userName: "小明",
    partnerName: "小美",
  });

  assert.match(prompt, /目前帳務已結清。/);
  assert.doesNotMatch(prompt, /件待處理任務/);
  assert.doesNotMatch(prompt, /已知商家規則/);
});

test("recurring service saves private recurring expenses without shared group scope", async () => {
  const { RecurringService } = await import("./recurring-service");

  const selfUserId = "00000000-0000-4000-8000-000000000101";
  const partnerUserId = "00000000-0000-4000-8000-000000000102";
  const groupId = "00000000-0000-4000-8000-000000000103";
  let inserted: Record<string, unknown> | null = null;
  let requireGroupCalls = 0;
  let activityArgs: unknown[] | null = null;
  let notifyArgs: unknown[] | null = null;
  let delivered = 0;

  const mockDb = {
    from: (table: string) => {
      if (table === "users") {
        return {
          select: () => ({
            eq: () => ({
              neq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: { id: partnerUserId },
                    error: null,
                  }),
              }),
            }),
          }),
        };
      }
      if (table === "recurring_expenses") {
        return {
          insert: (row: Record<string, unknown>) => {
            inserted = row;
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: { id: "00000000-0000-4000-8000-000000000104" },
                    error: null,
                  }),
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const service = new RecurringService();
  const result = await service.save(
    {
      db: mockDb,
      user: { id: selfUserId, couple_id: 1 },
      requireGroup: async () => {
        requireGroupCalls++;
      },
      appendActivity: async (...args: unknown[]) => {
        activityArgs = args;
      },
      notifyPartner: async (...args: unknown[]) => {
        notifyArgs = args;
      },
      deliverNotifications: async () => {
        delivered++;
      },
    },
    {
      id: null,
      ledger: "private",
      groupId,
      description: "Netflix",
      merchant: null,
      notes: null,
      tag: "娛樂",
      amountTwd: 390,
      paidBy: "self",
      expenseDate: "2026-06-30",
      splitMethod: "equal",
      selfValue: null,
      partnerValue: null,
      receiptId: null,
      frequency: "monthly",
      nextRunDate: "2026-07-15",
      endDate: null,
      active: true,
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(requireGroupCalls, 0);
  assert.ok(inserted);
  const row = inserted as Record<string, unknown>;
  assert.equal(row.group_id, null);
  assert.equal(row.ledger, "private");
  assert.equal(row.created_by_user_id, selfUserId);
  assert.equal(row.paid_by_user_id, selfUserId);
  assert.equal(row.anchor_day, 15);
  assert.deepEqual(activityArgs, [
    "00000000-0000-4000-8000-000000000104",
    "create",
    null,
    null,
    row,
  ]);
  assert.deepEqual(notifyArgs, [
    "週期支出已更新",
    "Netflix NT$390",
    null,
    "00000000-0000-4000-8000-000000000104",
  ]);
  assert.equal(delivered, 1);
});

test("recurring service deletes recurring expenses and notifies partner", async () => {
  const { RecurringService } = await import("./recurring-service");

  const recurringId = "00000000-0000-4000-8000-000000000105";
  let deleted = false;
  let activityArgs: unknown[] | null = null;
  let notifyArgs: unknown[] | null = null;
  let delivered = 0;

  const mockDb = {
    from: (table: string) => {
      if (table === "recurring_expenses") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve({
                    data: {
                      id: recurringId,
                      group_id: "00000000-0000-4000-8000-000000000106",
                      description: "健身房",
                    },
                    error: null,
                  }),
              }),
            }),
          }),
          delete: () => ({
            eq: () => ({
              eq: () => {
                deleted = true;
                return Promise.resolve({ error: null });
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const service = new RecurringService();
  const result = await service.save(
    {
      db: mockDb,
      user: { id: "00000000-0000-4000-8000-000000000101", couple_id: 1 },
      requireGroup: async () => undefined,
      appendActivity: async (...args: unknown[]) => {
        activityArgs = args;
      },
      notifyPartner: async (...args: unknown[]) => {
        notifyArgs = args;
      },
      deliverNotifications: async () => {
        delivered++;
      },
    },
    {
      operation: "delete",
      id: recurringId,
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(deleted, true);
  assert.deepEqual(activityArgs, [
    recurringId,
    "delete",
    "00000000-0000-4000-8000-000000000106",
    {
      id: recurringId,
      group_id: "00000000-0000-4000-8000-000000000106",
      description: "健身房",
    },
    null,
  ]);
  assert.deepEqual(notifyArgs, [
    "週期支出已刪除",
    "已刪除週期支出：「健身房」",
    "00000000-0000-4000-8000-000000000106",
    recurringId,
  ]);
  assert.equal(delivered, 1);
});

test("recurring service auto-posts due recurring expenses", async () => {
  const { RecurringService } = await import("./recurring-service");

  const recurringId = "00000000-0000-4000-8000-000000000107";
  const creatorId = "00000000-0000-4000-8000-000000000108";
  const groupId = "00000000-0000-4000-8000-000000000109";
  const executed: Array<{ userId: string; sourceEventId: string; groupId: string | null }> = [];
  const recurringUpdates: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];

  const mockDb = {
    from: (table: string) => {
      if (table === "recurring_expenses") {
        return {
          select: () => ({
            eq: (_field: string, _value: unknown) => ({
              lte: (_lteField: string, _lteValue: unknown) =>
                Promise.resolve({
                  data: [
                    {
                      id: recurringId,
                      group_id: groupId,
                      created_by_user_id: creatorId,
                      paid_by_user_id: creatorId,
                      ledger: "shared",
                      description: "Spotify",
                      amount_twd: 149,
                      tag: "娛樂",
                      split_method: "equal",
                      splits: [],
                      next_run_date: "2026-07-15",
                      frequency: "monthly",
                      anchor_day: 15,
                      end_date: "2026-12-31",
                    },
                  ],
                  error: null,
                }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: (_field: string, value: unknown) => {
              recurringUpdates.push({ id: String(value), ...payload });
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      if (table === "users") {
        return {
          select: () => ({
            eq: (_field: string, value: unknown) => ({
              single: () =>
                Promise.resolve({
                  data: {
                    id: String(value),
                    couple_id: 1,
                    line_user_id: "line-user",
                    role: "owner",
                  },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === "notifications") {
        return {
          upsert: (payload: Record<string, unknown>) => {
            notifications.push(payload);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const service = new RecurringService();
  const count = await (service as unknown as {
    runDue: (context: {
      env: ServerContext["env"];
      db: import("@supabase/supabase-js").SupabaseClient;
      today: string;
      executePendingAction: (
        context: { user: { id: string } },
        input: { sourceEventId: string; groupId: string | null },
      ) => Promise<void>;
    }) => Promise<number>;
  }).runDue({
    env: {} as ServerContext["env"],
    db: mockDb,
    today: "2026-07-20",
    executePendingAction: async (context, input) => {
      executed.push({
        userId: context.user.id,
        sourceEventId: input.sourceEventId,
        groupId: input.groupId,
      });
    },
  });

  assert.equal(count, 1);
  assert.deepEqual(executed, [
    {
      userId: creatorId,
      sourceEventId: `recurring:${recurringId}:2026-07-15`,
      groupId,
    },
  ]);
  assert.deepEqual(recurringUpdates, [
    {
      id: recurringId,
      next_run_date: "2026-08-15",
      active: true,
      updated_at: recurringUpdates[0]?.updated_at,
    },
  ]);
  assert.deepEqual(notifications, [
    {
      recipient_user_id: creatorId,
      group_id: groupId,
      kind: "recurring",
      title: "週期支出已自動入帳",
      body: "Spotify NT$149",
      entity_type: "recurring",
      entity_id: recurringId,
      dedupe_key: `recurring:${recurringId}:2026-07-15`,
    },
  ]);
});

test("group service creates a group and activates it for the caller", async () => {
  const { GroupService } = await import("./group-service");

  const groupId = "00000000-0000-4000-8000-000000000201";
  let inserted: Record<string, unknown> | null = null;
  let preferenceUpdate: Record<string, unknown> | null = null;
  let appendArgs: unknown[] | null = null;

  const mockDb = {
    from: (table: string) => {
      if (table === "groups") {
        return {
          insert: (row: Record<string, unknown>) => {
            inserted = row;
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: { id: groupId },
                    error: null,
                  }),
              }),
            };
          },
        };
      }
      if (table === "user_preferences") {
        return {
          update: (row: Record<string, unknown>) => {
            preferenceUpdate = row;
            return {
              eq: () => Promise.resolve({ error: null }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const result = await new GroupService().change(
    {
      db: mockDb,
      user: {
        id: "00000000-0000-4000-8000-000000000202",
        couple_id: 1,
      },
      requireGroup: async () => {
        throw new Error("requireGroup should not be called for create");
      },
      appendActivity: async (...args: unknown[]) => {
        appendArgs = args;
      },
    },
    {
      operation: "create",
      name: "旅遊",
      color: "#22c55e",
    },
  );

  assert.deepEqual(result, { groupId });
  assert.deepEqual(inserted, {
    couple_id: 1,
    name: "旅遊",
    color: "#22c55e",
    created_by_user_id: "00000000-0000-4000-8000-000000000202",
  });
  assert.ok(preferenceUpdate);
  const activeRow = preferenceUpdate as Record<string, unknown>;
  assert.equal(activeRow.active_group_id, groupId);
  assert.equal(typeof activeRow.updated_at, "string");
  assert.deepEqual(appendArgs, [
    groupId,
    "create",
    groupId,
    null,
    { name: "旅遊", color: "#22c55e" },
  ]);
});

test("group service archives a group and moves active users to another group", async () => {
  const { GroupService } = await import("./group-service");

  const oldGroupId = "00000000-0000-4000-8000-000000000203";
  const nextGroupId = "00000000-0000-4000-8000-000000000204";
  let archivedRow: Record<string, unknown> | null = null;
  let preferenceUpdate: Record<string, unknown> | null = null;
  let appendArgs: unknown[] | null = null;

  const mockDb = {
    from: (table: string) => {
      if (table === "groups") {
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                neq: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: () =>
                        Promise.resolve({
                          data: { id: nextGroupId },
                          error: null,
                        }),
                    }),
                  }),
                }),
              }),
            }),
          }),
          update: (row: Record<string, unknown>) => {
            archivedRow = row;
            return {
              eq: () => Promise.resolve({ error: null }),
            };
          },
        };
      }
      if (table === "user_preferences") {
        return {
          update: (row: Record<string, unknown>) => {
            preferenceUpdate = row;
            return {
              eq: () => Promise.resolve({ error: null }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const result = await new GroupService().change(
    {
      db: mockDb,
      user: {
        id: "00000000-0000-4000-8000-000000000205",
        couple_id: 1,
      },
      requireGroup: async () => ({
        id: oldGroupId,
        name: "日常",
      }),
      appendActivity: async (...args: unknown[]) => {
        appendArgs = args;
      },
    },
    {
      operation: "archive",
      groupId: oldGroupId,
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.ok(archivedRow);
  const archivePayload = archivedRow as Record<string, unknown>;
  assert.equal(typeof archivePayload.archived_at, "string");
  assert.equal(typeof archivePayload.updated_at, "string");
  assert.ok(preferenceUpdate);
  const activeRow = preferenceUpdate as Record<string, unknown>;
  assert.equal(activeRow.active_group_id, nextGroupId);
  assert.equal(typeof activeRow.updated_at, "string");
  assert.deepEqual(appendArgs, [
    oldGroupId,
    "archive",
    oldGroupId,
    { id: oldGroupId, name: "日常" },
    { id: oldGroupId, name: "日常", archived: true },
  ]);
});

test("bank import service uses active group and returns match summary", async () => {
  const { BankImportService } = await import("./bank-import-service");

  let requestedGroupId: string | null = null;
  let requestedStartDate: string | null = null;

  const service = new BankImportService({
    today: () => "2026-06-30",
    parseCsv: () => ({
      bank: "ctbc",
      transactions: [
        {
          date: "2026-06-20",
          amount: 185,
          description: "UBER TRIP",
        },
        {
          date: "2026-06-18",
          amount: 90,
          description: "7-11",
        },
      ],
    }),
    loadExpenses: async (_db, groupId, startDate) => {
      requestedGroupId = groupId;
      requestedStartDate = startDate;
      return [
        {
          id: "00000000-0000-4000-8000-000000000301",
          description: "共享機車",
          merchant: "Uber",
          amount_twd: 185,
          expense_date: "2026-06-20",
          deleted_at: null,
        },
      ];
    },
    matchTransactions: (rows) =>
      rows.map((row, index) => ({
        bankTx: row,
        matchedExpenseId:
          index === 0 ? "00000000-0000-4000-8000-000000000301" : undefined,
        matchedDescription: index === 0 ? "共享機車" : undefined,
        confidence: index === 0 ? 0.95 : 0.12,
      })),
  });

  const result = await service.import(
    {
      db: {} as import("@supabase/supabase-js").SupabaseClient,
      getActiveGroupId: async () => "00000000-0000-4000-8000-000000000302",
    },
    {
      csv: "mock csv",
      bank: "auto",
    },
  );

  assert.equal(requestedGroupId, "00000000-0000-4000-8000-000000000302");
  assert.equal(requestedStartDate, "2026-04-01");
  assert.deepEqual(result, {
    bank: "ctbc",
    transactionCount: 2,
    matchedCount: 1,
    matches: [
      {
        bankTx: {
          date: "2026-06-20",
          amount: 185,
          description: "UBER TRIP",
        },
        matchedExpenseId: "00000000-0000-4000-8000-000000000301",
        matchedDescription: "共享機車",
        confidence: 0.95,
      },
      {
        bankTx: {
          date: "2026-06-18",
          amount: 90,
          description: "7-11",
        },
        matchedExpenseId: null,
        matchedDescription: null,
        confidence: 0.12,
      },
    ],
  });
});

test("bank import service rejects CSV files with no parsed rows", async () => {
  const { BankImportService } = await import("./bank-import-service");

  const service = new BankImportService({
    parseCsv: () => ({
      bank: "esun",
      transactions: [],
    }),
  });

  await assert.rejects(
    () =>
      service.import(
        {
          db: {} as import("@supabase/supabase-js").SupabaseClient,
          getActiveGroupId: async () => "00000000-0000-4000-8000-000000000303",
        },
        {
          csv: "bad csv",
          bank: "auto",
        },
      ),
    (error: unknown) =>
      error instanceof HttpError &&
      error.status === 400 &&
      error.message === "無法解析 CSV，請確認銀行格式",
  );
});

test("secretary: getRecentExpenses filters by ledger through ledgerQueryService", async () => {
  const { executeSecretaryTool } = await import("./secretary-tools");

  const sharedData = [
    {
      id: "00000000-0000-4000-8000-000000000501",
      group_id: "00000000-0000-4000-8000-000000000502",
      ledger: "shared",
      description: "晚餐",
      merchant: null,
      tag: "餐飲",
      amount_twd: 860,
      paid_by_user_id: "00000000-0000-4000-8000-000000000503",
      created_by_user_id: "00000000-0000-4000-8000-000000000503",
      expense_date: "2026-06-27",
      version: 1,
      deleted_at: null,
      created_at: "2026-06-27T10:00:00Z",
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
    groupId: "00000000-0000-4000-8000-000000000502",
    userId: "00000000-0000-4000-8000-000000000503",
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

test("read tools: get_recent_expenses merges shared+private, sorts by created_at desc, dedupes and skips deleted", async () => {
  const { executeSecretaryTool } = await import("./secretary-tools");

  const sharedId = "00000000-0000-4000-8000-000000000601";
  const privateId = "00000000-0000-4000-8000-000000000602";
  const duplicateId = "00000000-0000-4000-8000-000000000603";
  const deletedId = "00000000-0000-4000-8000-000000000604";
  const groupId = "00000000-0000-4000-8000-000000000605";
  const userId = "00000000-0000-4000-8000-000000000606";
  const partnerId = "00000000-0000-4000-8000-000000000607";

  const sharedRows = [
    {
      id: sharedId,
      group_id: groupId,
      ledger: "shared",
      description: "shared-old",
      merchant: null,
      tag: "餐飲",
      amount_twd: 200,
      paid_by_user_id: userId,
      created_by_user_id: userId,
      expense_date: "2026-06-20",
      version: 1,
      deleted_at: null,
      created_at: "2026-06-20T10:00:00Z",
    },
    {
      id: duplicateId,
      group_id: groupId,
      ledger: "shared",
      description: "duplicate",
      merchant: null,
      tag: "餐飲",
      amount_twd: 100,
      paid_by_user_id: userId,
      created_by_user_id: userId,
      expense_date: "2026-06-22",
      version: 1,
      deleted_at: null,
      created_at: "2026-06-22T10:00:00Z",
    },
    {
      id: deletedId,
      group_id: groupId,
      ledger: "shared",
      description: "deleted-row",
      merchant: null,
      tag: "餐飲",
      amount_twd: 50,
      paid_by_user_id: userId,
      created_by_user_id: userId,
      expense_date: "2026-06-25",
      version: 1,
      deleted_at: "2026-06-26T00:00:00Z",
      created_at: "2026-06-25T10:00:00Z",
    },
  ];

  const privateRows = [
    {
      id: privateId,
      group_id: null,
      ledger: "private",
      description: "private-new",
      merchant: null,
      tag: "咖啡",
      amount_twd: 120,
      paid_by_user_id: userId,
      created_by_user_id: userId,
      expense_date: "2026-06-27",
      version: 1,
      deleted_at: null,
      created_at: "2026-06-27T10:00:00Z",
    },
    {
      id: duplicateId,
      group_id: null,
      ledger: "private",
      description: "duplicate-private",
      merchant: null,
      tag: "咖啡",
      amount_twd: 100,
      paid_by_user_id: userId,
      created_by_user_id: userId,
      expense_date: "2026-06-22",
      version: 1,
      deleted_at: null,
      created_at: "2026-06-22T10:00:00Z",
    },
  ];

  const ledgerHits: string[] = [];

  const mockDb = {
    from: (table: string) => {
      assert.equal(table, "expenses");
      const query = {
        select: () => query,
        eq: (field: string, value: string) => {
          if (field === "group_id") ledgerHits.push("shared");
          if (field === "created_by_user_id") ledgerHits.push("private");
          return query;
        },
        is: () => query,
        order: () => query,
        limit: () => {
          if (ledgerHits[ledgerHits.length - 1] === "shared") {
            return Promise.resolve({ data: sharedRows, error: null });
          }
          return Promise.resolve({ data: privateRows, error: null });
        },
      };
      return query;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const ctx = {
    db: mockDb,
    groupId,
    userId,
    coupleId: 1,
  };

  const result = (await executeSecretaryTool(
    "get_recent_expenses",
    { limit: 5 },
    ctx,
  )) as {
    count: number;
    items: Array<{
      id: string;
      description: string;
      ledger: "shared" | "private";
      paid_by: "self" | "partner";
    }>;
  };

  assert.equal(ledgerHits.includes("shared"), true);
  assert.equal(ledgerHits.includes("private"), true);
  assert.equal(result.count, 3);
  assert.equal(result.items[0].id, privateId);
  assert.equal(result.items[0].ledger, "private");
  assert.equal(result.items[0].paid_by, "self");
  assert.equal(result.items[1].id, duplicateId);
  assert.equal(result.items[2].id, sharedId);
  assert.equal(result.items[2].ledger, "shared");
  const ids = result.items.map((item) => item.id);
  assert.equal(ids.filter((id) => id === duplicateId).length, 1);
  assert.equal(ids.includes(deletedId), false);
});

test("read tools: get_recent_expenses marks partner-paid rows", async () => {
  const { executeSecretaryTool } = await import("./secretary-tools");

  const partnerPaidId = "00000000-0000-4000-8000-000000000701";
  const groupId = "00000000-0000-4000-8000-000000000702";
  const userId = "00000000-0000-4000-8000-000000000703";
  const partnerId = "00000000-0000-4000-8000-000000000704";

  const sharedRows = [
    {
      id: partnerPaidId,
      group_id: groupId,
      ledger: "shared",
      description: "對方付的",
      merchant: null,
      tag: "餐飲",
      amount_twd: 500,
      paid_by_user_id: partnerId,
      created_by_user_id: partnerId,
      expense_date: "2026-06-27",
      version: 1,
      deleted_at: null,
      created_at: "2026-06-27T10:00:00Z",
    },
  ];

  const callCount = { value: 0 };
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const resolve = () => {
      callCount.value += 1;
      return Promise.resolve({
        data: callCount.value === 1 ? sharedRows : [],
        error: null,
      });
    };
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.is = () => chain;
    chain.order = () => chain;
    chain.limit = () => resolve();
    return chain;
  };
  const mockDb = {
    from: () => makeChain(),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const ctx = {
    db: mockDb,
    groupId,
    userId,
    coupleId: 1,
  };

  const result = (await executeSecretaryTool(
    "get_recent_expenses",
    { limit: 1 },
    ctx,
  )) as { items: Array<{ paid_by: "self" | "partner" }> };

  assert.equal(result.items[0].paid_by, "partner");
});

test("read tools: query_expenses returns only summary when no limit", async () => {
  const { executeTool } = await import("./accountant-tools");

  const sharedRows = [
    {
      id: "00000000-0000-4000-8000-000000000801",
      description: "早餐",
      merchant: null,
      notes: null,
      tag: "餐飲",
      amount_twd: 80,
      paid_by_user_id: "00000000-0000-4000-8000-000000000810",
      expense_date: "2026-06-25",
      ledger: "shared",
      deleted_at: null,
    },
    {
      id: "00000000-0000-4000-8000-000000000802",
      description: "晚餐",
      merchant: null,
      notes: null,
      tag: "餐飲",
      amount_twd: 320,
      paid_by_user_id: "00000000-0000-4000-8000-000000000810",
      expense_date: "2026-06-26",
      ledger: "shared",
      deleted_at: null,
    },
  ];

  const privateRows = [
    {
      id: "00000000-0000-4000-8000-000000000803",
      description: "私房咖啡",
      merchant: null,
      notes: null,
      tag: "咖啡",
      amount_twd: 150,
      paid_by_user_id: "00000000-0000-4000-8000-000000000810",
      expense_date: "2026-06-24",
      ledger: "private",
      deleted_at: null,
    },
  ];

  const callCount = { value: 0 };
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const resolve = () => {
      callCount.value += 1;
      const data = callCount.value === 1 ? sharedRows : privateRows;
      return Promise.resolve({ data, error: null });
    };
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.neq = () => chain;
    chain.is = () => chain;
    chain.gte = () => chain;
    chain.lt = () => chain;
    chain.order = () => chain;
    chain.limit = () => resolve();
    return chain;
  };
  const mockDb = {
    from: () => makeChain(),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const ctx = {
    db: mockDb,
    groupId: "00000000-0000-4000-8000-000000000811",
    userId: "00000000-0000-4000-8000-000000000810",
    coupleId: 1,
  };

  const result = (await executeTool("query_expenses", {}, ctx)) as {
    summary: { total: number; count: number; average: number; date_range: { from: string; to: string } | null };
    items?: unknown;
  };

  assert.equal(result.summary.total, 550);
  assert.equal(result.summary.count, 3);
  assert.equal(result.summary.average, 183);
  assert.deepEqual(result.summary.date_range, { from: "2026-06-24", to: "2026-06-26" });
  assert.equal(result.items, undefined);
});

test("read tools: query_expenses with limit+amount_desc returns sorted items", async () => {
  const { executeTool } = await import("./accountant-tools");

  const sharedRows = [
    {
      id: "00000000-0000-4000-8000-000000000901",
      description: "小筆",
      merchant: null,
      notes: null,
      tag: "餐飲",
      amount_twd: 60,
      paid_by_user_id: "00000000-0000-4000-8000-000000000910",
      expense_date: "2026-06-20",
      ledger: "shared",
      deleted_at: null,
    },
    {
      id: "00000000-0000-4000-8000-000000000902",
      description: "大筆",
      merchant: null,
      notes: null,
      tag: "餐飲",
      amount_twd: 1200,
      paid_by_user_id: "00000000-0000-4000-8000-000000000910",
      expense_date: "2026-06-10",
      ledger: "shared",
      deleted_at: null,
    },
    {
      id: "00000000-0000-4000-8000-000000000903",
      description: "中筆",
      merchant: null,
      notes: null,
      tag: "餐飲",
      amount_twd: 500,
      paid_by_user_id: "00000000-0000-4000-8000-000000000910",
      expense_date: "2026-06-15",
      ledger: "shared",
      deleted_at: null,
    },
  ];

  const callCount = { value: 0 };
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const resolve = () => {
      callCount.value += 1;
      return Promise.resolve({
        data: callCount.value === 1 ? sharedRows : [],
        error: null,
      });
    };
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.neq = () => chain;
    chain.is = () => chain;
    chain.gte = () => chain;
    chain.lt = () => chain;
    chain.order = () => chain;
    chain.limit = () => resolve();
    return chain;
  };
  const mockDb = {
    from: () => makeChain(),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const ctx = {
    db: mockDb,
    groupId: "00000000-0000-4000-8000-000000000911",
    userId: "00000000-0000-4000-8000-000000000910",
    coupleId: 1,
  };

  const result = (await executeTool(
    "query_expenses",
    { limit: 3, sort: "amount_desc" },
    ctx,
  )) as {
    items: Array<{ id: string; amount: number; date: string }>;
  };

  assert.equal(result.items.length, 3);
  assert.equal(result.items[0].id, "00000000-0000-4000-8000-000000000902");
  assert.equal(result.items[0].amount, 1200);
  assert.equal(result.items[1].amount, 500);
  assert.equal(result.items[2].amount, 60);
});

test("read tools: get_balance_summary maps positive balance to partner owes me", async () => {
  const { executeTool } = await import("./accountant-tools");

  const userId = "00000000-0000-4000-8000-000000001001";
  const partnerId = "00000000-0000-4000-8000-000000001002";

  const mockDb = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      assert.equal(fn, "group_balances");
      assert.deepEqual(args, { p_group_id: "00000000-0000-4000-8000-000000001003" });
      return Promise.resolve({
        data: [
          { user_id: userId, balance_twd: 250 },
          { user_id: partnerId, balance_twd: -250 },
        ],
        error: null,
      });
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const ctx = {
    db: mockDb,
    groupId: "00000000-0000-4000-8000-000000001003",
    userId,
    coupleId: 1,
  };

  const result = (await executeTool("get_balance_summary", {}, ctx)) as {
    my_balance: number;
    partner_balance: number;
    summary: string;
  };

  assert.equal(result.my_balance, 250);
  assert.equal(result.partner_balance, -250);
  assert.equal(result.summary, "另一半欠你 NT$250");
});

test("read tools: get_balance_summary maps negative balance to I owe partner", async () => {
  const { executeTool } = await import("./accountant-tools");

  const userId = "00000000-0000-4000-8000-000000001011";
  const partnerId = "00000000-0000-4000-8000-000000001012";

  const mockDb = {
    rpc: () =>
      Promise.resolve({
        data: [
          { user_id: userId, balance_twd: -180 },
          { user_id: partnerId, balance_twd: 180 },
        ],
        error: null,
      }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const ctx = {
    db: mockDb,
    groupId: "00000000-0000-4000-8000-000000001013",
    userId,
    coupleId: 1,
  };

  const result = (await executeTool("get_balance_summary", {}, ctx)) as {
    my_balance: number;
    partner_balance: number;
    summary: string;
  };

  assert.equal(result.my_balance, -180);
  assert.equal(result.partner_balance, 180);
  assert.equal(result.summary, "你欠另一半 NT$180");
});

test("read tools: get_balance_summary returns settled message when both are zero", async () => {
  const { executeTool } = await import("./accountant-tools");

  const userId = "00000000-0000-4000-8000-000000001021";
  const partnerId = "00000000-0000-4000-8000-000000001022";

  const mockDb = {
    rpc: () =>
      Promise.resolve({
        data: [
          { user_id: userId, balance_twd: 0 },
          { user_id: partnerId, balance_twd: 0 },
        ],
        error: null,
      }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const ctx = {
    db: mockDb,
    groupId: "00000000-0000-4000-8000-000000001023",
    userId,
    coupleId: 1,
  };

  const result = (await executeTool("get_balance_summary", {}, ctx)) as {
    my_balance: number;
    partner_balance: number;
    summary: string;
  };

  assert.equal(result.my_balance, 0);
  assert.equal(result.partner_balance, 0);
  assert.equal(result.summary, "已結清");
});

test("read tools: get_recurring_list maps couple-scoped rows to tool contract", async () => {
  const { executeTool } = await import("./accountant-tools");

  const coupleId = 7;
  const captured: Array<{ table: string; coupleId: number; order: string }> = [];

  const mockDb = {
    from: (table: string) => {
      assert.equal(table, "recurring_expenses");
      const query = {
        select: () => query,
        eq: (_field: string, value: number) => {
          captured.push({ table, coupleId: value, order: "" });
          return query;
        },
        order: (column: string) => {
          captured[captured.length - 1]!.order = column;
          return Promise.resolve({
            data: [
              {
                id: "r1",
                description: "Netflix",
                amount_twd: 390,
                frequency: "monthly",
                next_run_date: "2026-07-01",
                active: true,
                tag: "訂閱",
                ledger: "shared",
              },
              {
                id: "r2",
                description: "健身房",
                amount_twd: 1200,
                frequency: "monthly",
                next_run_date: "2026-07-05",
                active: false,
                tag: "其他",
                ledger: "private",
              },
            ],
            error: null,
          });
        },
      };
      return query;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const ctx = {
    db: mockDb,
    groupId: "00000000-0000-4000-8000-000000001031",
    userId: "00000000-0000-4000-8000-000000001032",
    coupleId,
  };

  const result = (await executeTool("get_recurring_list", {}, ctx)) as {
    items: Array<{
      description: string;
      amount: number;
      frequency: string;
      next_run: string;
      active: boolean;
      tag: string;
      ledger: "shared" | "private";
    }>;
  };

  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.coupleId, coupleId);
  assert.equal(captured[0]!.order, "next_run_date");
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0], {
    description: "Netflix",
    amount: 390,
    frequency: "monthly",
    next_run: "2026-07-01",
    active: true,
    tag: "訂閱",
    ledger: "shared",
  });
  assert.deepEqual(result.items[1], {
    description: "健身房",
    amount: 1200,
    frequency: "monthly",
    next_run: "2026-07-05",
    active: false,
    tag: "其他",
    ledger: "private",
  });
});

test("secretary service retries hallucinated writes and applies corrected pending actions", async () => {
  const executed: Record<string, unknown>[] = [];
  const prompts: string[] = [];
  const service = new SecretaryService();

  const result = await service.run({
    initialInput: { text: "幫我新增私人帳 共享機車 185元" },
    sessionId: null,
    runLoop: async (input, sessionId) => {
      prompts.push(input.text);
      if (prompts.length === 1) {
        return {
          answer: "已為你記好這筆私人支出。",
          toolCallCount: 0,
          pendingActions: [],
          sessionId: sessionId ?? "secretary-session-1",
          newTasks: [],
          notifyPartner: false,
          partnerMessage: null,
        };
      }
      return {
        answer: "已為您記下一筆 私人帳支出：共享機車 NT$185（你付的）。",
        toolCallCount: 1,
        pendingActions: [
          {
            type: "create_expense",
            expense: {
              group_id: null,
              ledger: "private",
              description: "共享機車",
              merchant: null,
              notes: null,
              tag: "交通",
              amount_twd: 185,
              paid_by_user_id: CORE_OWNER,
              expense_date: "2026-06-30",
              split_method: "equal",
            },
            splits: { [CORE_OWNER]: 185 },
          },
        ],
        sessionId: sessionId ?? "secretary-session-1",
        newTasks: [],
        notifyPartner: false,
        partnerMessage: null,
      };
    },
    executeAction: async (action) => {
      executed.push(action);
      return { result: "confirmed", action_type: "create_expense" };
    },
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /你剛才說/);
  assert.equal(executed.length, 1);
  assert.equal(result.reply, "已為您記下一筆 私人帳支出：共享機車 NT$185（你付的）。");
  assert.equal(result.actionFailure, null);
});

test("write tools: propose_update_expense returns pending_action updates", async () => {
  const { executeSecretaryTool } = await import("./secretary-tools");
  const { registerPendingActionService } = await import("./pending-action-builders");
  const { PendingActionService } = await import("./pending-action-service");

  const mockDb = {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        order: () => Promise.resolve({
          data: [
            { id: "user-1", couple_id: 1, line_user_id: "line-1", role: "owner" },
            { id: "partner-123", couple_id: 1, line_user_id: "line-2", role: "partner" },
          ],
          error: null,
        }),
        single: () => {
          if (table === "expenses") {
            return Promise.resolve({
              data: {
                id: "00000000-0000-0000-0000-000000000001",
                couple_id: 1,
                group_id: "group-1",
                ledger: "shared",
                description: "晚餐",
                merchant: null,
                notes: null,
                tag: "其他",
                amount_twd: 1000,
                paid_by_user_id: "partner-123",
                created_by_user_id: "user-1",
                expense_date: "2026-07-01",
                split_method: "equal",
                version: 5,
                deleted_at: null,
                expense_splits: [],
              },
              error: null,
            });
          }
          if (table === "users") {
            return Promise.resolve({
              data: { id: "user-1", couple_id: 1, line_user_id: "line-user-1", role: "owner" },
              error: null,
            });
          }
          return Promise.resolve({ data: { user_id: "partner-123" }, error: null });
        },
      };
      return chain;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const pendingService = new PendingActionService({
    actionSeconds: 60,
    deliverNotifications: async () => {},
  });
  registerPendingActionService(pendingService);

  const ctx = {
    db: mockDb,
    groupId: "group-1",
    userId: "user-1",
    coupleId: 1,
  };

  const result = await executeSecretaryTool(
    "propose_update_expense",
    {
      expense_id: "00000000-0000-0000-0000-000000000001",
      updates: {
        ledger: "private",
        paid_by: "self",
      },
    },
    ctx,
  );

  const res = result as {
    pending_action: {
      type: string;
      expenseId: string;
      expectedVersion: number;
      groupId: string | null;
      updates: Record<string, unknown>;
    };
    message: string;
  };

  assert.equal(res.pending_action.type, "update_expense");
  assert.equal(res.pending_action.expectedVersion, 5);
  assert.equal(res.pending_action.groupId, null);
  assert.equal(res.pending_action.updates.ledger, "private");
  assert.equal(res.pending_action.updates.paid_by_user_id, "user-1");
  assert.ok(res.message.includes("晚餐"));
});

test("write tools: propose_update_expense no-op throws error", async () => {
  const { executeSecretaryTool } = await import("./secretary-tools");
  const { registerPendingActionService } = await import("./pending-action-builders");
  const { PendingActionService } = await import("./pending-action-service");

  const mockDb = {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        order: () => Promise.resolve({
          data: [
            { id: "user-1", couple_id: 1, line_user_id: "line-1", role: "owner" },
            { id: "partner-123", couple_id: 1, line_user_id: "line-2", role: "partner" },
          ],
          error: null,
        }),
        single: () => {
          if (table === "expenses") {
            return Promise.resolve({
              data: {
                id: "00000000-0000-0000-0000-000000000001",
                couple_id: 1,
                group_id: "group-1",
                ledger: "shared",
                description: "晚餐",
                merchant: null,
                notes: null,
                tag: "其他",
                amount_twd: 1000,
                paid_by_user_id: "user-1",
                created_by_user_id: "user-1",
                expense_date: "2026-07-01",
                split_method: "equal",
                version: 5,
                deleted_at: null,
                expense_splits: [],
              },
              error: null,
            });
          }
          if (table === "users") {
            return Promise.resolve({
              data: { id: "user-1", couple_id: 1, line_user_id: "line-user-1", role: "owner" },
              error: null,
            });
          }
          return Promise.resolve({ data: { user_id: "partner-123" }, error: null });
        },
      };
      return chain;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const pendingService = new PendingActionService({
    actionSeconds: 60,
    deliverNotifications: async () => {},
  });
  registerPendingActionService(pendingService);

  const ctx = {
    db: mockDb,
    groupId: "group-1",
    userId: "user-1",
    coupleId: 1,
  };

  const result = await executeSecretaryTool(
    "propose_update_expense",
    {
      expense_id: "00000000-0000-0000-0000-000000000001",
      updates: {},
    },
    ctx,
  );

  const res = result as { error: string };
  assert.equal(res.error, "沒有可修改的欄位");
});

test("tool integration regression: tool -> executeAgentAction -> apply_pending_action_plan", async () => {
  const { executeTool } = await import("./accountant-tools");
  const { registerPendingActionService } = await import("./pending-action-builders");
  const { PendingActionService } = await import("./pending-action-service");

  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const insertedRows: Record<string, unknown>[] = [];

  const mockDb = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "apply_pending_action_plan") {
        return Promise.resolve({ data: { result: "confirmed", action_type: "create_expense" }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        update: () => chain,
        order: () => Promise.resolve({
          data: [
            { id: "user-1", couple_id: 1, line_user_id: "line-user-1", role: "owner" },
            { id: "partner-123", couple_id: 1, line_user_id: "line-partner", role: "partner" },
          ],
          error: null,
        }),
        single: () => {
          if (table === "users") {
            return Promise.resolve({
              data: { id: "user-1", couple_id: 1, line_user_id: "line-user-1", role: "owner" },
              error: null,
            });
          }
          if (table === "pending_actions") {
            return Promise.resolve({
              data: {
                action_type: "create_expense",
                payload: {
                  tag: "交通",
                },
                group_id: null,
              },
              error: null,
            });
          }
          return Promise.resolve({ data: { user_id: "partner-123" }, error: null });
        },
        maybeSingle: () => Promise.resolve({
          data: {
            id: "action-id-123",
            couple_id: 1,
            group_id: null,
            action_type: "create_expense",
            payload: {
              kind: "ledger_command",
              version: 1,
              command: {
                type: "create_expense",
                expense: {
                  group_id: null,
                  ledger: "private",
                  description: "共享機車",
                  merchant: null,
                  notes: null,
                  tag: "交通",
                  amount_twd: 185,
                  paid_by_user_id: "user-1",
                  expense_date: "2026-07-01",
                  split_method: "equal",
                },
              },
              metadata: {
                source: "line",
                actorUserId: "user-1",
                idempotencyKey: null,
              },
              ledger: "private",
              amount_twd: 185,
              paid_by_user_id: "user-1",
              description: "共享機車",
              merchant: null,
              notes: null,
              tag: "交通",
              expense_date: "2026-07-01",
              split_method: "equal",
              splits: { "user-1": 185 },
            },
            status: "pending",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          },
          error: null,
        }),
        insert: (row: any) => {
          insertedRows.push(row);
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id: "action-id-123" }, error: null }),
            }),
          };
        },
      };
      return chain;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const pendingService = new PendingActionService({
    actionSeconds: 60,
    deliverNotifications: async () => {},
  });
  registerPendingActionService(pendingService);

  const ctx = {
    db: mockDb,
    groupId: "group-1",
    userId: "user-1",
    coupleId: 1,
  };

  // 1. Run tool to get the pending_action
  const toolResult = await executeTool(
    "record_expense",
    {
      description: "共享機車",
      amount_twd: 185,
      paid_by: "self",
      ledger: "private",
      tag: "交通",
    },
    ctx,
  );

  const res = toolResult as any;

  assert.equal(res.pending_action.type, "create_expense");
  assert.equal(res.pending_action.expense.group_id, null);

  // 2. Execute the action through executeAgentAction
  const serverContext = {
    db: mockDb,
    user: {
      id: "user-1",
      couple_id: 1,
      line_user_id: "line-user-1",
      role: "owner" as const,
    },
  };

  const fakeTx = new FakeTxClient();
  fakeTx.mockResults.push({
    pattern: /SELECT.*FROM.*pending_actions.*FOR UPDATE/i,
    result: {
      rowCount: 1,
      rows: [
        {
          status: "pending",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          action_type: "create_expense",
        },
      ],
    },
  });
  activeTxClient = fakeTx;

  try {
    const execResult = await pendingService.executeAgentAction(
      serverContext,
      res.pending_action,
    );

    assert.equal(execResult.result, "confirmed");
    assert.equal(insertedRows.length, 1);
    assert.equal(insertedRows[0]?.group_id, null);

    // Validate the new SQL transaction execution
    const insertCall = fakeTx.calls.find((c) => c.query.includes("INSERT INTO public.expenses"));
    assert.ok(insertCall);
    assert.equal(insertCall.params?.[3], "private"); // ledger
    assert.equal(insertCall.params?.[2], null); // group_id
    assert.equal(insertCall.params?.[8], 185); // amount_twd
  } finally {
    activeTxClient = null;
  }
});

test("secretary integration regression: tool -> SecretaryService.run -> apply_pending_action_plan", async () => {
  const { executeTool } = await import("./accountant-tools");
  const { registerPendingActionService } = await import("./pending-action-builders");
  const { PendingActionService } = await import("./pending-action-service");
  const { SecretaryService } = await import("./secretary-service");

  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const insertedRows: Record<string, unknown>[] = [];

  const mockDb = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "apply_pending_action_plan") {
        return Promise.resolve({ data: { result: "confirmed", action_type: "create_expense" }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        update: () => chain,
        order: () => Promise.resolve({
          data: [
            { id: "user-1", couple_id: 1, line_user_id: "line-user-1", role: "owner" },
            { id: "partner-123", couple_id: 1, line_user_id: "line-partner", role: "partner" },
          ],
          error: null,
        }),
        single: () => {
          if (table === "users") {
            return Promise.resolve({
              data: { id: "user-1", couple_id: 1, line_user_id: "line-user-1", role: "owner" },
              error: null,
            });
          }
          if (table === "pending_actions") {
            return Promise.resolve({
              data: {
                action_type: "create_expense",
                payload: {
                  tag: "交通",
                },
                group_id: null,
              },
              error: null,
            });
          }
          return Promise.resolve({ data: { user_id: "partner-123" }, error: null });
        },
        maybeSingle: () => Promise.resolve({
          data: {
            id: "action-id-123",
            couple_id: 1,
            group_id: null,
            action_type: "create_expense",
            payload: {
              kind: "ledger_command",
              version: 1,
              command: {
                type: "create_expense",
                expense: {
                  group_id: null,
                  ledger: "private",
                  description: "共享機車",
                  merchant: null,
                  notes: null,
                  tag: "交通",
                  amount_twd: 185,
                  paid_by_user_id: "user-1",
                  expense_date: "2026-07-01",
                  split_method: "equal",
                },
              },
              metadata: {
                source: "line",
                actorUserId: "user-1",
                idempotencyKey: null,
              },
              ledger: "private",
              amount_twd: 185,
              paid_by_user_id: "user-1",
              description: "共享機車",
              merchant: null,
              notes: null,
              tag: "交通",
              expense_date: "2026-07-01",
              split_method: "equal",
              splits: { "user-1": 185 },
            },
            status: "pending",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          },
          error: null,
        }),
        insert: (row: any) => {
          insertedRows.push(row);
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id: "action-id-123" }, error: null }),
            }),
          };
        },
      };
      return chain;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const pendingService = new PendingActionService({
    actionSeconds: 60,
    deliverNotifications: async () => {},
  });
  registerPendingActionService(pendingService);

  const ctx = {
    db: mockDb,
    groupId: "group-1",
    userId: "user-1",
    coupleId: 1,
  };

  // 1. Run tool to get the pending_action
  const toolResult = await executeTool(
    "record_expense",
    {
      description: "共享機車",
      amount_twd: 185,
      paid_by: "self",
      ledger: "private",
      tag: "交通",
    },
    ctx,
  );

  const res = toolResult as any;

  assert.equal(res.pending_action.type, "create_expense");
  assert.equal(res.pending_action.expense.group_id, null);

  // 2. Execute through SecretaryService.run
  const secretaryService = new SecretaryService();
  const serverContext = {
    db: mockDb,
    user: {
      id: "user-1",
      couple_id: 1,
      line_user_id: "line-user-1",
      role: "owner" as const,
    },
  };

  const fakeTx = new FakeTxClient();
  fakeTx.mockResults.push({
    pattern: /SELECT.*FROM.*pending_actions.*FOR UPDATE/i,
    result: {
      rowCount: 1,
      rows: [
        {
          status: "pending",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          action_type: "create_expense",
        },
      ],
    },
  });
  activeTxClient = fakeTx;

  let secretaryResult;
  try {
    secretaryResult = await secretaryService.run({
      initialInput: { text: "共享機車 185" },
      sessionId: "session-1",
      runLoop: async (input, sessionId) => {
        return {
          answer: "已經幫你記帳了：共享機車 185 元。",
          toolCallCount: 1,
          pendingActions: [res.pending_action],
          sessionId: "session-1",
          newTasks: [],
          notifyPartner: false,
          partnerMessage: null,
        };
      },
      executeAction: async (action) => {
        return pendingService.executeAgentAction(serverContext, action);
      },
    });
  } finally {
    activeTxClient = null;
  }

  assert.equal(secretaryResult.reply, "已經幫你記帳了：共享機車 185 元。");
  assert.equal(secretaryResult.actionFailure, null);
  assert.equal(insertedRows.length, 1);
  assert.equal(insertedRows[0]?.group_id, null);

  // Validate the new SQL transaction execution
  const insertCall = fakeTx.calls.find((c) => c.query.includes("INSERT INTO public.expenses"));
  assert.ok(insertCall);
  assert.equal(insertCall.params?.[3], "private"); // ledger
  assert.equal(insertCall.params?.[2], null); // group_id
  assert.equal(insertCall.params?.[8], 185); // amount_twd
});

function createMockDbForTools(
  sharedRows: any[],
  privateRows: any[] = [],
  rpcMock?: (fn: string, args: any) => any,
) {
  const makeChain = () => {
    let isPrivate = false;
    let dateFrom: string | undefined = undefined;
    let dateTo: string | undefined = undefined;
    let tagFilter: string | undefined = undefined;
    const chain: any = {
      select: () => chain,
      eq: (field: string, value: any) => {
        if (field === "ledger" && value === "private") {
          isPrivate = true;
        } else if (field === "tag") {
          tagFilter = value;
        }
        return chain;
      },
      neq: () => chain,
      is: () => chain,
      gte: (field: string, value: any) => {
        if (field === "expense_date") dateFrom = value;
        return chain;
      },
      lt: (field: string, value: any) => {
        if (field === "expense_date") dateTo = value;
        return chain;
      },
      order: () => chain,
      limit: () => {
        let data = isPrivate ? privateRows : sharedRows;
        if (dateFrom) data = data.filter((r) => r.expense_date >= dateFrom!);
        if (dateTo) data = data.filter((r) => r.expense_date < dateTo!);
        if (tagFilter) data = data.filter((r) => r.tag === tagFilter);
        return Promise.resolve({ data, error: null });
      },
      then: (onfulfilled: any) => {
        let data = isPrivate ? privateRows : sharedRows;
        if (dateFrom) data = data.filter((r) => r.expense_date >= dateFrom!);
        if (dateTo) data = data.filter((r) => r.expense_date < dateTo!);
        if (tagFilter) data = data.filter((r) => r.tag === tagFilter);
        return Promise.resolve({ data, error: null }).then(onfulfilled);
      },
    };
    return chain;
  };

  return {
    from: () => makeChain(),
    rpc: rpcMock || (() => Promise.resolve({ data: [], error: null })),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

const T_GROUP_ID = "00000000-0000-4000-8000-000000000001";
const T_USER_ID = "00000000-0000-4000-8000-000000000002";
const T_PARTNER_ID = "00000000-0000-4000-8000-000000000003";

const T_EXPENSE_1 = "00000000-0000-4000-8000-000000000010";
const T_EXPENSE_2 = "00000000-0000-4000-8000-000000000020";
const T_EXPENSE_3 = "00000000-0000-4000-8000-000000000030";
const T_EXPENSE_4 = "00000000-0000-4000-8000-000000000040";

test("tool: get_category_breakdown regression", async () => {
  const { executeTool } = await import("./accountant-tools");
  const sharedRows = [
    { id: T_EXPENSE_1, description: "Lunch", merchant: null, notes: null, tag: "Food", amount_twd: 100, expense_date: "2026-07-01", ledger: "shared" as const, paid_by_user_id: T_USER_ID, created_by_user_id: T_USER_ID },
    { id: T_EXPENSE_2, description: "Dinner", merchant: null, notes: null, tag: "Food", amount_twd: 200, expense_date: "2026-07-02", ledger: "shared" as const, paid_by_user_id: T_USER_ID, created_by_user_id: T_USER_ID },
    { id: T_EXPENSE_3, description: "Rent", merchant: null, notes: null, tag: "Rent", amount_twd: 700, expense_date: "2026-07-03", ledger: "shared" as const, paid_by_user_id: T_PARTNER_ID, created_by_user_id: T_PARTNER_ID },
  ];
  const ctx = {
    db: createMockDbForTools(sharedRows, []),
    groupId: T_GROUP_ID,
    userId: T_USER_ID,
    coupleId: 1,
  };
  const result = await executeTool("get_category_breakdown", { date_from: "2026-07-01", date_to: "2026-07-10" }, ctx) as any;
  
  assert.equal(result.total, 1000);
  assert.equal(result.count, 3);
  assert.equal(result.breakdown.length, 2);
  assert.equal(result.breakdown[0].label, "Rent");
  assert.equal(result.breakdown[0].total, 700);
  assert.equal(result.breakdown[0].percent, 70);
  assert.equal(result.breakdown[1].label, "Food");
  assert.equal(result.breakdown[1].total, 300);
  assert.equal(result.breakdown[1].percent, 30);
});

test("tool: compare_period regression", async () => {
  const { executeTool } = await import("./accountant-tools");
  const sharedRows = [
    // Period A: 2026-07-01 to 2026-07-10
    { id: T_EXPENSE_1, description: "Lunch", merchant: null, notes: null, tag: "Food", amount_twd: 500, expense_date: "2026-07-05", ledger: "shared" as const, paid_by_user_id: T_USER_ID, created_by_user_id: T_USER_ID },
    { id: T_EXPENSE_2, description: "Rent", merchant: null, notes: null, tag: "Rent", amount_twd: 1000, expense_date: "2026-07-05", ledger: "shared" as const, paid_by_user_id: T_USER_ID, created_by_user_id: T_USER_ID },
    // Period B: 2026-06-01 to 2026-06-10
    { id: T_EXPENSE_3, description: "Lunch Old", merchant: null, notes: null, tag: "Food", amount_twd: 300, expense_date: "2026-06-05", ledger: "shared" as const, paid_by_user_id: T_USER_ID, created_by_user_id: T_USER_ID },
    { id: T_EXPENSE_4, description: "Rent Old", merchant: null, notes: null, tag: "Rent", amount_twd: 1200, expense_date: "2026-06-05", ledger: "shared" as const, paid_by_user_id: T_USER_ID, created_by_user_id: T_USER_ID },
  ];
  const ctx = {
    db: createMockDbForTools(sharedRows, []),
    groupId: T_GROUP_ID,
    userId: T_USER_ID,
    coupleId: 1,
  };
  const result = await executeTool("compare_period", {
    period_a: { from: "2026-07-01", to: "2026-07-10" },
    period_b: { from: "2026-06-01", to: "2026-06-10" },
  }, ctx) as any;

  assert.equal(result.period_a.total, 1500);
  assert.equal(result.period_a.count, 2);
  assert.equal(result.period_b.total, 1500);
  assert.equal(result.period_b.count, 2);
  assert.equal(result.change_percent, 0);
  
  assert.equal(result.comparison.length, 2);
  assert.equal(Math.abs(result.comparison[0].change), 200);
  assert.equal(Math.abs(result.comparison[1].change), 200);
});

test("tool: get_anomalies regression", async () => {
  const { executeTool } = await import("./accountant-tools");
  const sharedRows = [
    { id: T_EXPENSE_1, description: "Lunch", merchant: null, notes: null, tag: "Food", amount_twd: 120, expense_date: "2026-07-01", ledger: "shared" as const, paid_by_user_id: T_USER_ID, created_by_user_id: T_USER_ID },
    { id: T_EXPENSE_2, description: "Lunch", merchant: null, notes: null, tag: "Food", amount_twd: 120, expense_date: "2026-07-01", ledger: "shared" as const, paid_by_user_id: T_USER_ID, created_by_user_id: T_USER_ID },
    { id: T_EXPENSE_3, description: "Dinner", merchant: null, notes: null, tag: "Food", amount_twd: 300, expense_date: "2026-07-02", ledger: "shared" as const, paid_by_user_id: T_USER_ID, created_by_user_id: T_USER_ID },
  ];
  const ctx = {
    db: createMockDbForTools(sharedRows, []),
    groupId: T_GROUP_ID,
    userId: T_USER_ID,
    coupleId: 1,
  };
  const result = await executeTool("get_anomalies", { date_from: "2026-07-01", date_to: "2026-07-10" }, ctx) as any;

  assert.equal(result.total_groups, 1);
  assert.equal(result.duplicate_groups.length, 1);
  assert.equal(result.duplicate_groups[0].length, 2);
  assert.equal(result.duplicate_groups[0][0].description, "Lunch");
  assert.equal(result.duplicate_groups[0][0].amount, 120);
});

test("tool: get_category_trend regression", async () => {
  const { executeTool } = await import("./accountant-tools");
  const todayStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const currentMonth = todayStr.slice(0, 7);
  
  const [year, monthNumber] = currentMonth.split("-").map(Number);
  const prevDate = new Date(Date.UTC(year!, monthNumber! - 2, 1));
  const prevMonth = `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, "0")}`;

  const sharedRows = [
    { id: T_EXPENSE_1, description: "Lunch", merchant: null, notes: null, tag: "Food", amount_twd: 150, expense_date: `${currentMonth}-05`, ledger: "shared" as const, paid_by_user_id: T_USER_ID, created_by_user_id: T_USER_ID },
    { id: T_EXPENSE_2, description: "Lunch Old", merchant: null, notes: null, tag: "Food", amount_twd: 250, expense_date: `${prevMonth}-10`, ledger: "shared" as const, paid_by_user_id: T_USER_ID, created_by_user_id: T_USER_ID },
  ];
  const ctx = {
    db: createMockDbForTools(sharedRows, []),
    groupId: T_GROUP_ID,
    userId: T_USER_ID,
    coupleId: 1,
  };

  const result = await executeTool("get_category_trend", { tag: "Food", months: 2 }, ctx) as any;

  assert.equal(result.tag, "Food");
  assert.equal(result.trend.length, 2);
  assert.equal(result.trend[0].month, prevMonth);
  assert.equal(result.trend[0].total, 250);
  assert.equal(result.trend[0].count, 1);
  assert.equal(result.trend[1].month, currentMonth);
  assert.equal(result.trend[1].total, 150);
  assert.equal(result.trend[1].count, 1);
});

test("tool: predict_month_end regression - insufficient data guard", async () => {
  const { executeTool } = await import("./accountant-tools");
  const OriginalDate = global.Date;
  const fixedDate = new OriginalDate("2026-07-02T12:00:00+08:00");
  global.Date = class extends OriginalDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(fixedDate.getTime());
      } else {
        // @ts-ignore
        super(...args);
      }
    }
    static now() {
      return fixedDate.getTime();
    }
  } as any;

  try {
    const ctx = {
      db: createMockDbForTools([], []),
      groupId: T_GROUP_ID,
      userId: T_USER_ID,
      coupleId: 1,
    };
    const result = await executeTool("predict_month_end", {}, ctx) as any;
    assert.equal(result.message, "月初資料不足，無法預測");
    assert.equal(result.days_elapsed, 2);
    assert.equal(result.days_total, 31);
  } finally {
    global.Date = OriginalDate;
  }
});

test("tool: predict_month_end regression - normal prediction", async () => {
  const { executeTool } = await import("./accountant-tools");
  const OriginalDate = global.Date;
  const fixedDate = new OriginalDate("2026-07-10T12:00:00+08:00");
  global.Date = class extends OriginalDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(fixedDate.getTime());
      } else {
        // @ts-ignore
        super(...args);
      }
    }
    static now() {
      return fixedDate.getTime();
    }
  } as any;

  try {
    const sharedRows = [
      { id: T_EXPENSE_1, description: "Lunch", merchant: null, notes: null, tag: "Food", amount_twd: 1000, expense_date: "2026-07-05", ledger: "shared" as const, paid_by_user_id: T_USER_ID, created_by_user_id: T_USER_ID },
    ];
    const ctx = {
      db: createMockDbForTools(sharedRows, []),
      groupId: T_GROUP_ID,
      userId: T_USER_ID,
      coupleId: 1,
    };
    const result = await executeTool("predict_month_end", { tag: "Food" }, ctx) as any;
    assert.equal(result.days_elapsed, 10);
    assert.equal(result.days_total, 31);
    assert.equal(result.spent_so_far, 1000);
    assert.equal(result.projected_total, 3100);
  } finally {
    global.Date = OriginalDate;
  }
});

test("tool: analyze_spending regression", async () => {
  const { executeTool } = await import("./accountant-tools");
  const OriginalDate = global.Date;
  const fixedDate = new OriginalDate("2026-07-10T12:00:00+08:00");
  global.Date = class extends OriginalDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(fixedDate.getTime());
      } else {
        // @ts-ignore
        super(...args);
      }
    }
    static now() {
      return fixedDate.getTime();
    }
  } as any;

  try {
    const sharedRows = [
      { id: T_EXPENSE_1, tag: "Food", amount_twd: 300, expense_date: "2026-07-05", ledger: "shared" as const, paid_by_user_id: T_USER_ID, created_by_user_id: T_USER_ID, description: "Lunch", merchant: null, notes: null },
      { id: T_EXPENSE_2, tag: "Food", amount_twd: 300, expense_date: "2026-07-05", ledger: "shared" as const, paid_by_user_id: T_USER_ID, created_by_user_id: T_USER_ID, description: "Lunch", merchant: null, notes: null },
      { id: T_EXPENSE_3, tag: "Rent", amount_twd: 1000, expense_date: "2026-07-05", ledger: "shared" as const, paid_by_user_id: T_PARTNER_ID, created_by_user_id: T_PARTNER_ID, description: "Rent", merchant: null, notes: null },
    ];
    const privateRows = [
      { id: T_EXPENSE_4, tag: "Secret", amount_twd: 9999, expense_date: "2026-07-05", ledger: "private" as const, paid_by_user_id: T_USER_ID, created_by_user_id: T_USER_ID, description: "Secret", merchant: null, notes: null },
    ];

    const rpcMock = (fn: string, args: any) => {
      assert.equal(fn, "group_balances");
      assert.equal(args.p_group_id, T_GROUP_ID);
      return Promise.resolve({
        data: [
          { user_id: T_USER_ID, balance_twd: 100 },
          { user_id: T_PARTNER_ID, balance_twd: -100 },
        ],
        error: null,
      });
    };

    const ctx = {
      db: createMockDbForTools(sharedRows, privateRows, rpcMock),
      groupId: T_GROUP_ID,
      userId: T_USER_ID,
      coupleId: 1,
    };

    const result = await executeTool("analyze_spending", { date_from: "2026-07-01", date_to: "2026-07-10" }, ctx) as any;

    assert.equal(result.total, 1600);
    assert.equal(result.transaction_count, 3);
    assert.equal(result.daily_average, 160);
    assert.equal(result.projected_month_end, 160 * 31);
    
    assert.equal(result.top_tags.length, 2);
    assert.equal(result.top_tags[0].label, "Rent");
    assert.equal(result.top_tags[0].amount, 1000);
    assert.equal(result.top_tags[0].percent, 63);
    assert.equal(result.top_tags[1].label, "Food");
    assert.equal(result.top_tags[1].amount, 600);
    assert.equal(result.top_tags[1].percent, 38);

    assert.equal(result.anomalies.length, 1);
    assert.equal(result.anomalies[0].length, 2);
    assert.equal(result.anomalies[0][0].id, T_EXPENSE_1);

    assert.deepEqual(result.balance, [
      { user_id: T_USER_ID, balance_twd: 100 },
      { user_id: T_PARTNER_ID, balance_twd: -100 },
    ]);
  } finally {
    global.Date = OriginalDate;
  }
});

function setupMockEnv() {
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "line-token";
  process.env.LINE_LOGIN_CHANNEL_ID = "login";
  process.env.GEMINI_API_KEY = "gemini";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "secret";
  process.env.COUPLE_SETUP_CODE = "x".repeat(24);
  process.env.LIFF_SESSION_SECRET = "x".repeat(32);
  process.env.APP_URL = "https://app.example.com";
  process.env.CRON_SECRET = "x".repeat(16);
}

function createMockDbForSecretary(tableData: Record<string, any>) {
  const chain = (tableName: string) => {
    const subChain: any = {
      select: () => subChain,
      eq: () => subChain,
      neq: () => subChain,
      order: () => subChain,
      limit: () => subChain,
      single: () => {
        return Promise.resolve({ data: tableData[tableName], error: null });
      },
      maybeSingle: () => {
        return Promise.resolve({ data: tableData[tableName], error: null });
      },
    };
    return subChain;
  };
  return {
    from: (name: string) => chain(name),
  } as any;
}

test("runLineSecretaryTurn replies actionResultMessage on action failure", async () => {
  setupMockEnv();
  const { runLineSecretaryTurn } = await import("./line-secretary-service");
  const { SecretaryService } = await import("./secretary-service");

  const originalRun = SecretaryService.prototype.run;
  SecretaryService.prototype.run = async () => {
    return {
      reply: "ignored",
      notifyPartner: false,
      partnerMessage: null,
      actionFailure: {
        result: "stale",
        action_type: "create_expense",
      },
    };
  };

  try {
    let repliedText = "";
    let pushCalled = false;
    const dependencies = {
      lineClient: {
        replyMessage: async () => {},
        getMessageContent: async () => ({} as any),
        pushMessage: async () => {
          pushCalled = true;
        },
      },
      supabase: createMockDbForSecretary({
        user_preferences: { active_group_id: "00000000-0000-4000-8000-000000000001" },
        users: { id: "00000000-0000-4000-8000-000000000003", couple_id: 1, role: "partner", line_user_id: "line-partner" },
        secretary_sessions: null,
      }),
      gemini: {} as any,
    };

    const user = {
      id: "user-id",
      couple_id: 1,
      role: "owner" as const,
      line_user_id: "line-user-id",
    };

    await runLineSecretaryTurn({
      text: "hello",
      user,
      dependencies,
      reply: async (text) => {
        repliedText = text;
      },
    });

    assert.equal(repliedText, "帳目已變動，請重新操作。");
    assert.equal(pushCalled, false);
  } finally {
    SecretaryService.prototype.run = originalRun;
  }
});

test("runLineSecretaryTurn replies success and notifies partner when requested", async () => {
  setupMockEnv();
  const { runLineSecretaryTurn } = await import("./line-secretary-service");
  const { SecretaryService } = await import("./secretary-service");

  const originalRun = SecretaryService.prototype.run;
  SecretaryService.prototype.run = async () => {
    return {
      reply: "Here is your coffee.",
      notifyPartner: true,
      partnerMessage: "Partner got coffee",
      actionFailure: null,
    };
  };

  try {
    let repliedText = "";
    let pushTarget = "";
    let pushMsg = "";

    const dependencies = {
      lineClient: {
        replyMessage: async () => {},
        getMessageContent: async () => ({} as any),
        pushMessage: async (params: any) => {
          pushTarget = params.to;
          pushMsg = params.messages[0].text;
        },
      },
      supabase: createMockDbForSecretary({
        user_preferences: { active_group_id: "00000000-0000-4000-8000-000000000001" },
        users: { id: "00000000-0000-4000-8000-000000000003", couple_id: 1, role: "partner", line_user_id: "line-partner" },
        secretary_sessions: null,
      }),
      gemini: {} as any,
    };

    const user = {
      id: "user-id",
      couple_id: 1,
      role: "owner" as const,
      line_user_id: "line-user-id",
    };

    await runLineSecretaryTurn({
      text: "hello",
      user,
      dependencies,
      reply: async (text) => {
        repliedText = text;
      },
    });

    assert.equal(repliedText, "Here is your coffee.");
    assert.equal(pushTarget, "line-partner");
    assert.equal(pushMsg, "📋 Partner got coffee");
  } finally {
    SecretaryService.prototype.run = originalRun;
  }
});

test("handleLineAudioTurn prefixes transcript into assistant reply", async () => {
  setupMockEnv();
  const { handleLineAudioTurn } = await import("./line-secretary-service");
  const { SecretaryService } = await import("./secretary-service");
  const { agentChatService } = await import("./services");

  const originalRun = SecretaryService.prototype.run;
  SecretaryService.prototype.run = async () => {
    return {
      reply: "Understood, logged it.",
      notifyPartner: false,
      partnerMessage: null,
      actionFailure: null,
    };
  };

  const originalTranscribe = agentChatService.transcribeAudio;
  agentChatService.transcribeAudio = async () => "buy coffee";

  try {
    let repliedText = "";
    const dependencies = {
      lineClient: {
        replyMessage: async () => {},
        getMessageContent: async (id: string) => {
          assert.equal(id, "msg-123");
          return [Buffer.from("fake audio")] as any;
        },
        pushMessage: async () => {},
      },
      supabase: createMockDbForSecretary({
        user_preferences: { active_group_id: "00000000-0000-4000-8000-000000000001" },
        users: { id: "00000000-0000-4000-8000-000000000003", couple_id: 1, role: "partner", line_user_id: "line-partner" },
        secretary_sessions: null,
      }),
      gemini: {} as any,
    };

    const user = {
      id: "user-id",
      couple_id: 1,
      role: "owner" as const,
      line_user_id: "line-user-id",
    };

    await handleLineAudioTurn({
      messageId: "msg-123",
      user,
      dependencies,
      reply: async (text) => {
        repliedText = text;
      },
    });

    assert.equal(repliedText, "聽到：「buy coffee」\nUnderstood, logged it.");

    // Oversize case
    let sizeRep = "";
    const dependenciesOversize = {
      ...dependencies,
      lineClient: {
        ...dependencies.lineClient,
        getMessageContent: async () => {
          return [Buffer.alloc(11 * 1024 * 1024)] as any;
        },
      },
    };
    await handleLineAudioTurn({
      messageId: "msg-123",
      user,
      dependencies: dependenciesOversize,
      reply: async (text) => {
        sizeRep = text;
      },
    });
    assert.equal(sizeRep, "語音訊息太大，請傳短一點的語音。");

  } finally {
    SecretaryService.prototype.run = originalRun;
    agentChatService.transcribeAudio = originalTranscribe;
  }
});

test("handleLineImageTurn detects mime and sends fixed vision prompt", async () => {
  setupMockEnv();
  const { handleLineImageTurn } = await import("./line-secretary-service");
  const { SecretaryService } = await import("./secretary-service");

  let receivedPrompt = "";
  let receivedMime = "";
  let receivedBase64 = "";

  const originalRun = SecretaryService.prototype.run;
  SecretaryService.prototype.run = async (args: any) => {
    receivedPrompt = args.initialInput.text;
    receivedBase64 = args.initialInput.imageData;
    receivedMime = args.initialInput.mimeType;
    return {
      reply: "Vision processed",
      notifyPartner: false,
      partnerMessage: null,
      actionFailure: null,
    };
  };

  try {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const dependencies = {
      lineClient: {
        replyMessage: async () => {},
        getMessageContent: async () => [pngHeader] as any,
        pushMessage: async () => {},
      },
      supabase: createMockDbForSecretary({
        user_preferences: { active_group_id: "00000000-0000-4000-8000-000000000001" },
        users: { id: "00000000-0000-4000-8000-000000000003", couple_id: 1, role: "partner", line_user_id: "line-partner" },
        secretary_sessions: null,
      }),
      gemini: {} as any,
    };

    const user = {
      id: "user-id",
      couple_id: 1,
      role: "owner" as const,
      line_user_id: "line-user-id",
    };

    let replied = "";
    await handleLineImageTurn({
      messageId: "msg-img",
      user,
      dependencies,
      reply: async (text) => {
        replied = text;
      },
    });

    assert.equal(replied, "Vision processed");
    assert.equal(receivedMime, "image/png");
    assert.equal(receivedBase64, pngHeader.toString("base64"));
    assert.ok(receivedPrompt.includes("這是一張收據或發票照片"));

  } finally {
    SecretaryService.prototype.run = originalRun;
  }
});

test("route regression: /api/app/receipts/* endpoints are not found", async () => {
  setupMockEnv();
  const routeModule = await import("../app/api/app/[...path]/route");
  
  const token = signSession(
    {
      userId: "00000000-0000-4000-8000-000000000001",
      lineUserId: "line-owner",
      expiresAt: Math.floor(Date.now() / 1000) + 1000,
    },
    "x".repeat(32),
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (typeof url === "string" && url.includes("/rest/v1/users")) {
      return new Response(
        JSON.stringify({
          id: "00000000-0000-4000-8000-000000000001",
          couple_id: 1,
          line_user_id: "line-owner",
          role: "owner",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return originalFetch(url, init);
  };

  try {
    const req = new Request("https://app.example.com/api/app/receipts/upload", {
      method: "POST",
      body: JSON.stringify({}),
      headers: {
        "cookie": `couple_ledger_session=${token}`,
        "x-forwarded-host": "app.example.com",
        "origin": "https://app.example.com",
      },
    });
    const res = await routeModule.POST(req, {
      params: Promise.resolve({ path: ["receipts", "upload"] }),
    });
    assert.equal(res.status, 404);
    
    const reqGet = new Request("https://app.example.com/api/app/receipts/123/url", {
      method: "GET",
      headers: {
        "cookie": `couple_ledger_session=${token}`,
      },
    });
    const resGet = await routeModule.GET(reqGet, {
      params: Promise.resolve({ path: ["receipts", "123", "url"] }),
    });
    assert.equal(resGet.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("static regression: check forbidden strings and imports in production files", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");

  function walk(dir: string, fileList: string[] = []): string[] {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filepath = path.join(dir, file);
      const stat = fs.statSync(filepath);
      if (stat.isDirectory()) {
        walk(filepath, fileList);
      } else {
        fileList.push(filepath);
      }
    }
    return fileList;
  }

  const srcDir = path.resolve(__dirname, "..");
  const allFiles = walk(srcDir);

  const forbiddenPatterns = [
    /fix_uncertain_receipt/,
    /processUploadedLineReceipt/,
    /receiptExpenseInputs/,
    /receiptDraft/,
    /apply_pending_action_plan/,
  ];

  for (const file of allFiles) {
    if (
      file.includes(".test.ts") ||
      file.includes(".spec.ts") ||
      file.includes("migrations") ||
      file.includes("node_modules") ||
      file.includes(".next")
    ) {
      continue;
    }

    const content = fs.readFileSync(file, "utf8");

    // Check imports from bot.ts
    const botImportRegex = /from\s+["'](@\/lib\/bot|\.\/bot)["']/;
    if (botImportRegex.test(content)) {
      assert.fail(`File ${file} contains legacy import from bot.ts`);
    }

    for (const pattern of forbiddenPatterns) {
      if (pattern.test(content)) {
        assert.fail(`File ${file} contains forbidden pattern: ${pattern.toString()}`);
      }
    }
  }
});

test("LINE regression: image message routes to handleLineImageTurn", async () => {
  setupMockEnv();
  const { handleLineEvent } = await import("./line-webhook-service");
  const { SecretaryService } = await import("./secretary-service");

  let imageTurnCalled = false;
  const originalRun = SecretaryService.prototype.run;
  SecretaryService.prototype.run = async () => {
    imageTurnCalled = true;
    return {
      reply: "Vision reply",
      notifyPartner: false,
      partnerMessage: null,
      actionFailure: null,
    };
  };

  try {
    let repliedText = "";
    const dependencies = {
      lineClient: {
        replyMessage: async (params: any) => {
          repliedText = params.messages[0].text;
        },
        getMessageContent: async () => [Buffer.from([0x89, 0x50, 0x4e, 0x47])] as any,
        pushMessage: async () => {},
      },
      supabase: createMockDbForSecretary({
        user_preferences: { active_group_id: "00000000-0000-4000-8000-000000000001" },
        users: { id: "00000000-0000-4000-8000-000000000003", couple_id: 1, role: "partner", line_user_id: "line-partner" },
        secretary_sessions: null,
      }),
      gemini: {} as any,
      setupCode: "couple-setup-code",
    };

    await handleLineEvent(
      {
        type: "message",
        webhookEventId: "evt-123",
        deliveryContext: { isRedelivery: false },
        timestamp: Date.now(),
        source: { type: "user", userId: "line-owner" },
        replyToken: "reply-123",
        message: { type: "image", id: "msg-img-123" },
      } as any,
      dependencies as any,
    );

    assert.ok(imageTurnCalled);
    assert.equal(repliedText, "Vision reply");
  } finally {
    SecretaryService.prototype.run = originalRun;
  }
});

function createMockDbConfirm(opts: {
  actionId?: string;
  actionType?: string;
  payload?: any;
  status?: string;
  expiresAt?: string;
  expenseId?: string;
  expenseGroupId?: string | null;
  expenseLedger?: string;
  expenseVersion?: number;
  activeGroupId?: string;
  groupBalances?: { [userId: string]: number };
}) {
  return {
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        update: () => chain,
        order: () => chain,
        is: () => chain,
        single: () => {
          if (table === "user_preferences") {
            return Promise.resolve({
              data: { active_group_id: opts.activeGroupId || GROUP },
              error: null
            });
          }
          if (table === "groups") {
            return Promise.resolve({
              data: { id: opts.expenseGroupId !== undefined ? opts.expenseGroupId : GROUP },
              error: null
            });
          }
          if (table === "pending_actions") {
            return chain.maybeSingle();
          }
          if (table === "expenses") {
            return Promise.resolve({
              data: {
                id: opts.expenseId || "00000000-0000-4000-8000-000000000188",
                couple_id: 1,
                group_id: opts.expenseGroupId !== undefined ? opts.expenseGroupId : null,
                ledger: opts.expenseLedger || "shared",
                description: "Test Expense",
                merchant: null,
                notes: null,
                tag: "餐飲",
                amount_twd: 100,
                paid_by_user_id: CORE_OWNER,
                expense_date: "2026-07-01",
                split_method: "equal",
                version: opts.expenseVersion || 3,
                created_by_user_id: CORE_OWNER,
                deleted_at: null,
                deleted_by_user_id: null,
                mirror_kind: null,
                expense_splits: []
              },
              error: null
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        maybeSingle: () => {
          if (opts.status === "not_found") {
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({
            data: {
              id: opts.actionId || "00000000-0000-4000-8000-000000000401",
              couple_id: 1,
              group_id: opts.expenseGroupId !== undefined ? opts.expenseGroupId : null,
              action_type: opts.actionType || "create_expense",
              payload: opts.payload || {},
              status: opts.status || "pending",
              expires_at: opts.expiresAt || "2099-01-01T00:00:00.000Z"
            },
            error: null
          });
        },
        then: (resolve: any) => {
          if (table === "users") {
            return resolve({
              data: [
                { id: CORE_OWNER, couple_id: 1, role: "owner", line_user_id: "line-owner" },
                { id: CORE_PARTNER, couple_id: 1, role: "partner", line_user_id: "line-partner" }
              ],
              error: null
            });
          }
          if (table === "expenses") {
            const balanceVal = opts.groupBalances?.[CORE_OWNER] ?? 0;
            if (balanceVal !== 0) {
              const paidBy = balanceVal < 0 ? CORE_PARTNER : CORE_OWNER;
              const amount = Math.abs(balanceVal) * 2;
              return resolve({
                data: [
                  {
                    id: "00000000-0000-4000-8000-000000000099",
                    ledger: "shared",
                    amount_twd: amount,
                    paid_by_user_id: paidBy,
                    created_by_user_id: paidBy,
                    expense_date: "2026-07-01",
                    deleted_at: null,
                    expense_splits: [
                      { user_id: CORE_OWNER, amount_twd: amount / 2 },
                      { user_id: CORE_PARTNER, amount_twd: amount / 2 }
                    ]
                  }
                ],
                error: null
              });
            }
            return resolve({ data: [], error: null });
          }
          if (table === "settlements") {
            return resolve({ data: [], error: null });
          }
          return resolve({ data: [], error: null });
        }
      };
      return chain;
    }
  } as any;
}

test("TS Confirm Paths: create_expense confirm success", async () => {
  const service = new PendingActionService();
  const fakeTx = new FakeTxClient();
  fakeTx.mockResults.push({
    pattern: /SELECT.*FROM.*pending_actions.*FOR UPDATE/i,
    result: {
      rowCount: 1,
      rows: [{ status: "pending", expires_at: "2099-01-01T00:00:00.000Z", action_type: "create_expense" }]
    }
  });
  activeTxClient = fakeTx;

  try {
    const mockDb = createMockDbConfirm({
      actionId: "00000000-0000-4000-8000-000000000401",
      actionType: "create_expense",
      payload: {
        kind: "ledger_command",
        version: 1,
        command: {
          type: "create_expense",
          expense: {
            group_id: null,
            ledger: "private",
            description: "Test Expense",
            merchant: null,
            notes: null,
            tag: "餐飲",
            amount_twd: 100,
            paid_by_user_id: CORE_OWNER,
            expense_date: "2026-07-01",
            split_method: "equal"
          }
        },
        metadata: { source: "line", actorUserId: CORE_OWNER, idempotencyKey: null },
        ledger: "private",
        description: "Test Expense",
        tag: "餐飲",
        amount_twd: 100,
        paid_by_user_id: CORE_OWNER,
        expense_date: "2026-07-01",
        split_method: "equal",
        splits: { [CORE_OWNER]: 100 }
      }
    });

    const result = await service.confirm(
      { db: mockDb, user: { id: CORE_OWNER, couple_id: 1, line_user_id: "line-owner", role: "owner" } },
      "00000000-0000-4000-8000-000000000401",
      true
    );

    assert.equal(result.result, "confirmed");
    const selectForUpdate = fakeTx.calls.find(c => c.query.includes("FOR UPDATE"));
    assert.ok(selectForUpdate);
    const insertExpense = fakeTx.calls.find(c => c.query.includes("INSERT INTO public.expenses"));
    assert.ok(insertExpense);
    assert.equal(insertExpense.params?.[4], "Test Expense");
    assert.equal(insertExpense.params?.[8], 100);
  } finally {
    activeTxClient = null;
  }
});

test("TS Confirm Paths: update_expense version mismatch -> stale", async () => {
  const service = new PendingActionService();
  const fakeTx = new FakeTxClient();
  fakeTx.mockResults.push({
    pattern: /SELECT.*FROM.*pending_actions.*FOR UPDATE/i,
    result: {
      rowCount: 1,
      rows: [{ status: "pending", expires_at: "2099-01-01T00:00:00.000Z", action_type: "update_expense" }]
    }
  });
  fakeTx.mockResults.push({
    pattern: /UPDATE public.expenses/i,
    result: { rowCount: 0 }
  });
  activeTxClient = fakeTx;

  try {
    const mockDb = createMockDbConfirm({
      actionId: "00000000-0000-4000-8000-000000000401",
      actionType: "update_expense",
      expenseId: "00000000-0000-4000-8000-000000000188",
      expenseVersion: 3,
      payload: {
        expense_id: "00000000-0000-4000-8000-000000000188",
        expected_version: 3,
        group_id: null,
        ledger: "private",
        tag: "餐飲",
        paid_by_user_id: CORE_OWNER,
        splits: { [CORE_OWNER]: 100 }
      }
    });

    const result = await service.confirm(
      { db: mockDb, user: { id: CORE_OWNER, couple_id: 1, line_user_id: "line-owner", role: "owner" } },
      "00000000-0000-4000-8000-000000000401",
      true
    );

    assert.equal(result.result, "stale");
  } finally {
    activeTxClient = null;
  }
});

test("TS Confirm Paths: delete_expense / restore_expense success", async () => {
  const service = new PendingActionService();
  const fakeTx = new FakeTxClient();
  fakeTx.mockResults.push({
    pattern: /SELECT.*FROM.*pending_actions.*FOR UPDATE/i,
    result: {
      rowCount: 1,
      rows: [{ status: "pending", expires_at: "2099-01-01T00:00:00.000Z", action_type: "delete_expense" }]
    }
  });
  activeTxClient = fakeTx;

  try {
    const mockDb = createMockDbConfirm({
      actionId: "00000000-0000-4000-8000-000000000401",
      actionType: "delete_expense",
      expenseId: "00000000-0000-4000-8000-000000000188",
      expenseVersion: 3,
      payload: {
        expense_id: "00000000-0000-4000-8000-000000000188",
        expected_version: 3
      }
    });

    const result = await service.confirm(
      { db: mockDb, user: { id: CORE_OWNER, couple_id: 1, line_user_id: "line-owner", role: "owner" } },
      "00000000-0000-4000-8000-000000000401",
      true
    );

    assert.equal(result.result, "confirmed");
    const updateCall = fakeTx.calls.find(c => c.query.includes("UPDATE public.expenses"));
    assert.ok(updateCall);
    assert.ok(updateCall.query.includes("deleted_at ="));
  } finally {
    activeTxClient = null;
  }
});

test("TS Confirm Paths: settle success", async () => {
  const service = new PendingActionService();
  const fakeTx = new FakeTxClient();
  fakeTx.mockResults.push({
    pattern: /SELECT.*FROM.*pending_actions.*FOR UPDATE/i,
    result: {
      rowCount: 1,
      rows: [{ status: "pending", expires_at: "2099-01-01T00:00:00.000Z", action_type: "settle" }]
    }
  });
  activeTxClient = fakeTx;

  try {
    const mockDb = createMockDbConfirm({
      actionId: "00000000-0000-4000-8000-000000000401",
      actionType: "settle",
      activeGroupId: GROUP,
      groupBalances: { [CORE_OWNER]: -500 },
      payload: {
        kind: "ledger_command",
        version: 1,
        command: {
          type: "settle_debt",
          settlement: {
            group_id: null,
            from_user_id: CORE_OWNER,
            to_user_id: CORE_PARTNER,
            amount_twd: 500
          }
        },
        metadata: { source: "line", actorUserId: CORE_OWNER, idempotencyKey: null },
        group_id: null,
        from_user_id: CORE_OWNER,
        to_user_id: CORE_PARTNER,
        amount_twd: 500
      }
    });

    const result = await service.confirm(
      { db: mockDb, user: { id: CORE_OWNER, couple_id: 1, line_user_id: "line-owner", role: "owner" } },
      "00000000-0000-4000-8000-000000000401",
      true
    );

    assert.equal(result.result, "confirmed");
    const insertSettlement = fakeTx.calls.find(c => c.query.includes("INSERT INTO public.settlements"));
    assert.ok(insertSettlement);
    assert.equal(insertSettlement.params?.[5], 500);
  } finally {
    activeTxClient = null;
  }
});

test("TS Confirm Paths: batch_create_expenses success", async () => {
  const service = new PendingActionService();
  const fakeTx = new FakeTxClient();
  fakeTx.mockResults.push({
    pattern: /SELECT.*FROM.*pending_actions.*FOR UPDATE/i,
    result: {
      rowCount: 1,
      rows: [{ status: "pending", expires_at: "2099-01-01T00:00:00.000Z", action_type: "batch_create_expenses" }]
    }
  });
  activeTxClient = fakeTx;

  try {
    const mockDb = createMockDbConfirm({
      actionId: "00000000-0000-4000-8000-000000000401",
      actionType: "batch_create_expenses",
      payload: {
        items: [
          {
            group_id: null,
            ledger: "private",
            description: "Batch 1",
            merchant: null,
            notes: null,
            tag: "餐飲",
            amount_twd: 150,
            paid_by_user_id: CORE_OWNER,
            expense_date: "2026-07-01",
            split_method: "equal",
            splits: { [CORE_OWNER]: 150 }
          }
        ]
      }
    });

    const result = await service.confirm(
      { db: mockDb, user: { id: CORE_OWNER, couple_id: 1, line_user_id: "line-owner", role: "owner" } },
      "00000000-0000-4000-8000-000000000401",
      true
    );

    assert.equal(result.result, "confirmed");
    assert.equal((result as any).created_count, 1);
    const insertExpense = fakeTx.calls.find(c => c.query.includes("INSERT INTO public.expenses"));
    assert.ok(insertExpense);
  } finally {
    activeTxClient = null;
  }
});

test("TS Confirm Paths: batch_update_expenses success", async () => {
  const service = new PendingActionService();
  const fakeTx = new FakeTxClient();
  fakeTx.mockResults.push({
    pattern: /SELECT.*FROM.*pending_actions.*FOR UPDATE/i,
    result: {
      rowCount: 1,
      rows: [{ status: "pending", expires_at: "2099-01-01T00:00:00.000Z", action_type: "batch_update_expenses" }]
    }
  });
  activeTxClient = fakeTx;

  try {
    const mockDb = createMockDbConfirm({
      actionId: "00000000-0000-4000-8000-000000000401",
      actionType: "batch_update_expenses",
      expenseId: "00000000-0000-4000-8000-000000000188",
      expenseGroupId: GROUP, // MATCH group_id!
      expenseVersion: 3,
      payload: {
        updates: [
          {
            expense_id: "00000000-0000-4000-8000-000000000188",
            expected_version: 3,
            tag: "交通"
          }
        ]
      }
    });

    const result = await service.confirm(
      { db: mockDb, user: { id: CORE_OWNER, couple_id: 1, line_user_id: "line-owner", role: "owner" } },
      "00000000-0000-4000-8000-000000000401",
      true
    );

    assert.equal(result.result, "confirmed");
    const updateCall = fakeTx.calls.find(c => c.query.includes("UPDATE public.expenses"));
    assert.ok(updateCall);
    assert.ok(updateCall.query.includes("tag ="));
  } finally {
    activeTxClient = null;
  }
});

test("TS Confirm Paths: already_done / expired / not_found", async () => {
  const service = new PendingActionService();

  // Case 1: not_found
  const fakeTxNotFound = new FakeTxClient();
  fakeTxNotFound.mockResults.push({
    pattern: /SELECT.*FROM.*pending_actions.*FOR UPDATE/i,
    result: { rowCount: 0, rows: [] }
  });
  activeTxClient = fakeTxNotFound;

  try {
    const mockDb = createMockDbConfirm({
      status: "not_found"
    });

    const result = await service.confirm(
      { db: mockDb, user: { id: CORE_OWNER, couple_id: 1, line_user_id: "line-owner", role: "owner" } },
      "00000000-0000-4000-8000-000000000401",
      true
    );
    assert.equal(result.result, "not_found");
  } finally {
    activeTxClient = null;
  }

  // Case 2: already_done
  const fakeTxAlreadyDone = new FakeTxClient();
  fakeTxAlreadyDone.mockResults.push({
    pattern: /SELECT.*FROM.*pending_actions.*FOR UPDATE/i,
    result: {
      rowCount: 1,
      rows: [{ status: "confirmed", expires_at: "2099-01-01T00:00:00.000Z", action_type: "create_expense" }]
    }
  });
  activeTxClient = fakeTxAlreadyDone;

  try {
    const mockDb = createMockDbConfirm({
      status: "confirmed",
      actionType: "create_expense"
    });

    const result = await service.confirm(
      { db: mockDb, user: { id: CORE_OWNER, couple_id: 1, line_user_id: "line-owner", role: "owner" } },
      "00000000-0000-4000-8000-000000000401",
      true
    );
    assert.equal(result.result, "already_done");
  } finally {
    activeTxClient = null;
  }

  // Case 3: expired
  const fakeTxExpired = new FakeTxClient();
  fakeTxExpired.mockResults.push({
    pattern: /SELECT.*FROM.*pending_actions.*FOR UPDATE/i,
    result: {
      rowCount: 1,
      rows: [{ status: "pending", expires_at: "1970-01-01T00:00:00.000Z", action_type: "create_expense" }]
    }
  });
  activeTxClient = fakeTxExpired;

  try {
    const mockDb = createMockDbConfirm({
      status: "pending",
      expiresAt: "1970-01-01T00:00:00.000Z",
      actionType: "create_expense"
    });

    const result = await service.confirm(
      { db: mockDb, user: { id: CORE_OWNER, couple_id: 1, line_user_id: "line-owner", role: "owner" } },
      "00000000-0000-4000-8000-000000000401",
      true
    );
    assert.equal(result.result, "expired");
  } finally {
    activeTxClient = null;
  }
});

test("TS Confirm Paths: constraint violation -> stale", async () => {
  const service = new PendingActionService();
  const fakeTx = new FakeTxClient();
  fakeTx.mockResults.push({
    pattern: /SELECT.*FROM.*pending_actions.*FOR UPDATE/i,
    result: {
      rowCount: 1,
      rows: [{ status: "pending", expires_at: "2099-01-01T00:00:00.000Z", action_type: "create_expense" }]
    }
  });
  fakeTx.mockResults.push({
    pattern: /INSERT INTO public.expenses/i,
    result: Promise.reject(Object.assign(new Error("Unique violation"), { code: "23505" }))
  });
  activeTxClient = fakeTx;

  try {
    const mockDb = createMockDbConfirm({
      actionId: "00000000-0000-4000-8000-000000000401",
      actionType: "create_expense",
      payload: {
        kind: "ledger_command",
        version: 1,
        command: {
          type: "create_expense",
          expense: {
            group_id: null,
            ledger: "private",
            description: "Test Expense",
            merchant: null,
            notes: null,
            tag: "餐飲",
            amount_twd: 100,
            paid_by_user_id: CORE_OWNER,
            expense_date: "2026-07-01",
            split_method: "equal"
          }
        },
        metadata: { source: "line", actorUserId: CORE_OWNER, idempotencyKey: null },
        ledger: "private",
        description: "Test Expense",
        tag: "餐飲",
        amount_twd: 100,
        paid_by_user_id: CORE_OWNER,
        expense_date: "2026-07-01",
        split_method: "equal",
        splits: { [CORE_OWNER]: 100 }
      }
    });

    const result = await service.confirm(
      { db: mockDb, user: { id: CORE_OWNER, couple_id: 1, line_user_id: "line-owner", role: "owner" } },
      "00000000-0000-4000-8000-000000000401",
      true
    );

    assert.equal(result.result, "stale");
  } finally {
    activeTxClient = null;
  }
});
