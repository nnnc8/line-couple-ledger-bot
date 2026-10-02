import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { A, B, C, names, navigationBrowser, activationRequests, deferred } from "./fixtures/p1-c-browser";

test.use({ video: "on" });
const NEW = "00000000-0000-4000-8000-000000000040";
const trigger = (page: Page) => page.getByTestId("ledger-name-trigger");
const dialog = (page: Page) => page.getByRole("dialog");
const option = (page: Page, id: string) => dialog(page).locator(`[data-ledger-option="${id}"]`);
async function start(page: Page, path = "/") {
  const fixture = await navigationBrowser(page);
  await fixture.goto(path); await fixture.ready();
  return fixture;
}
async function capture(page: Page, info: TestInfo, name: string, fixture: Awaited<ReturnType<typeof navigationBrowser>>) {
  const directory = `output/playwright/p2-b/${info.project.name}`;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true });
  writeFileSync(`${directory}/${name}-requests.json`, JSON.stringify(fixture.state.requests, null, 2));
}

test("name is the single Home identity; switch A B A reuses canonical scope", async ({ page }, info) => {
  const fixture = await start(page);
  await expect(trigger(page)).toHaveAccessibleName("共同生活，目前查看，切換帳本");
  await expect(page.getByTestId("surface-heading")).toHaveText("共同生活");
  expect(await page.locator("header").getByText("共同生活", { exact: true }).count()).toBe(1);
  await expect(page.getByRole("button", { name: "建立帳本", exact: true })).toHaveCount(0);
  const length = await page.evaluate(() => history.length);
  const reads = fixture.state.requests.filter(item => item.path.endsWith("/bootstrap")).length;
  await trigger(page).click();
  await expect(dialog(page)).toHaveAccessibleName("切換帳本");
  await expect(option(page, A)).toHaveAttribute("aria-selected", "true");
  await expect(option(page, A)).toHaveAccessibleDescription("目前查看");
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  expect(fixture.state.requests.filter(item => item.path.endsWith("/bootstrap"))).toHaveLength(reads);
  await capture(page, info, "switcher", fixture);
  const hold = deferred(); fixture.state.holdReads.set(B, hold);
  await option(page, B).click();
  await expect(trigger(page)).toHaveText(names[B]);
  await expect(page).toHaveURL(`/?v2Ledger=${B}`);
  await expect(page.getByText("A 專屬晚餐", { exact: true })).toHaveCount(0);
  await expect(page.getByText("正在載入帳本…", { exact: true })).toBeVisible();
  hold.release(); await fixture.ready();
  await expect(page.getByText("B 專屬車票", { exact: true })).toBeVisible();
  await trigger(page).click(); await option(page, A).click(); await fixture.ready();
  await expect(page).toHaveURL(`/?v2Ledger=${A}`);
  expect(await page.evaluate(() => history.length)).toBe(length);
  expect(fixture.state.posts).toHaveLength(0);
  await expect.poll(() => activationRequests(fixture.state).length).toBe(2);
});

test("deep-link viewed B and LINE default A remain distinct and selected is announced", async ({ page }, info) => {
  const fixture = await start(page, `/?v2Ledger=${B}`);
  await trigger(page).click();
  await expect(option(page, B)).toHaveAccessibleName("旅行");
  await expect(option(page, B)).toHaveAccessibleDescription("目前查看");
  await expect(option(page, B)).toHaveAttribute("aria-selected", "true");
  await expect(option(page, A)).toHaveAccessibleDescription("LINE 記帳預設");
  await expect(option(page, A)).toHaveAttribute("aria-selected", "false");
  expect(activationRequests(fixture.state)).toHaveLength(0);
  await capture(page, info, "viewed-vs-default", fixture);
  await page.keyboard.press("Escape"); await expect(trigger(page)).toBeFocused();
});

test("activation syncing and failure stay bounded while B remains readable", async ({ page }, info) => {
  const fixture = await start(page), hold = deferred();
  fixture.state.holdActivations.set(B, hold); fixture.state.failActivations.add(B);
  await trigger(page).click(); await option(page, B).click(); await fixture.ready();
  await expect(page.getByText("正在更新 LINE 記帳預設…")).toBeVisible();
  await expect(trigger(page)).toHaveText("旅行");
  await trigger(page).click();
  await expect(option(page, A)).toHaveAccessibleDescription("LINE 記帳預設");
  await expect(option(page, B)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape"); hold.release();
  await expect(page.getByText("這本可查看，LINE 的預設帳本尚未更新")).toBeVisible();
  await expect(page.getByText("B 專屬車票", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(`/?v2Ledger=${B}`);
  await capture(page, info, "preference-failure", fixture);
  const reads = fixture.state.requests.filter(item => item.path.endsWith("/bootstrap")).length;
  fixture.state.failActivations.delete(B);
  await page.getByRole("button", { name: "重試更新 LINE 預設" }).click();
  await expect(page.getByText("這本可查看，LINE 的預設帳本尚未更新")).toHaveCount(0);
  expect(fixture.state.requests.filter(item => item.path.endsWith("/bootstrap"))).toHaveLength(reads);
  expect(fixture.state.posts).toHaveLength(0);
});

for (const percent of [100, 200]) test(`40 character identities stay complete and wrap at ${percent}% text`, async ({ page }, info) => {
  const fixture = await navigationBrowser(page);
  const prefix = "共同生活".repeat(9) + "週末旅";
  fixture.state.names[A] = prefix + "甲"; fixture.state.names[B] = prefix + "乙";
  expect(fixture.state.names[A]).toHaveLength(40);
  await fixture.goto(); await fixture.ready();
  await page.evaluate(percent => { document.documentElement.style.fontSize = `${percent}%`; }, percent);
  await expect(trigger(page)).toHaveText(prefix + "甲");
  await trigger(page).click();
  for (const id of [A, B]) {
    await expect(option(page, id)).toHaveAccessibleName(fixture.state.names[id]);
    const dimensions = await option(page, id).evaluate(element => {
      const name = element.querySelector('span[id*="-name-"]') as HTMLElement;
      const style = getComputedStyle(name), bounds = element.getBoundingClientRect();
      return { height: bounds.height, width: bounds.width, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, clipped: name.scrollWidth > name.clientWidth + 1 || name.scrollHeight > name.clientHeight + 1 };
    });
    expect(dimensions.height).toBeGreaterThanOrEqual(44); expect(dimensions.width).toBeGreaterThanOrEqual(44);
    expect(dimensions.whiteSpace).not.toBe("nowrap"); expect(dimensions.textOverflow).not.toBe("ellipsis"); expect(dimensions.clipped).toBe(false);
  }
  expect(await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth + 1)).toBe(true);
  expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await capture(page, info, `long-names-${percent}`, fixture);
  await option(page, B).click(); await fixture.ready();
  await expect(trigger(page)).toHaveText(prefix + "乙");
  expect(await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth + 1)).toBe(true);
  await capture(page, info, `long-header-${percent}`, fixture);
});

test("40 unbroken Latin characters wrap without horizontal scroll at 200%", async ({ page }, info) => {
  const fixture = await navigationBrowser(page); fixture.state.names[A] = "W".repeat(39) + "A";
  await fixture.goto(); await fixture.ready(); await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await trigger(page).click();
  expect(await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth + 1)).toBe(true);
  expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(option(page, A)).toHaveAccessibleName(fixture.state.names[A]);
  await capture(page, info, "latin-name-200", fixture);
});

test("keyboard enters titled dialog, moves options without writes, selects and returns focus", async ({ page }, info) => {
  const fixture = await start(page);
  // WebKit's native all-control keyboard traversal uses Option-Tab on macOS.
  // https://support.apple.com/guide/safari/cpsh003/mac
  const tabKey = info.project.use.browserName === "webkit" ? "Alt+Tab" : "Tab";
  await trigger(page).focus(); await page.keyboard.press("Enter");
  await expect(dialog(page).getByRole("heading", { name: "切換帳本" })).toBeFocused();
  await page.keyboard.press(tabKey); await expect(dialog(page).getByRole("button", { name: "關閉視窗" })).toBeFocused();
  await page.keyboard.press(tabKey); await expect(option(page, A)).toBeFocused();
  await page.keyboard.press("ArrowDown"); await expect(option(page, B)).toBeFocused();
  await page.keyboard.press("End"); await expect(option(page, C)).toBeFocused();
  await page.keyboard.press("Home"); await expect(option(page, A)).toBeFocused();
  await page.keyboard.press("ArrowUp"); await expect(option(page, C)).toBeFocused();
  expect(activationRequests(fixture.state)).toHaveLength(0); expect(fixture.state.posts).toHaveLength(0);
  await page.keyboard.press("Escape"); await expect(trigger(page)).toBeFocused();
  await page.keyboard.press("Space"); await expect(dialog(page)).toBeVisible();
  await page.keyboard.press(tabKey); await page.keyboard.press(tabKey); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await fixture.ready(); await expect(trigger(page)).toHaveText("旅行");
  await trigger(page).click(); await expect(option(page, B)).toHaveAttribute("aria-selected", "true");
  await capture(page, info, "keyboard-selected", fixture);
  await dialog(page).getByRole("button", { name: "關閉視窗" }).click(); await expect(trigger(page)).toBeFocused();
});

test("create cancel returns to the same switcher and never changes scope or history", async ({ page }, info) => {
  const fixture = await start(page), length = await page.evaluate(() => history.length);
  await trigger(page).click();
  await expect(page.getByRole("button", { name: "建立帳本", exact: true })).toHaveCount(1);
  await dialog(page).getByRole("button", { name: "建立帳本", exact: true }).click();
  await expect(dialog(page)).toHaveAccessibleName("建立帳本");
  await page.getByLabel("新帳本名稱").fill("取消的帳本");
  await capture(page, info, "create-form", fixture);
  await dialog(page).getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog(page)).toHaveAccessibleName("切換帳本");
  await expect(option(page, A)).toHaveAttribute("aria-selected", "true");
  await dialog(page).getByRole("button", { name: "建立帳本", exact: true }).click();
  await expect(page.getByLabel("新帳本名稱")).toHaveValue("");
  await page.keyboard.press("Escape"); await expect(dialog(page)).toHaveAccessibleName("切換帳本");
  await page.keyboard.press("Escape"); await expect(trigger(page)).toBeFocused();
  await expect(page).toHaveURL(`/?v2Ledger=${A}`);
  expect(await page.evaluate(() => history.length)).toBe(length);
  expect(fixture.state.requests.filter(item => item.method === "POST" && item.path !== "/api/app/session")).toHaveLength(0);
});

for (const empty of [false, true]) test(`create success accepts new name and scope from ${empty ? "empty list" : "switcher"}`, async ({ page }, info) => {
  const fixture = await navigationBrowser(page); if (empty) fixture.state.ledgerIds = [];
  await fixture.goto();
  if (empty) { await expect(page.getByRole("heading", { name: "還沒有帳本" })).toBeVisible(); await expect(trigger(page)).toHaveCount(0); }
  else { await fixture.ready(); await trigger(page).click(); }
  await page.getByRole("button", { name: "建立帳本", exact: true }).click();
  const name = "一起生活".repeat(10);
  await expect(page.getByLabel("新帳本名稱")).toHaveAttribute("maxlength", "40");
  await expect(dialog(page).getByRole("button", { name: "建立", exact: true })).toBeDisabled();
  await page.getByLabel("新帳本名稱").fill(name);
  await dialog(page).getByRole("button", { name: "建立", exact: true }).click();
  await fixture.ready(); await expect(trigger(page)).toHaveText(name);
  await expect(page).toHaveURL(`/?v2Ledger=${NEW}`);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect.poll(() => fixture.state.defaultId).toBe(NEW);
  expect(fixture.state.requests.filter(item => item.method === "POST" && item.path === "/api/app/v2/ledgers")).toHaveLength(1);
  expect(fixture.state.requests.filter(item => item.path.endsWith(`${NEW}/bootstrap`))).toHaveLength(1);
  expect(fixture.state.posts).toHaveLength(0);
  await capture(page, info, empty ? "first-ledger-created" : "created-ledger", fixture);
});

test("empty list cancel returns to one clear create entry", async ({ page }, info) => {
  const fixture = await navigationBrowser(page); fixture.state.ledgerIds = [];
  await fixture.goto(); await expect(page.getByRole("heading", { name: "還沒有帳本" })).toBeVisible();
  await expect(trigger(page)).toHaveCount(0);
  await expect(page.getByText("正在載入帳本…")).toHaveCount(0);
  await capture(page, info, "empty-list", fixture);
  const create = page.getByRole("button", { name: "建立帳本", exact: true });
  await create.click(); await page.getByLabel("新帳本名稱").fill("取消"); await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0); await expect(create).toBeFocused();
  await expect(create).toHaveCount(1);
  expect(fixture.state.requests.some(item => item.path.endsWith("/bootstrap"))).toBe(false);
});

test("archived-only list has no broken identity trigger", async ({ page }) => {
  const fixture = await navigationBrowser(page);
  await page.route("**/api/app/v2/ledgers", route => route.fulfill({ json: { ledgers: [{ ...fixture.snapshot(A).ledger, status: "archived" }] } }));
  await fixture.goto(); await expect(page.getByRole("heading", { name: "還沒有帳本" })).toBeVisible();
  await expect(trigger(page)).toHaveCount(0); await expect(page.getByRole("button", { name: "建立帳本", exact: true })).toHaveCount(1);
  expect(fixture.state.requests.some(item => item.path.endsWith("/bootstrap"))).toBe(false);
});

test("create rejection preserves name and scope; cancelled retry writes nothing", async ({ page }, info) => {
  const fixture = await start(page); fixture.state.createFailure = true;
  await trigger(page).click(); await dialog(page).getByRole("button", { name: "建立帳本", exact: true }).click();
  await page.getByLabel("新帳本名稱").fill("保留名稱"); await dialog(page).getByRole("button", { name: "建立", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toHaveText("帳本暫時無法建立");
  await expect(page.getByLabel("新帳本名稱")).toHaveValue("保留名稱");
  await expect(page).toHaveURL(`/?v2Ledger=${A}`);
  await capture(page, info, "create-rejected", fixture);
  await dialog(page).getByRole("button", { name: "取消", exact: true }).click(); await expect(dialog(page)).toHaveAccessibleName("切換帳本");
  expect(fixture.state.requests.filter(item => item.path.endsWith("/activate"))).toHaveLength(0);
  expect(fixture.state.posts).toHaveLength(0);
});

test("create is single flight and keeps its only dialog until response", async ({ page }) => {
  const fixture = await start(page), hold = deferred(); fixture.state.createHold = hold;
  await trigger(page).click(); await dialog(page).getByRole("button", { name: "建立帳本", exact: true }).click();
  await page.getByLabel("新帳本名稱").fill("新的共同生活");
  await dialog(page).locator("form").evaluate(form => { (form as HTMLFormElement).requestSubmit(); (form as HTMLFormElement).requestSubmit(); });
  await expect(dialog(page).getByRole("button", { name: "正在建立…" })).toBeDisabled();
  await expect(dialog(page).getByRole("button", { name: "關閉視窗" })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(dialog(page)).toHaveAccessibleName("建立帳本");
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  expect(fixture.state.requests.filter(item => item.method === "POST" && item.path === "/api/app/v2/ledgers")).toHaveLength(1);
  hold.release(); await fixture.ready(); await expect(trigger(page)).toHaveText("新的共同生活");
  expect(fixture.state.posts).toHaveLength(0);
});
