import { expect, test } from "@playwright/test";

const OWNER = "00000000-0000-4000-8000-000000000001";
const PARTNER = "00000000-0000-4000-8000-000000000002";
const GROUP = "00000000-0000-4000-8000-000000000003";
let sessionBodies: unknown[] = [];

test.beforeEach(async ({ page }) => {
  sessionBodies = [];
  let sessionCreated = false;
  await page.addInitScript(() => {
    window.liff = {
      init: async () => undefined,
      isLoggedIn: () => true,
      login: () => undefined,
      getIDToken: () => "test-id-token",
      isInClient: () => true,
      closeWindow: () => undefined,
    };
  });
  await page.route("**/api/app/bootstrap", (route) =>
    sessionCreated
      ? route.fulfill({ json: bootstrap() })
      : route.fulfill({ status: 401, json: { error: "Session expired" } }),
  );
  await page.route("**/api/app/session", (route) => {
    sessionBodies.push(route.request().postDataJSON());
    sessionCreated = true;
    return route.fulfill({ json: { user: { id: OWNER, role: "owner" } } });
  });
  await page.route("**/api/app/actions/confirm", (route) =>
    route.fulfill({
      json: { result: "confirmed", action_type: "create_expense" },
    }),
  );
  await page.route("**/api/app/actions", (route) =>
    route.fulfill({
      json: {
        actionId: "00000000-0000-4000-8000-000000000099",
        preview: "新增 共同生活\n晚餐 NT$860\n平均分帳",
      },
    }),
  );
  await page.route("**/api/app/groups", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/app/accountant/reports", (route) =>
    route.fulfill({ json: [accountantReport("AI 月報")] }),
  );
  await page.route("**/api/app/accountant/ask", (route) =>
    route.fulfill({ json: accountantReport("AI 會計師回覆") }),
  );
  await page.route("**/api/app/agent/runs", (route) =>
    route.fulfill({ json: agentRun() }),
  );
  await page.route("**/api/app/analytics/categories**", (route) =>
    route.fulfill({
      json: {
        range: "this_month",
        scope: "shared",
        totalTwd: 1060,
        count: 2,
        categories: [
          { label: "晚餐", totalTwd: 860, count: 1, percent: 81 },
          { label: "捷運", totalTwd: 200, count: 1, percent: 19 },
        ],
      },
    }),
  );
  await page.route("https://static.line-scdn.net/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
});

test("mobile dashboard, history, and confirmed expense flow", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
  await expect(page.getByText("另一半欠你 NT$430")).toBeVisible();
  await expect(page.getByText("NT$1,060").first()).toBeVisible();

  await page.getByRole("button", { name: /流水/ }).click();
  await expect(page.getByRole("heading", { name: "帳務流水" })).toBeVisible();
  await expect(page.getByText("晚餐", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /私人/ }).click();
  await expect(page.getByRole("heading", { name: "私人帳" })).toBeVisible();
  await expect(page.getByText("共同分攤")).toBeVisible();

  await page.getByRole("button", { name: /新增/ }).click();
  await page.getByLabel("說明").fill("晚餐");
  await page.getByLabel("金額（TWD）").fill("860");
  await page.getByRole("button", { name: "預覽並確認" }).click();
  await expect(page.getByRole("dialog")).toContainText("晚餐 NT$860");
  await page.getByRole("dialog").getByRole("button", { name: "確認" }).click();
  await expect(page.getByRole("status")).toContainText("已完成");
});

test("passes invite code from LIFF link into session creation", async ({
  page,
}) => {
  await page.goto("/?invite=test-setup-code");
  await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
  expect(sessionBodies).toContainEqual({
    idToken: "test-id-token",
    invite: "test-setup-code",
  });
});

test("asks the accountant from the LIFF tab", async ({ page }) => {
  await page.goto("/?tab=accountant");
  await expect(
    page.getByRole("heading", { level: 1, name: "AI 會計師" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI 月報" })).toBeVisible();

  await page.getByLabel("你想問什麼").fill("本月哪裡花太多？");
  await page.getByRole("button", { name: "詢問會計師" }).click();
  await expect(page.getByRole("heading", { name: "AI 會計師回覆" })).toBeVisible();
  await expect(page.getByText("本月共 2 筆").first()).toBeVisible();
});

function bootstrap() {
  const expense = {
    id: "00000000-0000-4000-8000-000000000010",
    group_id: GROUP,
    ledger: "shared",
    description: "晚餐",
    merchant: "小吃店",
    notes: null,
    category: "food",
    category_label: "晚餐",
    mirror_kind: null,
    mirror_source_expense_id: null,
    amount_twd: 860,
    paid_by_user_id: OWNER,
    created_by_user_id: OWNER,
    expense_date: "2026-06-22",
    split_method: "equal",
    version: 1,
    deleted_at: null,
    created_at: "2026-06-22T12:00:00Z",
    expense_splits: [
      { user_id: OWNER, amount_twd: 430 },
      { user_id: PARTNER, amount_twd: 430 },
    ],
    receipts: [],
  };
  const privateExpense = {
    ...expense,
    id: "00000000-0000-4000-8000-000000000011",
    group_id: null,
    ledger: "private",
    category_label: "餐飲",
    amount_twd: 430,
    paid_by_user_id: OWNER,
    created_by_user_id: OWNER,
    mirror_kind: "shared_share",
    mirror_source_expense_id: expense.id,
    expense_splits: [{ user_id: OWNER, amount_twd: 430 }],
  };
  return {
    today: "2026-06-22",
    month: "2026-06",
    user: { id: OWNER, role: "owner", label: "你" },
    users: [
      { id: OWNER, role: "owner", label: "你" },
      { id: PARTNER, role: "partner", label: "另一半" },
    ],
    groups: [
      {
        id: GROUP,
        name: "共同生活",
        color: "#173B63",
        archived_at: null,
        created_at: "2026-06-01T00:00:00Z",
      },
    ],
    activeGroupId: GROUP,
    expenses: [expense, privateExpense],
    sharedExpenses: [expense],
    privateExpenses: [privateExpense],
    balances: [
      { user_id: OWNER, balance_twd: 430 },
      { user_id: PARTNER, balance_twd: -430 },
    ],
    budgets: [
      {
        id: "1",
        group_id: GROUP,
        category: null,
        month: "2026-06-01",
        limit_twd: 20000,
      },
    ],
    recurring: [],
    notifications: [],
    dashboard: {
      monthlyTotalTwd: 1060,
      monthlyCount: 2,
      categoryTotals: {
        food: 860,
        transport: 200,
        groceries: 0,
        household: 0,
        entertainment: 0,
        shopping: 0,
        medical: 0,
        travel: 0,
        other: 0,
      },
      trend: [
        { month: "2026-01", totalTwd: 0 },
        { month: "2026-02", totalTwd: 0 },
        { month: "2026-03", totalTwd: 0 },
        { month: "2026-04", totalTwd: 0 },
        { month: "2026-05", totalTwd: 200 },
        { month: "2026-06", totalTwd: 1060 },
      ],
      recent: [expense],
    },
    privateDashboard: {
      monthlyTotalTwd: 430,
      monthlyCount: 1,
      categoryTotals: {
        food: 430,
        transport: 0,
        groceries: 0,
        household: 0,
        entertainment: 0,
        shopping: 0,
        medical: 0,
        travel: 0,
        other: 0,
      },
      trend: [
        { month: "2026-01", totalTwd: 0 },
        { month: "2026-02", totalTwd: 0 },
        { month: "2026-03", totalTwd: 0 },
        { month: "2026-04", totalTwd: 0 },
        { month: "2026-05", totalTwd: 0 },
        { month: "2026-06", totalTwd: 430 },
      ],
      recent: [privateExpense],
    },
  };
}

function accountantReport(title: string) {
  return {
    id: "00000000-0000-4000-8000-000000000088",
    group_id: GROUP,
    owner_user_id: OWNER,
    report_type: "manual_question",
    scope: "combined",
    month: "2026-06-01",
    question: "本月哪裡花太多？",
    title,
    summary: "本月共 2 筆，總額 NT$1,060。",
    facts: {
      month: "2026-06",
      scope: "combined",
      sharedTotalTwd: 1060,
      privateTotalTwd: 0,
      totalTwd: 1060,
      transactionCount: 2,
      balanceTwd: 430,
      otherTotalTwd: 0,
    },
    findings: [
      {
        severity: "info",
        title: "餐飲是主要支出",
        body: "晚餐佔本月大部分支出。",
        amountTwd: 860,
      },
    ],
    suggestions: [
      {
        title: "可結清目前餘額",
        body: "確認後會建立結清草稿。",
        actionInput: { type: "settle", groupId: GROUP, amountTwd: 430 },
      },
    ],
    source: "fallback",
    created_at: "2026-06-22T12:00:00Z",
  };
}

function agentRun() {
  const report = accountantReport("AI 會計師回覆");
  return {
    answer: "本月共 2 筆，總額 NT$1,060。\n分類排行：\n1. 晚餐 NT$860（1筆）",
    reportId: report.id,
    toolCalls: [
      { tool: "search_expenses", count: 2 },
      { tool: "rank_categories", count: 2 },
    ],
    suggestions: report.suggestions,
    report,
  };
}
