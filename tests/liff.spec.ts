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

function bootstrap() {
  const expense = {
    id: "00000000-0000-4000-8000-000000000010",
    group_id: GROUP,
    ledger: "shared",
    description: "晚餐",
    merchant: "小吃店",
    notes: null,
    category: "food",
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
    expenses: [expense],
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
  };
}
