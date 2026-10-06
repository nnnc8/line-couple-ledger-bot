import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { ENTRY_RECOVERY_KEY } from "../src/lib/v2-entry-operation";
import { effectiveTimelineTransactions } from "../src/lib/v2-timeline";
import { entryBrowser, fillEntry, openEntry, LEDGER, OTHER, OWNER, PARTNER } from "./fixtures/p1-b-browser";
import { row } from "./fixtures/p1-c-browser";
import { timelineBrowser } from "./fixtures/p2-c-browser";

test.use({ video: "on" });
test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date("2026-09-25T04:00:00Z")); });
const dialog = (page: Page) => page.getByRole("dialog");
const amount = (page: Page) => page.getByLabel("金額，新臺幣");
const purpose = (page: Page) => page.getByLabel("用途", { exact: true });
const add = (page: Page) => page.getByRole("button", { name: "加入", exact: true });
const outcome = (page: Page) => page.locator("[data-write-outcome]");
const view = (page: Page) => page.getByTestId("entry-view-created");

async function capture(page: Page, info: TestInfo, name: string, requests: unknown) {
  const directory = `output/playwright/p2-d/${info.project.name}`;
  mkdirSync(directory, { recursive: true });
  const metrics = await page.evaluate(() => {
    const host = document.querySelector<HTMLDialogElement>("dialog");
    const scope = host?.open ? host : document.querySelector("main")!;
    const targets = [...scope.querySelectorAll<HTMLElement>("button,input,select,textarea,summary")]
      .filter(node => node.getClientRects().length && !node.closest("[hidden]") && (!node.closest("details") || node.closest("details")!.open || node.tagName === "SUMMARY"))
      .map(node => { const rect = node.getBoundingClientRect(); return { name: node.getAttribute("aria-label") ?? node.textContent, width: rect.width, height: rect.height }; });
    return { viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth, dialogs: document.querySelectorAll("dialog").length,
      dialogScrollWidth: host?.scrollWidth, dialogClientWidth: host?.clientWidth, targets, activeElement: document.activeElement?.getAttribute("data-entry-field") ?? document.activeElement?.getAttribute("data-transaction-id") };
  });
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewport.width + 1);
  expect(metrics.dialogs).toBe(1);
  if (metrics.dialogClientWidth) expect(metrics.dialogScrollWidth!).toBeLessThanOrEqual(metrics.dialogClientWidth + 1);
  for (const target of metrics.targets) { expect(Math.round(target.height), target.name ?? "target").toBeGreaterThanOrEqual(44); expect(Math.round(target.width)).toBeGreaterThanOrEqual(44); }
  const path = `${directory}/${name}.png`;
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  writeFileSync(`${directory}/${name}.json`, JSON.stringify({ metrics, requests }, null, 2));
  await info.attach(name, { path, contentType: "image/png" });
}

test("single bottom CTA replaces the persistent form; opening is synchronous, labelled and network-free", async ({ page }, info) => {
  const { state } = await entryBrowser(page);
  await expect(page.getByRole("button", { name: "記一筆", exact: true })).toHaveCount(1);
  await expect(page.locator("[data-entry] form")).toHaveCount(0);
  await expect(page.getByText("快速記一筆", { exact: true })).toHaveCount(0);
  expect((await page.getByTestId("quick-entry-trigger").boundingBox())!.height).toBeGreaterThanOrEqual(52);
  await capture(page, info, "home-single-cta", state.requests);
  const before = state.requests.length;
  const y = await page.evaluate(() => scrollY);
  await openEntry(page);
  await expect(dialog(page)).toHaveAccessibleName("記一筆");
  await expect(dialog(page)).toHaveAccessibleDescription("共同生活");
  await expect(page.getByTestId("quick-entry-ledger")).toHaveText("共同生活");
  await expect(amount(page)).toBeFocused();
  await expect(amount(page)).toHaveAttribute("inputmode", "numeric");
  await expect(add(page)).toBeDisabled();
  await expect(add(page)).toHaveAccessibleDescription("填金額與用途後即可加入");
  expect(await page.evaluate(() => scrollY)).toBe(y);
  expect(state.requests).toHaveLength(before);
  await page.getByTestId("ledger-name-trigger").evaluate(node => (node as HTMLElement).focus());
  expect(await page.evaluate(() => document.querySelector("dialog")!.contains(document.activeElement))).toBe(true);
  await capture(page, info, "fresh-quick-entry", state.requests);
});

test("amount Next, purpose Enter, Chinese composition and 229 never implicitly submit", async ({ page }) => {
  const { state } = await entryBrowser(page); await openEntry(page);
  await amount(page).fill("680"); await amount(page).press("Enter"); await expect(purpose(page)).toBeFocused();
  await purpose(page).fill("晚餐"); await purpose(page).press("Enter"); await expect(add(page)).toBeFocused();
  expect(state.posts).toHaveLength(0);
  await purpose(page).focus();
  await purpose(page).dispatchEvent("compositionstart", { data: "餐" });
  await expect(add(page)).toBeDisabled();
  await purpose(page).dispatchEvent("keydown", { key: "Enter", isComposing: true, keyCode: 13 });
  await purpose(page).evaluate(node => {
    node.dispatchEvent(new CompositionEvent("compositionend", { data: "餐", bubbles: true }));
    node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
  });
  await expect(purpose(page)).toBeFocused();
  await purpose(page).dispatchEvent("keydown", { key: "Enter", keyCode: 229 });
  await page.locator("[data-entry] form").dispatchEvent("submit");
  expect(state.posts).toHaveLength(0);
  await page.getByText("更多", { exact: true }).click();
  await page.getByLabel("備註").fill("第一行"); await page.getByLabel("備註").press("Enter"); await page.getByLabel("備註").pressSequentially("次");
  await expect(page.getByLabel("備註")).toHaveValue("第一行\n次");
  expect(state.posts).toHaveLength(0);
});

test("payer and split replace one host and restore editor disclosure, scroll and focus without requests", async ({ page }, info) => {
  const { state } = await entryBrowser(page); await fillEntry(page, "晚餐", "680");
  await page.getByText("更多", { exact: true }).click(); await page.getByLabel("備註").fill("保留備註");
  const requests = state.requests.length;
  for (const surface of ["payer", "split"] as const) {
    const trigger = page.getByTestId(`${surface}-summary`);
    await trigger.scrollIntoViewIfNeeded();
    const scroll = await page.locator("dialog").evaluate(node => node.scrollTop);
    await trigger.click();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await capture(page, info, `${surface}-control`, state.requests);
    await dialog(page).getByRole("button", { name: "套用", exact: true }).click();
    await expect(dialog(page)).toHaveAccessibleName("記一筆");
    await expect(trigger).toBeFocused();
    expect(await page.locator("dialog").evaluate(node => node.scrollTop)).toBe(scroll);
    await expect(page.locator("[data-entry] details")).toHaveAttribute("open", "");
    await expect(page.getByLabel("備註")).toHaveValue("保留備註");
  }
  expect(state.requests).toHaveLength(requests); expect(state.posts).toHaveLength(0);
  await capture(page, info, "valid-quick-entry", state.requests);
});

test("untouched cancel restores Home CTA; dirty cancel keeps the previous field or discards explicitly", async ({ page }) => {
  const { state } = await entryBrowser(page); await openEntry(page);
  await page.keyboard.press("Escape"); await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId("quick-entry-trigger")).toBeFocused();
  await fillEntry(page); await purpose(page).focus(); await dialog(page).getByRole("button", { name: "關閉視窗" }).click();
  await expect(dialog(page)).toHaveAccessibleName("放棄這筆輸入？");
  await dialog(page).getByRole("button", { name: "繼續編輯", exact: true }).click();
  await expect(purpose(page)).toHaveValue("晚餐"); await expect(purpose(page)).toBeFocused();
  await page.keyboard.press("Escape"); await dialog(page).getByRole("button", { name: "放棄這筆輸入", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0); await openEntry(page); await expect(amount(page)).toHaveValue("");
  expect(state.posts).toHaveLength(0);
});

test("T0 double activation has one recovery record/key/effect; pending, slow and close stay bound to the original operation", async ({ page }, info) => {
  const { state } = await entryBrowser(page); state.mode = "delay"; await fillEntry(page, "晚餐", "680");
  await page.clock.install({ time: new Date("2026-09-25T04:00:00Z") });
  await add(page).evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
  await expect.poll(() => state.posts.length).toBe(1);
  const pending = page.getByRole("button", { name: "正在加入…", exact: true });
  await expect(pending).toBeDisabled(); await expect(pending).toHaveAttribute("aria-busy", "true");
  expect(JSON.parse(state.posts[0]!.recovery!).phase).toBe("submitting");
  await expect(amount(page)).toHaveValue("680"); await expect(purpose(page)).toHaveValue("晚餐");
  await expect(page.getByTestId("payer-summary")).toBeVisible(); await expect(page.getByTestId("split-summary")).toBeVisible();
  await capture(page, info, "submitting", state.requests);
  await page.clock.fastForward(2001); await expect(outcome(page)).toContainText("連線比平常慢");
  await capture(page, info, "slow-request", state.requests);
  await dialog(page).getByRole("button", { name: "關閉視窗" }).click();
  await expect(dialog(page)).toContainText("這筆正在加入");
  await expect(dialog(page).getByRole("button", { name: "放棄這筆輸入", exact: true })).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "查看處理狀態" }).click();
  state.release!(); await expect(dialog(page)).toHaveCount(0);
  await expect(outcome(page)).toContainText("已加入晚餐 NT$680");
  expect(state.posts).toHaveLength(1); expect(state.effects).toBe(1);
});

test("UNKNOWN retains immutable original operation and reload never auto posts; replay uses the same bytes and key", async ({ page }, info) => {
  const { state } = await entryBrowser(page); state.mode = "drop"; await fillEntry(page);
  await add(page).click(); await expect(outcome(page)).toContainText("尚未確認是否已加入，請勿再記一次。");
  await capture(page, info, "unknown", state.requests);
  const saved = JSON.parse((await page.evaluate(key => sessionStorage.getItem(key), ENTRY_RECOVERY_KEY))!);
  expect(saved.body).toEqual(state.posts[0]!.body); expect(saved.phase).toBe("unknown");
  await page.reload(); await expect(outcome(page)).toContainText("尚未確認");
  await expect(dialog(page)).toHaveCount(0); await expect(page.locator("[data-entry] form")).toHaveCount(0);
  expect(state.posts).toHaveLength(1);
  await page.getByRole("button", { name: "確認並完成這筆", exact: true }).click();
  await expect(outcome(page)).toContainText("已加入晚餐 NT$681");
  expect(state.posts[1]!.bytes).toBe(state.posts[0]!.bytes); expect(state.posts[1]!.key).toBe(state.posts[0]!.key); expect(state.effects).toBe(1);
});

test("full canonical success closes once, updates row/balance/next payer atomically, targets today and uses no bootstrap GET", async ({ page }, info) => {
  const { state } = await entryBrowser(page); await fillEntry(page, "晚餐", "680");
  const reads = state.requests.filter(path => path.endsWith("/bootstrap")).length;
  await page.evaluate(() => {
    Object.assign(window, { inconsistentCreatePaint: [] });
    new MutationObserver(() => {
      if (!document.querySelector('button[data-transaction-id]')) return;
      const balance = document.querySelector('[data-testid="ledger-balance"]');
      const timeline = document.querySelector('[data-testid="home-timeline-card"]');
      if (!balance?.textContent?.includes("NT$340") || !balance.textContent.includes("下次建議由 另一半 付款") || balance.getAttribute("data-ledger-version") !== "2" || timeline?.getAttribute("data-ledger-version") !== "2")
        (window as unknown as { inconsistentCreatePaint: string[] }).inconsistentCreatePaint.push(document.body.textContent ?? "");
    }).observe(document.querySelector("main")!, { subtree: true, childList: true, characterData: true });
  });
  await add(page).click(); await expect(dialog(page)).toHaveCount(0);
  const created = page.locator(`button[data-transaction-id="${state.rows[0]!.id}"]`);
  await expect(created).toBeFocused(); await expect(created).toBeInViewport();
  await expect(created).toHaveAttribute("data-created-highlight", "true");
  await expect(page.getByRole("heading", { name: "你目前多付" })).toBeVisible();
  await expect(outcome(page)).toHaveCount(1); await expect(outcome(page)).toContainText("已加入晚餐 NT$680");
  expect(await page.evaluate(() => (window as unknown as { inconsistentCreatePaint: string[] }).inconsistentCreatePaint)).toEqual([]);
  expect(state.requests.filter(path => path.endsWith("/bootstrap"))).toHaveLength(reads);
  expect(state.posts).toHaveLength(1); await expect(amount(page)).toHaveCount(0);
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  await capture(page, info, "success-created-row", state.requests);
  await created.click(); await expect(page.locator("[data-detail-heading]")).toHaveText("晚餐");
  await page.getByTestId("transaction-detail-back").click(); await expect(created).toBeFocused();
});

test("today targeting expands P2-C's window past future and newer rows without moving dates or losing identity", async ({ page }) => {
  const fixture = await timelineBrowser(page); await fixture.goto(); await fixture.ready();
  await fillEntry(page, "今天剛加入", "680"); await add(page).click();
  const created = fixture.state.rows.find(tx => tx.description === "今天剛加入")!;
  const rows = page.getByTestId("ledger-timeline").locator("button[data-transaction-id]");
  await expect(rows).toHaveCount(60);
  expect(await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-transaction-id")))).toEqual(effectiveTimelineTransactions(fixture.state.rows.filter(tx => tx.ledgerId === LEDGER)).slice(0, 60).map(tx => tx.id));
  await expect(page.locator(`button[data-transaction-id="${created.id}"]`)).toBeFocused();
});

for (const occurredOn of ["2026-09-03", "2026-09-28"]) test(`${occurredOn} preserves chronological position and focuses one contextual View into canonical Detail`, async ({ page }, info) => {
  const existing = row(LEDGER, "00000000-0000-4000-8000-000000000077", "原有紀錄");
  const { state } = await entryBrowser(page, { rows: [existing] }); await fillEntry(page, "補記晚餐", "680");
  await page.getByText("更多", { exact: true }).click(); await page.getByLabel("交易日期").fill(occurredOn);
  await add(page).click(); await expect(dialog(page)).toHaveCount(0); await expect(view(page)).toBeFocused();
  await expect(outcome(page)).toHaveCount(1); await expect(outcome(page)).toContainText(`${occurredOn === "2026-09-03" ? "9月3日" : "9月28日"}的補記晚餐`);
  const expected = effectiveTimelineTransactions(state.rows).map(tx => tx.id);
  expect(await page.locator("button[data-transaction-id]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-transaction-id")))).toEqual(expected);
  await capture(page, info, occurredOn === "2026-09-03" ? "backdated-success-view" : "future-success-view", state.requests);
  await view(page).click(); await expect(page.locator("[data-detail-heading]")).toHaveText("補記晚餐");
  await expect(page.getByTestId("transaction-detail")).toContainText(occurredOn);
});

test("a moved Home reading position is preserved and View is visible without a forced scroll", async ({ page }) => {
  const rows = Array.from({ length: 20 }, (_, index) => row(LEDGER, `00000000-0000-4000-8000-${String(1000 + index).padStart(12, "0")}`, `讀取紀錄 ${index}`));
  const { state } = await entryBrowser(page, { rows }); state.mode = "delay"; await fillEntry(page);
  await add(page).click(); await expect.poll(() => state.posts.length).toBe(1);
  await page.evaluate(() => window.scrollTo(0, 700));
  const origin = await page.evaluate(() => {
    const node = [...document.querySelectorAll<HTMLElement>('button[data-transaction-id]')].find(row => row.getBoundingClientRect().top >= 120)!;
    return { id: node.dataset.transactionId!, top: node.getBoundingClientRect().top };
  });
  state.release!(); await expect(view(page)).toBeFocused();
  // Browser scroll anchoring may change scrollY as the status/new row appears;
  // the user's existing reading row must keep its screen offset.
  expect(Math.abs(await page.locator(`button[data-transaction-id="${origin.id}"]`).evaluate(node => node.getBoundingClientRect().top) - origin.top)).toBeLessThanOrEqual(2);
  await expect(view(page)).toBeInViewport();
});

test("filtered Search keeps its query and excludes a nonmatching canonical row, with View using P2-C Detail", async ({ page }) => {
  const fixture = await timelineBrowser(page); await fixture.goto(); await fixture.ready();
  await fillEntry(page, "新加入不符合搜尋", "680"); await add(page).click(); await expect(dialog(page)).toHaveCount(0);
  await page.getByRole("button", { name: "搜尋", exact: true }).click(); await page.getByLabel("搜尋紀錄").fill("昨日買菜");
  await expect(page.getByRole("button", { name: /新加入不符合搜尋，支出/ })).toHaveCount(0);
  await expect(page.getByLabel("搜尋紀錄")).toHaveValue("昨日買菜");
  await expect(view(page)).toBeVisible(); await view(page).click();
  await expect(page.locator("[data-detail-heading]")).toHaveText("新加入不符合搜尋");
  await page.getByTestId("transaction-detail-back").click(); await expect(page.getByLabel("搜尋紀錄")).toHaveValue("昨日買菜");
});

test("partial commit plus read500 closes as success, and retry remains GET-only", async ({ page }, info) => {
  const { state } = await entryBrowser(page); state.mode = "partial"; state.failRead = true; await fillEntry(page);
  await add(page).click(); await expect(dialog(page)).toHaveCount(0);
  await expect(outcome(page)).toContainText("已加入晚餐 NT$681。其他紀錄暫時無法更新。");
  // A partial receipt proves commit, but P2-C still needs its canonical collection
  // before offering Detail. Do not link to a misleading "record not found" surface.
  await expect(view(page)).toHaveCount(0);
  await expect(page.getByTestId("entry-success-copy")).toHaveText("已加入晚餐 NT$681");
  await expect(page.getByTestId("entry-success-copy").locator("+ span")).toHaveAttribute("aria-live", "off");
  await capture(page, info, "committed-read500", state.requests);
  const posts = state.posts.length; state.failRead = false; await page.getByRole("button", { name: "重新整理", exact: true }).click();
  await expect(outcome(page)).toHaveAttribute("data-read-freshness", "ready"); expect(state.posts).toHaveLength(posts);
  await expect(page.getByTestId("entry-success-copy")).toHaveText("已加入晚餐 NT$681");
  await expect(view(page)).toBeVisible(); await view(page).click();
  await expect(page.locator("[data-detail-heading]")).toHaveText("晚餐"); expect(state.posts).toHaveLength(posts);
});

test("the next explicit open snapshots fresh defaults and has no prior amount, payer, shares or key", async ({ page }) => {
  const { state } = await entryBrowser(page); await fillEntry(page);
  await page.getByTestId("payer-summary").click(); await dialog(page).getByRole("combobox").selectOption("partner"); await dialog(page).getByRole("button", { name: "套用", exact: true }).click();
  await add(page).click(); await expect(dialog(page)).toHaveCount(0);
  state.weights = { [OWNER]: "2", [PARTNER]: "1" }; state.version += 1;
  await page.getByLabel("重新整理帳本").click(); await expect(outcome(page)).toHaveAttribute("data-read-freshness", "ready");
  await openEntry(page); await expect(amount(page)).toHaveValue(""); await expect(purpose(page)).toHaveValue("");
  await expect(page.getByTestId("entry-success-copy")).toHaveCount(0);
  await expect(outcome(page)).toHaveCount(0);
  await expect(page.getByTestId("payer-summary")).toContainText("你付款");
  await fillEntry(page, "下一筆", "681"); await expect(page.getByTestId("split-summary")).toContainText("你 2：另一半 1 分攤"); await add(page).click(); await expect(outcome(page)).toContainText("已加入下一筆");
  expect(state.posts[1]!.key).not.toBe(state.posts[0]!.key); expect(state.effects).toBe(2);
  expect(state.posts[1]!.body.payments).toEqual([{ userId: OWNER, amountTwd: "681" }]);
  expect(state.posts[1]!.body.shares).toEqual([{ userId: OWNER, amountTwd: "454" }, { userId: PARTNER, amountTwd: "227" }]);
});

test("Ledger switch works after closing Quick Entry; secondary pages have no create form or CTA", async ({ page }) => {
  const { state } = await entryBrowser(page); await openEntry(page); await page.keyboard.press("Escape");
  await page.getByTestId("ledger-name-trigger").click(); await dialog(page).locator(`[data-ledger-option="${OTHER}"]`).click();
  await expect(page.getByTestId("surface-heading")).toHaveText("旅行帳本"); await openEntry(page);
  await expect(page.getByTestId("quick-entry-ledger")).toHaveText("旅行帳本"); await page.keyboard.press("Escape");
  for (const name of ["收支概況", "帳本設定", "搜尋"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator("[data-entry] form")).toHaveCount(0); await expect(page.getByTestId("quick-entry-trigger")).toHaveCount(0);
    await page.getByTestId("transaction-detail-back").click();
  }
  expect(state.posts).toHaveLength(0);
});

test("background and foreground preserve unsent draft and focus without storage or POST", async ({ page }) => {
  const { state } = await entryBrowser(page); await fillEntry(page); await purpose(page).focus();
  const before = await page.evaluate(() => document.activeElement?.id);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new PageTransitionEvent("pageshow"));
  });
  await expect(amount(page)).toHaveValue("681"); await expect(purpose(page)).toHaveValue("晚餐");
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(before); expect(state.posts).toHaveLength(0);
  expect(await page.evaluate(key => sessionStorage.getItem(key), ENTRY_RECOVERY_KEY)).toBeNull();
});

test("reduced motion, 200% text and keyboard-sized viewport keep labelled controls and Add reachable", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); const { state } = await entryBrowser(page); await fillEntry(page);
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await add(page).scrollIntoViewIfNeeded(); await expect(add(page)).toBeInViewport(); await capture(page, info, "200-percent-text", state.requests);
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 420 });
  await add(page).scrollIntoViewIfNeeded(); await expect(add(page)).toBeInViewport();
  const bounds = await add(page).evaluate(node => { const rect = node.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: innerHeight }; });
  expect(bounds.top).toBeGreaterThanOrEqual(0); expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
  await capture(page, info, "keyboard-reduced-viewport", state.requests);
  await add(page).click(); await expect(dialog(page)).toHaveCount(0);
  const highlighted = page.locator('[data-created-highlight="true"]');
  expect(await highlighted.evaluate(node => getComputedStyle(node).animationName)).toBe("none");
});


test("Taipei midnight keeps the existing draft date contextual, then a fresh today draft targets its row", async ({ page }) => {
  const { state } = await entryBrowser(page);
  await page.clock.setFixedTime(new Date("2026-09-25T15:59:59Z")); await fillEntry(page, "跨日保留", "680");
  await page.clock.setFixedTime(new Date("2026-09-25T16:00:01Z")); await add(page).click();
  await expect(view(page)).toBeFocused(); await expect(outcome(page)).toContainText("已加入昨天的跨日保留 NT$680");
  expect(state.posts[0]!.body.occurredOn).toBe("2026-09-25");
  await fillEntry(page, "新一天", "680"); await add(page).click();
  await expect.poll(() => state.posts.length).toBe(2);
  expect(state.posts[1]!.body.occurredOn).toBe("2026-09-26");
  await expect(page.locator(`button[data-transaction-id="${state.rows[0]!.id}"]`)).toBeFocused();
  await expect(outcome(page)).toContainText("已加入新一天 NT$680"); expect(state.effects).toBe(2);
  await expect(page.locator('[data-timeline-date="2026-09-26"]')).toHaveText("今天");
  await expect(page.locator('[data-timeline-date="2026-09-25"]')).toHaveText("昨天");
});
