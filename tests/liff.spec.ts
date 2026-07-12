import { expect, test } from "@playwright/test";

const OWNER = "00000000-0000-4000-8000-000000000001";
const PARTNER = "00000000-0000-4000-8000-000000000002";
const GROUP = "00000000-0000-4000-8000-000000000003";
let sessionBodies: unknown[] = [];

type TestLiff = {
  init: (input: { liffId: string; withLoginOnExternalBrowser?: boolean }) => Promise<void>;
  isLoggedIn: () => boolean;
  login: (input?: { redirectUri?: string }) => void;
  getIDToken: () => string | null;
  isInClient: () => boolean;
  closeWindow: () => void;
};

type TestWindow = Window & { liff?: TestLiff; __redirectUri?: string };

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
  await page.route("**/api/app/actions", (route) =>
    route.fulfill({
      json: { result: "confirmed", action_type: "create_expense" },
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
  await page.route("**/api/app/agent/memories", (route) =>
    route.fulfill({ json: { memories: [] } }),
  );
  await page.route("**/api/app/analytics/categories**", (route) =>
    route.fulfill({
      json: {
        range: "this_month",
        scope: "shared",
        totalTwd: 1060,
        count: 2,
        categories: [
          { tag: "晚餐", totalTwd: 860, count: 1, percent: 81 },
          { tag: "捷運", totalTwd: 200, count: 1, percent: 19 },
        ],
      },
    }),
  );
  await page.route("https://static.line-scdn.net/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
});

test("mobile dashboard, history, and direct expense flow", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
  await expect(page.getByText("另一半欠你 NT$430")).toBeVisible();
  await expect(page.getByRole("button", { name: /記錄已轉帳/ })).toHaveCount(0);
  await expect(page.getByText("NT$1,060").first()).toBeVisible();

  await page.getByRole("button", { name: /流水/ }).click();
  await expect(page.getByRole("heading", { name: "帳務流水" })).toBeVisible();
  await expect(page.getByText("晚餐", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: /私人/ }).click();
  await expect(page.getByRole("heading", { name: "私人帳" })).toBeVisible();
  await expect(page.getByText("共同分攤")).toBeVisible();

  await page.getByRole("button", { name: /新增/ }).click();
  await page.getByLabel("說明").fill("晚餐");
  await page.getByLabel("金額（TWD）").fill("860");
  await page.getByRole("button", { name: "直接記帳" }).click();
  await expect(page.getByText("已記帳")).toBeVisible();
  await expect(page.getByLabel("說明")).toHaveCount(0);
});

test("dashboard fallback keeps free category labels and centered add button", async ({
  page,
}) => {
  await page.route("**/api/app/analytics/categories**", (route) =>
    route.fulfill({ status: 500, json: { error: "failed" } }),
  );

  await page.goto("/");
  await expect(page.getByText("晚餐", { exact: true })).toHaveCount(2);
  await expect(page.getByText("捷運", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("transport", { exact: true })).toHaveCount(0);

  const centerOffset = await page
    .locator("nav")
    .getByRole("button", { name: /新增/ })
    .evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2);
    });
  expect(centerOffset).toBeLessThan(3);
});

test("LIFF waits for a delayed SDK and still creates one session", async ({ page }) => {
  await page.addInitScript(() => {
    const delayedLiff: TestLiff = {
      init: async () => undefined,
      isLoggedIn: () => true,
      login: () => undefined,
      getIDToken: () => "delayed-id-token",
      isInClient: () => true,
      closeWindow: () => undefined,
    };
    const browser = window as TestWindow;
    browser.liff = undefined;
    window.setTimeout(() => {
      browser.liff = delayedLiff;
    }, 350);
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
  expect(sessionBodies).toHaveLength(1);
});

test("external LIFF login keeps invite and tab in redirect URI", async ({ page }) => {
  await page.addInitScript(() => {
    const browser = window as TestWindow;
    browser.liff = {
      init: async () => undefined,
      isLoggedIn: () => false,
      login: ({ redirectUri }: { redirectUri?: string } = {}) => {
        browser.__redirectUri = redirectUri;
      },
      getIDToken: () => null,
      isInClient: () => false,
      closeWindow: () => undefined,
    };
  });

  await page.goto("/?invite=invite-code&tab=history");
  await expect.poll(() => page.evaluate(() => (window as TestWindow).__redirectUri)).toContain(
    "invite=invite-code",
  );
  await expect.poll(() => page.evaluate(() => (window as TestWindow).__redirectUri)).toContain(
    "tab=history",
  );
  expect(sessionBodies).toHaveLength(0);
});


function bootstrap() {
  const expense = {
    id: "00000000-0000-4000-8000-000000000010",
    group_id: GROUP,
    ledger: "shared" as const,
    description: "晚餐",
    merchant: "小吃店",
    notes: null,
    tag: "晚餐",
    mirror_kind: null,
    mirror_source_expense_id: null,
    amount_twd: 860,
    paid_by_user_id: OWNER,
    created_by_user_id: OWNER,
    expense_date: "2026-06-22",
    split_method: "equal" as const,
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
    ledger: "private" as const,
    tag: "餐飲",
    amount_twd: 430,
    paid_by_user_id: OWNER,
    created_by_user_id: OWNER,
    mirror_kind: "shared_share" as const,
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
    settlements: [],
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
        晚餐: 860,
        捷運: 200,
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
    openTasks: [],
    recentEvents: [],
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
        body: "可直接建立結清。",
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
