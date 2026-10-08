import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homeBrowser, A, B, OWNER, PARTNER, LARGE_BALANCE, LARGE_AMOUNT, LONG_NAME, deferred, switchLedger } from "./fixtures/p2-e-browser";
import { fillEntry, homeAction, homeSurface } from "./fixtures/p1-b-browser";

const balance = (page: Page) => page.getByTestId("ledger-balance");
const timeline = (page: Page) => page.getByTestId("ledger-timeline");
const more = (page: Page) => page.getByRole("button", { name: "更多", exact: true });
const rows = (page: Page) => timeline(page).locator("button[data-transaction-id]");
const dialog = (page: Page) => page.getByRole("dialog");

async function start(page: Page, options: Parameters<typeof homeBrowser>[1] = {}) {
  const fixture = await homeBrowser(page, options); await fixture.goto(); await fixture.ready(); return fixture;
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
}
async function firstFold(page: Page) {
  await expect(page.getByTestId("ledger-name-trigger")).toBeInViewport({ ratio: 1 });
  await expect(balance(page)).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("quick-entry-trigger")).toBeInViewport({ ratio: 1 });
  const visible = await page.evaluate(() => {
    const boundary = document.querySelector('[data-testid="home-entry-action"]')!.getBoundingClientRect().top;
    return [...document.querySelectorAll('[data-testid="ledger-timeline"] button[data-transaction-id]')].filter(node => { const r = node.getBoundingClientRect(); return r.top >= 0 && r.bottom <= boundary; }).length;
  });
  expect(visible).toBeGreaterThanOrEqual(3);
}
async function capture(page: Page, info: TestInfo, name: string) {
  const directory = `output/playwright/p2-e/${info.project.name}`; mkdirSync(directory, { recursive: true });
  await noOverflow(page);
  const metrics = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth,
    targets: [...document.querySelectorAll<HTMLElement>('header button,[data-testid="quick-entry-trigger"]')].map(node => ({ name: node.getAttribute("aria-label") ?? node.textContent, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })) }));
  for (const target of metrics.targets) { expect(target.width).toBeGreaterThanOrEqual(44); expect(target.height).toBeGreaterThanOrEqual(target.name === "記一筆" ? 52 : 44); }
  await page.screenshot({ path: `${directory}/${name}.png`, animations: "disabled" });
  await page.screenshot({ path: `${directory}/${name}-full.png`, fullPage: true, animations: "disabled" });
  writeFileSync(`${directory}/${name}.json`, JSON.stringify(metrics, null, 2));
}

test("Home has one location heading, direct header Search/More and the frozen semantic hierarchy", async ({ page }, info) => {
  await start(page, { balance: "2480", nextPayer: PARTNER });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("共同生活");
  await expect(page.getByTestId("ledger-name-trigger")).toHaveAccessibleName("共同生活，目前查看，切換帳本");
  await expect(page.locator("header button")).toHaveCount(3);
  await expect(page.getByTestId("home-search-trigger")).toHaveAccessibleName("搜尋紀錄");
  await expect(page.getByTestId("home-more-trigger")).toHaveAccessibleName("更多");
  await expect(page.getByRole("button", { name: "帳本設定", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /重新整理/ })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "帳本功能" })).toHaveCount(0);
  await expect(balance(page)).not.toContainText("共同生活");
  expect(await balance(page).evaluate(node => node.tagName)).toBe("SECTION");
  expect(await page.getByTestId("home-timeline-section").evaluate(node => node.tagName)).toBe("SECTION");
  await expect(page.getByRole("region", { name: "最近紀錄" })).toBeVisible();
  const structure = await page.getByTestId("ledger-home-core").evaluate(node => [...node.children].filter(child => child.getClientRects().length).map(child => child.getAttribute("data-testid") ?? child.textContent));
  expect(structure.slice(0, 3)).toEqual(["ledger-balance", "收支概況", "home-timeline-section"]);
  expect(await page.getByTestId("ledger-home-core").evaluate(node => [...node.querySelectorAll('*')].some(child => getComputedStyle(child).backgroundImage.includes("gradient")))).toBe(false);
  await expect(page.getByTestId("home-timeline-card")).toHaveCount(0);
  await firstFold(page); await capture(page, info, "normal-hierarchy");
});

for (const [value, label, payer] of [["2480", "你目前多付", PARTNER], ["-2480", "另一半目前多付", OWNER], ["0", "目前很平衡", PARTNER]] as const) test(`canonical ${value} displays ${label} without debt framing`, async ({ page }, info) => {
  await start(page, { balance: value, nextPayer: payer });
  await expect(balance(page).getByRole("heading")).toHaveText(label);
  if (value === "0") { await expect(balance(page)).toContainText("下次誰方便，就由誰付款"); await expect(balance(page)).not.toContainText("NT$0"); await expect(balance(page)).not.toContainText("下次建議"); }
  else { await expect(balance(page)).toContainText("NT$2,480"); await expect(balance(page)).toContainText(`下次建議由 ${payer === OWNER ? "你" : "另一半"} 付款`); await expect(balance(page).locator("p").first()).toHaveText(`${label} NT$2,480`); }
  await expect(balance(page)).not.toContainText("你欠"); await firstFold(page); await capture(page, info, `balance-${value}`);
});

test("next payer follows the supplied canonical recommendation, including one differing from the balance sign", async ({ page }) => {
  await start(page, { balance: "2480", nextPayer: OWNER }); await expect(balance(page)).toContainText("下次建議由 你 付款");
});
for (const payer of [null, "missing-member"]) test(`no payer fabrication when canonical next payer is ${payer}`, async ({ page }) => {
  await start(page, { balance: "2480", nextPayer: payer }); await expect(balance(page)).not.toContainText("下次建議由");
});

for (const value of [LARGE_BALANCE, `-${LARGE_BALANCE}`]) test(`BigInt complete absolute balance ${value} has no exponent, clipping or overflow`, async ({ page }, info) => {
  await start(page, { balance: value, nextPayer: PARTNER }); await expect(balance(page)).toContainText(LARGE_AMOUNT);
  await expect(balance(page)).not.toContainText("e+"); await capture(page, info, `large-${value.startsWith("-") ? "negative" : "positive"}`);
  expect(await balance(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test("zero-record Ledger is balanced, has an empty timeline and one valid Quick Entry", async ({ page }, info) => {
  await start(page, { count: 0 }); await expect(balance(page)).toContainText("目前很平衡");
  await expect(timeline(page)).toContainText("從一起花的第一筆開始"); await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "記一筆", exact: true })).toHaveCount(1);
  await capture(page, info, "zero-records");
  await page.getByTestId("quick-entry-trigger").click(); await expect(dialog(page)).toHaveAccessibleName("記一筆");
});

test("no-Ledger state has only the existing create flow, with no financial Home shell", async ({ page }, info) => {
  const fixture = await homeBrowser(page, { noLedger: true }); await fixture.goto();
  await expect(page.getByRole("heading", { name: "還沒有帳本" })).toBeVisible();
  await expect(page.getByText("建立一本帳本，開始一起記錄生活。")).toBeVisible();
  for (const id of ["ledger-balance", "ledger-timeline", "quick-entry-trigger", "home-more-trigger", "home-search-trigger"]) await expect(page.getByTestId(id)).toHaveCount(0);
  await capture(page, info, "no-ledger");
  await page.getByRole("button", { name: "建立帳本", exact: true }).click(); await expect(dialog(page)).toHaveAccessibleName("建立帳本");
  await page.getByLabel("新帳本名稱").fill("第一本"); await dialog(page).getByRole("button", { name: "建立", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("第一本"); await expect(page.getByTestId("quick-entry-trigger")).toBeVisible();
});

test("first bootstrap loading keeps accepted identity and quiet skeletons without fake zero/empty", async ({ page }, info) => {
  const fixture = await homeBrowser(page), hold = deferred(); fixture.state.holdReads.set(A, hold); await fixture.goto();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("共同生活");
  await expect(balance(page)).toHaveAttribute("aria-busy", "true"); await expect(balance(page).getByRole("status")).toHaveText("正在載入近況…");
  await expect(page.locator("[data-timeline-skeleton]")).toHaveCount(3);
  await expect(page.getByText("目前很平衡", { exact: true })).toHaveCount(0); await expect(page.getByText("從一起花的第一筆開始", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("quick-entry-trigger")).toHaveCount(0); await capture(page, info, "initial-loading");
  hold.release(); await fixture.ready();
});

test("initial read failure is unavailable, scoped and retryable, not an empty or valid submit state", async ({ page }, info) => {
  const fixture = await homeBrowser(page); fixture.state.failReads.set(A, 500); await fixture.goto();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("共同生活");
  await expect(page.locator("main").getByRole("alert")).toContainText("暫時讀不到這本帳本"); await expect(balance(page)).toContainText("暫時無法讀取近況");
  await expect(balance(page)).not.toContainText("NT$"); await expect(timeline(page)).toHaveCount(0); await expect(page.getByTestId("quick-entry-trigger")).toHaveCount(0);
  await capture(page, info, "initial-read-failure"); fixture.state.failReads.delete(A); await page.getByRole("button", { name: "重新讀取" }).click(); await fixture.ready();
});

test("known refresh failure keeps balance, payer and timeline, adds stale copy and contextual retry", async ({ page }, info) => {
  const fixture = await start(page, { balance: "2480", nextPayer: PARTNER }); const ids = await rows(page).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-transaction-id")));
  fixture.state.failReads.set(A, 500); await homeAction(page, "重新整理");
  await expect(balance(page)).toContainText("尚未更新"); await expect(balance(page)).toContainText("NT$2,480"); await expect(balance(page)).toContainText("下次建議由 另一半 付款");
  expect(await rows(page).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-transaction-id")))).toEqual(ids);
  await expect(page.locator("[data-timeline-skeleton]")).toHaveCount(0); await capture(page, info, "stale-known-data");
  fixture.state.failReads.delete(A); await page.getByRole("button", { name: "重新讀取" }).click(); await expect(balance(page)).not.toContainText("尚未更新");
});

test("read 401 remains a distinct authentication failure", async ({ page }) => {
  const fixture = await start(page); fixture.state.failReads.set(A, 401); await homeAction(page, "重新整理");
  await expect(page.getByRole("alert").filter({ hasText: "登入已失效" })).toBeVisible(); await expect(page.getByRole("button", { name: "重新登入" })).toBeVisible();
  await expect(balance(page)).toHaveCount(0); await expect(page.getByText("暫時讀不到這本帳本。", { exact: true })).toHaveCount(0);
});

test("More reuses one bounded host, makes no request/history change and restores focus", async ({ page }, info) => {
  const fixture = await start(page); await expect.poll(() => fixture.state.requests.filter(item => item.path.endsWith("/categories")).length).toBe(1);
  const requestCount = fixture.state.requests.length, url = page.url(), history = await page.evaluate(() => window.history.length);
  await more(page).focus(); await more(page).press("Enter"); await expect(dialog(page)).toHaveAccessibleName("更多");
  await expect(page.locator("#ledger-dialog-title")).toBeFocused(); await expect(page.locator("dialog[open]")).toHaveCount(1);
  await expect(dialog(page)).not.toHaveAttribute("data-full-height");
  await expect(dialog(page).getByRole("button")).toHaveText(["關閉", "帳本設定", "重新整理"]);
  expect(fixture.state.requests.length).toBe(requestCount); expect(page.url()).toBe(url); expect(await page.evaluate(() => window.history.length)).toBe(history);
  await capture(page, info, "home-more"); await page.keyboard.press("Escape"); await expect(more(page)).toBeFocused();
});

test("More Refresh performs only existing scoped reads and returns focus", async ({ page }) => {
  const fixture = await start(page); await expect.poll(() => fixture.state.requests.filter(item => item.path.endsWith("/categories")).length).toBe(1);
  const url = page.url(), count = await page.evaluate(() => history.length), readCount = fixture.state.requests.filter(item => item.path.endsWith("/bootstrap")).length;
  await homeAction(page, "重新整理"); await expect(dialog(page)).toHaveCount(0); await expect(more(page)).toBeFocused();
  await expect.poll(() => fixture.state.requests.filter(item => item.path.endsWith("/bootstrap")).length).toBe(readCount + 1);
  expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(count); expect(fixture.state.posts).toHaveLength(0);
});

for (const name of ["收支概況", "帳本設定", "搜尋"]) test(`${name} is reachable with existing scoped Back`, async ({ page }) => {
  await start(page); await homeSurface(page, name); await expect(page.getByTestId("surface-heading")).toContainText(name === "搜尋" ? "搜尋紀錄" : name);
  await expect(page.getByRole("button", { name: "返回帳本", exact: true })).toBeVisible(); await page.getByTestId("transaction-detail-back").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("共同生活"); await expect(page.getByTestId("quick-entry-trigger")).toBeVisible();
});

test("timeline stays 20+20 without an append request; Detail returns focus and scroll to its original row", async ({ page }) => {
  const fixture = await start(page); await expect(rows(page)).toHaveCount(20);
  const count = fixture.state.requests.length; await page.getByRole("button", { name: "更早紀錄" }).click(); await expect(rows(page)).toHaveCount(40); expect(fixture.state.requests).toHaveLength(count);
  const target = rows(page).nth(24); await target.scrollIntoViewIfNeeded(); const id = await target.getAttribute("data-transaction-id"), y = await page.evaluate(() => scrollY);
  await target.click(); await expect(page.locator("[data-detail-heading]")).toBeVisible(); await page.getByTestId("transaction-detail-back").click();
  await expect(page.locator(`button[data-transaction-id="${id}"]`)).toBeFocused(); expect(Math.abs(await page.evaluate(() => scrollY) - y)).toBeLessThan(3); await expect(rows(page)).toHaveCount(40);
});

test("A to B shows B identity/skeleton with neither A balance nor A rows", async ({ page }, info) => {
  const fixture = await start(page, { balance: "2480", nextPayer: PARTNER }), hold = deferred(); fixture.state.holdReads.set(B, hold);
  await switchLedger(page, B); await expect(page.getByRole("heading", { level: 1 })).toHaveText("旅行");
  await expect(balance(page)).not.toContainText("NT$2,480"); await expect(balance(page)).toHaveAttribute("aria-busy", "true"); await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText(/一起生活 \d/)).toHaveCount(0); await capture(page, info, "switch-loading-B"); hold.release(); await fixture.ready();
  await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText("旅行車票"); await expect(balance(page)).not.toContainText("NT$2,480");
});

for (const textSize of [100, 200]) test(`40-character Ledger name and huge balance wrap at ${textSize}% without obscuring header controls`, async ({ page }, info) => {
  expect(LONG_NAME.length).toBe(40); await start(page, { name: LONG_NAME, balance: LARGE_BALANCE, nextPayer: PARTNER });
  if (textSize === 200) await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(LONG_NAME); await expect(balance(page)).toContainText(LARGE_AMOUNT);
  const boxes = await page.locator("header button").evaluateAll(nodes => nodes.map(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })));
  expect(boxes[0]!.right).toBeLessThanOrEqual(boxes[1]!.left); expect(boxes[1]!.right).toBeLessThanOrEqual(boxes[2]!.left);
  await capture(page, info, `long-name-${textSize}`); await more(page).click(); await page.keyboard.press("Escape"); await expect(more(page)).toBeFocused();
  await page.getByTestId("quick-entry-trigger").click(); await expect(dialog(page)).toHaveAccessibleName("記一筆"); await noOverflow(page);
});

test("header keyboard order is identity, Search, More, followed by the quiet statistics target", async ({ page }) => {
  await start(page); await page.getByTestId("ledger-name-trigger").focus(); await page.keyboard.press("Tab"); await expect(page.getByTestId("home-search-trigger")).toBeFocused();
  await page.keyboard.press("Tab"); await expect(more(page)).toBeFocused(); await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name: "收支概況", exact: true })).toBeFocused();
});

test("Quick Entry create preserves one contextual success, canonical row/balance targeting and fresh draft", async ({ page }) => {
  const fixture = await start(page); await fillEntry(page, "剛加入", "680"); await dialog(page).getByRole("button", { name: "加入", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0); await expect(page.locator("[data-write-outcome]")).toHaveCount(1); await expect(page.locator("[data-write-outcome]")).toContainText("已加入剛加入 NT$680");
  await expect(page.getByRole("button", { name: /剛加入，支出/ })).toBeFocused(); expect(fixture.state.posts).toHaveLength(1);
  await page.getByTestId("quick-entry-trigger").click(); await expect(page.getByLabel("金額，新臺幣")).toHaveValue(""); await expect(page.getByLabel("用途", { exact: true })).toHaveValue("");
});

test("reduced motion retains the complete Home and More focus behavior", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); await start(page); await more(page).click(); await page.keyboard.press("Escape"); await expect(more(page)).toBeFocused();
  await firstFold(page); await noOverflow(page);
});
