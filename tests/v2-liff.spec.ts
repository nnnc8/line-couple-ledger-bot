import { expect, test, type Page } from "@playwright/test";

const OWNER = "00000000-0000-4000-8000-000000000001";
const PARTNER = "00000000-0000-4000-8000-000000000002";
const LEDGER = "00000000-0000-4000-8000-000000000010";
const TRANSACTION = "00000000-0000-4000-8000-000000000011";

type PostMode = "success" | "failure" | "fail-once" | "delay";

test.beforeEach(async ({ page }) => {
  let bootstrapCalls = 0;
  let postMode: PostMode = "success";
  let postRequests = 0;
  let postedBodies: Array<Record<string, unknown>> = [];
  let releasePost: (() => void) | null = null;
  let rows: Array<Record<string, unknown>> = [];
  let failRefresh = false;

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
  await page.route("**/api/app/bootstrap", (route) => route.fulfill({ status: 401, json: { error: "V2 test uses context" } }));
  await page.route("**/api/app/session", (route) => route.fulfill({ json: { user: { id: OWNER, role: "owner" } } }));
  await page.route("**/api/app/v2/context", (route) => route.fulfill({ json: {
    today: "2026-08-28",
    user: { id: OWNER, role: "owner", label: "你" },
    users: [
      { id: OWNER, role: "owner", label: "你" },
      { id: PARTNER, role: "partner", label: "另一半" },
    ],
  } }));
  await page.route("**/api/app/v2/ledgers", (route) => route.fulfill({ json: {
    ledgers: [{ id: LEDGER, name: "共同生活", color: "#173B63", status: "active", version: 1, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z" }],
  } }));
  await page.route(`**/api/app/v2/ledgers/${LEDGER}/bootstrap`, (route) => {
    bootstrapCalls += 1;
    if (failRefresh && bootstrapCalls > 1) return route.fulfill({ status: 503, json: { error: "暫時無法同步" } });
    return route.fulfill({ json: {
      ledger: {
        id: LEDGER,
        name: "共同生活",
        color: "#173B63",
        status: "active",
        version: 1,
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-01T00:00:00Z",
        coupleId: 1,
        members: [{ userId: OWNER, role: "owner" }, { userId: PARTNER, role: "partner" }],
        defaultShares: { [OWNER]: "1", [PARTNER]: "1" },
      },
      transactions: rows,
      balance: rows.length ? { [OWNER]: "-50", [PARTNER]: "50" } : { [OWNER]: "0", [PARTNER]: "0" },
      nextPayer: rows.length ? { payerUserId: OWNER, payeeUserId: PARTNER, amountTwd: "50" } : null,
    } });
  });
  await page.route(`**/api/app/v2/ledgers/${LEDGER}/categories`, (route) => route.fulfill({ json: { categories: [] } }));
  await page.route(`**/api/app/v2/ledgers/${LEDGER}/recurring`, (route) => route.fulfill({ json: { recurring: [] } }));
  await page.route(`**/api/app/v2/ledgers/${LEDGER}/statistics`, (route) => route.fulfill({ json: { byType: {}, byCategory: {}, paidBy: {}, borneBy: {} } }));
  await page.route(`**/api/app/v2/ledgers/${LEDGER}/transactions*`, async (route) => {
    if (route.request().method() === "POST") {
      postRequests += 1;
      const body = route.request().postDataJSON() as Record<string, unknown>;
      postedBodies = [...postedBodies, body];
      if (postMode === "delay") await new Promise<void>((resolve) => { releasePost = resolve; });
      if (postMode === "failure" || (postMode === "fail-once" && postRequests === 1)) {
        return route.fulfill({ status: 422, json: { error: "交易格式錯誤" } });
      }
      const created = {
        id: TRANSACTION,
        ledgerId: LEDGER,
        type: body.type ?? "expense",
        amountTwd: body.amountTwd ?? "100",
        payments: [{ userId: OWNER, amountTwd: body.amountTwd ?? "100" }],
        shares: [{ userId: OWNER, amountTwd: "50" }, { userId: PARTNER, amountTwd: "50" }],
        status: "posted",
        occurredOn: body.occurredOn ?? "2026-08-28",
        description: body.description ?? "午餐",
        category: null,
        categoryId: null,
        note: null,
        splitMethod: body.splitMethod ?? "weights",
        createdAt: "2026-08-28T02:30:00.000Z",
        version: 1,
      };
      rows = [created];
      return route.fulfill({ status: 201, json: {
        transaction: created,
        balance: { [OWNER]: "-50", [PARTNER]: "50" },
        nextPayer: { payerUserId: OWNER, payeeUserId: PARTNER, amountTwd: "50" },
        ledgerVersion: 2,
      } });
    }
    const url = new URL(route.request().url());
    const type = url.searchParams.get("type");
    const query = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase();
    const filtered = rows.filter((row) => {
      if (type && row.type !== type) return false;
      if (query && ![row.description, row.note, row.category].some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(query))) return false;
      return true;
    });
    return route.fulfill({ json: { transactions: filtered, nextCursor: null } });
  });
  await page.route("https://static.line-scdn.net/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Ledger", exact: true })).toBeVisible();

  (page as typeof page & { __v2Controls?: unknown }).__v2Controls = { setPostMode: (mode: PostMode) => { postMode = mode; }, releasePost: () => releasePost?.(), getPostRequests: () => postRequests, getPostedBodies: () => postedBodies, setFailRefresh: (value: boolean) => { failRefresh = value; } };
});

function controls(page: Page) {
  return (page as typeof page & { __v2Controls: { setPostMode: (mode: PostMode) => void; releasePost: () => void; getPostRequests: () => number; getPostedBodies: () => Array<Record<string, unknown>>; setFailRefresh: (value: boolean) => void } }).__v2Controls;
}

test("shows server-confirmed saving and success feedback without waiting for history reload", async ({ page }) => {
  controls(page).setPostMode("delay");
  await page.getByLabel("金額 TWD").fill("100");
  await page.getByLabel("說明").fill("午餐");
  const submit = page.getByRole("button", { name: "儲存交易" });
  await submit.click();
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('button[type="submit"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect(page.getByRole("button", { name: /儲存中/ })).toBeDisabled();
  await expect.poll(() => controls(page).getPostRequests()).toBe(1);
  controls(page).releasePost();
  await expect(page.getByRole("status").filter({ hasText: "已入帳：午餐 NT$100" }).first()).toBeVisible();
  await expect(page.getByText("午餐", { exact: true }).last()).toBeVisible();
  await expect(page.getByRole("heading", { name: "你欠另一半 NT$50" })).toBeVisible();
  await expect(page.getByLabel("金額 TWD")).toHaveValue("");
  await expect(page.getByLabel("說明")).toHaveValue("");
  await expect(page.getByLabel("交易類型")).toHaveValue("expense");
  await expect(page.getByLabel("分攤方式")).toHaveValue("weights");
});

test("keeps the committed success when background refresh fails", async ({ page }) => {
  controls(page).setFailRefresh(true);
  await page.getByLabel("金額 TWD").fill("100");
  await page.getByLabel("說明").fill("午餐");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(page.getByRole("status").filter({ hasText: "已入帳：午餐 NT$100" }).first()).toContainText("流水同步失敗");
  await expect(page.getByText("儲存失敗", { exact: true })).toHaveCount(0);
});

test("keeps the draft on a rejected POST and does not add a local row", async ({ page }) => {
  controls(page).setPostMode("failure");
  await page.getByLabel("金額 TWD").fill("100");
  await page.getByLabel("說明").fill("午餐");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "交易格式錯誤" }).first()).toBeVisible();
  await expect(page.getByLabel("金額 TWD")).toHaveValue("100");
  await expect(page.getByLabel("說明")).toHaveValue("午餐");
  await expect(page.getByText("已入帳：午餐 NT$100", { exact: true })).toHaveCount(0);
  await expect(page.getByText("午餐", { exact: true })).toHaveCount(0);
});

test("reuses the idempotency key on an unchanged retry", async ({ page }) => {
  controls(page).setPostMode("fail-once");
  await page.getByLabel("金額 TWD").fill("100");
  await page.getByLabel("說明").fill("午餐");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "交易格式錯誤" }).first()).toBeVisible();
  controls(page).setPostMode("success");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(page.getByRole("status").filter({ hasText: "已入帳：午餐 NT$100" }).first()).toBeVisible();
  const bodies = controls(page).getPostedBodies();
  expect(bodies).toHaveLength(2);
  expect(bodies[0]?.idempotencyKey).toBe(bodies[1]?.idempotencyKey);
});

test("does not insert a committed transaction that fails the active history filter", async ({ page }) => {
  await page.getByLabel("搜尋 Ledger 流水").fill("晚餐");
  await page.getByLabel("金額 TWD").fill("100");
  await page.getByLabel("說明").fill("午餐");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(page.getByRole("status").filter({ hasText: "已入帳：午餐 NT$100" }).first()).toBeVisible();
  await expect(page.getByText("午餐", { exact: true })).toHaveCount(0);
});
