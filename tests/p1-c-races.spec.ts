import { test, expect, type Page } from "@playwright/test";
import { navigationBrowser, A, B, TA, row, deferred, switchLedger, activationRequests } from "./fixtures/p1-c-browser";

const home = (id = A) => `/?v2Ledger=${id}`;
const heading = (page: Page) => page.getByTestId("surface-heading");

test("native push and replace remain observable and preserve unrelated and Next state", async ({ page }) => {
  const fixture = await navigationBrowser(page); await fixture.goto(); await fixture.ready();
  const errors: string[] = [];
  page.on("console", event => { if (/useInsertionEffect|Maximum update depth/.test(event.text())) errors.push(event.text()); });
  await page.evaluate(() => history.pushState({ ...history.state, custom: { keep: 42 } }, "", `${location.pathname}${location.search}&tab=stats`));
  await expect(heading(page)).toContainText("收支概況");
  await page.evaluate(() => history.replaceState({ ...history.state }, "", location.href.replace("tab=stats", "tab=settings")));
  await expect(heading(page)).toContainText("帳本設定");
  expect(await page.evaluate(() => history.state.custom)).toEqual({ keep: 42 });
  expect(await page.evaluate(() => Boolean(history.state.__NA && history.state.__PRIVATE_NEXTJS_INTERNALS_TREE))).toBe(true);
  await page.getByRole("button", { name: "返回帳本", exact: true }).click();
  await fixture.ready(); expect(await page.evaluate(() => history.state.custom)).toEqual({ keep: 42 });
  expect(errors).toEqual([]);
});

test("LIFF redirect parameters are untouched until init resolves", async ({ page }) => {
  const fixture = await navigationBrowser(page, { holdLiffInit: true });
  const path = `/?liff.state=${encodeURIComponent(`?v2Ledger=${B}&tab=stats`)}&liff.referrer=line&unrelated=keep`;
  await fixture.goto(path);
  await expect(page.getByText("正在連線至 LINE…")).toBeVisible();
  // Server-rendered loading text can appear before hydration invokes liff.init.
  await page.waitForFunction(() => typeof (window as unknown as { releaseLiff: unknown }).releaseLiff === "function");
  expect(new URL(page.url()).search).toBe(path.slice(1)); expect(fixture.state.requests).toHaveLength(0);
  await page.evaluate(() => (window as unknown as { releaseLiff: () => void }).releaseLiff());
  await expect(heading(page)).toContainText("旅行 · 收支概況");
  expect(new URL(page.url()).searchParams.get("liff.referrer")).toBe("line");
  expect(new URL(page.url()).searchParams.get("unrelated")).toBe("keep");
  expect(fixture.state.requests.some(request => request.path.includes(`${A}/`))).toBe(false);
});

test("delayed deep-link B cannot pull a subsequent manual A selection back", async ({ page }) => {
  const fixture = await navigationBrowser(page), hold = deferred(); fixture.state.holdReads.set(B, hold);
  await fixture.goto(home(B)); await expect(heading(page)).toContainText("旅行");
  await switchLedger(page, A); await fixture.ready(); hold.release();
  await expect(page).toHaveURL(new RegExp(`v2Ledger=${A}$`));
  await expect(page.getByText("A 專屬晚餐", { exact: true })).toBeVisible();
  expect(activationRequests(fixture.state).map(request => request.path)).toEqual([`/api/app/v2/ledgers/${A}/activate`]);
});

for (const failure of [false, true]) test(`A-B-A late first A bootstrap ${failure ? "failure" : "success"} cannot overwrite new A`, async ({ page }) => {
  const fixture = await navigationBrowser(page); await fixture.goto(); await fixture.ready();
  const hold = deferred(); fixture.state.holdReads.set(A, hold); if (failure) fixture.state.failReads.set(A, 500);
  const before = fixture.state.requests.length;
  await page.getByRole("button", { name: "重新整理帳本" }).click();
  await expect.poll(() => fixture.state.requests.slice(before).some(item => item.path.endsWith(`${A}/bootstrap`))).toBe(true);
  await switchLedger(page, B); await fixture.ready();
  fixture.state.holdReads.delete(A); fixture.state.failReads.delete(A); fixture.state.version += 1;
  fixture.state.rows = fixture.state.rows.map(item => item.id === TA ? { ...item, description: "CURRENT A" } : item);
  await switchLedger(page, A); await fixture.ready(); await expect(page.getByText("CURRENT A", { exact: true })).toBeVisible();
  hold.release(); await page.waitForTimeout(100);
  await expect(page.getByText("CURRENT A", { exact: true })).toBeVisible(); await expect(page.getByText(/fixture read failure/)).toHaveCount(0);
});

for (const endpoint of ["categories", "recurring", "statistics", "history"] as const) for (const failure of [false, true]) {
  test(`A-B-A late ${endpoint} ${failure ? "failure" : "success"} stays in its generation`, async ({ page }) => {
    const fixture = await navigationBrowser(page), hold = deferred(); let reads = 0;
    const path = endpoint === "history" ? "transactions*" : endpoint;
    await page.route(`**/api/app/v2/ledgers/${A}/${path}`, async route => {
      const request = ++reads;
      if (request === 1) await hold.promise;
      if (request === 1 && failure) return route.fulfill({ status: 500, json: { error: "STALE A ERROR" } }).catch(() => undefined);
      const marker = request === 1 ? "STALE A" : "CURRENT A";
      const json = endpoint === "categories" ? { categories: [{ id: "category", ledgerId: A, name: marker, status: "active" }] }
        : endpoint === "recurring" ? { recurring: [{ id: "recurring", name: marker, amountTwd: "200", frequency: "monthly", nextRunDate: "2026-10-01", active: true, splitMethod: "equal" }] }
          : endpoint === "statistics" ? { byType: { expense: "200" }, byCategory: { [marker]: "200" }, paidBy: {}, borneBy: {} }
            : { transactions: [row(A, TA, marker)], nextCursor: null };
      return route.fulfill({ json }).catch(() => undefined);
    });
    const query = endpoint === "recurring" ? "&tab=recurring" : endpoint === "statistics" ? "&tab=stats" : endpoint === "history" ? "&view=search&q=A" : "";
    await fixture.goto(home() + query); await expect.poll(() => reads).toBe(1);
    await switchLedger(page, B); await fixture.ready(); await switchLedger(page, A); await fixture.ready();
    if (endpoint === "recurring") await page.getByRole("button", { name: "帳本設定", exact: true }).click();
    if (endpoint === "statistics") await page.getByRole("button", { name: "收支概況", exact: true }).click();
    if (endpoint === "history") { await page.getByRole("button", { name: "搜尋", exact: true }).click(); await page.getByLabel("搜尋紀錄").fill("A"); }
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    if (endpoint === "categories") { await page.getByText("更多", { exact: true }).click(); await expect(page.getByLabel("分類", { exact: true }).locator("option", { hasText: "CURRENT A" })).toHaveCount(1); }
    else await expect(page.getByText(/CURRENT A/).first()).toBeVisible();
    hold.release(); await page.waitForTimeout(100);
    await expect(page.getByText(/STALE A/)).toHaveCount(0);
    if (endpoint === "categories") await expect(page.getByLabel("分類", { exact: true }).locator("option", { hasText: "CURRENT A" })).toHaveCount(1);
    else await expect(page.getByText(/CURRENT A/).first()).toBeVisible();
  });
}

test("same-ledger Detail identity change cannot reuse previous attachments", async ({ page }) => {
  const fixture = await navigationBrowser(page), secondId = "00000000-0000-4000-8000-000000000012";
  fixture.state.rows.push(row(A, secondId, "第二筆"));
  await page.route(`**/api/app/v2/transactions/${TA}/attachments`, route => route.fulfill({ json: { attachments: [{ id: "first-receipt", mimeType: "application/pdf", createdAt: "2026-09-25T00:00:00Z", url: "https://example.invalid/receipt" }] } }));
  await fixture.goto(`${home()}&v2Transaction=${TA}`); await page.getByRole("button", { name: "更多操作", exact: true }).click(); await expect(page.getByRole("link", { name: /PDF 收據/ })).toBeVisible();
  await page.evaluate(url => history.pushState({}, "", url), `${home()}&v2Transaction=${secondId}`);
  await expect(page.getByText("第二筆", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "更多操作", exact: true }).click(); await expect(page.getByText("尚無收據")).toBeVisible();
  await expect(page.getByRole("link", { name: /PDF 收據/ })).toHaveCount(0);
});

test("search failure is visible on Search and absent after leaving its scope", async ({ page }) => {
  const fixture = await navigationBrowser(page); await fixture.goto(); await fixture.ready();
  await page.route(`**/api/app/v2/ledgers/${A}/transactions*`, route => route.fulfill({ status: 500, json: { error: "SEARCH READ FAILED" } }));
  await page.getByRole("button", { name: "搜尋", exact: true }).click(); await page.getByLabel("搜尋紀錄").fill("query");
  await expect(page.getByRole("alert").filter({ hasText: "SEARCH READ FAILED" })).toBeVisible();
  await page.getByRole("button", { name: "返回帳本", exact: true }).click(); await fixture.ready();
  await expect(page.getByText("SEARCH READ FAILED")).toHaveCount(0);
});

test("same-ledger proposal compatibility responses stay with their proposal id", async ({ page }) => {
  const fixture = await navigationBrowser(page), hold = deferred();
  await page.route("**/api/app/v2/proposals/first", async route => { await hold.promise; await route.fulfill({ json: { status: "proposed" } }).catch(() => undefined); });
  await page.route("**/api/app/v2/proposals/second", route => route.fulfill({ json: { status: "cancelled" } }));
  await fixture.goto("/?v2Proposal=first"); await expect(heading(page)).toHaveText("LINE 待確認草稿");
  await expect.poll(() => fixture.state.requests.some(item => item.path.endsWith("proposals/first"))).toBe(true);
  await page.evaluate(() => history.replaceState({}, "", "/?v2Proposal=second"));
  await expect(page.getByText("狀態：已取消", { exact: true })).toBeVisible(); hold.release();
  await expect(page.getByRole("button", { name: "確認入帳" })).toHaveCount(0);
  expect(activationRequests(fixture.state)).toHaveLength(0);
});

for (const mode of ["delay", "drop"] as const) test(`popstate while ${mode === "delay" ? "SUBMITTING" : "UNKNOWN"} keeps original scope and sends no destination request`, async ({ page }) => {
  const fixture = await navigationBrowser(page); await fixture.goto(home(B)); await fixture.ready();
  await page.evaluate(url => history.pushState({}, "", url), home()); await fixture.ready();
  fixture.state.mode = mode;
  await page.getByLabel("金額，新臺幣").fill("681"); await page.getByLabel("用途", { exact: true }).fill("受保護的操作");
  await page.getByRole("button", { name: "加入" }).click(); await expect.poll(() => fixture.state.posts.length).toBe(1);
  if (mode === "drop") await expect(page.locator("[data-write-outcome]")).toContainText("尚未確認");
  const before = fixture.state.requests.length;
  await page.evaluate(() => history.back()); await expect(page.getByRole("dialog")).toContainText(mode === "delay" ? "完成後才能切換" : "結果還沒確認");
  await expect(page).toHaveURL(new RegExp(`v2Ledger=${A}$`));
  expect(fixture.state.requests.slice(before).filter(item => item.path.includes(`${B}/`))).toEqual([]);
  expect(activationRequests(fixture.state)).toEqual([]);
  await page.keyboard.press("Escape");
  if (mode === "delay") { fixture.state.postHold!.release(); await expect(page.locator("[data-write-outcome]")).toContainText("已加入受保護的操作"); }
  expect(fixture.state.posts).toHaveLength(1); expect(fixture.state.posts[0]!.endpoint).toContain(A);
});

test("late refresh and background resume do not steal editing focus", async ({ page }) => {
  const fixture = await navigationBrowser(page); await fixture.goto(); await fixture.ready();
  const hold = deferred(); fixture.state.holdReads.set(A, hold);
  await page.getByRole("button", { name: "重新整理帳本" }).click();
  await expect.poll(() => fixture.state.requests.filter(item => item.path.endsWith("/bootstrap")).length).toBe(2);
  const field = page.getByLabel("用途", { exact: true }); await field.fill("保持編輯位置");
  await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); });
  hold.release(); await expect(page.getByLabel("金額，新臺幣")).toBeEnabled(); await expect(page.getByRole("button", { name: "加入" })).toBeDisabled();
  await expect(field).toBeFocused(); await expect(field).toHaveValue("保持編輯位置");
});

for (const label of ["收支概況", "帳本設定", "搜尋"]) test(`${label} Back restores Home scroll; reload resets it`, async ({ page }) => {
  const fixture = await navigationBrowser(page);
  fixture.state.rows.push(...Array.from({ length: 30 }, (_, index) => row(A, `scroll-${index}`, `滾動 ${index}`)));
  await fixture.goto(); await fixture.ready();
  await page.getByRole("button", { name: "更早紀錄", exact: true }).click();
  await page.getByRole("button", { name: /滾動 15/ }).scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => scrollY); expect(before).toBeGreaterThan(500);
  await page.getByRole("button", { name: label, exact: true }).evaluate(element => (element as HTMLElement).click());
  await expect(heading(page)).toBeFocused(); await page.getByRole("button", { name: "返回帳本", exact: true }).click();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(before - 100);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeLessThan(before + 100);
  await page.reload(); await fixture.ready(); await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
});

for (const field of ["新增自訂分類", "週期交易名稱"]) test(`unsaved setting ${field} shares the leave host and preserves focus on cancel`, async ({ page }) => {
  const fixture = await navigationBrowser(page); await fixture.goto(`${home()}&tab=${field === "週期交易名稱" ? "recurring" : "settings"}`);
  if (field === "週期交易名稱") await page.getByRole("button", { name: "新增", exact: true }).click();
  const input = page.getByLabel(field, { exact: true }); await input.fill("未儲存設定");
  await switchLedger(page, B); await expect(page.getByRole("dialog")).toHaveAccessibleName("放棄尚未儲存的設定？");
  expect(activationRequests(fixture.state)).toEqual([]);
  await page.getByRole("dialog").getByRole("button", { name: "繼續編輯" }).click();
  await expect(input).toHaveValue("未儲存設定"); await expect(input).toBeFocused();
  await switchLedger(page, B); await page.getByRole("dialog").getByRole("button", { name: "放棄並切換" }).click();
  await fixture.ready(); await expect(page).toHaveURL(new RegExp(`v2Ledger=${B}$`));
  expect(fixture.state.posts).toHaveLength(0);
});

for (const tab of ["stats", "recurring", "search"]) for (const code of [401, 500]) test(`${tab} read ${code} offers the correct recovery action without changing Ledger preference`, async ({ page }) => {
  const fixture = await navigationBrowser(page);
  const endpoint = tab === "stats" ? "statistics" : tab === "search" ? "transactions*" : "recurring";
  let failed = true, reads = 0;
  await page.route(`**/api/app/v2/ledgers/${A}/${endpoint}`, route => {
    reads += 1;
    return failed ? route.fulfill({ status: code, json: { error: "SECONDARY READ FAILED" } }) : route.fallback();
  });
  await fixture.goto(`${home()}&${tab === "search" ? "view=search&q=A" : `tab=${tab}`}`);
  const error = page.getByRole("alert").filter({ hasText: "SECONDARY READ FAILED" });
  await expect(error).toBeVisible();
  const button = error.getByRole("button", { name: code === 401 ? "重新登入" : "重新讀取", exact: true });
  await expect(button).toBeVisible();
  if (code === 500) {
    if (tab === "recurring") { await page.getByRole("button", { name: "新增", exact: true }).click(); await page.getByLabel("週期交易名稱").fill("保留尚未儲存設定"); }
    const requests = fixture.state.requests.length; failed = false; await button.click();
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2); await expect(error).toHaveCount(0);
    expect(fixture.state.requests.slice(requests).some(item => item.path.endsWith("/bootstrap"))).toBe(false);
    if (tab === "recurring") await expect(page.getByLabel("週期交易名稱")).toHaveValue("保留尚未儲存設定");
  }
  expect(activationRequests(fixture.state)).toEqual([]);
});

test("stale app-origin row marker falls back to a surviving Home row", async ({ page }) => {
  const fixture = await navigationBrowser(page); await fixture.goto(); await fixture.ready();
  await page.getByRole("button", { name: /A 專屬晚餐/ }).click();
  // Simulate an origin from an older Home snapshot without violating the P1-B
  // bootstrap invariant that an accepted read cannot erase a known transaction.
  await page.evaluate(() => history.replaceState({ ...history.state, v2LedgerOrigin: { ...history.state.v2LedgerOrigin, rowId: "removed-row" } }, "", `${location.href}&revision=2`));
  await expect(page).toHaveURL(/revision=2/); await expect(page.locator("[data-detail-heading]")).toBeFocused();
  await page.getByRole("button", { name: "返回帳本", exact: true }).click();
  await expect(page.getByRole("button", { name: /A 專屬晚餐/ })).toBeFocused();
  expect(fixture.state.posts).toHaveLength(0);
});
