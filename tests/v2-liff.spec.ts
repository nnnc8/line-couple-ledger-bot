import { expect, test, type Page, type Route } from "@playwright/test";

const OWNER = "00000000-0000-4000-8000-000000000001";
const PARTNER = "00000000-0000-4000-8000-000000000002";
const LEDGER = "00000000-0000-4000-8000-000000000010";
const TRANSACTION = "00000000-0000-4000-8000-000000000011";
const SECOND_LEDGER = "00000000-0000-4000-8000-000000000012";

type PostMode = "success" | "failure" | "fail-once" | "delay";

test.beforeEach(async ({ page }) => {
  let bootstrapCalls = 0;
  let postMode: PostMode = "success";
  let postRequests = 0;
  let postedBodies: Array<Record<string, unknown>> = [];
  let releasePost: (() => void) | null = null;
  let rows: Array<Record<string, unknown>> = [];
  let balance = { [OWNER]: "0", [PARTNER]: "0" };
  let nextPayer: Record<string, string> | null = null;
  let failRefresh = false;
  const requestPaths: string[] = [];

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) requestPaths.push(`${request.method()} ${url.pathname}${url.search}`);
  });

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
      balance,
      nextPayer,
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
      balance = { [OWNER]: "-50", [PARTNER]: "50" };
      nextPayer = { payerUserId: OWNER, payeeUserId: PARTNER, amountTwd: "50" };
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
  await page.route(`**/api/app/v2/transactions/${TRANSACTION}/mutate`, async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    if (body.action === "void") {
      rows = rows.map((row) => row.id === TRANSACTION ? { ...row, status: "voided", version: 2 } : row);
      balance = { [OWNER]: "0", [PARTNER]: "0" };
      nextPayer = null;
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("https://static.line-scdn.net/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Ledger", exact: true })).toBeVisible();

  (page as typeof page & { __v2Controls?: unknown }).__v2Controls = { setPostMode: (mode: PostMode) => { postMode = mode; }, releasePost: () => releasePost?.(), getPostRequests: () => postRequests, getPostedBodies: () => postedBodies, setFailRefresh: (value: boolean) => { failRefresh = value; }, setBalance: (owner: string, partner: string) => { balance = { [OWNER]: owner, [PARTNER]: partner }; nextPayer = Number(owner) === 0 ? null : { payerUserId: Number(owner) > 0 ? PARTNER : OWNER, payeeUserId: Number(owner) > 0 ? OWNER : PARTNER, amountTwd: String(Math.abs(Number(owner))) }; }, getRequestPaths: () => requestPaths };
});

function controls(page: Page) {
  return (page as typeof page & { __v2Controls: { setPostMode: (mode: PostMode) => void; releasePost: () => void; getPostRequests: () => number; getPostedBodies: () => Array<Record<string, unknown>>; setFailRefresh: (value: boolean) => void; setBalance: (owner: string, partner: string) => void; getRequestPaths: () => string[] } }).__v2Controls;
}

test("uses the V2 startup request budget", async ({ page }) => {
  await expect.poll(() => controls(page).getRequestPaths().filter((path) => path.includes("/categories")).length).toBe(1);
  const requests = controls(page).getRequestPaths();
  expect(requests.filter((path) => path === "POST /api/app/session")).toHaveLength(1);
  expect(requests.filter((path) => path === "GET /api/app/v2/context")).toHaveLength(1);
  expect(requests.filter((path) => path === "GET /api/app/v2/ledgers")).toHaveLength(1);
  expect(requests.filter((path) => path === `GET /api/app/v2/ledgers/${LEDGER}/bootstrap`)).toHaveLength(1);
  expect(requests.some((path) => path.includes("/api/app/bootstrap"))).toBe(false);
  expect(requests.some((path) => path.includes("/statistics") || path.includes("/recurring") || path.includes("/transactions?"))).toBe(false);
});

test("loads statistics and recurring rules only when their secondary UI is opened", async ({ page }) => {
  await page.getByRole("tab", { name: "統計" }).click();
  await expect.poll(() => controls(page).getRequestPaths().filter((path) => path.includes("/statistics")).length).toBe(1);
  await page.getByRole("tab", { name: "設定" }).click();
  await expect.poll(() => controls(page).getRequestPaths().filter((path) => path.includes("/recurring")).length).toBe(1);
});

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
  await expect(page.getByRole("heading", { name: "另一半目前多付" })).toBeVisible();
  await expect(page.getByText("NT$50", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("下次建議由 你 付款", { exact: true })).toBeVisible();
  await expect(page.getByLabel("金額 TWD")).toHaveValue("");
  await expect(page.getByLabel("說明")).toHaveValue("");
  await expect(page.getByLabel("交易類型")).toHaveValue("expense");
  await expect(page.getByLabel("分攤方式")).toHaveValue("weights");
  expect(controls(page).getPostedBodies()[0]).toMatchObject({ type: "expense", amountTwd: "100", occurredOn: "2026-08-28", splitMethod: "weights", payments: [{ userId: OWNER, amountTwd: "100" }] });
});

test("keeps uncommon transaction choices behind more settings", async ({ page }) => {
  await expect(page.getByLabel("交易類型")).not.toBeVisible();
  await expect(page.getByLabel("分攤方式")).not.toBeVisible();
  await page.getByText("更多設定", { exact: true }).click();
  await expect(page.getByLabel("交易類型")).toHaveValue("expense");
  await page.getByLabel("付款人").first().selectOption("partner");
  await expect(page.getByLabel("付款人").first()).toHaveValue("partner");
  await page.getByLabel("付款人").first().selectOption("both");
  await expect(page.getByLabel("你 金額").first()).toBeVisible();
  await expect(page.getByLabel("另一半 金額").first()).toBeVisible();
  await page.getByLabel("分攤方式").first().selectOption("percentage");
  await expect(page.getByLabel("你 百分比").first()).toBeVisible();
  await page.getByLabel("分攤方式").first().selectOption("exact");
  await expect(page.getByLabel("你 分攤").first()).toBeVisible();
  await page.getByLabel("交易類型").first().selectOption("income");
  await expect(page.getByLabel("收款人").first()).toBeVisible();
  await page.getByLabel("交易類型").first().selectOption("transfer");
  await expect(page.getByLabel("發送人").first()).toBeVisible();
  await expect(page.getByLabel("分攤方式").first()).not.toBeVisible();
  await expect(page.getByText("轉帳會記錄發送人 → 接收人，不會出現支出分攤選項。")).toBeVisible();
});

test("uses continuous balance language for either payer and balanced state", async ({ page }) => {
  controls(page).setBalance("50", "-50");
  await page.getByLabel("重新載入 Ledger").click();
  await expect(page.getByRole("heading", { name: "你目前多付" })).toBeVisible();
  await expect(page.getByText("下次建議由 另一半 付款", { exact: true })).toBeVisible();
  controls(page).setBalance("0", "0");
  await page.getByLabel("重新載入 Ledger").click();
  await expect(page.getByRole("heading", { name: "目前很平衡" })).toBeVisible();
  await expect(page.getByText(/欠|全部結清|轉帳／結清/)).toHaveCount(0);
});

test("keeps the daily UI usable on a narrow mobile viewport", async ({ page }) => {
  await expect(page.getByRole("button", { name: "儲存交易" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "output/playwright/v2-visual/quick-entry.png", fullPage: true });
  await page.getByText("更多設定", { exact: true }).click();
  await page.screenshot({ path: "output/playwright/v2-visual/advanced-entry.png", fullPage: true });
  await page.getByLabel("交易類型").first().selectOption("transfer");
  await expect(page.getByText("轉帳會記錄發送人 → 接收人，不會出現支出分攤選項。")).toBeVisible();
  await page.screenshot({ path: "output/playwright/v2-visual/transfer.png", fullPage: true });
  await page.getByLabel("交易類型").first().selectOption("expense");
  await page.getByText("更多設定", { exact: true }).click();
  await page.getByRole("tab", { name: "統計" }).click();
  await page.screenshot({ path: "output/playwright/v2-visual/statistics.png", fullPage: true });
  await page.getByRole("tab", { name: "設定" }).click();
  await page.screenshot({ path: "output/playwright/v2-visual/settings.png", fullPage: true });
});

test("keeps voided transactions distinct in the mobile history", async ({ page }) => {
  await page.getByLabel("金額 TWD").fill("100");
  await page.getByLabel("說明").fill("午餐");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(page.getByText("午餐", { exact: true }).last()).toBeVisible();
  await page.getByText("午餐", { exact: true }).last().click();
  await page.getByRole("button", { name: "作廢" }).click();
  await expect(page.getByText("午餐（已作廢）", { exact: true })).toBeVisible();
  await page.screenshot({ path: "output/playwright/v2-visual/voided-transaction.png", fullPage: true });
});

test("uses the canonical save response without reloading the Ledger", async ({ page }) => {
  controls(page).setFailRefresh(true);
  await page.getByLabel("金額 TWD").fill("100");
  await page.getByLabel("說明").fill("午餐");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(page.getByRole("status").filter({ hasText: "已入帳：午餐 NT$100" }).first()).toBeVisible();
  await expect.poll(() => controls(page).getRequestPaths().filter((path) => path === `GET /api/app/v2/ledgers/${LEDGER}/bootstrap`).length).toBe(1);
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

// V3-0: every response is deliberately released by the test, independent of timing.
function scopeBootstrap(id: string, name: string) {
  return { ledger: { id, name, color: "#173B63", status: "active", version: 1,
    coupleId: 1, members: [{ userId: OWNER, role: "owner" }, { userId: PARTNER, role: "partner" }],
    defaultShares: { [OWNER]: "1", [PARTNER]: "1" } }, transactions: [], balance: { [OWNER]: "0", [PARTNER]: "0" }, nextPayer: null };
}

async function twoLedgers(page: Page) {
  await page.route("**/api/app/v2/ledgers", route => route.fulfill({ json: { ledgers: [scopeBootstrap(LEDGER, "Scope A").ledger, scopeBootstrap(SECOND_LEDGER, "Scope B").ledger] } }));
  await page.route("**/api/app/v2/ledgers/*/activate", route => route.fulfill({ json: { ok: true } }));
  for (const [id, name] of [[LEDGER, "Scope A"], [SECOND_LEDGER, "Scope B"]]) {
    await page.route(`**/api/app/v2/ledgers/${id}/bootstrap`, route => route.fulfill({ json: scopeBootstrap(id!, name!) }));
    await page.route(`**/api/app/v2/ledgers/${id}/categories`, route => route.fulfill({ json: { categories: [] } }));
    await page.route(`**/api/app/v2/ledgers/${id}/recurring`, route => route.fulfill({ json: { recurring: [] } }));
    await page.route(`**/api/app/v2/ledgers/${id}/statistics`, route => route.fulfill({ json: { byType: {}, byCategory: { [name!]: "73" }, paidBy: {}, borneBy: {} } }));
    await page.route(`**/api/app/v2/ledgers/${id}/transactions?*`, route => route.fulfill({ json: { transactions: [], nextCursor: null } }));
  }
  await page.reload();
  await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("Scope A");
}

async function releaseScopeResponse(page: Page, route: Route, reply: Parameters<Route["fulfill"]>[0]) {
  const received = page.waitForResponse(response => response.url() === route.request().url());
  await route.fulfill(reply);
  await (await received).finished();
  // Wait for the completed response's React update, not an arbitrary delay.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("V3-0 ignores reversed bootstrap responses and resets the Ledger draft", async ({ page }) => {
  await twoLedgers(page);
  const held: Route[] = [];
  await page.route(`**/api/app/v2/ledgers/${LEDGER}/bootstrap`, route => { held.push(route); });
  await page.getByLabel("金額 TWD").fill("731");
  await page.getByLabel("說明").fill("A draft");
  await page.getByLabel("重新載入 Ledger").click();
  await expect.poll(() => held.length).toBe(1);
  await page.getByLabel("切換 Ledger").selectOption(SECOND_LEDGER);
  const card = page.locator('[style*="linear-gradient"]').first();
  await expect(card).toContainText("Scope B");
  await releaseScopeResponse(page, held[0]!, { json: scopeBootstrap(LEDGER, "STALE A") });
  // An independent B request gives the browser an observable processing barrier.
  await page.getByRole("tab", { name: "統計" }).click();
  await expect(page.getByText("Scope B", { exact: true }).last()).toBeVisible();
  await expect(card).toContainText("Scope B");
  await expect(page.getByLabel("金額 TWD")).toHaveValue("");
  await expect(page.getByLabel("說明")).toHaveValue("");
  await page.screenshot({ path: "output/playwright/v3-0/ledger-scope.png", fullPage: true });
});

test("V3-0 rapid A B A switches ignore the first A generation and stale errors", async ({ page }) => {
  await twoLedgers(page);
  const held: Route[] = [];
  await page.route(`**/api/app/v2/ledgers/${LEDGER}/bootstrap`, route => { held.push(route); });
  await page.getByLabel("重新載入 Ledger").click();
  await expect.poll(() => held.length).toBe(1);
  await page.getByLabel("切換 Ledger").selectOption(SECOND_LEDGER);
  await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("Scope B");
  await page.getByLabel("切換 Ledger").selectOption(LEDGER);
  await expect.poll(() => held.length).toBe(2);
  await held[1]!.fulfill({ json: scopeBootstrap(LEDGER, "NEW A") });
  await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("NEW A");
  await releaseScopeResponse(page, held[0]!, { status: 503, json: { error: "STALE ERROR" } });
  await page.getByLabel("金額 TWD").fill("12");
  await expect(page.getByText("STALE ERROR", { exact: true })).toHaveCount(0);
  await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("NEW A");
});

for (const endpoint of ["statistics", "categories", "recurring", "transactions"] as const) {
  test(`V3-0 ignores reversed ${endpoint} responses across Ledgers`, async ({ page }) => {
    await twoLedgers(page);
    const held: Route[] = [];
    await page.route(`**/api/app/v2/ledgers/${LEDGER}/${endpoint}${endpoint === "transactions" ? "?*" : ""}`, route => { held.push(route); });
    if (endpoint === "statistics") await page.getByRole("tab", { name: "統計" }).click();
    if (endpoint === "recurring") await page.getByRole("tab", { name: "設定" }).click();
    if (endpoint === "categories") await page.getByLabel("重新載入 Ledger").click();
    if (endpoint === "transactions") await page.getByLabel("搜尋 Ledger 流水").fill("STALE");
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await page.getByLabel("切換 Ledger").selectOption(SECOND_LEDGER);
    await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("Scope B");
    await page.getByRole("tab", { name: endpoint === "statistics" ? "統計" : endpoint === "transactions" ? "流水" : "設定" }).click();
    const json = endpoint === "statistics" ? { byType: {}, byCategory: { STALE: "731" }, paidBy: {}, borneBy: {} }
      : endpoint === "categories" ? { categories: [{ id: "stale-cat", ledgerId: LEDGER, name: "STALE", status: "active" }] }
      : endpoint === "recurring" ? { recurring: [{ id: "stale-rule", ledgerId: LEDGER, name: "STALE", amountTwd: "731", frequency: "monthly", nextRunDate: "2026-09-14", active: true }] }
      : { transactions: [{ id: TRANSACTION, ledgerId: LEDGER, type: "expense", amountTwd: "731", description: "STALE", status: "posted", occurredOn: "2026-09-14", payments: [], shares: [] }], nextCursor: null };
    for (const route of held) {
      if (endpoint === "transactions") await route.fulfill({ json }).catch(() => undefined); // history was aborted by the switch
      else await releaseScopeResponse(page, route, { json });
    }
    await page.getByLabel("金額 TWD").fill("12");
    await expect(page.getByText(/STALE/)).toHaveCount(0);
    await expect(page.getByLabel("STALE 分類名稱", { exact: true })).toHaveCount(0);
    await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("Scope B");
  });
}

test("V3-0 switching Ledger after a deep link stays on the manual selection", async ({ page }) => {
  await twoLedgers(page);
  await page.goto(`/?v2Ledger=${LEDGER}`);
  await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("Scope A");
  const activations: string[] = [];
  await page.route("**/api/app/v2/ledgers/*/activate", route => {
    activations.push(route.request().url().split("/").at(-2)!);
    return route.fulfill({ json: { ok: true } });
  });
  await page.getByLabel("切換 Ledger").selectOption(SECOND_LEDGER);
  await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("Scope B");
  await expect.poll(() => activations.length).toBeGreaterThan(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(activations).toEqual([SECOND_LEDGER]);
  await expect(page.getByLabel("切換 Ledger")).toHaveValue(SECOND_LEDGER);
});


test("V3-0 a late A save cannot update B feedback or reuse A's draft/key", async ({ page }) => {
  await twoLedgers(page);
  let held: Route | undefined;
  const requests: Array<{ ledger: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/app/v2/ledgers/*/transactions", route => {
    if (route.request().method() !== "POST") return route.fallback();
    const ledger = route.request().url().includes(SECOND_LEDGER) ? SECOND_LEDGER : LEDGER;
    requests.push({ ledger, body: route.request().postDataJSON() as Record<string, unknown> });
    if (ledger === LEDGER) { held = route; return; }
    return route.fulfill({ status: 422, json: { error: "B rejection" } });
  });
  await page.getByLabel("金額 TWD").fill("100");
  await page.getByLabel("說明").fill("late-A");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.getByLabel("切換 Ledger").selectOption(SECOND_LEDGER);
  await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("Scope B");
  await releaseScopeResponse(page, held!, { status: 422, json: { error: "STALE SAVE ERROR" } });
  await expect(page.getByText("STALE SAVE ERROR", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("金額 TWD")).toHaveValue("");
  await page.getByLabel("金額 TWD").fill("100");
  await page.getByLabel("說明").fill("late-A");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "B rejection" }).first()).toBeVisible();
  expect(requests.map(request => request.ledger)).toEqual([LEDGER, SECOND_LEDGER]);
  expect(requests[0]!.body.idempotencyKey).not.toBe(requests[1]!.body.idempotencyKey);
});
