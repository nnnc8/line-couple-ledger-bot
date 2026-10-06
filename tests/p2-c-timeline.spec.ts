import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { A, B, IDS, LONG_PURPOSE, LONG_NOTE, HUGE_DISPLAY, timelineBrowser, timelineRows, transactionId, deferred, switchLedger } from "./fixtures/p2-c-browser";
import { fillEntry } from "./fixtures/p1-b-browser";

test.use({ video: "on" });
test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date("2026-09-25T04:00:00Z")); });
const timeline = (page: Page) => page.getByTestId("ledger-timeline");
const rows = (page: Page) => timeline(page).locator("button[data-transaction-id]");
const row = (page: Page, id: string) => page.locator(`button[data-transaction-id="${id}"]`);
const detail = (page: Page) => page.getByTestId("transaction-detail");
const back = (page: Page) => page.getByRole("button", { name: "返回帳本", exact: true });
const more = (page: Page) => detail(page).getByRole("button", { name: "更多操作", exact: true });
const homeUrl = (ledger = A) => `/?v2Ledger=${ledger}`;
const detailUrl = (id: string, ledger = A) => `${homeUrl(ledger)}&v2Transaction=${id}`;

async function start(page: Page, options: Parameters<typeof timelineBrowser>[1] = {}) {
  const fixture = await timelineBrowser(page, options); const started = performance.now();
  await fixture.goto(); await fixture.ready(); await expect(timeline(page)).toBeVisible();
  return { ...fixture, initialRenderMs: performance.now() - started };
}
async function openDetail(page: Page, id: string) {
  await row(page, id).click(); await expect(detail(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`v2Transaction=${id}`));
}
async function openActions(page: Page) {
  await more(page).click(); await expect(detail(page).getByRole("heading", { name: "收據", exact: true })).toBeVisible();
}
async function capture(page: Page, info: TestInfo, name: string, extra: unknown = {}) {
  const directory = `output/playwright/p2-c/${info.project.name}`; mkdirSync(directory, { recursive: true });
  const metrics = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight }, scrollY,
    documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
    timelineRows: document.querySelectorAll('[data-testid="ledger-timeline"] button[data-transaction-id]').length,
    rowIds: Array.from(document.querySelectorAll('[data-testid="ledger-timeline"] button[data-transaction-id]')).map(node => node.getAttribute("data-transaction-id")),
    rowRects: Array.from(document.querySelectorAll('[data-testid="ledger-timeline"] button[data-transaction-id]')).map(node => ({ id: node.getAttribute("data-transaction-id"), height: node.getBoundingClientRect().height, width: node.getBoundingClientRect().width })),
    amountRects: Array.from(document.querySelectorAll<HTMLElement>("[data-timeline-amount]")).map(node => ({ text: node.textContent, width: node.clientWidth, scrollWidth: node.scrollWidth, fontSize: getComputedStyle(node).fontSize, fontVariantNumeric: getComputedStyle(node).fontVariantNumeric })),
    dateHeadings: Array.from(document.querySelectorAll("[data-timeline-date]")).map(node => ({ date: node.getAttribute("data-timeline-date"), text: node.textContent, tag: node.tagName })),
    focus: document.activeElement?.getAttribute("data-transaction-id") ?? document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName,
  }));
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewport.width + 1); expect(metrics.bodyWidth).toBeLessThanOrEqual(metrics.viewport.width + 1);
  for (const target of metrics.rowRects) expect(target.height, target.id ?? "timeline row").toBeGreaterThanOrEqual(44);
  for (const amount of metrics.amountRects) { expect(amount.scrollWidth, amount.text ?? "amount").toBeLessThanOrEqual(amount.width + 1); expect(amount.fontVariantNumeric).toContain("tabular-nums"); }
  expect(new Set(metrics.rowIds).size).toBe(metrics.rowIds.length);
  expect(new Set(metrics.dateHeadings.map(item => item.date)).size).toBe(metrics.dateHeadings.length);
  for (const heading of metrics.dateHeadings) expect(heading.tag).toMatch(/^H[2-6]$/);
  const path = `${directory}/${name}.png`; await page.screenshot({ path, fullPage: true, animations: "disabled" });
  writeFileSync(`${directory}/${name}.json`, JSON.stringify({ test: { title: info.title, project: info.project.name, resultDir: info.outputDir }, metrics, extra }, null, 2));
  await info.attach(name, { path, contentType: "image/png" });
}
async function loadAll(page: Page) {
  await expect(timeline(page)).toBeVisible();
  while (await page.getByRole("button", { name: "更早紀錄", exact: true }).count()) {
    const button = page.getByRole("button", { name: "更早紀錄", exact: true }); if (!(await button.isEnabled())) break; await button.click();
  }
}

test("01–05 20+20 client window preserves identity and single date headings across 20/21 and 40/41", async ({ page }, info) => {
  const fixture = await start(page); await expect(rows(page)).toHaveCount(20);
  const initialIds = await rows(page).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-transaction-id")));
  const initialPositions = await rows(page).evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top + scrollY));
  await capture(page, info, "normal-timeline-20", { initialRenderMs: fixture.initialRenderMs, requests: fixture.state.requests });
  const requests = fixture.state.requests.length, begin = performance.now();
  expect(fixture.state.requests.filter(item => item.method === "GET" && /\/transactions(?:\?|$)/.test(item.path))).toEqual([]);
  await page.getByRole("button", { name: "更早紀錄", exact: true }).click(); await expect(rows(page)).toHaveCount(40);
  const appendMs = performance.now() - begin;
  expect(await rows(page).evaluateAll(nodes => nodes.slice(0, 20).map(node => node.getAttribute("data-transaction-id")))).toEqual(initialIds);
  expect(await rows(page).evaluateAll(nodes => nodes.slice(0, 20).map(node => node.getBoundingClientRect().top + scrollY))).toEqual(initialPositions);
  await expect(timeline(page).locator('[data-timeline-date="2026-09-25"]')).toHaveCount(1);
  expect(fixture.state.requests.slice(requests)).toEqual([]);
  await capture(page, info, "load-older-40", { appendMs, requestsBefore: requests, requestsAfter: fixture.state.requests.length });
  await page.getByRole("button", { name: "更早紀錄", exact: true }).click(); await expect(rows(page)).toHaveCount(60);
  await expect(timeline(page).locator('[data-timeline-date="2026-09-25"]')).toHaveCount(1);
  await loadAll(page); const effectiveCount = fixture.state.rows.filter(item => item.ledgerId === A && item.status === "posted" && !item.replacedByTransactionId).length;
  await expect(rows(page)).toHaveCount(effectiveCount);
  await expect(page.getByRole("button", { name: "更早紀錄", exact: true })).toHaveCount(0);
  await expect(row(page, IDS.old)).toHaveCount(0); await expect(row(page, IDS.voided)).toHaveCount(0);
  await capture(page, info, "all-effective-rows", { bootstrapTransactionCount: fixture.snapshot(A).transactions.length, bootstrapResponseBytes: Buffer.byteLength(JSON.stringify(fixture.snapshot(A))), effectiveCount, requests: fixture.state.requests });
});

test("06 today yesterday cross-year and future use occurrence date under Taipei semantics", async ({ page }, info) => {
  await start(page); await loadAll(page);
  await expect(timeline(page).locator('[data-timeline-date="2026-09-25"]')).toHaveText("今天");
  await expect(timeline(page).locator('[data-timeline-date="2026-09-24"]')).toHaveText("昨天");
  await expect(timeline(page).locator('[data-timeline-date="2025-12-31"]')).toContainText("2025");
  const futureHeading = timeline(page).locator('[data-timeline-date="2026-09-28"]'); await expect(futureHeading).toContainText(/9.*28/); await expect(futureHeading).not.toContainText(/今天|最近/);
  await capture(page, info, "date-labels");
});

test("07 long purpose stays bounded on row and appears in full with long note in Detail", async ({ page }, info) => {
  await start(page); await expect(row(page, IDS.long)).toHaveAccessibleName(new RegExp(LONG_PURPOSE));
  const purposeSize = await row(page, IDS.long).locator("[data-timeline-purpose]").evaluate(node => ({ height: node.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(node).lineHeight) }));
  expect(purposeSize.height).toBeLessThanOrEqual(purposeSize.lineHeight * 2 + 1);
  await capture(page, info, "long-purpose"); await openDetail(page, IDS.long);
  await expect(detail(page).getByText(LONG_PURPOSE, { exact: true })).toBeVisible(); await expect(detail(page)).toContainText(LONG_NOTE);
  await capture(page, info, "long-purpose-detail");
});

test("08 huge canonical TWD remains exact and readable at 200% text", async ({ page }, info) => {
  await start(page); await expect(row(page, IDS.huge)).toContainText(HUGE_DISPLAY);
  await expect(row(page, IDS.huge)).toHaveAccessibleName(new RegExp(HUGE_DISPLAY.replace(/\$/g, "\\$")));
  await capture(page, info, "large-amount");
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; }); await capture(page, info, "200-percent-timeline");
  await openDetail(page, IDS.huge); await expect(detail(page)).toContainText(HUGE_DISPLAY); await expect(back(page)).toBeVisible();
  await capture(page, info, "200-percent-large-amount-detail"); await openActions(page); await capture(page, info, "200-percent-more-actions");
});

for (const scenario of [
  { number: "09", id: IDS.expense, type: "支出", summary: "你付款", name: "expense" },
  { number: "10", id: IDS.income, type: "收入／退款", summary: "另一半收款", name: "income" },
  { number: "11", id: IDS.transfer, type: "轉帳", summary: "你 → 另一半", name: "transfer" },
  { number: "12", id: IDS.both, type: "支出", summary: "兩人付款", name: "both-payer" },
]) test(`${scenario.number} ${scenario.name} row and Detail use truthful type/payment semantics`, async ({ page }, info) => {
  const fixture = await start(page); const target = row(page, scenario.id);
  await expect(target).toContainText(scenario.summary); await expect(target).toHaveAccessibleName(new RegExp(scenario.type));
  if (scenario.id === IDS.income) await expect(target).toContainText(/＋NT\$100|\+NT\$100/);
  if (scenario.id === IDS.both) { await expect(target).not.toContainText("NT$120"); await expect(target).not.toContainText("NT$80"); }
  await capture(page, info, `${scenario.name}-row`); await openDetail(page, scenario.id);
  await expect(detail(page)).toContainText(scenario.type);
  if (scenario.id === IDS.both) { await expect(detail(page)).toContainText("NT$120"); await expect(detail(page)).toContainText("NT$80"); }
  if (scenario.id === IDS.transfer) { await expect(detail(page)).toContainText("你 → 另一半"); await expect(detail(page)).not.toContainText("分攤："); }
  if (scenario.id === IDS.income) { await expect(detail(page)).toContainText(/收款|分配/); await expect(detail(page)).toContainText("未分類"); }
  await capture(page, info, `${scenario.name}-detail`);
  if (scenario.id === IDS.expense) {
    const categoryId = "00000000-0000-4000-8000-000000003000";
    Object.assign(fixture.state.rows.find(item => item.id === IDS.expense)!, { category: null, categoryId });
    let categoryReadFails = true;
    await page.route(`**/api/app/v2/ledgers/${A}/categories`, route => categoryReadFails
      ? route.fulfill({ status: 500, json: { error: "fixture category read failure" } })
      : route.fulfill({ json: { categories: [{ id: categoryId, ledgerId: A, name: "封存餐飲", status: "archived", isDefault: false, createdAt: "2026-09-24T00:00:00Z", updatedAt: "2026-09-25T00:00:00Z" }] } }));
    const failedCategoryRead = page.waitForResponse(response => response.url().endsWith(`/ledgers/${A}/categories`) && response.status() === 500);
    await page.reload(); await failedCategoryRead; await expect(detail(page)).toBeVisible();
    await expect(detail(page)).toContainText("分類暫時無法顯示"); await expect(detail(page)).not.toContainText("未分類");
    await capture(page, info, "category-unavailable", { categoryId, categoryReadStatus: 500, requests: fixture.state.requests });
    categoryReadFails = false;
    const archivedCategoryRead = page.waitForResponse(response => response.url().endsWith(`/ledgers/${A}/categories`) && response.status() === 200);
    await page.reload(); await archivedCategoryRead; await expect(detail(page)).toContainText("封存餐飲");
    await expect(detail(page)).not.toContainText("分類暫時無法顯示"); await expect(detail(page)).not.toContainText("未分類");
    expect(fixture.actions.mutations).toHaveLength(0); expect(fixture.state.posts).toHaveLength(0);
    await capture(page, info, "archived-category-detail", { categoryId, categoryReadStatus: 200, categoryStatus: "archived", requests: fixture.state.requests });
  }
});

test("13–17 canonical Detail focuses heading, opens at top and returns scroll/focus to row beyond initial 20", async ({ page }, info) => {
  const fixture = await start(page); await page.getByRole("button", { name: "更早紀錄", exact: true }).click(); await expect(rows(page)).toHaveCount(40);
  const origin = row(page, transactionId(35)); await origin.scrollIntoViewIfNeeded(); await origin.focus();
  const before = await origin.evaluate(node => ({ top: node.getBoundingClientRect().top, scrollY })); expect(before.scrollY).toBeGreaterThan(500);
  const requests = fixture.state.requests.length, openedAt = performance.now(); await origin.click(); await expect(detail(page)).toBeVisible();
  await expect(detail(page).locator("[data-detail-heading]")).toBeFocused(); await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await expect(detail(page)).toContainText("日常紀錄 35"); await expect(detail(page)).toContainText("2026-09-25");
  const detailOpenMs = performance.now() - openedAt; expect(fixture.state.requests.slice(requests)).toEqual([]);
  await capture(page, info, "detail-from-row-35", { detailOpenMs, requestsAdded: fixture.state.requests.slice(requests) });
  const returnedAt = performance.now(); await back(page).click(); await expect(rows(page)).toHaveCount(40); await expect(origin).toBeFocused();
  await expect.poll(async () => Math.abs((await origin.evaluate(node => node.getBoundingClientRect().top)) - before.top)).toBeLessThan(5);
  await expect.poll(async () => Math.abs((await page.evaluate(() => scrollY)) - before.scrollY)).toBeLessThan(5);
  await capture(page, info, "back-row-35", { detailBackMs: performance.now() - returnedAt, origin: before, requests: fixture.state.requests });
});

test("18–19 direct Detail and reload replace Back to scoped Home without app-origin history escape", async ({ page }, info) => {
  const fixture = await timelineBrowser(page); await fixture.goto(detailUrl(IDS.expense)); await expect(detail(page)).toBeVisible();
  await expect(back(page)).toContainText("共同生活"); await expect(detail(page)).toContainText("單人付款晚餐");
  await page.reload(); await expect(detail(page)).toBeVisible(); await expect(page).toHaveURL(new RegExp(`v2Transaction=${IDS.expense}`));
  const length = await page.evaluate(() => history.length); await back(page).click(); await fixture.ready();
  await expect(page).toHaveURL(new RegExp(`v2Ledger=${A}$`)); expect(await page.evaluate(() => history.length)).toBe(length);
  await expect(rows(page)).toHaveCount(20); await capture(page, info, "direct-reload-back", { requests: fixture.state.requests });
});

for (const scenario of [{ number: "20", id: IDS.expense, ledger: B }, { number: "21", id: transactionId(999), ledger: A }]) test(`${scenario.number} wrong scoped or nonexistent transaction never falls back`, async ({ page }, info) => {
  const fixture = await timelineBrowser(page); await fixture.goto(detailUrl(scenario.id, scenario.ledger));
  await expect(page.getByRole("alert").filter({ hasText: /紀錄.*無法|紀錄.*不屬於|找不到/ })).toBeVisible();
  await expect(page.getByText("單人付款晚餐", { exact: true })).toHaveCount(0);
  const bootstrapPaths = fixture.state.requests.filter(item => item.path.endsWith("/bootstrap")).map(item => item.path);
  expect(bootstrapPaths).toEqual([`/api/app/v2/ledgers/${scenario.ledger}/bootstrap`]);
  expect(fixture.state.requests.some(item => item.path.includes(`/transactions/${scenario.id}`))).toBe(false);
  await capture(page, info, `scope-error-${scenario.number}`, { requests: fixture.state.requests });
});

test("22–24 replaced and void historical deep links resolve and 查看新版 opens exact replacement", async ({ page }, info) => {
  const fixture = await timelineBrowser(page); await fixture.goto(detailUrl(IDS.old)); await expect(detail(page)).toBeVisible();
  await expect(detail(page)).toContainText("這筆已更新"); await expect(detail(page)).toContainText("原始晚餐"); await capture(page, info, "replaced-old-detail");
  await detail(page).getByRole("button", { name: "查看新版", exact: true }).click(); await expect(page).toHaveURL(new RegExp(`v2Transaction=${IDS.replacement}`));
  await expect(detail(page)).toContainText("修正後晚餐");
  await fixture.goto(detailUrl(IDS.voided)); await expect(detail(page)).toContainText("已作廢，不計入目前近況"); await capture(page, info, "voided-detail");
});

test("25–26 edit uses shared P2-A controls and clean cancel returns to Detail", async ({ page }, info) => {
  await start(page); await openDetail(page, IDS.expense); await openActions(page); await capture(page, info, "more-actions");
  await detail(page).getByRole("button", { name: "修改", exact: true }).click();
  await expect(page.getByLabel("用途", { exact: true })).toHaveValue("單人付款晚餐"); await expect(page.getByLabel("金額，新臺幣")).toHaveValue("200");
  await expect(page.getByTestId("payer-summary")).toContainText("你付款"); await expect(page.getByTestId("split-summary")).toContainText("沿用這筆分攤");
  await capture(page, info, "correction"); await page.locator("[data-entry]").getByRole("button", { name: "取消", exact: true }).click(); await expect(detail(page)).toBeVisible();
  await expect(page.getByLabel("用途", { exact: true })).toHaveCount(0);
});

for (const readFailure of [false, true]) test(`${readFailure ? "28" : "27"} correction known commit remains success when read ${readFailure ? "500" : "succeeds"}`, async ({ page }, info) => {
  const fixture = await start(page); await openDetail(page, IDS.expense); await openActions(page); await detail(page).getByRole("button", { name: "修改", exact: true }).click();
  await page.getByLabel("用途", { exact: true }).fill("已修正的晚餐"); fixture.actions.failAfterMutation = readFailure;
  await page.getByRole("button", { name: "儲存修改", exact: true }).click();
  await expect(page.locator("[data-write-outcome]")).toContainText("已修改已修正的晚餐");
  await expect.poll(() => fixture.actions.mutations.length).toBe(1); expect(fixture.actions.mutations[0]!.body).toMatchObject({ action: "replace", expectedVersion: 1 });
  await expect(detail(page)).toContainText("已修正的晚餐"); await expect(page).toHaveURL(new RegExp(`v2Transaction=${transactionId(101)}`));
  if (readFailure) { await expect(page.locator("[data-write-outcome]")).toContainText(/暫時無法更新|重新整理/); await expect(page.getByText(/修改失敗/)).toHaveCount(0); }
  await capture(page, info, readFailure ? "correction-commit-read500" : "correction-committed", { mutations: fixture.actions.mutations, requests: fixture.state.requests });
});

for (const readFailure of [false, true]) test(`${readFailure ? "30" : "29"} explicit void preserves known success when read ${readFailure ? "500" : "succeeds"}`, async ({ page }, info) => {
  const fixture = await start(page); await openDetail(page, IDS.expense); await openActions(page); await detail(page).getByRole("button", { name: "作廢", exact: true }).click();
  await expect(detail(page)).toContainText("單人付款晚餐"); await expect(detail(page)).toContainText("NT$200"); expect(fixture.actions.mutations).toHaveLength(0);
  fixture.actions.failAfterMutation = readFailure; await detail(page).getByRole("button", { name: "確認作廢", exact: true }).click();
  await expect(detail(page)).toContainText("已作廢，不計入目前近況"); await expect(detail(page)).toContainText("已作廢");
  expect(fixture.actions.mutations).toHaveLength(1); expect(fixture.actions.mutations[0]!.body).toMatchObject({ action: "void", expectedVersion: 1 });
  if (readFailure) { await expect(detail(page)).toContainText(/暫時無法|待.*更新|重新整理/); await expect(detail(page)).not.toContainText("作廢失敗"); }
  await capture(page, info, readFailure ? "void-commit-read500" : "void-committed", { mutations: fixture.actions.mutations });
  await back(page).click(); await expect(row(page, IDS.expense)).toHaveCount(0); await expect(rows(page)).toHaveCount(20);
});

test("31 historical void Detail retains service restore ability", async ({ page }, info) => {
  const fixture = await timelineBrowser(page); await fixture.goto(detailUrl(IDS.voided)); await expect(detail(page)).toBeVisible(); await openActions(page);
  await detail(page).getByRole("button", { name: "恢復", exact: true }).click(); expect(fixture.actions.mutations).toHaveLength(0);
  await detail(page).getByRole("button", { name: "確認恢復", exact: true }).click(); await expect(detail(page)).toContainText("已恢復");
  await expect(detail(page)).not.toContainText("不計入目前近況"); expect(fixture.actions.mutations[0]!.body).toMatchObject({ action: "restore", expectedVersion: 2 });
  await capture(page, info, "restore-committed", { mutations: fixture.actions.mutations }); await back(page).click(); await loadAll(page); await expect(row(page, IDS.voided)).toBeVisible();
});

test("32–34 receipt existing open upload and delete stay within Detail attachment capability", async ({ page }, info) => {
  const fixture = await start(page); await openDetail(page, IDS.expense); await openActions(page);
  const receipt = detail(page).getByRole("link", { name: /PDF 收據/ }); await expect(receipt).toHaveAttribute("href", "https://receipt.example.invalid/existing.pdf"); await expect(receipt).toHaveAttribute("target", "_blank");
  await capture(page, info, "receipt-section");
  await detail(page).locator('input[type="file"]').setInputFiles({ name: "browser-receipt.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nfixture receipt\n") });
  await expect(detail(page)).toContainText("收據已上傳"); await expect(detail(page).getByRole("link", { name: /PDF 收據/ })).toHaveCount(2);
  expect(fixture.actions.attachmentRequests.map(item => item.method)).toEqual(["POST", "PUT", "POST"]);
  await detail(page).getByRole("button", { name: "刪除收據", exact: true }).first().click(); await expect(detail(page).getByRole("link", { name: /PDF 收據/ })).toHaveCount(1);
  expect(fixture.actions.mutations).toHaveLength(0); expect(fixture.state.posts).toHaveLength(0);
  await capture(page, info, "receipt-upload-delete", { attachmentRequests: fixture.actions.attachmentRequests });
});

test("35 attachment failure preserves posted financial state and sends no financial mutation", async ({ page }, info) => {
  const fixture = await start(page); await openDetail(page, IDS.expense); await openActions(page); fixture.actions.attachmentFailure = true;
  await detail(page).locator('input[type="file"]').setInputFiles({ name: "failed-receipt.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n") });
  await expect(detail(page)).toContainText("收據上傳失敗"); await expect(detail(page)).not.toContainText(/交易.*失敗|尚未確認|已作廢，不計入目前近況/);
  expect(fixture.state.rows.find(item => item.id === IDS.expense)!.status).toBe("posted"); expect(fixture.actions.mutations).toHaveLength(0); expect(fixture.state.posts).toHaveLength(0);
  await expect(page.locator('[data-write-outcome="unknown"], [data-write-outcome="submitting"]')).toHaveCount(0);
  await capture(page, info, "attachment-failure-financial-state", { attachmentRequests: fixture.actions.attachmentRequests });
});

test("36–37 timeline has one interactive row and no legacy details or duplicate financial/receipt actions", async ({ page }, info) => {
  await start(page); await expect(timeline(page).locator("details, summary, input[type=file]")).toHaveCount(0);
  await expect(timeline(page).getByRole("button", { name: /^(修改|編輯|作廢|恢復|加收據|刪除收據)$/ })).toHaveCount(0);
  expect(await rows(page).evaluateAll(nodes => nodes.every(node => node.querySelectorAll("button, a, input, summary").length === 0))).toBe(true);
  await openDetail(page, IDS.expense); await expect(timeline(page)).toHaveCount(0); await openActions(page);
  await expect(detail(page).getByRole("button", { name: "修改", exact: true })).toHaveCount(1); await expect(detail(page).getByRole("button", { name: "作廢", exact: true })).toHaveCount(1);
  await expect(detail(page).locator("details, summary")).toHaveCount(0); await capture(page, info, "single-detail-actions");
});

test("38–39 Search preserves secondary filters and include-void reveals historical row, with origin Back", async ({ page }, info) => {
  const fixture = await start(page); await expect(page.getByLabel("搜尋紀錄")).toHaveCount(0); await page.getByRole("button", { name: "搜尋", exact: true }).click();
  await expect(page.getByLabel("搜尋紀錄")).toBeVisible(); await expect(page.getByLabel("紀錄開始日期")).toBeVisible(); await expect(page.getByLabel("紀錄結束日期")).toBeVisible();
  await expect(page.getByLabel("付款人", { exact: true })).toBeVisible(); await expect(page.getByLabel("紀錄分類")).toBeVisible(); await expect(page.getByLabel("紀錄類型")).toBeVisible();
  await page.getByLabel("搜尋紀錄").fill("已作廢早餐"); await expect(row(page, IDS.voided)).toHaveCount(0);
  await page.getByLabel("包含已作廢", { exact: true }).check(); await expect(row(page, IDS.voided)).toBeVisible(); expect(new URL(page.url()).searchParams.get("includeVoided")).toBe("1");
  await row(page, IDS.voided).click(); await expect(detail(page)).toContainText("已作廢，不計入目前近況"); await back(page).click();
  await expect(page).toHaveURL(/view=search/); await expect(page.getByLabel("搜尋紀錄")).toHaveValue("已作廢早餐"); await expect(page.getByLabel("包含已作廢")).toBeChecked(); await expect(row(page, IDS.voided)).toBeFocused();
  await capture(page, info, "search-void-back", { requests: fixture.state.requests });
});

test("40 P2-B Ledger switch keeps truthful identity and scopes timeline data", async ({ page }, info) => {
  const fixture = await start(page); await switchLedger(page, B); await fixture.ready(); await expect(page.getByTestId("ledger-name-trigger")).toContainText("旅行");
  await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText("旅行帳本車票"); await expect(row(page, IDS.expense)).toHaveCount(0);
  await openDetail(page, transactionId(80)); await expect(back(page)).toContainText("旅行"); await capture(page, info, "ledger-switch-detail");
});

test("41 P2-A create editor remains usable and canonical upsert keeps future row first", async ({ page }, info) => {
  const fixture = await start(page); await fillEntry(page, "新增的正常日期紀錄", "681"); await page.getByTestId("payer-summary").click();
  await page.getByRole("dialog").getByRole("combobox").selectOption("partner"); await page.getByRole("dialog").getByRole("button", { name: "套用", exact: true }).click();
  await page.getByRole("button", { name: "加入", exact: true }).click(); await expect(page.locator("[data-write-outcome]")).toContainText("已加入新增的正常日期紀錄");
  await expect(rows(page)).toHaveCount(20); expect(await rows(page).first().getAttribute("data-transaction-id")).toBe(IDS.future);
  expect(fixture.state.posts).toHaveLength(1); const created = fixture.state.rows.find(item => item.description === "新增的正常日期紀錄")!;
  await loadAll(page); await expect(row(page, created.id)).toHaveCount(1); await capture(page, info, "new-create-canonical-upsert", { posts: fixture.state.posts });
});

test("42 dirty correction leave guard keeps draft/focus or explicitly discards with one dialog host", async ({ page }, info) => {
  const fixture = await start(page); await openDetail(page, IDS.expense); await openActions(page); await detail(page).getByRole("button", { name: "修改", exact: true }).click();
  const purpose = page.getByLabel("用途", { exact: true }); await purpose.fill("尚未儲存的更正"); await back(page).click();
  await expect(page.getByRole("dialog")).toHaveCount(1); await expect(page.getByRole("dialog")).toContainText(/放棄/); expect(fixture.actions.mutations).toHaveLength(0);
  await page.getByRole("dialog").getByRole("button", { name: "繼續編輯", exact: true }).click(); await expect(purpose).toHaveValue("尚未儲存的更正"); await expect(purpose).toBeFocused();
  await capture(page, info, "dirty-correction-preserved"); await back(page).click();
  await page.getByRole("dialog").getByRole("button", { name: /放棄/ }).click(); await expect(timeline(page)).toBeVisible(); expect(fixture.actions.mutations).toHaveLength(0);
});

test("first read has three static timeline skeletons and refresh failure preserves known effective rows", async ({ page }, info) => {
  const fixture = await timelineBrowser(page), hold = deferred(); fixture.state.holdReads.set(A, hold);
  await fixture.goto(); await expect(timeline(page).locator("[data-timeline-skeleton]")).toHaveCount(3);
  await expect(page.getByText("從一起花的第一筆開始", { exact: true })).toHaveCount(0); await capture(page, info, "timeline-loading");
  hold.release(); await fixture.ready(); await expect(rows(page)).toHaveCount(20); fixture.state.failReads.set(A, 500);
  await page.getByRole("button", { name: "重新整理帳本", exact: true }).click(); await expect(page.getByRole("alert").filter({ hasText: /fixture read failure/ })).toBeVisible();
  await expect(rows(page)).toHaveCount(20); await capture(page, info, "read-failure-keeps-timeline");
});

test("empty effective history avoids fake zeros and historical records remain deep-linkable", async ({ page }, info) => {
  const fixture = await start(page, { rows: timelineRows().filter(item => item.id === IDS.old || item.id === IDS.voided) });
  await expect(rows(page)).toHaveCount(0); await expect(timeline(page)).toContainText("從一起花的第一筆開始"); await capture(page, info, "empty-effective-history");
  await fixture.goto(detailUrl(IDS.voided)); await expect(detail(page)).toContainText("已作廢早餐");
});

test("Detail pending read and read500 never guess a transaction or reveal foreign scope", async ({ page }, info) => {
  const fixture = await timelineBrowser(page), hold = deferred(); fixture.state.holdReads.set(A, hold);
  await fixture.goto(detailUrl(IDS.expense)); await expect(page.getByTestId("transaction-detail-skeleton")).toBeVisible();
  await expect(page.getByText("單人付款晚餐", { exact: true })).toHaveCount(0); await capture(page, info, "detail-loading"); hold.release(); await expect(detail(page)).toBeVisible();
  fixture.state.holdReads.delete(A); fixture.state.failReads.set(A, 500); await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: /fixture read failure/ })).toBeVisible(); await expect(page.getByRole("button", { name: /重新整理|重新讀取/ }).first()).toBeVisible();
  await capture(page, info, "detail-read-error");
});

test("200% long notes and reduced motion keep Back and More actions reachable without overflow", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); const fixture = await timelineBrowser(page); await fixture.goto(detailUrl(IDS.long)); await expect(detail(page)).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await expect(back(page)).toBeVisible(); await more(page).scrollIntoViewIfNeeded(); await expect(more(page)).toBeInViewport();
  await openActions(page); await capture(page, info, "200-percent-long-note-reduced-motion"); await back(page).click(); await expect(timeline(page)).toBeVisible();
});

test("filtered Search preserves insertion-independent origin scroll and loaded second history page without a new request", async ({ page }, info) => {
  const fixture = await start(page, { searchPageSize: 50 }); await page.getByRole("button", { name: "搜尋", exact: true }).click();
  await page.getByLabel("紀錄類型").selectOption("expense"); await page.getByLabel("搜尋紀錄").fill("日常紀錄");
  await expect(page.getByRole("button", { name: "載入更早交易", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "載入更早交易", exact: true }).click();
  const origin = row(page, transactionId(59)); await expect(origin).toBeVisible(); await origin.scrollIntoViewIfNeeded(); await origin.focus();
  const before = await origin.evaluate(node => ({ top: node.getBoundingClientRect().top, scrollY })); expect(before.scrollY).toBeGreaterThan(500);
  const requests = fixture.state.requests.length; await origin.click(); await expect(detail(page)).toBeVisible(); await back(page).click();
  await expect(page.locator("[data-search-ready]")).toHaveAttribute("data-search-ready", "true"); await expect(origin).toBeFocused();
  await expect(page.getByLabel("紀錄類型")).toHaveValue("expense"); await expect(page.getByLabel("搜尋紀錄")).toHaveValue("日常紀錄");
  await expect.poll(async () => Math.abs((await origin.evaluate(node => node.getBoundingClientRect().top)) - before.top)).toBeLessThan(5);
  expect(fixture.state.requests.slice(requests)).toEqual([]); await expect(page.getByRole("button", { name: "載入更早交易", exact: true })).toHaveCount(0);
  await capture(page, info, "search-page-2-origin-restored", { origin: before, requests: fixture.state.requests });
});

for (const failedRead of [false, true]) test(`Search mutation refresh restores loaded history window and ${failedRead ? "preserves known rows on read500" : "reads the same two pages"}`, async ({ page }, info) => {
  const fixture = await start(page, { searchPageSize: 50 }); await page.getByRole("button", { name: "搜尋", exact: true }).click();
  await page.getByLabel("搜尋紀錄").fill("日常紀錄"); await expect(page.getByRole("button", { name: "載入更早交易", exact: true })).toBeVisible(); await page.getByRole("button", { name: "載入更早交易", exact: true }).click();
  const origin = row(page, transactionId(59)); await expect(origin).toBeVisible(); await origin.scrollIntoViewIfNeeded(); await origin.click(); await expect(detail(page)).toBeVisible(); await openActions(page);
  await detail(page).getByRole("button", { name: "作廢", exact: true }).click(); await detail(page).getByRole("button", { name: "確認作廢", exact: true }).click();
  await expect(detail(page)).toContainText("已作廢，不計入目前近況");
  await expect.poll(() => fixture.state.requests.filter(item => item.path.endsWith("/bootstrap")).length).toBe(2);
  fixture.actions.historyFailure = failedRead; const requests = fixture.state.requests.length; await back(page).click();
  await expect(page.locator("[data-search-ready]")).toHaveAttribute("data-search-ready", "true");
  await expect(row(page, transactionId(58))).toBeVisible(); await expect(origin).toHaveCount(0);
  const returnedRows = page.locator("button[data-transaction-id]"); await expect(returnedRows).toHaveCount(52);
  await expect(row(page, transactionId(58))).toBeFocused();
  if (failedRead) await expect(page.getByRole("alert").filter({ hasText: "fixture Search read failure" })).toBeVisible();
  else {
    const historyReads = fixture.state.requests.slice(requests).filter(item => /\/transactions\?/.test(item.path));
    expect(historyReads.map(item => new URL(`http://fixture${item.path}`).searchParams.get("cursor"))).toEqual([null, "50"]);
  }
  await capture(page, info, failedRead ? "search-mutation-known-history-read500" : "search-mutation-window-refreshed", { requests: fixture.state.requests, mutations: fixture.actions.mutations });
});

test("direct Detail retry focuses purpose heading after initial bootstrap read500", async ({ page }, info) => {
  const fixture = await timelineBrowser(page); fixture.state.failReads.set(A, 500); await fixture.goto(detailUrl(IDS.expense));
  await expect(page.getByRole("alert").filter({ hasText: /fixture read failure/ })).toBeVisible(); fixture.state.failReads.delete(A);
  await page.getByRole("alert").getByRole("button", { name: /重新整理|重新讀取/ }).click();
  await expect(detail(page)).toBeVisible(); await expect(detail(page).locator("[data-detail-heading]")).toBeFocused(); await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await capture(page, info, "detail-initial-read500-retry-focus", { requests: fixture.state.requests });
});

test("ambiguous void response retains original mutation key and expectedVersion across a successful background read", async ({ page }, info) => {
  const fixture = await start(page), hold = deferred();
  await page.route(`**/api/app/v2/ledgers/${A}/bootstrap`, async route => { await hold.promise; await route.fulfill({ json: fixture.snapshot(A) }); });
  await page.getByRole("button", { name: "重新整理帳本", exact: true }).click();
  await expect.poll(() => fixture.state.requests.filter(item => item.path.endsWith("/bootstrap")).length).toBe(2);
  await openDetail(page, IDS.expense); await openActions(page); fixture.actions.dropNextMutationResponse = true;
  await detail(page).getByRole("button", { name: "作廢", exact: true }).click(); await detail(page).getByRole("button", { name: "確認作廢", exact: true }).click();
  await expect(detail(page).getByTestId("mutation-status")).toContainText("尚未確認是否已作廢");
  hold.release(); await expect(detail(page)).toContainText("已作廢，不計入目前近況");
  await detail(page).getByRole("button", { name: "確認作廢", exact: true }).click(); await expect(detail(page).getByTestId("mutation-status")).toHaveText("已作廢");
  expect(fixture.actions.mutations).toHaveLength(2); expect(fixture.actions.mutations[1]!.body).toEqual(fixture.actions.mutations[0]!.body);
  expect(fixture.actions.mutations[1]!.body).toMatchObject({ action: "void", expectedVersion: 1, idempotencyKey: `v2:transaction:${IDS.expense}:void:1` });
  expect(fixture.state.rows.find(item => item.id === IDS.expense)!.version).toBe(2); expect(fixture.state.version).toBe(2);
  await capture(page, info, "void-ambiguous-same-key-after-read", { mutations: fixture.actions.mutations, requests: fixture.state.requests });
});

test("voiding an origin row beyond twenty returns focus to its nearest surviving timeline row", async ({ page }, info) => {
  await start(page); await page.getByRole("button", { name: "更早紀錄", exact: true }).click();
  const origin = row(page, transactionId(35)); await origin.scrollIntoViewIfNeeded(); const before = await origin.evaluate(node => node.getBoundingClientRect().top);
  await openDetail(page, transactionId(35)); await openActions(page); await detail(page).getByRole("button", { name: "作廢", exact: true }).click(); await detail(page).getByRole("button", { name: "確認作廢", exact: true }).click();
  await expect(detail(page)).toContainText("已作廢，不計入目前近況"); await back(page).click(); await expect(rows(page)).toHaveCount(40); await expect(origin).toHaveCount(0);
  const nearest = row(page, transactionId(36)); await expect(nearest).toBeFocused();
  await expect.poll(async () => Math.abs((await nearest.evaluate(node => node.getBoundingClientRect().top)) - before)).toBeLessThan(5);
  await capture(page, info, "void-origin-nearest-row-focus");
});

test("browser records native view-transition support for bounded Detail-close motion", async ({ page }, info) => {
  await start(page); const support = await page.evaluate(() => typeof document.startViewTransition === "function");
  await page.evaluate(() => {
    const observations: string[] = []; Object.assign(window, { detailCloseMotion: observations });
    if (typeof document.startViewTransition !== "function") return;
    const original = document.startViewTransition;
    document.startViewTransition = (...args: Parameters<Document["startViewTransition"]>) => {
      const transition = original.apply(document, args);
      void transition.ready.then(() => observations.push(getComputedStyle(document.documentElement, "::view-transition-old(transaction-detail)").animationDuration)).catch(() => undefined);
      return transition;
    };
  });
  await openDetail(page, IDS.expense); await back(page).click(); await expect(timeline(page)).toBeVisible();
  if (support) await expect.poll(() => page.evaluate(() => (window as unknown as { detailCloseMotion: string[] }).detailCloseMotion)).toEqual(["0.14s"]);
  await page.emulateMedia({ reducedMotion: "reduce" }); await openDetail(page, IDS.expense); await back(page).click(); await expect(timeline(page)).toBeVisible();
  const motion = await page.evaluate(() => (window as unknown as { detailCloseMotion: string[] }).detailCloseMotion);
  expect(motion).toHaveLength(support ? 1 : 0);
  await capture(page, info, "native-view-transition-support", { supported: support, motion });
});

test("aborted filtered Search append returns an enabled retry and preserves the loaded first page", async ({ page }, info) => {
  const fixture = await start(page, { searchPageSize: 50 }); await page.getByRole("button", { name: "搜尋", exact: true }).click(); await page.getByLabel("搜尋紀錄").fill("日常紀錄");
  await expect(page.getByRole("button", { name: "載入更早交易", exact: true })).toBeVisible(); const hold = deferred(); let holdOlder = true;
  await page.route(`**/api/app/v2/ledgers/${A}/transactions?*`, async route => {
    if (new URL(route.request().url()).searchParams.get("cursor") === "50" && holdOlder) await hold.promise;
    await route.fallback().catch(() => undefined);
  });
  await page.getByRole("button", { name: "載入更早交易", exact: true }).click(); await expect(page.getByRole("button", { name: "載入中…", exact: true })).toBeDisabled();
  const origin = row(page, transactionId(35)); await origin.click(); await expect(detail(page)).toBeVisible(); await back(page).click();
  await expect(origin).toBeFocused(); await expect(page.locator("button[data-transaction-id]")).toHaveCount(50); await expect(page.getByRole("button", { name: "載入更早交易", exact: true })).toBeEnabled();
  holdOlder = false; hold.release(); await page.getByRole("button", { name: "載入更早交易", exact: true }).click(); await expect(row(page, transactionId(59))).toBeVisible();
  await expect(page.locator("button[data-transaction-id]")).toHaveCount(53); await expect(page.getByRole("button", { name: "載入更早交易", exact: true })).toHaveCount(0);
  await capture(page, info, "search-aborted-append-retry", { requests: fixture.state.requests });
});

test("Back expands root render window when a new canonical row moves the surviving origin beyond row twenty", async ({ page }, info) => {
  const fixture = await start(page), hold = deferred();
  await page.route(`**/api/app/v2/ledgers/${A}/bootstrap`, async route => { await hold.promise; await route.fulfill({ json: fixture.snapshot(A) }); });
  await page.getByRole("button", { name: "重新整理帳本", exact: true }).click();
  await expect.poll(() => fixture.state.requests.filter(item => item.path.endsWith("/bootstrap")).length).toBe(2);
  const origin = row(page, transactionId(20)); await origin.scrollIntoViewIfNeeded(); await origin.click(); await expect(detail(page)).toBeVisible();
  const source = fixture.state.rows.find(item => item.id === IDS.expense)!;
  fixture.state.rows.unshift({ ...structuredClone(source), id: transactionId(150), description: "讀回的新紀錄", note: null, category: null, createdAt: "2026-09-25T23:59:59Z" }); fixture.state.version += 1;
  hold.release(); await expect.poll(() => fixture.state.requests.filter(item => item.path.endsWith("/bootstrap") && item.finishedAt).length).toBe(2);
  await back(page).click(); await expect(rows(page)).toHaveCount(40); await expect(origin).toBeFocused();
  expect(await rows(page).first().getAttribute("data-transaction-id")).toBe(IDS.future); await expect(row(page, transactionId(150))).toBeVisible();
  await capture(page, info, "new-canonical-row-expands-origin-window", { requests: fixture.state.requests });
});
