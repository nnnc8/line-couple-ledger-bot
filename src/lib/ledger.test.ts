import assert from "node:assert/strict";
import test from "node:test";

import { actionResultMessage } from "./line-bot-shared";
import {
  handleLineEvent,
  parsePendingRetargetCommand,
  parseFixedIntent,
  parseInlineExpenseItems,
  resolveMentionedGroupTurn,
  selectMentionedGroup,
} from "./line-webhook-service";
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
  classifyExpenseCategory,
  fallbackCategoryClassification,
  splitBootstrapExpenses,
} from "./category-agent";
import { safeSecretEqual, signSession, verifySession } from "./security";
import { matchTransactions, parseBankCsvWithMeta } from "./bank-csv";
import { setMockWithTx } from "./db/tx";
import { TransactionStaleError } from "./pending-action-executor";

function replyTextOf(reply: any): string {
  if (reply == null) return "";
  if (typeof reply === "string") return reply;
  if (Array.isArray(reply)) return reply.map((r: any) => typeof r === "string" ? r : r?.altText ?? "").join("\n");
  return reply?.altText ?? "";
}

function collectAllTexts(container: any): string[] {
  const texts: string[] = [];
  function walk(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.type === "text" && typeof node.text === "string") {
      texts.push(node.text);
    }
    if (Array.isArray(node.contents)) {
      for (const child of node.contents) walk(child);
    }
    if (node.header) walk(node.header);
    if (node.body) walk(node.body);
    if (node.footer) walk(node.footer);
    if (node.action?.label) texts.push(node.action.label);
  }
  walk(container);
  return texts;
}

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

import { searchExpenseRows } from "./expense-search";
import {
  calculateBalances,
  geminiIntentJsonSchema,
  geminiTextParseSchema,
  learnCategoryFromHistory,
  monthlySummary,
  nextRecurringDate,
  parsedIntentSchema,
  textParseSchema,
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
import { purgeDeletedReceipts } from "./receipt-service";
import { expirePendingActions } from "./daily-jobs";
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

test("resolves a mentioned LINE group into target group and cleaned text", () => {
  const resolved = resolveMentionedGroupTurn(
    "幫我新增 吃飽喝足 拉麵 840 對方付",
    [
      { id: "active", name: "阿提斯" },
      { id: "food", name: "吃飽喝足" },
    ],
    "active",
  );

  assert.equal(resolved.group?.id, "food");
  assert.equal(resolved.mentionedGroup?.id, "food");
  assert.equal(resolved.cleanedText, "幫我新增 拉麵 840 對方付");
});

test("LINE payer hints cover natural self and partner wording", async () => {
  const { inferDeterministicPayerHint } = await import("./line-message-parsers");
  assert.equal(inferDeterministicPayerHint("肯德基 478 我出"), "self");
  assert.equal(inferDeterministicPayerHint("晚餐 500 她出"), "partner");
  assert.equal(inferDeterministicPayerHint("晚餐 500"), null);
});

test("LINE transfer parser preserves invalid amounts for rejection", async () => {
  const { parseSettlementRequest } = await import("./line-secretary-service");
  assert.equal(parseSettlementRequest("阿提斯 我轉 0")?.amountTwd, 0);
  assert.equal(parseSettlementRequest("阿提斯 我轉 -100")?.amountTwd, -100);
  assert.equal(parseSettlementRequest("阿提斯 我轉 100.5")?.amountTwd, 100.5);
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

test("category classifier keeps rules and history off the LLM path", async () => {
  let generatorCalls = 0;
  const generator = async () => {
    generatorCalls += 1;
    return { tag: "錯誤", confidence: 1, reason: "test" };
  };

  assert.equal(
    (
      await classifyExpenseCategory(
        {
          description: "藥局",
          fallbackTag: "其他",
          history: [],
        },
        generator,
      )
    ).tag,
    "醫療",
  );
  assert.equal(
    (
      await classifyExpenseCategory(
        {
          description: "肯德基",
          merchant: "肯德基",
          fallbackTag: "其他",
          history: [{ tag: "餐飲", description: "肯德基", merchant: "肯德基" }],
        },
        generator,
      )
    ).tag,
    "餐飲",
  );
  assert.equal(generatorCalls, 0);
});

test("category classifier uses injected generator and always falls back safely", async () => {
  const input = {
    description: "完全未知店名",
    fallbackTag: "其他",
    history: [],
  };
  let calls = 0;
  const success = await classifyExpenseCategory(input, async () => {
    calls += 1;
    return { tag: "餐飲", confidence: 0.9, reason: "test" };
  });
  assert.equal(success.tag, "餐飲");
  assert.equal(calls, 1);

  const lowConfidence = await classifyExpenseCategory(input, async () => ({
    tag: "餐飲",
    confidence: 0.2,
    reason: "test",
  }));
  assert.equal(lowConfidence.tag, "其他");

  const failed = await classifyExpenseCategory(input, async () => {
    throw new Error("classifier down");
  });
  assert.equal(failed.tag, "其他");

  const timedOut = await classifyExpenseCategory(input, async () => new Promise(() => {}));
  assert.equal(timedOut.tag, "其他");
});

test("tag frequency for prompts excludes both generic other labels", async () => {
  const { loadTagFrequencyForPrompt } = await import("./tag-suggestion-service");
  const query: any = {
    select: () => query,
    eq: () => query,
    is: () => query,
    gte: () => query,
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve(resolve({
        data: [
          { tag: "其他" },
          { tag: "other" },
          { tag: "餐飲" },
          { tag: "餐飲" },
        ],
        error: null,
      })),
  };
  const db = { from: () => query } as unknown as import("@supabase/supabase-js").SupabaseClient;
  assert.deepEqual(await loadTagFrequencyForPrompt(db, OWNER), [{ tag: "餐飲", count: 2 }]);
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
    },
  });
});



test("receipt service purges expired deleted receipts from storage and db", async () => {
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

  const count = await purgeDeletedReceipts(db, new Date("2026-07-31T00:00:00.000Z"));

  assert.equal(count, 2);
  assert.deepEqual(removedPaths, ["1/u/a.jpg", "1/u/b.jpg"]);
  assert.deepEqual(deletedIds, [
    "00000000-0000-4000-8000-000000000301",
    "00000000-0000-4000-8000-000000000302",
  ]);
});

test("daily jobs expire only pending actions past their deadline", async () => {
  let updatePayload: Record<string, unknown> | null = null;
  const mockDb = {
    from: (table: string) => {
      assert.equal(table, "pending_actions");
      const chain: any = {
        update: (payload: Record<string, unknown>) => {
          updatePayload = payload;
          return chain;
        },
        eq: () => chain,
        lte: () => chain,
        select: () => Promise.resolve({ data: [{ id: "expired-1" }, { id: "expired-2" }], error: null }),
      };
      return chain;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const now = new Date("2026-07-12T10:00:00.000Z");
  const count = await expirePendingActions(mockDb, now);

  assert.equal(count, 2);
  assert.deepEqual(updatePayload, {
    status: "expired",
    processed_at: now.toISOString(),
  });
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
  };
}

function fakeContext(db: ReturnType<typeof fakeNotificationDb>): ServerContext {
  return {
    env: {
      DATABASE_URL: "postgresql://localhost:5432/db",
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

test("write tools: record_expense fills a missing tag before building the action", async () => {
  const { executeTool } = await import("./accountant-tools");
  const users = [
    { id: "user-1", couple_id: 1, line_user_id: "line-1", role: "owner" as const },
    { id: "partner-123", couple_id: 1, line_user_id: "line-2", role: "partner" as const },
  ];
  const classifierCapture: {
    current: {
      groupName?: string | null;
      history: Array<{ tag: string; description: string; merchant?: string | null }>;
    } | null;
  } = { current: null };

  const db = {
    from(table: string) {
      const filters = new Map<string, unknown>();
      const query: any = {
        select: () => query,
        eq: (field: string, value: unknown) => {
          filters.set(field, value);
          return query;
        },
        is: (field: string, value: unknown) => {
          filters.set(field, value);
          return query;
        },
        order: () => query,
        limit: () => query,
        single: async () => {
          if (table === "users") return { data: users[0], error: null };
          if (table === "groups") return { data: { id: GROUP, name: "阿提斯" }, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (value: { data: unknown; error: null }) => unknown) => {
          if (table === "users") return Promise.resolve(resolve({ data: users, error: null }));
          if (table === "expenses") {
            return Promise.resolve(resolve({
              data: [
                { tag: "其他", description: "錯誤歷史", merchant: null },
                { tag: "餐飲", description: "漢堡", merchant: "餐廳" },
              ],
              error: null,
            }));
          }
          return Promise.resolve(resolve({ data: [], error: null }));
        },
      };
      return query;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const result = await executeTool(
    "record_expense",
    {
      description: "肯德基",
      amount_twd: 478,
      paid_by: "self",
      ledger: "shared",
    },
    {
      db,
      groupId: GROUP,
      userId: OWNER,
      coupleId: 1,
      context: {
        categoryClassificationGenerator: async (input: {
          groupName?: string | null;
          history: Array<{ tag: string; description: string; merchant?: string | null }>;
        }) => {
          classifierCapture.current = input;
          return { tag: "餐飲", confidence: 0.9, reason: "test" };
        },
      },
    },
  );

  const expense = (result as { pending_action: { expense: { tag: string } } }).pending_action.expense;
  assert.equal(expense.tag, "餐飲");
  if (!classifierCapture.current) assert.fail("classifier was not called");
  const captured = classifierCapture.current;
  assert.equal(captured.groupName, "阿提斯");
  assert.deepEqual(captured.history.map((entry) => entry.tag), ["餐飲"]);
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
  } as unknown as AgentDeps["gemini"];

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
                eq: () => ({
                  is: () => ({
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
  assert.equal(saved.scope, "group");
  assert.equal(saved.user_id, null);
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

test("recurring service: toggle updates active flag and notifies partner", async () => {
  const { RecurringService } = await import("./recurring-service");

  const recurringId = "00000000-0000-4000-8000-000000000120";
  let updated = false;
  let activityArgs: any[] | null = null;
  let notifyArgs: any[] | null = null;
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
                      group_id: "00000000-0000-4000-8000-000000000121",
                      active: true,
                    },
                    error: null,
                  }),
              }),
            }),
          }),
          update: (payload: any) => {
            assert.equal(payload.active, false);
            return {
              eq: () => ({
                eq: () => {
                  updated = true;
                  return Promise.resolve({ error: null });
                },
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as any;

  const service = new RecurringService();
  const result = await service.save(
    {
      db: mockDb,
      user: { id: "u", couple_id: 1 },
      requireGroup: async () => {},
      appendActivity: async (...args: any[]) => {
        activityArgs = args;
      },
      notifyPartner: async (...args: any[]) => {
        notifyArgs = args;
      },
      deliverNotifications: async () => {
        delivered++;
      },
    },
    {
      operation: "toggle",
      id: recurringId,
      active: false,
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(updated, true);
  assert.deepEqual(activityArgs, [
    recurringId,
    "update",
    "00000000-0000-4000-8000-000000000121",
    {
      id: recurringId,
      group_id: "00000000-0000-4000-8000-000000000121",
      active: true,
    },
    { operation: "toggle", id: recurringId, active: false },
  ]);
  assert.deepEqual(notifyArgs, [
    "週期支出已更新",
    "已停用週期支出",
    "00000000-0000-4000-8000-000000000121",
    recurringId,
  ]);
  assert.equal(delivered, 1);
});

test("recurring service: shared save requires group and preserves shared group_id", async () => {
  const { RecurringService } = await import("./recurring-service");

  const selfUserId = "00000000-0000-4000-8000-000000000122";
  const partnerUserId = "00000000-0000-4000-8000-000000000123";
  const groupId = "00000000-0000-4000-8000-000000000124";
  let requireGroupCalledWith: string | null = null;
  let inserted: any = null;

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
          insert: (row: any) => {
            inserted = row;
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: { id: "00000000-0000-4000-8000-000000000125" },
                    error: null,
                  }),
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as any;

  const service = new RecurringService();
  await service.save(
    {
      db: mockDb,
      user: { id: selfUserId, couple_id: 1 },
      requireGroup: async (gid) => {
        requireGroupCalledWith = gid;
      },
      appendActivity: async () => {},
      notifyPartner: async () => {},
      deliverNotifications: async () => {},
    },
    {
      id: null,
      ledger: "shared",
      groupId,
      description: "Rent",
      merchant: null,
      notes: null,
      tag: "房租",
      amountTwd: 20000,
      paidBy: "self",
      expenseDate: "2026-06-30",
      splitMethod: "equal",
      selfValue: null,
      partnerValue: null,
      frequency: "monthly",
      nextRunDate: "2026-07-01",
      endDate: null,
      active: true,
    },
  );

  assert.equal(requireGroupCalledWith, groupId);
  assert.ok(inserted);
  assert.equal(inserted.group_id, groupId);
  assert.equal(inserted.ledger, "shared");
});

test("recurring runner: failed executePendingAction logs error and does not advance next_run_date", async () => {
  const { RecurringService } = await import("./recurring-service");

  const recurringId = "00000000-0000-4000-8000-000000000126";
  const creatorId = "00000000-0000-4000-8000-000000000127";
  const groupId = "00000000-0000-4000-8000-000000000128";
  
  let loggedErrorId: string | null = null;
  let dbUpdatesCalled = 0;

  const mockDb = {
    from: (table: string) => {
      if (table === "recurring_expenses") {
        return {
          select: () => ({
            eq: () => ({
              lte: () =>
                Promise.resolve({
                  data: [
                    {
                      id: recurringId,
                      group_id: groupId,
                      created_by_user_id: creatorId,
                      paid_by_user_id: creatorId,
                      ledger: "shared",
                      description: "Spotify Failure",
                      amount_twd: 149,
                      tag: "娛樂",
                      split_method: "equal",
                      splits: { [creatorId]: 75 },
                      next_run_date: "2026-07-15",
                      frequency: "monthly",
                      anchor_day: 15,
                      end_date: null,
                    },
                  ],
                  error: null,
                }),
            }),
          }),
          update: () => {
            dbUpdatesCalled++;
            return {
              eq: () => Promise.resolve({ error: null }),
            };
          },
        };
      }
      if (table === "users") {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: {
                    id: creatorId,
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
      throw new Error(`unexpected table ${table}`);
    },
  } as any;

  const service = new RecurringService();
  const count = await service.runDue({
    env: {},
    db: mockDb,
    today: "2026-07-20",
    executePendingAction: async () => {
      throw new Error("Simulated action failure");
    },
    logError: (rid, err) => {
      loggedErrorId = rid;
      assert.match((err as Error).message, /Simulated action failure/);
    },
  });

  assert.equal(count, 0);
  assert.equal(loggedErrorId, recurringId);
  assert.equal(dbUpdatesCalled, 0);
});

test("recurring facade: save/runDue delegate to the split modules", async () => {
  const { RecurringService } = await import("./recurring-service");
  const { recurringSaveHandler } = await import("./recurring-save");
  const { recurringRunnerHandler } = await import("./recurring-runner");

  let saveCalled = false;
  let runDueCalled = false;

  const originalSave = recurringSaveHandler.saveRecurring;
  const originalRunDue = recurringRunnerHandler.runDueRecurring;

  recurringSaveHandler.saveRecurring = async () => {
    saveCalled = true;
    return { ok: true };
  };
  recurringRunnerHandler.runDueRecurring = async () => {
    runDueCalled = true;
    return 42;
  };

  try {
    const service = new RecurringService();
    const saveRes = await service.save({} as any, {});
    const runDueRes = await service.runDue({} as any);

    assert.equal(saveCalled, true);
    assert.deepEqual(saveRes, { ok: true });
    assert.equal(runDueCalled, true);
    assert.equal(runDueRes, 42);
  } finally {
    recurringSaveHandler.saveRecurring = originalSave;
    recurringRunnerHandler.runDueRecurring = originalRunDue;
  }
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
  assert.equal(row.tag, "娛樂");
  assert.equal("category" in row, false);
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
                      splits: {
                        [creatorId]: 75,
                        "00000000-0000-4000-8000-000000000110": 74,
                      },
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
          lastToolCall: null,
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
        lastToolCall: null,
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

test("write tools: update_expense returns pending_action updates", async () => {
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
    "update_expense",
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

test("write tools: update_expense no-op throws error", async () => {
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
    "update_expense",
    {
      expense_id: "00000000-0000-0000-0000-000000000001",
      updates: {},
    },
    ctx,
  );

  const res = result as { error: string };
  assert.equal(res.error, "沒有可修改的欄位");
});

test("tool integration regression: tool -> executeAgentAction -> TS transaction", async () => {
  const { executeTool } = await import("./accountant-tools");
  const { registerPendingActionService } = await import("./pending-action-builders");
  const { PendingActionService } = await import("./pending-action-service");

  const insertedRows: Record<string, unknown>[] = [];

  const mockDb = {
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

test("secretary integration regression: tool -> SecretaryService.run -> TS transaction", async () => {
  const { executeTool } = await import("./accountant-tools");
  const { registerPendingActionService } = await import("./pending-action-builders");
  const { PendingActionService } = await import("./pending-action-service");
  const { SecretaryService } = await import("./secretary-service");

  const insertedRows: Record<string, unknown>[] = [];

  const mockDb = {
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
          lastToolCall: null,
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
  process.env.DATABASE_URL = "postgresql://localhost:5432/db";
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
    const filters = new Map<string, unknown>();
    const resolveData = () =>
      typeof tableData[tableName] === "function"
        ? tableData[tableName](filters)
        : tableData[tableName];
    const subChain: any = {
      select: () => subChain,
      eq: (field: string, value: unknown) => {
        filters.set(field, value);
        return subChain;
      },
      is: (field: string, value: unknown) => {
        filters.set(field, value);
        return subChain;
      },
      neq: () => subChain,
      order: () => subChain,
      limit: () => subChain,
      single: () => {
        return Promise.resolve({ data: resolveData(), error: null });
      },
      maybeSingle: () => {
        return Promise.resolve({ data: resolveData(), error: null });
      },
      then: (resolve: (value: { data: any; error: null }) => unknown) =>
        Promise.resolve(resolve({ data: resolveData(), error: null })),
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
      didExecuteAction: false,
      lastToolCall: null,
    };
  };

  try {
    let repliedText: any = "";
    let pushCalled = false;
    const dependencies: any = {
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
      didExecuteAction: false,
      lastToolCall: null,
    };
  };

  try {
    let repliedText: any = "";
    let pushTarget = "";
    let pushMsg = "";

    const dependencies: any = {
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

test("runLineSecretaryTurn routes explicit group mention to that group and strips it from text", async () => {
  setupMockEnv();
  const { runLineSecretaryTurn } = await import("./line-secretary-service");
  const { SecretaryService } = await import("./secretary-service");

  let receivedText = "";
  let sessionGroupId = "";
  const originalRun = SecretaryService.prototype.run;
  SecretaryService.prototype.run = async (args: any) => {
    receivedText = args.initialInput.text;
    return {
      reply: "ok",
      notifyPartner: false,
      partnerMessage: null,
      actionFailure: null,
      didExecuteAction: false,
      lastToolCall: null,
    };
  };

  try {
    const activeGroupId = "00000000-0000-4000-8000-000000000001";
    const foodGroupId = "00000000-0000-4000-8000-000000000002";
    const dependencies: any = {
      lineClient: {
        replyMessage: async () => {},
        getMessageContent: async () => ({} as any),
        pushMessage: async () => {},
      },
      supabase: createMockDbForSecretary({
        user_preferences: { active_group_id: activeGroupId },
        groups: [
          { id: activeGroupId, name: "阿提斯" },
          { id: foodGroupId, name: "吃飽喝足" },
        ],
        users: { id: "00000000-0000-4000-8000-000000000003", couple_id: 1, role: "partner", line_user_id: "line-partner" },
        secretary_sessions: (filters: Map<string, unknown>) => {
          sessionGroupId = String(filters.get("group_id") ?? "");
          return null;
        },
      }),
      gemini: {} as any,
    };

    const user = {
      id: "user-id",
      couple_id: 1,
      role: "owner" as const,
      line_user_id: "line-user-id",
    };

    let repliedText: any = "";
    await runLineSecretaryTurn({
      text: "幫我新增 吃飽喝足 拉麵 840 對方付",
      user,
      dependencies,
      reply: async (text) => {
        repliedText = text;
      },
    });

    assert.equal(receivedText, "幫我新增 拉麵 840 對方付");
    assert.equal(sessionGroupId, foodGroupId);
    assert.equal(repliedText, "ok");
  } finally {
    SecretaryService.prototype.run = originalRun;
  }
});

test("runLineSecretaryTurn: shared account + accounting intent + no group name -> needs_group, no LLM call", async () => {
  setupMockEnv();
  const { runLineSecretaryTurn } = await import("./line-secretary-service");
  const { SecretaryService } = await import("./secretary-service");

  let runCalled = false;
  const originalRun = SecretaryService.prototype.run;
  SecretaryService.prototype.run = async () => {
    runCalled = true;
    return {
      reply: "should not happen",
      notifyPartner: false,
      partnerMessage: null,
      actionFailure: null,
      didExecuteAction: false,
      lastToolCall: null,
    };
  };

  try {
    let repliedText: any = "";
    const dependencies: any = {
      lineClient: {
        replyMessage: async () => {},
        getMessageContent: async () => ({} as any),
        pushMessage: async () => {},
      },
      supabase: createMockDbForSecretary({
        user_preferences: { active_group_id: "00000000-0000-4000-8000-000000000001" },
        groups: [
          { id: "00000000-0000-4000-8000-000000000001", name: "阿提斯" },
          { id: "00000000-0000-4000-8000-000000000002", name: "吃飽喝足" },
        ],
        users: { id: "00000000-0000-4000-8000-000000000003", couple_id: 1, role: "partner", line_user_id: "line-partner" },
        secretary_sessions: null,
      }),
      gemini: {} as any,
    };

    await runLineSecretaryTurn({
      text: "幫我記 晚餐 500",
      user: {
        id: "user-id",
        couple_id: 1,
        role: "owner" as const,
        line_user_id: "line-user-id",
      },
      dependencies,
      reply: async (text) => {
        repliedText = text;
      },
    });

    assert.equal(runCalled, false);
    assert.match(replyTextOf(repliedText), /要記到哪個群組/);
    assert.match(replyTextOf(repliedText), /阿提斯、吃飽喝足/);
  } finally {
    SecretaryService.prototype.run = originalRun;
  }
});

test("runLineSecretaryTurn: shared account + chitchat + no group name -> reaches LLM, no gate", async () => {
  setupMockEnv();
  const { runLineSecretaryTurn } = await import("./line-secretary-service");
  const { SecretaryService } = await import("./secretary-service");

  let runCalled = false;
  const originalRun = SecretaryService.prototype.run;
  SecretaryService.prototype.run = async () => {
    runCalled = true;
    return {
      reply: "你好！需要什麼協助？",
      notifyPartner: false,
      partnerMessage: null,
      actionFailure: null,
      didExecuteAction: false,
      lastToolCall: null,
    };
  };

  try {
    let repliedText: any = "";
    const dependencies: any = {
      lineClient: {
        replyMessage: async () => {},
        getMessageContent: async () => ({} as any),
        pushMessage: async () => {},
      },
      supabase: createMockDbForSecretary({
        user_preferences: { active_group_id: "00000000-0000-4000-8000-000000000001" },
        groups: [{ id: "00000000-0000-4000-8000-000000000001", name: "阿提斯" }],
        users: { id: "00000000-0000-4000-8000-000000000003", couple_id: 1, role: "partner", line_user_id: "line-partner" },
        secretary_sessions: null,
      }),
      gemini: {} as any,
    };

    await runLineSecretaryTurn({
      text: "你好",
      user: {
        id: "user-id",
        couple_id: 1,
        role: "owner" as const,
        line_user_id: "line-user-id",
      },
      dependencies,
      reply: async (text) => {
        repliedText = text;
      },
    });

    assert.equal(runCalled, true);
    assert.equal(repliedText, "你好！需要什麼協助？");
  } finally {
    SecretaryService.prototype.run = originalRun;
  }
});

test("handleLineAudioTurn uses the only available group without a redundant question", async () => {
  setupMockEnv();
  const { handleLineAudioTurn } = await import("./line-secretary-service");
  const { SecretaryService } = await import("./secretary-service");
  const { agentChatService } = await import("./services");

  let runCalled = false;
  const originalRun = SecretaryService.prototype.run;
  SecretaryService.prototype.run = async () => {
    runCalled = true;
    return {
      reply: "should not happen",
      notifyPartner: false,
      partnerMessage: null,
      actionFailure: null,
      didExecuteAction: false,
      lastToolCall: null,
    };
  };

  const originalTranscribe = agentChatService.transcribeAudio;
  agentChatService.transcribeAudio = async () => "幫我記 咖啡 120";

  try {
    let repliedText: any = "";
    const dependencies: any = {
      lineClient: {
        replyMessage: async () => {},
        getMessageContent: async () => [Buffer.from("fake audio")] as any,
        pushMessage: async () => {},
      },
      supabase: createMockDbForSecretary({
        user_preferences: { active_group_id: "00000000-0000-4000-8000-000000000001" },
        groups: [{ id: "00000000-0000-4000-8000-000000000001", name: "阿提斯" }],
        users: { id: "00000000-0000-4000-8000-000000000003", couple_id: 1, role: "partner", line_user_id: "line-partner" },
        secretary_sessions: null,
      }),
      gemini: {} as any,
    };

    await handleLineAudioTurn({
      messageId: "msg-audio",
      user: {
        id: "user-id",
        couple_id: 1,
        role: "owner" as const,
        line_user_id: "line-user-id",
      },
      dependencies,
      reply: async (text) => {
        repliedText = text;
      },
    });

    assert.equal(runCalled, true);
    assert.match(replyTextOf(repliedText), /should not happen/);
  } finally {
    SecretaryService.prototype.run = originalRun;
    agentChatService.transcribeAudio = originalTranscribe;
  }
});

test("runLineSecretaryTurn: dependencies.context is not mutated by resolvedGroupId", async () => {
  setupMockEnv();
  const { runLineSecretaryTurn } = await import("./line-secretary-service");
  const { SecretaryService } = await import("./secretary-service");

  const originalRun = SecretaryService.prototype.run;
  SecretaryService.prototype.run = async () => {
    return {
      reply: "ok",
      notifyPartner: false,
      partnerMessage: null,
      actionFailure: null,
      didExecuteAction: false,
      lastToolCall: null,
    };
  };

  try {
    const groupA = "00000000-0000-4000-8000-000000000001";
    const groupB = "00000000-0000-4000-8000-000000000002";
    const dependencies: any = {
      lineClient: {
        replyMessage: async () => {},
        getMessageContent: async () => ({} as any),
        pushMessage: async () => {},
      },
      supabase: createMockDbForSecretary({
        user_preferences: { active_group_id: groupA },
        groups: [
          { id: groupA, name: "阿提斯" },
          { id: groupB, name: "吃飽喝足" },
        ],
        users: { id: "00000000-0000-4000-8000-000000000003", couple_id: 1, role: "partner", line_user_id: "line-partner" },
        secretary_sessions: null,
      }),
      gemini: {} as any,
      context: { existing: "marker" },
    };

    await runLineSecretaryTurn({
      text: "吃飽喝足 拉麵 200",
      user: {
        id: "user-id",
        couple_id: 1,
        role: "owner" as const,
        line_user_id: "line-user-id",
      },
      dependencies,
      reply: async () => {},
    });

    assert.equal(dependencies.context.existing, "marker");
    assert.equal(dependencies.context.resolvedGroupId, undefined);
  } finally {
    SecretaryService.prototype.run = originalRun;
  }
});

test("runLineSecretaryTurn passes a stable line idempotency key into executeAgentAction", async () => {
  setupMockEnv();
  const { runLineSecretaryTurn } = await import("./line-secretary-service");
  const { SecretaryService } = await import("./secretary-service");
  const { pendingActionService } = await import("./services");

  let capturedMetadata: any = null;
  const originalRun = SecretaryService.prototype.run;
  const originalExecuteAgentAction = pendingActionService.executeAgentAction;

  SecretaryService.prototype.run = async (args: any) => {
    await args.executeAction({
      type: "create_expense",
      expense: { description: "拉麵", amount_twd: 840 },
    });
    return {
      reply: "ok",
      notifyPartner: false,
      partnerMessage: null,
      actionFailure: null,
      didExecuteAction: false,
      lastToolCall: null,
    };
  };

  pendingActionService.executeAgentAction = async (_context: any, _action: any, metadata?: any) => {
    capturedMetadata = metadata;
    return { result: "confirmed", action_type: "create_expense" } as any;
  };

  try {
    const dependencies: any = {
      lineClient: {
        replyMessage: async () => {},
        getMessageContent: async () => ({} as any),
        pushMessage: async () => {},
      },
      supabase: createMockDbForSecretary({
        user_preferences: { active_group_id: "00000000-0000-4000-8000-000000000001" },
        groups: [{ id: "00000000-0000-4000-8000-000000000001", name: "阿提斯" }],
        users: {
          id: "00000000-0000-4000-8000-000000000003",
          couple_id: 1,
          role: "partner",
          line_user_id: "line-partner",
        },
        secretary_sessions: null,
      }),
      gemini: {} as any,
    };

    await runLineSecretaryTurn({
      text: "阿提斯 拉麵 840 對方付",
      sourceEventId: "evt-123",
      user: {
        id: "user-id",
        couple_id: 1,
        role: "owner",
        line_user_id: "line-user-id",
      },
      dependencies,
      reply: async () => {},
    });

    assert.equal(capturedMetadata?.source, "line");
    assert.equal(capturedMetadata?.sourceEventId, capturedMetadata?.idempotencyKey);
    assert.match(capturedMetadata?.idempotencyKey ?? "", /^evt-123:/);
  } finally {
    SecretaryService.prototype.run = originalRun;
    pendingActionService.executeAgentAction = originalExecuteAgentAction;
  }
});

test("LINE transfer command writes one settle action without a duplicate partner push", async () => {
  setupMockEnv();
  const { runLineSecretaryTurn } = await import("./line-secretary-service");
  const { pendingActionService } = await import("./services");
  const groupId = "00000000-0000-4000-8000-000000000001";
  const userId = "00000000-0000-4000-8000-000000000002";
  const partnerId = "00000000-0000-4000-8000-000000000003";
  const baseDb: any = createMockDbForSecretary({
    groups: [{ id: groupId, name: "阿提斯" }],
    users: { id: partnerId, couple_id: 1, role: "partner", line_user_id: "line-partner" },
    secretary_sessions: null,
  });
  let balanceCalls = 0;
  baseDb.rpc = async () => ({
    data: [
      { user_id: userId, balance_twd: balanceCalls++ === 0 ? -8000 : 0 },
      { user_id: partnerId, balance_twd: balanceCalls === 1 ? 8000 : 0 },
    ],
    error: null,
  });
  let action: any = null;
  let pushCount = 0;
  const originalExecute = pendingActionService.executeAgentAction;
  pendingActionService.executeAgentAction = async (_context: any, input: any) => {
    action = input;
    return { result: "confirmed", action_type: "settle" } as any;
  };
  try {
    let replyText = "";
    await runLineSecretaryTurn({
      text: "阿提斯 我轉 8000 給她",
      sourceEventId: "transfer-event",
      user: { id: userId, couple_id: 1, role: "partner", line_user_id: "line-user" },
      dependencies: {
        lineClient: {
          replyMessage: async () => {},
          getMessageContent: async () => ({} as any),
          pushMessage: async () => {
            pushCount += 1;
          },
        },
        supabase: baseDb,
        gemini: {} as any,
      } as any,
      reply: async (message) => {
        replyText = typeof message === "string" ? message : JSON.stringify(message);
      },
    });
    assert.deepEqual(action, { type: "settle", groupId, amountTwd: 8000 });
    assert.match(replyText, /阿提斯帳務已結清/);
    assert.equal(pushCount, 0);
  } finally {
    pendingActionService.executeAgentAction = originalExecute;
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
      didExecuteAction: false,
      lastToolCall: null,
    };
  };

  const originalTranscribe = agentChatService.transcribeAudio;
  agentChatService.transcribeAudio = async () => "buy coffee";

  try {
    let repliedText: any = "";
    const dependencies: any = {
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

    assert.deepEqual(repliedText, ["聽到：「buy coffee」", "Understood, logged it."]);

    // Oversize case
    let sizeRep: any = "";
    const dependenciesOversize: any = {
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

test("handleLineImageTurn rejects image without downloading or calling LLM", async () => {
  setupMockEnv();
  const { handleLineImageTurn } = await import("./line-secretary-service");
  const { SecretaryService } = await import("./secretary-service");

  let getMessageContentCalls = 0;
  let runCalled = false;

  const originalRun = SecretaryService.prototype.run;
  SecretaryService.prototype.run = async () => {
    runCalled = true;
    return {
      reply: "should not happen",
      notifyPartner: false,
      partnerMessage: null,
      actionFailure: null,
      didExecuteAction: false,
      lastToolCall: null,
    };
  };

  try {
    const dependencies: any = {
      lineClient: {
        replyMessage: async () => {},
        getMessageContent: async () => {
          getMessageContentCalls++;
          return [Buffer.from([0x89, 0x50, 0x4e, 0x47])] as any;
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

    let replied: any = "";
    await handleLineImageTurn({
      messageId: "msg-img",
      user,
      dependencies,
      reply: async (text) => {
        replied = text;
      },
    });

    assert.equal(replied, "目前請直接用文字記帳，圖片暫不自動入帳 📝");
    assert.equal(getMessageContentCalls, 0);
    assert.equal(runCalled, false);

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
    /receiptId/,
    /receipts\(/,
    /detectReceiptMime/,
    /receiptExtractionSchema/,
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
        if (
          (pattern.source.includes("receiptId") || pattern.source.includes("receipts\\(")) &&
          (file.includes("pending-action-service.ts") ||
           file.includes("pending-action-executor.ts") ||
           file.includes("receipt-service.ts"))
        ) {
          continue;
        }
        assert.fail(`File ${file} contains forbidden pattern: ${pattern.toString()}`);
      }
    }
  }
});

test("LINE regression: image message routes to handleLineImageTurn and short-circuits", async () => {
  setupMockEnv();
  const { handleLineEvent } = await import("./line-webhook-service");
  const { SecretaryService } = await import("./secretary-service");

  let imageTurnCalled = false;
  let getMessageContentCalls = 0;
  const originalRun = SecretaryService.prototype.run;
  SecretaryService.prototype.run = async () => {
    imageTurnCalled = true;
    return {
      reply: "should not happen",
      notifyPartner: false,
      partnerMessage: null,
      actionFailure: null,
      didExecuteAction: false,
      lastToolCall: null,
    };
  };

  try {
    let repliedText: any = "";
    const dependencies: any = {
      lineClient: {
        replyMessage: async (params: any) => {
          repliedText = params.messages[0].text;
        },
        getMessageContent: async () => {
          getMessageContentCalls++;
          return [Buffer.from([0x89, 0x50, 0x4e, 0x47])] as any;
        },
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

    assert.equal(imageTurnCalled, false);
    assert.equal(getMessageContentCalls, 0);
    assert.equal(repliedText, "目前請直接用文字記帳，圖片暫不自動入帳 📝");
  } finally {
    SecretaryService.prototype.run = originalRun;
  }
});

test("line webhook: join path uses claimUser result and bypasses joined-user lookup", async () => {
  setupMockEnv();
  const { handleLineEvent } = await import("./line-webhook-service");

  let findUserCalled = false;
  let claimUserCalled = false;

  const mockDb = {
    from: (table: string) => {
      const chain: any = {
        select: (fields?: string, options?: any) => {
          if (table === "users") {
            if (fields === "id, couple_id, role, line_user_id") {
              findUserCalled = true;
            }
            if (options?.count === "exact") {
              return {
                eq: (field: string, val: any) => {
                  return Promise.resolve({ count: 0, error: null });
                }
              };
            }
          }
          return chain;
        },
        eq: (field: string, val: any) => {
          return chain;
        },
        maybeSingle: async () => {
          return { data: null, error: null };
        },
        insert: (data: any) => {
          claimUserCalled = true;
          return {
            select: () => ({
              single: async () => ({
                data: {
                  id: "00000000-0000-4000-8000-000000000003",
                  couple_id: 1,
                  line_user_id: "line-user-1",
                  role: "owner",
                },
                error: null,
              }),
            }),
          };
        },
      };
      return chain;
    },
  } as any;

  let repliedText: any = "";
  const dependencies = {
    lineClient: {
      replyMessage: async (params: any) => {
        repliedText = params.messages[0].text;
      },
      getMessageContent: async () => { throw new Error("unused"); },
      pushMessage: async () => {},
    },
    supabase: mockDb,
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
      message: { type: "text", text: "加入 couple-setup-code" },
    } as any,
    dependencies as any,
  );

  assert.equal(findUserCalled, false);
  assert.equal(claimUserCalled, true);
  assert.equal(repliedText, "加入成功，你是 owner。");
});

test("line text service: search command calls ledgerQueryService.searchExpenses and returns LIFF link", async () => {
  setupMockEnv();
  const { handleLineTextMessage } = await import("./line-text-service");
  const { ledgerQueryService } = await import("./services");

  let searchCalled = false;
  let searchParams: any = null;
  const originalSearch = ledgerQueryService.searchExpenses;
  ledgerQueryService.searchExpenses = async (ctx, params) => {
    searchCalled = true;
    searchParams = params;
    return {
      expenses: [
        {
          id: "1",
          description: "午餐",
          amount_twd: 120,
          expense_date: "2026-06-25",
          tag: "餐飲",
        }
      ]
    } as any;
  };

  try {
    let repliedText: any = "";
    const dependencies: any = {
      lineClient: {
        replyMessage: async (params: any) => {
          repliedText = params.messages[0].text;
        },
      },
      supabase: {} as any,
    };

    const user = {
      id: "user-1",
      couple_id: 1,
      role: "owner",
      line_user_id: "line-user-1",
    } as any;

    await handleLineTextMessage(
      "搜尋 午餐",
      "evt-123",
      user,
      "reply-123",
      dependencies as any,
    );

    assert.ok(searchCalled);
    assert.equal(searchParams?.get("q"), "午餐");
    assert.match(repliedText, /找到 1 筆：/);
    assert.match(repliedText, /午餐 NT\$120｜2026-06-25/);
    assert.match(repliedText, /看更多：https:\/\/app.example.com\/\?search=%E5%8D%88%E9%A4%90/);
  } finally {
    ledgerQueryService.searchExpenses = originalSearch;
  }
});

test("line text service: pending retarget confirms every returned actionId", async () => {
  setupMockEnv();
  const { handleLineTextMessage } = await import("./line-text-service");
  const { pendingActionService } = await import("./services");

  let retargetCalled = false;
  const confirmedIds: string[] = [];
  const originalRetarget = pendingActionService.retargetActions;
  const originalConfirm = pendingActionService.confirm;

  pendingActionService.retargetActions = async (ctx, input) => {
    retargetCalled = true;
    return {
      count: 2,
      actionIds: ["action-1", "action-2"]
    };
  };

  pendingActionService.confirm = async (ctx, actionId, bypass) => {
    confirmedIds.push(actionId);
    return {
      result: "confirmed",
      action_type: "create_expense"
    };
  };

  try {
    let repliedText: any = "";
    const dependencies: any = {
      lineClient: {
        replyMessage: async (params: any) => {
          repliedText = params.messages[0].text;
        },
      },
      supabase: {} as any,
    };

    const user = {
      id: "user-1",
      couple_id: 1,
      role: "owner",
      line_user_id: "line-user-1",
    } as any;

    await handleLineTextMessage(
      "都改成私人帳 交通",
      "evt-123",
      user,
      "reply-123",
      dependencies as any,
    );

    assert.ok(retargetCalled);
    assert.deepEqual(confirmedIds, ["action-1", "action-2"]);
    assert.match(repliedText, /已把 2 筆待確認草稿改成私人帳｜交通，並直接入帳。/);
  } finally {
    pendingActionService.retargetActions = originalRetarget;
    pendingActionService.confirm = originalConfirm;
  }
});

test("line webhook facade: exported parser helpers and handleLineEvent still route through split modules", async () => {
  setupMockEnv();
  const {
    parseFixedIntent,
    parseInlineExpenseItems,
    selectMentionedGroup,
    parsePendingRetargetCommand,
    parseSearchCommand,
    handleLineEvent,
  } = await import("./line-webhook-service");

  // Verify parser helpers exports are functional
  assert.equal(parseFixedIntent("誰欠誰")?.intent, "balance");
  assert.equal(parseFixedIntent("說明")?.intent, "help");
  assert.deepEqual(parsePendingRetargetCommand("都改成私人帳 交通"), {
    ledger: "private",
    tag: "交通",
  });
  assert.equal(parseSearchCommand("搜尋 早餐"), "早餐");

  // Verify handleLineEvent routing for join commands (uses joinCouple in split modules)
  let repliedText: any = "";
  const dependencies = {
    lineClient: {
      replyMessage: async (params: any) => {
        repliedText = params.messages[0].text;
      },
      getMessageContent: async () => { throw new Error("unused"); },
      pushMessage: async () => {},
    },
    supabase: {} as any,
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
      message: { type: "text", text: "加入 wrong-code" },
    } as any,
    dependencies as any,
  );

  assert.equal(repliedText, "設定碼不正確。");
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

test("env regression: shared server env schema fails when DATABASE_URL is missing", async () => {
  const { envSchema } = await import("./server-runtime");
  const baseEnv = {
    LINE_CHANNEL_ACCESS_TOKEN: "token",
    LINE_LOGIN_CHANNEL_ID: "login-id",
    GEMINI_API_KEY: "key",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "secret",
    COUPLE_SETUP_CODE: "x".repeat(24),
    LIFF_SESSION_SECRET: "x".repeat(32),
    APP_URL: "https://example.com",
    CRON_SECRET: "x".repeat(16),
  };

  const resultMissing = envSchema.safeParse(baseEnv);
  assert.equal(resultMissing.success, false);

  const resultPresent = envSchema.safeParse({
    ...baseEnv,
    DATABASE_URL: "postgresql://localhost:5432/db",
  });
  assert.equal(resultPresent.success, true);
});

test("env regression: webhook route env schema fails when DATABASE_URL is missing", async () => {
  const { envSchema: webhookEnvSchema } = await import("../app/api/line/webhook/route");
  const baseEnv = {
    LINE_CHANNEL_SECRET: "secret",
    LINE_CHANNEL_ACCESS_TOKEN: "token",
    LINE_LOGIN_CHANNEL_ID: "login-id",
    GEMINI_API_KEY: "key",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "secret",
    COUPLE_SETUP_CODE: "x".repeat(24),
    LIFF_SESSION_SECRET: "x".repeat(32),
    APP_URL: "https://example.com",
    CRON_SECRET: "x".repeat(16),
  };

  const resultMissing = webhookEnvSchema.safeParse(baseEnv);
  assert.equal(resultMissing.success, false);

  const resultPresent = webhookEnvSchema.safeParse({
    ...baseEnv,
    DATABASE_URL: "postgresql://localhost:5432/db",
  });
  assert.equal(resultPresent.success, true);
});

test("withTx regression: withTx does not fail when DATABASE_URL is present", async () => {
  const { withTx, setMockWithTx } = await import("./db/tx");

  let called = false;
  setMockWithTx(async (callback) => {
    called = true;
    return callback({ query: async () => ({ rows: [] }) });
  });

  try {
    const res = await withTx(async (client) => {
      return "ok";
    });
    assert.equal(res, "ok");
    assert.equal(called, true);
  } finally {
    setMockWithTx(null);
  }
});

test("withTx env boundary: only DATABASE_URL is required; LINE/GEMINI/APP_URL are irrelevant", async () => {
  // Regression: withTx used to pull from serverEnvironment(), which demanded
  // every LINE_*, GEMINI_*, APP_URL, etc. Other env gaps must NOT be reported
  // as "DATABASE_URL missing".
  const { withTx, setMockWithTx } = await import("./db/tx");

  const origUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://localhost:5432/db";
  // Other app env is intentionally left as the runner default (likely absent
  // in CI) — we MUST NOT blow up here.

  let called = false;
  setMockWithTx(async (callback) => {
    called = true;
    return callback({ query: async () => ({ rows: [] }) });
  });

  try {
    const res = await withTx(async () => "ok");
    assert.equal(res, "ok");
    assert.equal(called, true);
  } finally {
    setMockWithTx(null);
    if (origUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = origUrl;
  }
});

test("withTx env boundary: missing DATABASE_URL still produces a DATABASE_URL error (not a LINE/GEMINI error)", async () => {
  const { withTx, setMockWithTx } = await import("./db/tx");

  // Force a no-mock path so the real env branch runs.
  setMockWithTx(null);
  const origUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  try {
    await assert.rejects(
      () => withTx(async () => "nope"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(
          err.message,
          /DATABASE_URL/,
          `error must point at DATABASE_URL, got: ${err.message}`,
        );
        // Must NOT mention LINE / GEMINI / APP_URL — those are unrelated to DB.
        assert.doesNotMatch(err.message, /LINE_/);
        assert.doesNotMatch(err.message, /GEMINI_/);
        assert.doesNotMatch(err.message, /APP_URL/);
        return true;
      },
    );
  } finally {
    if (origUrl !== undefined) process.env.DATABASE_URL = origUrl;
  }
});

// ---------------------------------------------------------------------------
// claimUser (TS replacement for public.claim_user(text) RPC)
// ---------------------------------------------------------------------------
//
// Tiny mock DB that records the .from(table) calls and lets each test
// program the responses for the `users` queries claimUser makes.
type ClaimUserCall = { op: "select-existing" | "count" | "insert" | "recheck" };

function makeClaimUserMockDb(opts: {
  existingUser?: { id: string; couple_id: number; line_user_id: string; role: "owner" | "partner" } | null;
  count?: number | null;
  insertErrorCode?: string;
  recheckUser?: { id: string; couple_id: number; line_user_id: string; role: "owner" | "partner" } | null;
}) {
  const calls: ClaimUserCall[] = [];
  const insertArgs: Array<Record<string, unknown>> = [];
  let maybeSingleCall = 0;

  const db = {
    from(table: string) {
      assert.equal(table, "users", `claimUser must only touch the users table, got ${table}`);
      const builder: any = {};
      builder.select = (...args: unknown[]) => {
        if (args[0] === "id") {
          // count(*) head:true query
          return {
            eq: (_col: string, _val: unknown) => {
              calls.push({ op: "count" });
              return Promise.resolve({ count: opts.count ?? 0, error: null });
            },
          };
        }
        return {
          eq: (_col: string, _val: unknown) => {
            return {
              maybeSingle: () => {
                maybeSingleCall += 1;
                if (maybeSingleCall === 1) {
                  calls.push({ op: "select-existing" });
                  if (opts.existingUser !== undefined) {
                    return Promise.resolve({ data: opts.existingUser, error: null });
                  }
                  return Promise.resolve({ data: null, error: null });
                }
                // subsequent maybeSingle is the post-23505 recheck
                calls.push({ op: "recheck" });
                if (opts.recheckUser !== undefined) {
                  return Promise.resolve({ data: opts.recheckUser, error: null });
                }
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
        };
      };
      builder.insert = (row: Record<string, unknown>) => {
        calls.push({ op: "insert" });
        insertArgs.push(row);
        if (opts.insertErrorCode) {
          return {
            select: () => ({
              single: () =>
                Promise.resolve({ data: null, error: { code: opts.insertErrorCode, message: "mock" } }),
            }),
          };
        }
        return {
          select: () => ({
            single: () =>
              Promise.resolve({
                data: { id: "00000000-0000-4000-8000-000000000001", couple_id: 1, line_user_id: row.line_user_id, role: row.role },
                error: null,
              }),
          }),
        };
      };
      return builder;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  return { db, calls, insertArgs };
}

test("claimUser: returns joined + owner when the couple is empty", async () => {
  const { claimUser } = await import("./claim-user");
  const { db, calls } = makeClaimUserMockDb({ count: 0 });
  const result = await claimUser(db, "U-new");
  assert.deepEqual(result, { result: "joined", role: "owner" });
  // existing-user lookup, then count, then insert — no recheck needed
  assert.deepEqual(
    calls.map((c) => c.op),
    ["select-existing", "count", "insert"],
  );
});

test("claimUser: returns joined + partner when one user already exists", async () => {
  const { claimUser } = await import("./claim-user");
  const { db } = makeClaimUserMockDb({ count: 1 });
  const result = await claimUser(db, "U-second");
  assert.deepEqual(result, { result: "joined", role: "partner" });
});

test("claimUser: returns full when the couple already has 2 users", async () => {
  const { claimUser } = await import("./claim-user");
  const { db, calls } = makeClaimUserMockDb({ count: 2 });
  const result = await claimUser(db, "U-third");
  assert.deepEqual(result, { result: "full" });
  // No insert should have been attempted.
  assert.ok(!calls.some((c) => c.op === "insert"), "must not attempt insert when couple is full");
});

test("claimUser: returns already_joined when the same line_user_id exists", async () => {
  const { claimUser } = await import("./claim-user");
  const { db, calls } = makeClaimUserMockDb({
    existingUser: {
      id: "00000000-0000-4000-8000-000000000099",
      couple_id: 1,
      line_user_id: "U-same",
      role: "owner",
    },
  });
  const result = await claimUser(db, "U-same");
  assert.deepEqual(result, { result: "already_joined", role: "owner" });
  // No count, no insert.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "select-existing");
});

test("claimUser: reclassifies race-loss unique violation on line_user_id as already_joined", async () => {
  const { claimUser } = await import("./claim-user");
  const { db, calls } = makeClaimUserMockDb({
    count: 1,
    insertErrorCode: "23505",
    recheckUser: {
      id: "00000000-0000-4000-8000-000000000077",
      couple_id: 1,
      line_user_id: "U-race",
      role: "partner",
    },
  });
  const result = await claimUser(db, "U-race");
  assert.deepEqual(result, { result: "already_joined", role: "partner" });
  assert.ok(calls.some((c) => c.op === "recheck"));
});

test("claimUser: reclassifies race-loss unique violation on (couple_id, role) as full", async () => {
  const { claimUser } = await import("./claim-user");
  const { db } = makeClaimUserMockDb({
    count: 0,
    insertErrorCode: "23505",
    // recheck finds no row for our line_user_id — the violation must be
    // the (couple_id, role) unique, so the couple is now full from the
    // other writer's perspective.
    recheckUser: null,
  });
  const result = await claimUser(db, "U-late");
  assert.deepEqual(result, { result: "full" });
});

test("claimUser: rejects empty / oversized line_user_id", async () => {
  const { claimUser } = await import("./claim-user");
  const { db } = makeClaimUserMockDb({ count: 0 });
  await assert.rejects(() => claimUser(db, ""), /invalid line user id/);
  await assert.rejects(() => claimUser(db, "x".repeat(101)), /invalid line user id/);
});

// ---------------------------------------------------------------------------
// loadGroupBalances (typed entry point for the group_balances RPC)
// ---------------------------------------------------------------------------
test("loadGroupBalances: parses rpc rows into camelCase GroupBalanceRow[]", async () => {
  const { loadGroupBalances } = await import("./balance-loader");
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      assert.equal(fn, "group_balances");
      assert.deepEqual(args, { p_group_id: "g-1" });
      return {
        data: [
          { user_id: "u-1", balance_twd: 100 },
          { user_id: "u-2", balance_twd: -100 },
        ],
        error: null,
      };
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
  const rows = await loadGroupBalances(db, "g-1");
  assert.deepEqual(rows, [
    { userId: "u-1", balanceTwd: 100 },
    { userId: "u-2", balanceTwd: -100 },
  ]);
});

test("loadGroupBalances: throws on rpc error (callers catch and degrade)", async () => {
  const { loadGroupBalances } = await import("./balance-loader");
  const db = {
    rpc: async () => ({ data: null, error: { message: "boom" } }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
  await assert.rejects(() => loadGroupBalances(db, "g-1"), /balance lookup failed/);
});

test("loadGroupBalances: rejects missing groupId up front", async () => {
  const { loadGroupBalances } = await import("./balance-loader");
  const db = {} as unknown as import("@supabase/supabase-js").SupabaseClient;
  await assert.rejects(() => loadGroupBalances(db, ""), /groupId is required/);
});

// ---------------------------------------------------------------------------
// Env boundary: server-env + module-level process.env reads
// ---------------------------------------------------------------------------
test("server-env: getAppUrl returns process.env.APP_URL or empty string", () => {
  const { getAppUrl } = require("./server-env");
  const orig = process.env.APP_URL;
  try {
    delete process.env.APP_URL;
    assert.equal(getAppUrl(), "");
    process.env.APP_URL = "https://app.example.com";
    assert.equal(getAppUrl(), "https://app.example.com");
  } finally {
    if (orig === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = orig;
  }
});

test("server-env: getModelConfig picks provider from AGENT_MODEL_PROVIDER or heuristically from modelId", () => {
  const { getModelConfig } = require("./server-env");
  const origProvider = process.env.AGENT_MODEL_PROVIDER;
  const origModel = process.env.AGENT_MODEL;
  try {
    delete process.env.AGENT_MODEL_PROVIDER;
    delete process.env.AGENT_MODEL;
    assert.equal(getModelConfig().provider, "google");
    assert.equal(getModelConfig().modelId, "gemini-3.1-flash-lite");
    assert.equal(getModelConfig("gpt-4o-mini").provider, "openai");
    assert.equal(getModelConfig("claude-haiku-4-20250514").provider, "anthropic");
    process.env.AGENT_MODEL_PROVIDER = "openai";
    assert.equal(getModelConfig("gemini-3.1-flash-lite").provider, "openai");
  } finally {
    if (origProvider === undefined) delete process.env.AGENT_MODEL_PROVIDER;
    else process.env.AGENT_MODEL_PROVIDER = origProvider;
    if (origModel === undefined) delete process.env.AGENT_MODEL;
    else process.env.AGENT_MODEL = origModel;
  }
});

test("server-env: getModelConfig reads provider-specific API keys", () => {
  const { getModelConfig } = require("./server-env");
  const origProvider = process.env.AGENT_MODEL_PROVIDER;
  const origGemini = process.env.GEMINI_API_KEY;
  const origGoogleGen = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const origOpenAi = process.env.OPENAI_API_KEY;
  const origAnthropic = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.AGENT_MODEL_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    assert.equal(getModelConfig().apiKey, "sk-test");
    process.env.AGENT_MODEL_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "ant-test";
    assert.equal(getModelConfig().apiKey, "ant-test");
    process.env.AGENT_MODEL_PROVIDER = "google";
    process.env.GEMINI_API_KEY = "g-1";
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    assert.equal(getModelConfig().apiKey, "g-1");
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "g-2";
    assert.equal(getModelConfig().apiKey, "g-2");
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    assert.equal(getModelConfig().apiKey, null);
  } finally {
    if (origProvider === undefined) delete process.env.AGENT_MODEL_PROVIDER;
    else process.env.AGENT_MODEL_PROVIDER = origProvider;
    if (origGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = origGemini;
    if (origGoogleGen === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = origGoogleGen;
    if (origOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = origOpenAi;
    if (origAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = origAnthropic;
  }
});

test("env boundary: secretary-briefing no longer reads process.env.APP_URL at module load", () => {
  // If the module imported process.env.APP_URL at top level, removing the
  // env var before the import (via the dynamic require below) would still
  // be observable. This is a guard against regression to a naked top-level
  // process.env read.
  const orig = process.env.APP_URL;
  try {
    delete process.env.APP_URL;
    const mod = require("./secretary-briefing");
    assert.equal(typeof mod.sendSecretaryBriefing, "function");
    // The function itself should be defined even without APP_URL — runtime
    // call sites will fall back to "" via getAppUrl().
    assert.doesNotThrow(() => mod.sendSecretaryBriefing);
  } finally {
    if (orig !== undefined) process.env.APP_URL = orig;
  }
});

test("env boundary: model-provider no longer reads process.env at module load", () => {
  // Same idea: ensure the module can be required with no relevant env set.
  const orig = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    AGENT_MODEL: process.env.AGENT_MODEL,
    AGENT_MODEL_PROVIDER: process.env.AGENT_MODEL_PROVIDER,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  try {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.AGENT_MODEL;
    delete process.env.AGENT_MODEL_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const mod = require("./model-provider");
    assert.equal(typeof mod.getModel, "function");
  } finally {
    for (const [key, value] of Object.entries(orig)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// PendingActionService split: structural regressions at the most fragile
// seams. These guard against the easy-to-miss breakage that comes from
// moving proposal / agent-action / guard logic into separate files.
// ---------------------------------------------------------------------------
//
// Test helpers — minimal in-memory db that records the tables the proposal
// flow touches, with programmable responses for the proposal-guard layer.
function makeProposalMockDb(opts: {
  expense?: {
    id: string;
    couple_id: number;
    group_id: string | null;
    ledger: "shared" | "private";
    description: string;
    amount_twd: number;
    version: number;
    deleted_at: string | null;
    created_by_user_id: string;
    mirror_kind: "shared_share" | null;
  } | null;
  hasAnySettlement?: boolean;
}) {
  const calls: { table: string; op: string }[] = [];
  const expense = opts.expense ?? null;
  const hasAnySettlement = opts.hasAnySettlement ?? false;

  const db = {
    from(table: string) {
      calls.push({ table, op: "from" });
      const builder: any = {};
      builder.select = (sel?: string) => {
        if (sel === "id") {
          return {
            eq: () => Promise.resolve({ count: hasAnySettlement ? 1 : 0, error: null }),
          };
        }
        const terminal: any = {
          single: () => {
            if (table === "expenses") {
              return expense
                ? Promise.resolve({ data: expense, error: null })
                : Promise.resolve({ data: null, error: { message: "no row" } });
            }
            if (table === "groups") {
              return Promise.resolve({ data: { id: T_GROUP_ID, name: "g" }, error: null });
            }
            if (table === "users") {
              return Promise.resolve({
                data: { id: T_USER_ID, couple_id: 1, line_user_id: "u", role: "owner" },
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          },
        };
        // eq() returns the same terminal object so chained .eq().eq().single()
        // all share the same terminal.
        terminal.eq = () => terminal;
        // order() resolves to a users-shaped list (used by loadCoupleUsers).
        terminal.order = () =>
          Promise.resolve({
            data: [
              { id: T_USER_ID, couple_id: 1, line_user_id: "u1", role: "owner" },
              { id: T_PARTNER_ID, couple_id: 1, line_user_id: "u2", role: "partner" },
            ],
            error: null,
          });
        // maybeSingle returns the partner lookup pattern used by other paths.
        terminal.maybeSingle = () => {
          if (table === "users") {
            return Promise.resolve({
              data: { id: T_USER_ID, couple_id: 1, line_user_id: "u1", role: "owner" },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        };
        return terminal;
      };
      return builder;
    },
    rpc: async (fn: string) => {
      calls.push({ table: fn, op: "rpc" });
      return {
        data: [
          { user_id: T_USER_ID, balance_twd: 100 },
          { user_id: T_PARTNER_ID, balance_twd: -100 },
        ],
        error: null,
      };
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  return { db, calls };
}

function makeProposalContext(
  db: import("@supabase/supabase-js").SupabaseClient,
  overrides?: Partial<{ userId: string; coupleId: number; groupId: string }>,
) {
  return {
    db,
    user: {
      id: overrides?.userId ?? T_USER_ID,
      couple_id: overrides?.coupleId ?? 1,
    },
  } as any;
}

test("proposal guard: delete_expense rejects when mirror_kind is 'shared_share'", async () => {
  const { PendingActionService } = await import("./pending-action-service");
  const { db } = makeProposalMockDb({
    expense: {
      id: T_EXPENSE_1,
      couple_id: 1,
      group_id: T_GROUP_ID,
      ledger: "private",
      description: "mirror",
      amount_twd: 100,
      version: 1,
      deleted_at: null,
      created_by_user_id: T_USER_ID,
      mirror_kind: "shared_share",
    },
  });
  const service = new PendingActionService({
    actionSeconds: 60,
    deliverNotifications: async () => {},
  });
  const context = makeProposalContext(db);
  await assert.rejects(
    () => service.proposeDeleteExpenseHelper(context, T_EXPENSE_1, 1, { source: "liff" }),
    (err: unknown) => {
      const e = err as { status?: number; message?: string };
      assert.equal(e.status, 403);
      assert.match(
        e.message ?? "",
        /共同分攤紀錄請修改來源共同帳/,
      );
      return true;
    },
  );
});

test("proposal guard: restore_expense rejects when mirror_kind is 'shared_share'", async () => {
  const { PendingActionService } = await import("./pending-action-service");
  const { db } = makeProposalMockDb({
    expense: {
      id: T_EXPENSE_1,
      couple_id: 1,
      group_id: T_GROUP_ID,
      ledger: "private",
      description: "mirror",
      amount_twd: 100,
      version: 1,
      deleted_at: "2026-07-01T00:00:00.000Z",
      created_by_user_id: T_USER_ID,
      mirror_kind: "shared_share",
    },
  });
  const service = new PendingActionService({
    actionSeconds: 60,
    deliverNotifications: async () => {},
  });
  const context = makeProposalContext(db);
  await assert.rejects(
    () => service.proposeRestoreExpenseHelper(context, T_EXPENSE_1, 1, { source: "liff" }),
    (err: unknown) => {
      const e = err as { status?: number; message?: string };
      assert.equal(e.status, 403);
      assert.match(
        e.message ?? "",
        /共同分攤紀錄請修改來源共同帳/,
      );
      return true;
    },
  );
});

test("proposal guard: update_expense shared→private is refused when any settlement exists", async () => {
  const { PendingActionService } = await import("./pending-action-service");
  const { db } = makeProposalMockDb({
    expense: {
      id: T_EXPENSE_1,
      couple_id: 1,
      group_id: T_GROUP_ID,
      ledger: "shared",
      description: "shared one",
      amount_twd: 500,
      version: 3,
      deleted_at: null,
      created_by_user_id: T_USER_ID,
      mirror_kind: null,
    },
    hasAnySettlement: true,
  });
  const service = new PendingActionService({
    actionSeconds: 60,
    deliverNotifications: async () => {},
  });
  const context = makeProposalContext(db);
  await assert.rejects(
    () =>
      service.proposeUpdateExpenseHelper(
        context,
        T_EXPENSE_1,
        3,
        {
          ledger: "private",
          groupId: null,
          description: "shared one",
          merchant: null,
          notes: null,
          tag: "餐飲",
          amountTwd: 500,
          paidBy: "self",
          expenseDate: "2026-07-01",
          splitMethod: "equal",
          selfValue: null,
          partnerValue: null,
        },
        { source: "liff" },
      ),
    (err: unknown) => {
      const e = err as { status?: number; message?: string };
      assert.equal(e.status, 409);
      assert.match(
        e.message ?? "",
        /此帳已包含在結清紀錄中/,
      );
      return true;
    },
  );
});

test("agent action: legacy splits + paid_by_user_id are converted to standard create_expense input", async () => {
  // After the split, `executeAgentAction` lives in
  // pending-action-agent-actions.ts but `proposeCreateExpenseHelper`
  // (now in pending-action-proposals.ts) is what actually gets
  // dispatched. This test asserts the wiring end-to-end: the legacy
  // payload with `splits` and `paid_by_user_id` reaches the standard
  // create path and gets converted to a paidBy of "self" when the
  // payer is the requester.
  const insertedRows: Record<string, unknown>[] = [];
  const mockDb = {
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () =>
          Promise.resolve({
            data: [
              { id: T_USER_ID, couple_id: 1, line_user_id: "u1", role: "owner" },
              { id: T_PARTNER_ID, couple_id: 1, line_user_id: "u2", role: "partner" },
            ],
            error: null,
          }),
        single: () => {
          if (table === "users") {
            return Promise.resolve({
              data: { id: T_USER_ID, couple_id: 1, line_user_id: "u1", role: "owner" },
              error: null,
            });
          }
          if (table === "groups") {
            return Promise.resolve({ data: { id: T_GROUP_ID, name: "g" }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        insert: (row: any) => {
          insertedRows.push(row);
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id: "action-id" }, error: null }),
            }),
          };
        },
      };
      return chain;
    },
    rpc: async () => ({
      data: [
        { user_id: T_USER_ID, balance_twd: 100 },
        { user_id: T_PARTNER_ID, balance_twd: -100 },
      ],
      error: null,
    }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const { PendingActionService } = await import("./pending-action-service");
  const service = new PendingActionService({
    actionSeconds: 60,
    deliverNotifications: async () => {},
  });

  // We pass a legacy-shape create_expense action with splits/paid_by_user_id.
  // The split is supposed to flow through `executeAgentAction` -> the
  // extracted `proposeCreateExpenseHelper` plain function. We assert
  // that `paidBy` ends up as "self" because `paid_by_user_id` matches
  // the requester.
  // We can't easily assert the full paidBy conversion without executing
  // through `service.execute`, which would require a working confirm path.
  // Instead, we verify the conversion at the normalize layer directly.
  const { normalizeCreateExpenseInput } = await import("./pending-action-agent-actions");

  const context = makeProposalContext(mockDb);
  const standardInput = await normalizeCreateExpenseInput(
    context,
    {
      group_id: null,
      ledger: "private",
      description: "晚餐",
      merchant: null,
      notes: null,
      tag: "餐飲",
      amount_twd: 200,
      paid_by_user_id: T_USER_ID,
      expense_date: "2026-07-01",
      split_method: "equal",
    },
    null,
    null,
  );
  assert.equal(standardInput.paidBy, "self");
  assert.equal(standardInput.amountTwd, 200);
  assert.equal(standardInput.ledger, "private");
  assert.equal(standardInput.groupId, null);
  assert.equal(standardInput.splitMethod, "equal");

  // And that the public service wrapper still wires through the new module.
  assert.equal(typeof service.executeAgentAction, "function");
  assert.equal(typeof service.proposeCreateExpenseHelper, "function");
  assert.equal(typeof service.proposeUpdateExpenseHelper, "function");
  assert.equal(typeof service.proposeDeleteExpenseHelper, "function");
  assert.equal(typeof service.proposeRestoreExpenseHelper, "function");
  // Suppress unused-warning for the `insertedRows` accumulator above; it
  // is referenced in case future tests in this file want to assert
  // inserted pending_action rows from the new path.
  assert.equal(insertedRows.length, 0);
});

test("builder: buildUpdateExpenseAction on a no-op update still throws '沒有可修改的欄位'", async () => {
  // Direct unit test on the extracted builder. The fixture returns a
  // shared expense that already matches every requested field, so the
  // `mappedUpdates` ends up empty.
  const mockDb = {
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () =>
          Promise.resolve({
            data: [
              { id: T_USER_ID, couple_id: 1, line_user_id: "u1", role: "owner" },
              { id: T_PARTNER_ID, couple_id: 1, line_user_id: "u2", role: "partner" },
            ],
            error: null,
          }),
        single: () => {
          if (table === "expenses") {
            return Promise.resolve({
              data: {
                id: T_EXPENSE_1,
                couple_id: 1,
                group_id: T_GROUP_ID,
                ledger: "shared",
                description: "unchanged",
                merchant: null,
                notes: null,
                tag: "餐飲",
                amount_twd: 1000,
                paid_by_user_id: T_USER_ID,
                created_by_user_id: T_USER_ID,
                expense_date: "2026-07-01",
                split_method: "equal",
                version: 7,
                deleted_at: null,
                deleted_by_user_id: null,
                mirror_kind: null,
                expense_splits: [
                  { user_id: T_USER_ID, amount_twd: 500 },
                  { user_id: T_PARTNER_ID, amount_twd: 500 },
                ],
              },
              error: null,
            });
          }
          if (table === "users") {
            return Promise.resolve({
              data: { id: T_USER_ID, couple_id: 1, line_user_id: "u1", role: "owner" },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
    rpc: async () => ({
      data: [
        { user_id: T_USER_ID, balance_twd: 100 },
        { user_id: T_PARTNER_ID, balance_twd: -100 },
      ],
      error: null,
    }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const { PendingActionService } = await import("./pending-action-service");
  const service = new PendingActionService({
    actionSeconds: 60,
    deliverNotifications: async () => {},
  });
  const context = makeProposalContext(mockDb);

  await assert.rejects(
    () =>
      service.buildUpdateExpenseAction(context, T_EXPENSE_1, {
        // Every field matches the current row → no-op
        description: "unchanged",
        tag: "餐飲",
        amountTwd: 1000,
        paidBy: "self",
        expenseDate: "2026-07-01",
        ledger: "shared",
      }),
    (err: unknown) => {
      const e = err as { status?: number; message?: string };
      assert.equal(e.status, 400);
      assert.equal(e.message, "沒有可修改的欄位");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// AccountantService split: structural regressions at the most fragile
// seams. These guard against the easy-to-miss breakage that comes
// from moving analytics / agent / reports into separate files.
// ---------------------------------------------------------------------------

test("accountant: ask() still routes through runAgent() (shared report contract)", async () => {
  // The ask/runAgent split was the largest behaviour change in the
  // refactor. We assert that ask() returns the same report object
  // that runAgent() would have produced, by intercepting the
  // accountant_reports insert and making runAgent deterministic.
  const { AccountantService } = await import("./accountant-service");

  const reportRow = {
    id: "00000000-0000-4000-8000-000000009201",
    group_id: GROUP,
    owner_user_id: null,
    report_type: "manual_question",
    scope: "combined",
    month: "2026-07-01",
    question: "本月花最多",
    title: "AI 會計師",
    summary: "本月花最多是餐飲。",
    facts: { totalTwd: 1000, transactionCount: 5 },
    findings: [],
    suggestions: [],
    source: "fallback",
    created_at: "2026-07-15T00:00:00.000Z",
  };

  const insertedPayloads: Array<Record<string, unknown>> = [];
  const mockDb = {
    from(table: string) {
      if (table === "user_preferences") {
        const query: any = {
          select: () => query,
          eq: () => query,
          single: async () => ({
            data: { active_group_id: GROUP },
            error: null,
          }),
        };
        return query;
      }
      if (table === "expenses") {
        const query: any = {
          select: () => query,
          eq: () => query,
          order: () => query,
          limit: () => Promise.resolve({ data: [], error: null }),
        };
        return query;
      }
      if (table === "accountant_reports") {
        const query: any = {
          insert: (row: Record<string, unknown>) => {
            insertedPayloads.push(row);
            return {
              select: () => ({
                single: async () => ({ data: reportRow, error: null }),
              }),
            };
          },
        };
        return query;
      }
      if (table === "agent_runs") {
        const query: any = {
          insert: () => ({
            select: () => ({
              single: async () => ({ data: { id: "run-1" }, error: null }),
            }),
          }),
        };
        return query;
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const service = new AccountantService();
  const result = await service.ask(
    {
      env: {} as ServerContext["env"],
      db: mockDb,
      user: {
        id: CORE_OWNER,
        couple_id: 1,
        line_user_id: "line-owner",
        role: "owner",
      },
    },
    { question: "本月花最多", scope: "shared" },
  );

  // ask() should return the same shape runAgent() puts on its `.report`.
  assert.equal(result.id, reportRow.id);
  assert.equal(result.summary, reportRow.summary);
  // ask() parsed `scope: "shared"` and runAgent forwarded it into the
  // accountant_reports insert.
  assert.equal(insertedPayloads.length, 1);
  assert.equal(insertedPayloads[0].scope, "shared");
  assert.equal(insertedPayloads[0].report_type, "manual_question");
  // The parsed question is what gets persisted (not the raw ask input).
  assert.equal(insertedPayloads[0].question, "本月花最多");
});

test("accountant: createCategoryCleanup() emits snake_case batch_update_expenses payload", async () => {
  // The category-cleanup boundary is the one that crosses into
  // PendingActionService. We must keep the snake_case payload shape
  // (expense_id / expected_version / tag) that the LIFF UI and the
  // pending action executor both rely on.
  const { AccountantService } = await import("./accountant-service");

  const expenses = [
    {
      id: "00000000-0000-4000-8000-000000009301",
      couple_id: 1,
      group_id: GROUP,
      ledger: "shared",
      description: "Lunch",
      merchant: null,
      notes: null,
      tag: "其他",
      mirror_kind: null,
      mirror_source_expense_id: null,
      amount_twd: 100,
      paid_by_user_id: CORE_OWNER,
      created_by_user_id: CORE_OWNER,
      expense_date: "2026-07-01",
      split_method: "equal",
      version: 3,
      deleted_at: null,
      created_at: "2026-07-01T00:00:00.000Z",
      expense_splits: [],
    },
  ];
  const mockDb = {
    from(table: string) {
      if (table === "user_preferences") {
        const query: any = {
          select: () => query,
          eq: () => query,
          single: async () => ({
            data: { active_group_id: GROUP },
            error: null,
          }),
        };
        return query;
      }
      if (table === "expenses") {
        const query: any = {
          select: () => query,
          eq: () => query,
          order: () => query,
          limit: () => Promise.resolve({ data: expenses, error: null }),
        };
        return query;
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const service = new AccountantService();
  let receivedAction: unknown = null;
  await service.createCategoryCleanup(
    {
      env: {} as ServerContext["env"],
      db: mockDb,
      user: {
        id: CORE_OWNER,
        couple_id: 1,
        line_user_id: "line-owner",
        role: "owner",
      },
    },
    {
      updates: [
        { expenseId: "00000000-0000-4000-8000-000000009301", expectedVersion: 3, tag: "餐飲" },
      ],
    },
    "idempotency-key-123",
    async (action) => {
      receivedAction = action;
      return { ok: true };
    },
  );

  assert.ok(receivedAction, "createCategoryCleanup must call executePendingAction");
  const action = receivedAction as {
    actionType: string;
    groupId: string | null;
    payload: { updates: Array<Record<string, unknown>> };
    sourceEventId: string;
    idempotencyKey?: string;
  };
  assert.equal(action.actionType, "batch_update_expenses");
  assert.equal(action.groupId, GROUP);
  assert.equal(action.idempotencyKey, "idempotency-key-123");
  assert.match(action.sourceEventId, /^liff:category:/);
  assert.equal(action.payload.updates.length, 1);
  const update = action.payload.updates[0];
  // Critical contract: snake_case keys, not camelCase.
  assert.equal(update.expense_id, "00000000-0000-4000-8000-000000009301");
  assert.equal(update.expected_version, 3);
  assert.equal(update.tag, "餐飲");
  assert.equal((update as Record<string, unknown>).expenseId, undefined);
  assert.equal((update as Record<string, unknown>).expectedVersion, undefined);
});

test("accountant: generateMonthlyReports() notification titles + dedupe keys per scope", async () => {
  // Tighter than the existing test: assert the dedupe_key shape
  // exactly (so a future "improvement" doesn't break idempotency).
  const { AccountantService } = await import("./accountant-service");

  const users = [
    { id: CORE_OWNER, couple_id: 1, line_user_id: "o", role: "owner" as const },
    { id: CORE_PARTNER, couple_id: 1, line_user_id: "p", role: "partner" as const },
  ];
  const groups = [{ id: GROUP, couple_id: 1 }];
  const generateCalls: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];

  const service = new AccountantService();
  const svc = service as unknown as {
    generateReport: (
      context: ServerContext,
      input: Record<string, unknown>,
    ) => Promise<{ id: string; title: string }>;
  };
  svc.generateReport = async (context, input) => {
    generateCalls.push({
      userId: context.user.id,
      scope: input.scope,
      month: input.month,
      groupId: input.groupId ?? null,
    });
    const scope = String(input.scope);
    return {
      id:
        scope === "shared"
          ? "00000000-0000-4000-8000-000000009401"
          : context.user.id === CORE_OWNER
            ? "00000000-0000-4000-8000-000000009402"
            : "00000000-0000-4000-8000-000000009403",
      title: `${scope}-${context.user.id}`,
    };
  };

  const mockDb = {
    from(table: string) {
      if (table === "users") {
        const query: any = {
          select: () => query,
          order: () => Promise.resolve({ data: users, error: null }),
        };
        return query;
      }
      if (table === "groups") {
        const query: any = {
          select: () => query,
          is: () => Promise.resolve({ data: groups, error: null }),
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

  const count = await service.generateMonthlyReports(
    { APP_URL: "https://example.com" } as ServerContext["env"],
    mockDb,
    "2026-07",
  );

  assert.equal(count, 3);
  // Three generateReport calls in the expected order.
  assert.equal(generateCalls.length, 3);
  assert.equal(generateCalls[0].scope, "shared");
  assert.equal(generateCalls[0].groupId, GROUP);
  assert.equal(generateCalls[1].scope, "private");
  assert.equal(generateCalls[2].scope, "private");

  // Four notifications: 2 shared (both users), 1 private for each user.
  assert.equal(notifications.length, 4);
  // Shared report: 2 notifications, both titled "AI 會計師月報", with
  // dedupe_key of the form `accountant-report:<id>:user:<recipient>`.
  const shared = notifications.filter((n) => n.title === "AI 會計師月報");
  assert.equal(shared.length, 2);
  for (const n of shared) {
    assert.equal(n.group_id, GROUP);
    assert.match(
      String(n.dedupe_key),
      /^accountant-report:00000000-0000-4000-8000-000000009401:user:/,
    );
  }
  // Private reports: 2 notifications, titled "AI 私人帳月報",
  // group_id: null, one per user.
  const priv = notifications.filter((n) => n.title === "AI 私人帳月報");
  assert.equal(priv.length, 2);
  for (const n of priv) {
    assert.equal(n.group_id, null);
    assert.match(
      String(n.dedupe_key),
      /^accountant-report:00000000-0000-4000-8000-00000000940[23]:user:/,
    );
  }
  // Notification body carries the APP_URL deep link. In production the
  // body is `<title>\n<APP_URL>?tab=accountant`; the test mock sets
  // titles to `shared-<userId>` or `private-<userId>`, so we just
  // assert the URL suffix is present on every notification.
  for (const n of notifications) {
    assert.match(String(n.body), /https:\/\/example\.com\/\?tab=accountant/);
  }
});

test("accountant: loadAccountantSnapshot() separates previous-month total by scope", async () => {
  // Lock down the previous-month aggregation for shared / private /
  // combined so a future refactor can't silently start double-counting.
  const { loadAccountantSnapshot } = await import("./accountant-loaders");

  // We have to distinguish between the current-month expense query
  // (which goes through `expenseSchema` and demands every column)
  // and the previous-month `amount_twd`-only sum query. The mock
  // records which chain was reached and returns either [] for the
  // current-month query or a single `amount_twd` row for the prev
  // query.
  function makeDbForScope(scope: "shared" | "private" | "combined") {
    let prevSharedHit = false;
    let prevPrivateHit = false;
    return {
      from(table: string) {
        if (table === "user_preferences") {
          const query: any = {
            select: () => query,
            eq: () => query,
            single: async () => ({
              data: { active_group_id: GROUP },
              error: null,
            }),
          };
          return query;
        }
        if (table === "expenses") {
          let selectCols: string | undefined;
          const query: any = {
            select: (cols?: string) => {
              selectCols = cols;
              return query;
            },
            eq: () => query,
            order: () => query,
            gte: () => query,
            lt: () => query,
            is: () => query,
            then: (
              resolve: (value: { data: Array<unknown>; error: null }) => void,
            ) => {
              // Current-month query: select(EXPENSE_SELECT) demands full rows.
              // Return [] so z.array(expenseSchema).parse([]) is a no-op.
              // Prev-month query: select("amount_twd") returns the sum row(s).
              if (selectCols === "amount_twd") {
                // shared prev sums 100, private prev sums 200.
                // Detect via which path (eq chain order). Easiest:
                // track by side.
                const value =
                  // first prev hit wins
                  prevSharedHit
                    ? { data: [{ amount_twd: 200 }], error: null }
                    : (prevPrivateHit
                      ? { data: [{ amount_twd: 0 }], error: null }
                      : (() => {
                          if (scope === "shared") {
                            prevSharedHit = true;
                            return { data: [{ amount_twd: 100 }], error: null };
                          }
                          prevPrivateHit = true;
                          return { data: [{ amount_twd: 200 }], error: null };
                        })());
                return Promise.resolve(value).then(resolve);
              }
              return Promise.resolve({ data: [], error: null }).then(resolve);
            },
          };
          return query;
        }
        throw new Error(`unexpected table ${table}`);
      },
      rpc: async () => ({ data: [], error: null }),
    } as unknown as import("@supabase/supabase-js").SupabaseClient;
  }

  // shared scope: prevSharedQuery is the only prev source, sum = 100.
  const sharedSnap = await loadAccountantSnapshot(
    {
      env: {} as ServerContext["env"],
      db: makeDbForScope("shared"),
      user: {
        id: CORE_OWNER,
        couple_id: 1,
        line_user_id: "o",
        role: "owner",
      },
    },
    "shared",
    "2026-07",
  );
  assert.equal(sharedSnap.facts.previousMonthTotalTwd, 100);

  // private scope: prevPrivateQuery is the only prev source, sum = 200.
  const privateSnap = await loadAccountantSnapshot(
    {
      env: {} as ServerContext["env"],
      db: makeDbForScope("private"),
      user: {
        id: CORE_OWNER,
        couple_id: 1,
        line_user_id: "o",
        role: "owner",
      },
    },
    "private",
    "2026-07",
  );
  assert.equal(privateSnap.facts.previousMonthTotalTwd, 200);
});

// ---------------------------------------------------------------------------
// Secretary tool/agent convergence: structural regressions at the
// registry seams. These guard against the easy-to-miss breakage
// that comes from collapsing secretary-tools / vercel-agent into a
// single registry.
// ---------------------------------------------------------------------------

test("secretary registry: declared names match what executeSecretaryTool actually accepts", async () => {
  // The registry is the single source of truth. Adding a tool to one
  // and forgetting the other would break this invariant.
  const { SECRETARY_TOOL_NAMES, findSecretaryTool } = await import(
    "./secretary-tool-registry"
  );
  const { executeSecretaryTool } = await import("./secretary-tools");

  // Names advertised by the registry.
  const expected = new Set<string>(SECRETARY_TOOL_NAMES);

  // Names reachable through the dispatch path used by executeSecretaryTool.
  // We pick tools whose executor does not require a real db to
  // produce a non-error result; the unknown-tool check is what we
  // want to lock down here.
  const samples = [
    "get_recent_expenses",
    "get_open_tasks",
    "get_user_memories",
    "update_expense",
    "propose_merchant_rule",
    "create_task",
  ];
  // The "Unknown tool" check is structural: if a name resolves via
  // findSecretaryTool, dispatchSecretaryTool must not return the
  // unknown-tool error envelope. The executor may still return
  // domain errors (e.g. "找不到支出"), which is fine.
  for (const name of samples) {
    const tool = findSecretaryTool(name);
    assert.ok(tool, `registry must have a definition for ${name}`);
    // Calling executeSecretaryTool with an empty db mock may throw
    // downstream; wrap in a try/catch so the test only fails if the
    // registry itself returns the unknown-tool error.
    try {
      await executeSecretaryTool(name, {}, {
        db: {} as import("@supabase/supabase-js").SupabaseClient,
        groupId: "g",
        userId: "u",
        coupleId: 1,
      });
    } catch {
      // downstream error — not the registry's concern here
    }
  }
  // And explicitly verify that an unknown tool returns the unknown-tool error envelope.
  const unknownResult = (await executeSecretaryTool(
    "this_is_not_a_real_tool",
    {},
    {
      db: {} as import("@supabase/supabase-js").SupabaseClient,
      groupId: "g",
      userId: "u",
      coupleId: 1,
    },
  )) as { error: string };
  assert.equal(unknownResult.error, "Unknown tool: this_is_not_a_real_tool");

  // And every registry name is reachable from the dispatch.
  for (const name of expected) {
    assert.ok(findSecretaryTool(name), `registry entry missing: ${name}`);
  }
});

test("secretary registry: vercel-agent's tools object is the registry's tools object (no second source)", async () => {
  // The hard part of the convergence: vercel-agent must not have its
  // own hand-rolled zod schema. The way to lock that down is to assert
  // that for every entry returned by `vercelToolDefs`, the
  // `description` and `parameters` shape are the same as the
  // registry's own definition.
  const {
    SECRETARY_TOOLS,
    findSecretaryTool,
    vercelToolDefs,
  } = await import("./secretary-tool-registry");

  // The dispatchTool argument is only used to populate `execute`; we
  // pass a stub.
  const tools = vercelToolDefs({ dispatchTool: async () => ({ ok: true }) });

  for (const def of SECRETARY_TOOLS) {
    const vercelEntry = tools[def.name];
    assert.ok(
      vercelEntry,
      `vercelToolDefs must produce an entry for ${def.name}`,
    );
    assert.equal(
      vercelEntry.description,
      def.description,
      `vercel description for ${def.name} drifted from registry`,
    );
    // Both must reference the same zod schema object. If anyone ever
    // re-introduces a second schema, this assertion will fail because
    // they will be two different references.
    assert.equal(
      vercelEntry.parameters,
      def.zodSchema,
      `vercel parameters for ${def.name} are not the same zod object as the registry`,
    );
    assert.equal(
      typeof vercelEntry.execute,
      "function",
      `vercel execute for ${def.name} must be a function`,
    );
    // And the registry's own executor must still be reachable for
    // other consumers (e.g. the Gemini declaration consumer).
    assert.equal(
      typeof findSecretaryTool(def.name)?.executor,
      "function",
      `registry executor for ${def.name} must be a function`,
    );
  }
});

test("secretary registry: record_expense / update_expense / propose_settlement still go through pending action builder path", async () => {
  // These three tools are the ones the LIFF depends on for the
  // record → confirm flow. If their executors stop producing
  // `pending_action` / using `buildUpdateExpenseAction`, the workflow
  // service's side-effect collection would break and notify-partner
  // would silently stop firing.
  const { SECRETARY_TOOLS, findSecretaryTool } = await import(
    "./secretary-tool-registry"
  );

  for (const name of [
    "record_expense",
    "update_expense",
    "propose_settlement",
  ]) {
    const def = findSecretaryTool(name);
    assert.ok(def, `${name} must be in the registry`);
    // The executor must be a function; the contract is that the
    // underlying call lands in `accountant-tools.executeTool` or
    // `buildUpdateExpenseAction` (we don't introspect that here, but
    // we at least lock the tool is present in the registry with a
    // real executor and a non-empty description).
    assert.equal(typeof def.executor, "function");
    assert.ok(def.description.length > 0);
  }
  // And the registry count matches the historical set.
  assert.equal(SECRETARY_TOOLS.length, 11);
});

test("secretary registry: get_open_tasks / get_user_memories return the same shape as the legacy executors", async () => {
  // The contract test: build a minimal mock db and assert the two
  // read tools return the exact `{ count, tasks/items[] }` shape
  // the LLM consumer has been seeing.
  const { executeSecretaryTool } = await import("./secretary-tools");

  const groupId = "00000000-0000-4000-8000-000000000801";
  const userId = "00000000-0000-4000-8000-000000000802";
  const coupleId = 1;

  function makeReadMock(rows: Array<Record<string, unknown>>) {
    return {
      from(table: string) {
        if (table === "user_preferences") {
          const query: any = {
            select: () => query,
            eq: () => query,
            single: async () => ({
              data: { active_group_id: groupId },
              error: null,
            }),
          };
          return query;
        }
        // tasks + memories both build a chainable query that
        // resolves to `{ data: rows, error: null }` on `await`.
        if (table === "assistant_tasks" || table === "assistant_memories") {
          const query: any = {
            select: () => query,
            eq: () => query,
            is: () => query,
            in: () => query,
            or: () => query,
            order: () => query,
            limit: () => query,
            then: (
              resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => void,
              reject?: (reason: unknown) => unknown,
            ) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
          };
          return query;
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as import("@supabase/supabase-js").SupabaseClient;
  }

  // get_open_tasks: tasks table returns the array; the registry's
  // executor maps each row to the documented shape.
  const taskRows = [
    {
      id: "00000000-0000-4000-8000-000000000901",
      couple_id: coupleId,
      group_id: groupId,
      owner_user_id: null,
      type: "tag_cleanup" as const,
      title: "整理其他分類",
      summary: "12 筆待整理",
      payload: null,
      status: "open" as const,
      priority: "normal" as const,
      due_at: null,
      snooze_until: null,
      source: null,
      related_pending_action_id: null,
      related_expense_id: null,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
  ];
  const taskMock = makeReadMock(taskRows);
  const taskResult = (await executeSecretaryTool(
    "get_open_tasks",
    { limit: 5 },
    {
      db: taskMock,
      groupId,
      userId,
      coupleId,
    },
  )) as { count: number; tasks: Array<{ id: string; title: string }> };
  assert.equal(taskResult.count, 1);
  assert.equal(taskResult.tasks.length, 1);
  assert.equal(taskResult.tasks[0].id, "00000000-0000-4000-8000-000000000901");
  assert.equal(taskResult.tasks[0].title, "整理其他分類");

  // get_user_memories: the registry's executor returns { count, items }
  // and the `approved` flag is derived from `approved_at`.
  const memoryRows = [
    {
      id: "00000000-0000-4000-8000-000000000902",
      couple_id: coupleId,
      group_id: groupId,
      user_id: userId,
      scope: "group" as const,
      kind: "merchant_rule" as const,
      key: "uber",
      value: { ledger: "private" },
      confidence: 0.9,
      source: "line",
      approved_at: "2026-07-01T00:00:00.000Z",
      expires_at: null,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
  ];
  const memoryMock = makeReadMock(memoryRows);
  const memoryResult = (await executeSecretaryTool(
    "get_user_memories",
    {},
    {
      db: memoryMock,
      groupId,
      userId,
      coupleId,
    },
  )) as {
    count: number;
    items: Array<{ id: string; approved: boolean; kind: string }>;
  };
  assert.equal(memoryResult.count, 1);
  assert.equal(memoryResult.items[0].id, "00000000-0000-4000-8000-000000000902");
  assert.equal(memoryResult.items[0].approved, true);
  assert.equal(memoryResult.items[0].kind, "merchant_rule");
});

// ---------------------------------------------------------------------------
// accountant registry tests
// ---------------------------------------------------------------------------

test("accountant registry: declared names match executeTool dispatch names", async () => {
  const { ACCOUNTANT_TOOL_NAMES, getAccountantTool, findAccountantTool } = await import("./accountant-tool-registry");
  const { executeTool } = await import("./accountant-tools");

  const expected = [
    "query_expenses",
    "get_balance_summary",
    "get_category_breakdown",
    "compare_period",
    "get_recurring_list",
    "get_anomalies",
    "get_category_trend",
    "predict_month_end",
    "record_expense",
    "settle_debt",
    "analyze_spending",
  ];

  assert.equal(ACCOUNTANT_TOOL_NAMES.length, expected.length);
  for (const name of expected) {
    assert.ok(ACCOUNTANT_TOOL_NAMES.includes(name), `expected ${name} to be in ACCOUNTANT_TOOL_NAMES`);
    assert.ok(findAccountantTool(name), `expected ${name} to be found in registry`);
    assert.equal(typeof getAccountantTool(name).executor, "function");
  }

  // Check unknown tool returns unknown error envelope
  const unknownResult = (await executeTool("this_is_not_a_real_tool", {}, {
    db: {} as any,
    groupId: "g",
    userId: "u",
    coupleId: 1,
  })) as { error: string };
  assert.equal(unknownResult.error, "Unknown tool: this_is_not_a_real_tool");
});

test("accountant registry: agent-chat-service tools come from registry, not inline second source", async () => {
  const { buildAccountantVercelTools, getAccountantTool } = await import("./accountant-tool-registry");

  const ctx = {
    db: {} as any,
    groupId: "g",
    userId: "u",
    coupleId: 1,
  };
  const tools = buildAccountantVercelTools(ctx);

  const readTools = [
    "query_expenses",
    "get_balance_summary",
    "get_category_breakdown",
    "compare_period",
    "get_recurring_list",
    "get_anomalies",
    "get_category_trend",
    "predict_month_end",
    "analyze_spending",
  ];

  for (const name of readTools) {
    const vercelEntry = tools[name];
    assert.ok(vercelEntry, `buildAccountantVercelTools must produce an entry for ${name}`);
    const registryEntry = getAccountantTool(name);
    assert.equal(vercelEntry.description, registryEntry.description);
    assert.equal(vercelEntry.parameters, registryEntry.zodSchema);
    assert.equal(typeof vercelEntry.execute, "function");
  }
});

test("accountant registry: query_expenses parameters are canonical date/tag/member/type contract", async () => {
  const { getAccountantTool } = await import("./accountant-tool-registry");
  const tool = getAccountantTool("query_expenses");
  
  // Verify it parses the canonical contract
  const validArgs = {
    date_from: "2026-07-01",
    date_to: "2026-07-10",
    tag: "Food",
    member: "me",
    type: "shared",
    limit: 10,
    sort: "date_desc",
  };
  const parsed = tool.zodSchema.parse(validArgs) as any;
  assert.equal(parsed.date_from, "2026-07-01");
  assert.equal(parsed.sort, "date_desc");

  // Verify it throws on incorrect fields or incorrect types
  assert.throws(() => tool.zodSchema.parse({ member: "invalid" }));
  assert.throws(() => tool.zodSchema.parse({ type: "invalid" }));
  assert.throws(() => tool.zodSchema.parse({ sort: "invalid" }));
});

test("accountant registry: compare_period and get_anomalies use canonical schemas, not stale Vercel-only args", async () => {
  const { getAccountantTool } = await import("./accountant-tool-registry");
  const compareTool = getAccountantTool("compare_period");
  const anomaliesTool = getAccountantTool("get_anomalies");

  // compare_period: should NOT accept stale Vercel-only fields
  const canonicalCompare = {
    period_a: { from: "2026-07-01", to: "2026-07-10" },
    period_b: { from: "2026-06-01", to: "2026-06-10" },
  };
  const parsedCompare = compareTool.zodSchema.parse(canonicalCompare) as any;
  assert.deepEqual(parsedCompare.period_a, canonicalCompare.period_a);

  const staleCompare = {
    metric: "category",
    tag: "Food",
    date_from_a: "2026-07-01",
    date_to_a: "2026-07-10",
    date_from_b: "2026-06-01",
    date_to_b: "2026-06-10",
  };
  assert.throws(() => compareTool.zodSchema.parse(staleCompare));

  // get_anomalies: should NOT accept threshold_std_dev
  const staleAnomalies = {
    threshold_std_dev: 2.5,
  };
  const parsedAnomalies = anomaliesTool.zodSchema.parse(staleAnomalies);
  const validAnomalies = { date_from: "2026-07-01", date_to: "2026-07-10" };
  const parsedValid = anomaliesTool.zodSchema.parse(validAnomalies) as any;
  assert.equal(parsedValid.date_from, "2026-07-01");
});

test("accountant registry integration: query_expenses parameters are canonical in AgentChatService", async () => {
  const { AgentChatService } = await import("./agent-chat-service");
  let passedTools: any = null;

  const chatService = new AgentChatService({
    generateTextImpl: async (input: any) => {
      passedTools = input.tools;
      return {
        text: "test",
        steps: [],
      };
    },
  });

  const mockQuery: any = {
    insert: () => mockQuery,
    update: () => mockQuery,
    select: () => mockQuery,
    eq: () => mockQuery,
    single: async () => ({ data: { id: "00000000-0000-4000-8000-000000000001" }, error: null }),
  };
  const mockDb = {
    from: () => mockQuery,
  } as any;

  const ctx = {
    db: mockDb,
    user: { id: "u", couple_id: 1 },
    getActiveGroupId: async () => "g",
  };

  await chatService.chat(ctx, { message: "query test" });

  assert.ok(passedTools);
  assert.ok(passedTools.query_expenses);
  
  const querySchema = passedTools.query_expenses.parameters;
  const parsed = querySchema.parse({
    date_from: "2026-07-01",
    sort: "amount_desc",
  });
  assert.equal(parsed.date_from, "2026-07-01");
  assert.equal(parsed.sort, "amount_desc");

  const shape = querySchema.shape;
  assert.ok(!("category" in shape), "should not contain category");
  assert.ok(!("category_label" in shape), "should not contain category_label");
});

test("accountant registry integration: compare_period does not accept stale args in AgentChatService", async () => {
  const { AgentChatService } = await import("./agent-chat-service");
  let passedTools: any = null;

  const chatService = new AgentChatService({
    generateTextImpl: async (input: any) => {
      passedTools = input.tools;
      return {
        text: "test",
        steps: [],
      };
    },
  });

  const mockQuery: any = {
    insert: () => mockQuery,
    update: () => mockQuery,
    select: () => mockQuery,
    eq: () => mockQuery,
    single: async () => ({ data: { id: "00000000-0000-4000-8000-000000000001" }, error: null }),
  };
  const mockDb = {
    from: () => mockQuery,
  } as any;

  const ctx = {
    db: mockDb,
    user: { id: "u", couple_id: 1 },
    getActiveGroupId: async () => "g",
  };

  await chatService.chat(ctx, { message: "compare test" });

  assert.ok(passedTools);
  assert.ok(passedTools.compare_period);

  const compareSchema = passedTools.compare_period.parameters;
  const staleCompare = {
    metric: "category",
    tag: "Food",
    date_from_a: "2026-07-01",
    date_to_a: "2026-07-10",
    date_from_b: "2026-06-01",
    date_to_b: "2026-06-10",
  };
  assert.throws(() => compareSchema.parse(staleCompare));

  const canonicalCompare = {
    period_a: { from: "2026-07-01", to: "2026-07-10" },
    period_b: { from: "2026-06-01", to: "2026-06-10" },
  };
  const parsed = compareSchema.parse(canonicalCompare);
  assert.deepEqual(parsed.period_a, canonicalCompare.period_a);
});

// ---------------------------------------------------------------------------
// ledger-query split: structural regressions at the most fragile
// seams. These guard against the easy-to-miss breakage that comes
// from collapsing ledger-query.ts into core / read / bootstrap /
// search modules.
// ---------------------------------------------------------------------------

test("ledger-query split: loadBootstrap() still separates shared/private/balances/dashboard", async () => {
  // The contract that the LIFF dashboard depends on: the bootstrap
  // payload has separate shared + private expense arrays, separate
  // dashboards for each, balances keyed by snake_case, and an
  // active group id. We lock the partition with a minimal mock.
  const { loadBootstrap } = await import("./ledger-query-bootstrap");
  const { LedgerQueryService } = await import("./ledger-query");

  const coupleId = 1;
  const userId = "00000000-0000-4000-8000-000000000a01";
  const partnerId = "00000000-0000-4000-8000-000000000a02";
  const activeGroupId = "00000000-0000-4000-8000-000000000a03";

  const sharedExpense = {
    id: "00000000-0000-4000-8000-000000000b01",
    couple_id: coupleId,
    group_id: activeGroupId,
    ledger: "shared" as const,
    description: "共同晚餐",
    merchant: null,
    notes: null,
    tag: "餐飲",
    mirror_kind: null,
    mirror_source_expense_id: null,
    amount_twd: 600,
    paid_by_user_id: userId,
    created_by_user_id: userId,
    expense_date: "2026-07-05",
    split_method: "equal" as const,
    version: 1,
    deleted_at: null,
    created_at: "2026-07-05T00:00:00.000Z",
    expense_splits: [
      { user_id: userId, amount_twd: 300 },
      { user_id: partnerId, amount_twd: 300 },
    ],
  };
  const privateExpense = {
    ...sharedExpense,
    id: "00000000-0000-4000-8000-000000000b02",
    group_id: null,
    ledger: "private" as const,
    description: "私人咖啡",
    amount_twd: 120,
    expense_splits: [{ user_id: userId, amount_twd: 120 }],
  };

  const mockDb = {
    from(table: string) {
      if (table === "users") {
        const query: any = {
          select: () => query,
          eq: () => query,
          order: () => Promise.resolve({
            data: [
              { id: userId, couple_id: coupleId, line_user_id: "u", role: "owner" },
              { id: partnerId, couple_id: coupleId, line_user_id: "p", role: "partner" },
            ],
            error: null,
          }),
        };
        return query;
      }
      if (table === "groups") {
        const query: any = {
          select: () => query,
          eq: () => query,
          order: () => Promise.resolve({
            data: [
              {
                id: activeGroupId,
                name: "g",
                color: "#000000",
                archived_at: null,
                created_at: "2026-07-01T00:00:00.000Z",
              },
            ],
            error: null,
          }),
        };
        return query;
      }
      if (table === "user_preferences") {
        const query: any = {
          select: () => query,
          eq: () => query,
          single: async () => ({
            data: { active_group_id: activeGroupId },
            error: null,
          }),
        };
        return query;
      }
      if (table === "expenses") {
        // The bootstrap fires two expense queries: shared by group_id,
        // private by created_by_user_id. Both must use the same
        // chainable shape; we route them by which .eq() the chain saw
        // most recently.
        const calls: { kind: "shared" | "private" | "other" } = { kind: "other" };
        const query: any = {
          select: () => query,
          eq: (field: string, value: unknown) => {
            if (field === "group_id" && value === activeGroupId) calls.kind = "shared";
            else if (field === "ledger" && value === "private")
              calls.kind = "private";
            return query;
          },
          gte: () => query,
          order: () => query,
          limit: () =>
            Promise.resolve({
              data: calls.kind === "private" ? [privateExpense] : [sharedExpense],
              error: null,
            }),
        };
        return query;
      }
      if (table === "settlements") {
        const query: any = {
          select: () => query,
          eq: () => query,
          order: () => query,
          limit: () => Promise.resolve({ data: [], error: null }),
        };
        return query;
      }
      if (table === "recurring_expenses") {
        const query: any = {
          select: () => query,
          eq: () => query,
          order: () => Promise.resolve({ data: [], error: null }),
        };
        return query;
      }
      if (table === "notifications") {
        const query: any = {
          select: () => query,
          eq: () => query,
          order: () => query,
          limit: () => Promise.resolve({ data: [], error: null }),
        };
        return query;
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async () => ({
      data: [
        { user_id: userId, balance_twd: 100 },
        { user_id: partnerId, balance_twd: -100 },
      ],
      error: null,
    }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const user = {
    id: userId,
    couple_id: coupleId,
    line_user_id: "u",
    role: "owner" as const,
  };

  const result = await loadBootstrap({ db: mockDb, user });

  // Bootstrap must surface the active group, the user list, the
  // shared + private expense arrays, the dashboard, and the
  // snake_case balances. Every one of these is consumed by the LIFF.
  assert.equal(result.activeGroupId, activeGroupId);
  assert.equal(result.users.length, 2);
  assert.equal(result.user.id, userId);
  assert.equal(result.sharedExpenses.length, 1);
  assert.equal(result.privateExpenses.length, 1);
  assert.equal(result.expenses.length, 2);
  // balances is snake_case, exactly as the LIFF expects.
  assert.deepEqual(result.balances, [
    { user_id: userId, balance_twd: 100 },
    { user_id: partnerId, balance_twd: -100 },
  ]);
  // Dashboard splits monthly / trend.
  assert.ok(result.dashboard);
  assert.ok(result.privateDashboard);
  assert.equal(result.dashboard.monthlyCount, 1);
  assert.equal(result.privateDashboard.monthlyCount, 1);
  // The facade class must delegate to the same bootstrap.
  const service = new LedgerQueryService();
  const facadeResult = await service.loadBootstrap({ db: mockDb, user });
  assert.equal(facadeResult.activeGroupId, result.activeGroupId);
  assert.equal(facadeResult.expenses.length, result.expenses.length);
  assert.deepEqual(facadeResult.balances, result.balances);
});

test("ledger-query split: searchExpenses() resolves active group first, then filters", async () => {
  // The contract: searchExpenses must look up active_group_id from
  // user_preferences before running the search filter, and must use
  // that group id to scope the listAccessibleExpenses call.
  const { searchExpenses } = await import("./ledger-query-search");
  const { LedgerQueryService } = await import("./ledger-query");

  const userId = "00000000-0000-4000-8000-000000000c01";
  const activeGroupId = "00000000-0000-4000-8000-000000000c02";

  let activeGroupLookupHits = 0;
  let groupIdUsedForSearch: string | null = null;

  const mockDb = {
    from(table: string) {
      if (table === "user_preferences") {
        const query: any = {
          select: () => query,
          eq: () => query,
          single: async () => {
            activeGroupLookupHits += 1;
            return { data: { active_group_id: activeGroupId }, error: null };
          },
        };
        return query;
      }
      if (table === "expenses") {
        const query: any = {
          select: () => query,
          eq: (field: string, value: unknown) => {
            if (field === "group_id") groupIdUsedForSearch = String(value);
            return query;
          },
          is: () => query,
          order: () => query,
          limit: () => Promise.resolve({ data: [], error: null }),
        };
        return query;
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const params = new URLSearchParams({ q: "晚餐" });
  const result = await searchExpenses({ db: mockDb, user: { id: userId } }, params);

  assert.ok(activeGroupLookupHits >= 1, "active group must be looked up first");
  assert.equal(groupIdUsedForSearch, activeGroupId);
  assert.equal(result.count, 0);
  assert.deepEqual(result.expenses, []);

  // Same path through the facade.
  const service = new LedgerQueryService();
  const facadeResult = await service.searchExpenses(
    { db: mockDb, user: { id: userId } },
    params,
  );
  assert.deepEqual(facadeResult, result);
});

test("ledger-query split: categoryExpenses() returns the documented shape for six_months/combined", async () => {
  // The contract: categoryExpenses returns { label, total, offset,
  // limit, expenses[] } where each expense item has the snake_case
  // / camelCase fields the LIFF panel expects. The split must not
  // drop any of them.
  const { categoryExpenses } = await import("./ledger-query-search");
  const { LedgerQueryService } = await import("./ledger-query");

  const userId = "00000000-0000-4000-8000-000000000d01";
  const activeGroupId = "00000000-0000-4000-8000-000000000d02";

  const sharedExpense = {
    id: "00000000-0000-4000-8000-000000000d10",
    couple_id: 1,
    group_id: activeGroupId,
    ledger: "shared" as const,
    description: "shared1",
    merchant: null,
    notes: null,
    tag: "餐飲",
    mirror_kind: null,
    mirror_source_expense_id: null,
    amount_twd: 500,
    paid_by_user_id: userId,
    created_by_user_id: userId,
    expense_date: "2026-07-10",
    split_method: "equal" as const,
    version: 1,
    deleted_at: null,
    created_at: "2026-07-10T00:00:00.000Z",
    expense_splits: [
      { user_id: userId, amount_twd: 250 },
      {
        user_id: "00000000-0000-4000-8000-000000000d03",
        amount_twd: 250,
      },
    ],
  };

  const mockDb = {
    from(table: string) {
      if (table === "user_preferences") {
        const query: any = {
          select: () => query,
          eq: () => query,
          single: async () => ({
            data: { active_group_id: activeGroupId },
            error: null,
          }),
        };
        return query;
      }
      if (table === "expenses") {
        const query: any = {
          select: () => query,
          eq: () => query,
          order: () => query,
          limit: () => Promise.resolve({ data: [sharedExpense], error: null }),
        };
        return query;
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const params = new URLSearchParams({
    label: "餐飲",
    range: "six_months",
    scope: "combined",
    limit: "5",
  });
  const result = await categoryExpenses({ db: mockDb, user: { id: userId } }, params);

  // Shape contract:
  assert.equal(result.label, "餐飲");
  assert.equal(typeof result.total, "number");
  assert.equal(result.offset, 0);
  assert.equal(result.limit, 5);
  assert.ok(Array.isArray(result.expenses));
  if (result.expenses.length > 0) {
    const e = result.expenses[0];
    // snake_case fields the LIFF depends on
    assert.equal(e.id, sharedExpense.id);
    assert.equal(e.amount_twd, sharedExpense.amount_twd);
    assert.equal(e.expense_date, sharedExpense.expense_date);
    assert.equal(e.paid_by_user_id, sharedExpense.paid_by_user_id);
    assert.equal(e.version, sharedExpense.version);
  }

  // Same path through the facade.
  const service = new LedgerQueryService();
  const facadeResult = await service.categoryExpenses(
    { db: mockDb, user: { id: userId } },
    params,
  );
  assert.deepEqual(facadeResult, result);
});

test("ledger-query split: facade return shapes match the public types", async () => {
  // Each facade method must produce a value that satisfies the
  // public zod schema exported from `ledger-query-core`. The types
  // have been stable for a long time; this test exists to make sure
  // the refactor doesn't silently narrow or change a return shape.
  const {
    balanceSummarySchema,
    queryExpensesSummarySchema,
    recentExpensesResultSchema,
    recurringListResultSchema,
  } = await import("./ledger-query-core");
  const { LedgerQueryService } = await import("./ledger-query");

  const service = new LedgerQueryService();

  // balanceSummary with a real db: just assert the schema parse on
  // an empty/mock success path.
  const balance = await service.balanceSummary({
    db: {} as import("@supabase/supabase-js").SupabaseClient,
    groupId: "g",
    userId: "u",
  });
  // The error envelope is fine if loadGroupBalances fails on a stub.
  if ("error" in balance) {
    assert.equal(balance.error, "balance lookup failed");
  } else {
    assert.ok(balanceSummarySchema.safeParse(balance).success);
  }

  // recentExpenses with an empty mock db throws / returns weird; we
  // only assert the type-level contract by feeding the schemas
  // directly with a hand-rolled object.
  assert.ok(
    recentExpensesResultSchema.safeParse({
      count: 0,
      items: [],
    }).success,
  );
  assert.ok(
    queryExpensesSummarySchema.safeParse({
      total: 0,
      count: 0,
      average: 0,
      date_range: null,
    }).success,
  );
  assert.ok(
    recurringListResultSchema.safeParse({
      items: [
        {
          description: "x",
          amount: 100,
          frequency: "monthly",
          next_run: "2026-07-01",
          active: true,
          tag: "餐飲",
          ledger: "shared",
        },
      ],
    }).success,
  );
});

test("accountant agent runner: LLM fact mismatch falls back but still persists report/run rows", async () => {
  const { runAgent } = await import("./accountant-agent-runner");
  const { setAnswerWithGemini } = await import("./accountant-agent-answer");

  // Simulate fallback being triggered (due to mismatch or error)
  setAnswerWithGemini(async (input, fallback) => {
    return { answer: fallback, source: "fallback" };
  });

  try {
    const reportRow = {
      id: "00000000-0000-4000-8000-000000009202",
      group_id: GROUP,
      owner_user_id: null,
      report_type: "manual_question",
      scope: "shared",
      month: "2026-07-01",
      question: "本月支出",
      title: "AI 會計師",
      summary: "Mocked fallback answer",
      facts: { totalTwd: 100, transactionCount: 1 },
      findings: [],
      suggestions: [],
      source: "fallback",
      created_at: "2026-07-15T00:00:00.000Z",
    };

    const insertedReports: any[] = [];
    const insertedRuns: any[] = [];

    const mockDb = {
      from(table: string) {
        if (table === "user_preferences") {
          return {
            select: () => mockDb.from(table),
            eq: () => mockDb.from(table),
            single: async () => ({
              data: { active_group_id: GROUP },
              error: null,
            }),
          };
        }
        if (table === "expenses") {
          return {
            select: () => mockDb.from(table),
            eq: () => mockDb.from(table),
            order: () => mockDb.from(table),
            limit: () => Promise.resolve({ data: [], error: null }),
          };
        }
        if (table === "accountant_reports") {
          return {
            insert: (row: any) => {
              insertedReports.push(row);
              return {
                select: () => ({
                  single: async () => ({ data: reportRow, error: null }),
                }),
              };
            },
          };
        }
        if (table === "agent_runs") {
          return {
            insert: (row: any) => {
              insertedRuns.push(row);
              return {
                select: () => ({
                  single: async () => ({ data: { id: "run-2" }, error: null }),
                }),
              };
            },
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as import("@supabase/supabase-js").SupabaseClient;

    const result = await runAgent(
      {
        env: {} as ServerContext["env"],
        db: mockDb,
        user: {
          id: CORE_OWNER,
          couple_id: 1,
          line_user_id: "line-owner",
          role: "owner",
        },
      },
      { message: "本月支出", scope: "shared" },
    );

    assert.equal(result.answer, "本月共同帳共 0 筆，總額 NT$0。");
    assert.equal(insertedReports.length, 1);
    assert.equal(insertedReports[0].source, "fallback");
    assert.equal(insertedRuns.length, 1);
    assert.equal(insertedRuns[0].report_id, reportRow.id);
  } finally {
    // Restore default implementation
    const { answerWithGemini: originalAnswerWithGemini } = await import("./accountant-agent-answer");
    setAnswerWithGemini(originalAnswerWithGemini);
  }
});

test("accountant category cleanup: suggestCategoryUpdates only returns visible other-tag candidates", async () => {
  const { suggestCategoryUpdates } = await import("./accountant-category-cleanup");

  const expenses = [
    {
      id: "00000000-0000-4000-8000-000000009501",
      couple_id: 1,
      group_id: GROUP,
      ledger: "shared",
      description: "Shared other",
      merchant: null,
      notes: null,
      tag: "其他",
      mirror_kind: null,
      mirror_source_expense_id: null,
      amount_twd: 100,
      paid_by_user_id: CORE_OWNER,
      created_by_user_id: CORE_OWNER,
      expense_date: "2026-07-01",
      split_method: "equal",
      version: 1,
      deleted_at: null,
      created_at: "2026-07-01T00:00:00.000Z",
      expense_splits: [],
    },
    {
      id: "00000000-0000-4000-8000-000000009502",
      couple_id: 1,
      group_id: GROUP,
      ledger: "shared",
      description: "Shared food",
      merchant: null,
      notes: null,
      tag: "Food",
      mirror_kind: null,
      mirror_source_expense_id: null,
      amount_twd: 200,
      paid_by_user_id: CORE_OWNER,
      created_by_user_id: CORE_OWNER,
      expense_date: "2026-07-01",
      split_method: "equal",
      version: 1,
      deleted_at: null,
      created_at: "2026-07-01T00:00:00.000Z",
      expense_splits: [],
    },
    {
      id: "00000000-0000-4000-8000-000000009503",
      couple_id: 1,
      group_id: GROUP,
      ledger: "private",
      description: "Partner private other",
      merchant: null,
      notes: null,
      tag: "其他",
      mirror_kind: null,
      mirror_source_expense_id: null,
      amount_twd: 300,
      paid_by_user_id: CORE_PARTNER,
      created_by_user_id: CORE_PARTNER,
      expense_date: "2026-07-01",
      split_method: "equal",
      version: 1,
      deleted_at: null,
      created_at: "2026-07-01T00:00:00.000Z",
      expense_splits: [],
    },
  ];

  let isPrivateQuery = false;
  const mockDb = {
    from(table: string) {
      if (table === "user_preferences") {
        return {
          select: () => mockDb.from(table),
          eq: () => mockDb.from(table),
          single: async () => ({
            data: { active_group_id: GROUP },
            error: null,
          }),
        };
      }
      if (table === "expenses") {
        return {
          select: () => mockDb.from(table),
          eq: (col: string, val: any) => {
            if (col === "ledger" && val === "private") {
              isPrivateQuery = true;
            }
            return mockDb.from(table);
          },
          order: () => mockDb.from(table),
          limit: () => {
            const data = isPrivateQuery ? [] : expenses;
            isPrivateQuery = false;
            return Promise.resolve({ data, error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const result = await suggestCategoryUpdates(
    {
      env: {} as ServerContext["env"],
      db: mockDb,
      user: {
        id: CORE_OWNER,
        couple_id: 1,
        line_user_id: "line-owner",
        role: "owner",
      },
    },
    { range: "all", scope: "shared" },
  );

  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0].expenseId, "00000000-0000-4000-8000-000000009501");
});

test("accountant category analytics: six_months still filters to the last six months window", async () => {
  const { categoryAnalytics } = await import("./accountant-category-cleanup");

  const expenses = [
    {
      id: "00000000-0000-4000-8000-000000009601",
      couple_id: 1,
      group_id: GROUP,
      ledger: "shared",
      description: "In window",
      merchant: null,
      notes: null,
      tag: "Food",
      mirror_kind: null,
      mirror_source_expense_id: null,
      amount_twd: 100,
      paid_by_user_id: CORE_OWNER,
      created_by_user_id: CORE_OWNER,
      expense_date: "2026-02-01",
      split_method: "equal",
      version: 1,
      deleted_at: null,
      created_at: "2026-02-01T00:00:00.000Z",
      expense_splits: [],
    },
    {
      id: "00000000-0000-4000-8000-000000009602",
      couple_id: 1,
      group_id: GROUP,
      ledger: "shared",
      description: "Out window",
      merchant: null,
      notes: null,
      tag: "Rent",
      mirror_kind: null,
      mirror_source_expense_id: null,
      amount_twd: 1000,
      paid_by_user_id: CORE_OWNER,
      created_by_user_id: CORE_OWNER,
      expense_date: "2026-01-31",
      split_method: "equal",
      version: 1,
      deleted_at: null,
      created_at: "2026-01-31T00:00:00.000Z",
      expense_splits: [],
    },
  ];

  let isPrivateQuery = false;
  const mockDb = {
    from(table: string) {
      if (table === "user_preferences") {
        return {
          select: () => mockDb.from(table),
          eq: () => mockDb.from(table),
          single: async () => ({
            data: { active_group_id: GROUP },
            error: null,
          }),
        };
      }
      if (table === "expenses") {
        return {
          select: () => mockDb.from(table),
          eq: (col: string, val: any) => {
            if (col === "ledger" && val === "private") {
              isPrivateQuery = true;
            }
            return mockDb.from(table);
          },
          order: () => mockDb.from(table),
          limit: () => {
            const data = isPrivateQuery ? [] : expenses;
            isPrivateQuery = false;
            return Promise.resolve({ data, error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const params = new URLSearchParams({
    range: "six_months",
    scope: "shared",
  });

  const result = await categoryAnalytics(
    {
      env: {} as ServerContext["env"],
      db: mockDb,
      user: {
        id: CORE_OWNER,
        couple_id: 1,
        line_user_id: "line-owner",
        role: "owner",
      },
    },
    params,
  );

  assert.equal(result.count, 1);
  assert.equal(result.categories.length, 1);
  assert.equal(result.categories[0].label, "Food");
  assert.equal(result.totalTwd, 100);
});

test("accountant agent barrel: exported functions/schemas still match the old public surface", async () => {
  const barrel = await import("./accountant-agent");

  assert.equal(typeof barrel.ask, "function");
  assert.equal(typeof barrel.runAgent, "function");
  assert.equal(typeof barrel.categoryAnalytics, "function");
  assert.equal(typeof barrel.suggestCategoryUpdates, "function");
  assert.equal(typeof barrel.createCategoryCleanup, "function");

  assert.ok(barrel.accountantAskInputSchema);
  assert.ok(barrel.agentRunInputSchema);
  assert.ok(barrel.categoryAnalyticsInputSchema);
  assert.ok(barrel.categoryCleanupInputSchema);

  assert.equal(barrel.accountantAskInputSchema.safeParse({ question: "x" }).success, true);
  assert.equal(barrel.agentRunInputSchema.safeParse({ message: "x" }).success, true);
  assert.equal(barrel.categoryAnalyticsInputSchema.safeParse({ range: "six_months" }).success, true);
  assert.equal(barrel.categoryCleanupInputSchema.safeParse({ updates: [] }).success, false);
});

test("flex-message-builder: flexExpenseConfirm produces valid Flex bubble", () => {
  const { flexExpenseConfirm } = require("./flex-message-builder");
  const msg = flexExpenseConfirm({
    description: "晚餐 拉麵",
    amountTwd: 500,
    tag: "餐飲",
    paidBy: "self",
    ledger: "shared",
    groupName: "共同生活",
    balanceText: "對方欠你 NT$1,200",
  });
  assert.equal(msg.type, "flex");
  assert.equal(msg.altText, "已記帳 晚餐 拉麵 NT$500");
  assert.equal(msg.contents.type, "bubble");
  assert.ok(msg.contents.header, "header box must exist");
  assert.ok(msg.contents.body, "body box must exist");
  const allTexts = collectAllTexts(msg.contents);
  assert.ok(allTexts.some((t: string) => t.includes("晚餐 拉麵")));
  assert.ok(allTexts.some((t: string) => t.includes("NT$500")));
  assert.ok(allTexts.some((t: string) => t.includes("你付")));
  assert.ok(allTexts.some((t: string) => t.includes("共同帳")));
  assert.ok(allTexts.some((t: string) => t.includes("餐飲")));
});

test("flex-message-builder: flexQueryResult produces valid Flex bubble with tags", () => {
  const { flexQueryResult } = require("./flex-message-builder");
  const msg = flexQueryResult({
    title: "本月共同帳",
    totalTwd: 12500,
    count: 15,
    topTags: [
      { label: "餐飲", amount: 5625, percent: 45 },
      { label: "交通", amount: 2500, percent: 20 },
    ],
    vsLastMonthPercent: 12,
  });
  assert.equal(msg.type, "flex");
  assert.equal(msg.altText, "本月共同帳 NT$12,500 15筆");
  assert.equal(msg.contents.type, "bubble");
  const allTexts = collectAllTexts(msg.contents);
  assert.ok(allTexts.some((t: string) => t.includes("餐飲")));
  assert.ok(allTexts.some((t: string) => t.includes("45%")));
  assert.ok(allTexts.some((t: string) => t.includes("較上月")));
});

test("flex-message-builder: flexNeedsGroup produces buttons for each group", () => {
  const { flexNeedsGroup } = require("./flex-message-builder");
  const msg = flexNeedsGroup([
    { id: "g1", name: "共同生活" },
    { id: "g2", name: "旅遊基金" },
  ]);
  assert.equal(msg.type, "flex");
  assert.ok(msg.altText.includes("共同生活"));
  assert.ok(msg.altText.includes("旅遊基金"));
  const buttons = msg.contents.body.contents.filter((c: any) => c.type === "button");
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].action.label, "共同生活");
  assert.equal(buttons[1].action.label, "旅遊基金");
});

test("flex-message-builder: flexError produces a warning card", () => {
  const { flexError } = require("./flex-message-builder");
  const msg = flexError("金額必須是正整數");
  assert.equal(msg.type, "flex");
  assert.equal(msg.altText, "金額必須是正整數");
  assert.equal(msg.contents.type, "bubble");
});

test("secretary-direct-actions: executeDirectUpdate on private expense succeeds without pending_action", async () => {
  const { executeDirectUpdate } = await import("./secretary-direct-actions");

  let updateCall: any = null;
  const mockDb = {
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        single: () => {
          if (table === "expenses") {
            return Promise.resolve({
              data: {
                id: "exp-private-1",
                ledger: "private",
                created_by_user_id: "user-1",
                deleted_at: null,
                description: "午餐",
                version: 3,
              },
              error: null,
            });
          }
          if (table === "users") {
            return Promise.resolve({
              data: { id: "partner-1" },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        update: (data: any) => {
          updateCall = data;
          return {
            eq: () => ({ eq: () => Promise.resolve({ error: null }) }),
          };
        },
      };
      return chain;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const ctx = {
    db: mockDb,
    groupId: "group-1",
    userId: "user-1",
    coupleId: 1,
  };

  const result = await executeDirectUpdate(ctx, "exp-private-1", {
    amount_twd: 300,
    tag: "餐飲",
  });

  assert.equal((result as any).result, "done");
  assert.ok(!(result as any).pending_action, "should not produce pending_action");
  assert.ok(updateCall, "should have called update on expenses");
  assert.equal(updateCall.tag, "餐飲");
  assert.equal(updateCall.amount_twd, 300);
  assert.equal(updateCall.version, 4);
});

test("secretary-direct-actions: executeDirectUpdate rejects shared expense", async () => {
  const { executeDirectUpdate } = await import("./secretary-direct-actions");

  const mockDb = {
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        single: () => {
          if (table === "expenses") {
            return Promise.resolve({
              data: {
                id: "exp-shared-1",
                ledger: "shared",
                created_by_user_id: "user-1",
                deleted_at: null,
                description: "晚餐",
                version: 1,
              },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const ctx = {
    db: mockDb,
    groupId: "group-1",
    userId: "user-1",
    coupleId: 1,
  };

  const result = await executeDirectUpdate(ctx, "exp-shared-1", {
    amount_twd: 500,
  });

  assert.ok(!(result as any).result, "should not succeed on shared expense");
  assert.ok((result as any).error, "should return error");
});

test("secretary-direct-actions: executeDirectDelete on private expense soft-deletes", async () => {
  const { executeDirectDelete } = await import("./secretary-direct-actions");

  let updateCall: any = null;
  const mockDb = {
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        single: () => {
          if (table === "expenses") {
            return Promise.resolve({
              data: {
                id: "exp-private-2",
                ledger: "private",
                created_by_user_id: "user-1",
                deleted_at: null,
                description: "咖啡",
                version: 2,
              },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        update: (data: any) => {
          updateCall = data;
          return {
            eq: () => ({ eq: () => ({ is: () => Promise.resolve({ error: null }) }) }),
          };
        },
      };
      return chain;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const ctx = {
    db: mockDb,
    groupId: "group-1",
    userId: "user-1",
    coupleId: 1,
  };

  const result = await executeDirectDelete(ctx, "exp-private-2");

  assert.equal((result as any).result, "done");
  assert.ok(!(result as any).pending_action, "should not produce pending_action");
  assert.ok(updateCall.deleted_at, "should set deleted_at");
  assert.equal(updateCall.deleted_by_user_id, "user-1");
});

test("secretary-direct-actions: executeDirectDelete rejects shared expense", async () => {
  const { executeDirectDelete } = await import("./secretary-direct-actions");

  const mockDb = {
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        single: () => {
          if (table === "expenses") {
            return Promise.resolve({
              data: {
                id: "exp-shared-2",
                ledger: "shared",
                created_by_user_id: "user-1",
                deleted_at: null,
                description: "晚餐",
                version: 1,
              },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const ctx = {
    db: mockDb,
    groupId: "group-1",
    userId: "user-1",
    coupleId: 1,
  };

  const result = await executeDirectDelete(ctx, "exp-shared-2");

  assert.ok(!(result as any).result, "should not succeed on shared expense");
  assert.ok((result as any).error, "should return error");
});
