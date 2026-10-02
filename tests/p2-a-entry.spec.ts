import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { correctionDraft, newTransactionDraft, normalizeTransactionDraft, type DraftFields } from "../src/lib/v2-transaction-draft";
import { splitEqual, splitPercentage, splitWeights, validateV2Transaction } from "../src/lib/v2-ledger";
import type { V2LedgerTransaction } from "../src/lib/types";
import { entryBrowser, fillEntry, LEDGER, OWNER, PARTNER } from "./fixtures/p1-b-browser";

test.use({ video: "on" });
test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date("2026-09-25T04:00:00Z")); });
const payer = (page: Page) => page.getByTestId("payer-summary");
const split = (page: Page) => page.getByTestId("split-summary");
const join = (page: Page) => page.getByRole("button", { name: "加入", exact: true });
const modal = (page: Page) => page.getByRole("dialog");
async function setPayer(page: Page, mode: DraftFields["paymentMode"], amounts?: [string, string]) {
  await payer(page).click();
  await modal(page).getByRole("combobox").selectOption(mode);
  if (amounts) { await page.getByLabel("你 金額", { exact: true }).fill(amounts[0]); await page.getByLabel("另一半 金額", { exact: true }).fill(amounts[1]); }
  await modal(page).getByRole("button", { name: "套用", exact: true }).click();
  await expect(payer(page)).toBeFocused();
}
async function setSplit(page: Page, mode: DraftFields["splitMode"], amounts?: [string, string]) {
  await split(page).click();
  await modal(page).getByRole("combobox").selectOption(mode);
  if (amounts) { const suffix = mode === "percentage" ? "百分比" : "分攤"; await page.getByLabel(`你 ${suffix}`, { exact: true }).fill(amounts[0]); await page.getByLabel(`另一半 ${suffix}`, { exact: true }).fill(amounts[1]); }
  await modal(page).getByRole("button", { name: "套用", exact: true }).click();
  await expect(split(page)).toBeFocused();
}
async function evidence(page: Page, info: TestInfo, name: string, extra: unknown = {}) {
  const directory = `output/playwright/p2-a/${info.project.name}`;
  mkdirSync(directory, { recursive: true });
  const metrics = await page.evaluate(() => {
    const visible = (node: Element) => node.getBoundingClientRect().height > 0 && (!node.closest("dialog") || node.closest("dialog")!.open) && (!node.closest("details") || node.closest("details")!.open || node.tagName === "SUMMARY");
    return { viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth, dialogs: document.querySelectorAll("dialog").length,
      targets: Array.from(document.querySelectorAll("[data-entry] button, [data-entry] input, [data-entry] summary, dialog[open] button, dialog[open] input, dialog[open] select")).filter(visible).map(node => ({ name: node.getAttribute("aria-label") || node.textContent, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })) };
  });
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewport.width + 1);
  expect(metrics.dialogs).toBe(1);
  for (const target of metrics.targets) { expect(target.height, target.name ?? "target").toBeGreaterThanOrEqual(44); expect(target.width).toBeGreaterThanOrEqual(44); }
  const path = `${directory}/${name}.png`;
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  writeFileSync(`${directory}/${name}.json`, JSON.stringify({ metrics, extra }, null, 2));
  await info.attach(name, { path, contentType: "image/png" });
}

const cases: Array<{ name: string; actor: string; weights: [string, string]; patch: Partial<DraftFields>; kernel: "weights" | "equal" | "percentage" | "exact" }> = [
  { name: "default-simple-1-1", actor: OWNER, weights: ["1", "1"], patch: {}, kernel: "weights" },
  { name: "non-50-50-second-member-partner-2-1", actor: PARTNER, weights: ["2", "1"], patch: { paymentMode: "partner" }, kernel: "weights" },
  { name: "both-payers-second-member-0-1", actor: PARTNER, weights: ["0", "1"], patch: { paymentMode: "both", selfPayment: "300", partnerPayment: "381" }, kernel: "weights" },
  { name: "equal-second-member", actor: PARTNER, weights: ["2", "1"], patch: { splitMode: "equal" }, kernel: "equal" },
  { name: "percentage-fractional", actor: PARTNER, weights: ["1", "1"], patch: { splitMode: "percentage", selfPercentage: "33.33", partnerPercentage: "66.67" }, kernel: "percentage" },
  { name: "exact-partner-payer", actor: OWNER, weights: ["2", "1"], patch: { paymentMode: "partner", splitMode: "exact", selfShare: "600", partnerShare: "81" }, kernel: "exact" },
  { name: "income-both", actor: OWNER, weights: ["2", "1"], patch: { type: "income", paymentMode: "both", selfPayment: "400", partnerPayment: "281" }, kernel: "weights" },
  { name: "transfer-partner-direction", actor: PARTNER, weights: ["2", "1"], patch: { type: "transfer", paymentMode: "partner" }, kernel: "exact" },
];
for (const scenario of cases) test(`command body matches P1-B and kernel: ${scenario.name}`, async ({ page }, info) => {
  const fixture = await entryBrowser(page, { actor: scenario.actor, weights: { [OWNER]: scenario.weights[0], [PARTNER]: scenario.weights[1] } });
  const bootstrap = fixture.snapshot();
  await fillEntry(page, " 晚餐 ");
  await expect(page.getByLabel("用途", { exact: true })).toHaveValue(" 晚餐 ");
  if (scenario.patch.type) { await page.getByText("更多", { exact: true }).click(); await page.getByLabel("交易類型").selectOption(scenario.patch.type); await page.getByText("更多", { exact: true }).click(); }
  const before = fixture.state.requests.length;
  if (scenario.patch.paymentMode) await setPayer(page, scenario.patch.paymentMode, scenario.patch.paymentMode === "both" ? [scenario.patch.selfPayment!, scenario.patch.partnerPayment!] : undefined);
  if (scenario.patch.splitMode) await setSplit(page, scenario.patch.splitMode, scenario.patch.splitMode === "percentage" ? [scenario.patch.selfPercentage!, scenario.patch.partnerPercentage!] : scenario.patch.splitMode === "exact" ? [scenario.patch.selfShare!, scenario.patch.partnerShare!] : undefined);
  expect(fixture.state.requests).toHaveLength(before);
  expect(fixture.state.posts).toHaveLength(0);
  const expected = normalizeTransactionDraft({ ...newTransactionDraft(bootstrap, scenario.actor, "2026-09-25", "oracle"), amountTwd: "681", description: " 晚餐 ", ...scenario.patch });
  if (scenario.patch.type === "transfer") { await expect(payer(page)).toContainText("另一半 → 你"); await expect(split(page)).toHaveCount(0); }
  else {
    const allocations = scenario.kernel === "weights" ? splitWeights("681", [OWNER, PARTNER], scenario.weights) : scenario.kernel === "equal" ? splitEqual("681", [OWNER, PARTNER]) : scenario.kernel === "percentage" ? splitPercentage("681", [OWNER, PARTNER], [66.67, 33.33]) : { [OWNER]: 600n, [PARTNER]: 81n };
    expect(expected.shares).toEqual([OWNER, PARTNER].map(userId => ({ userId, amountTwd: String(allocations[userId]) })));
  }
  await expect(join(page)).toBeEnabled();
  await evidence(page, info, scenario.name, { expected });
  await join(page).click();
  await expect.poll(() => fixture.state.posts.length).toBe(1);
  const { idempotencyKey, ...body } = fixture.state.posts[0]!.body;
  expect(idempotencyKey).toBeTruthy(); expect(body).toEqual(expected);
  validateV2Transaction({ ...expected, ledgerId: LEDGER }, { ledgerId: LEDGER, memberIds: [OWNER, PARTNER] });
  await evidence(page, info, `${scenario.name}-command`, { actual: fixture.state.posts[0], expected });
});

test("one host, cancel preserves draft, Apply only edits draft and returns focus", async ({ page }, info) => {
  const { state } = await entryBrowser(page); await fillEntry(page);
  const requests = state.requests.length;
  await payer(page).click(); await expect(modal(page)).toHaveCount(1);
  await modal(page).getByRole("combobox").selectOption("partner");
  await modal(page).getByRole("button", { name: "取消", exact: true }).click();
  await expect(payer(page)).toContainText("你付款"); await expect(payer(page)).toBeFocused();
  await split(page).click(); await modal(page).getByRole("combobox").selectOption("exact");
  await page.getByLabel("你 分攤", { exact: true }).fill("500");
  await page.keyboard.press("Escape");
  await expect(split(page)).toContainText("平均分"); await expect(split(page)).toBeFocused();
  await setPayer(page, "partner"); await setSplit(page, "percentage", ["25", "75"]);
  expect(state.requests).toHaveLength(requests); expect(state.posts).toHaveLength(0);
  await evidence(page, info, "partner-payer", { requests });
  await payer(page).click();
  await page.keyboard.press("Tab"); await expect(modal(page).getByRole("button", { name: "關閉視窗" })).toBeFocused();
  await page.keyboard.press("Tab"); await expect(modal(page).getByRole("combobox")).toBeFocused();
  await evidence(page, info, "keyboard-modal");
});

test("both payments and exact shares retain explicit amounts after total changes", async ({ page }, info) => {
  const { state } = await entryBrowser(page); await fillEntry(page);
  await setPayer(page, "both", ["400", "281"]); await setSplit(page, "exact", ["600", "81"]);
  await evidence(page, info, "both-payers");
  await page.getByLabel("金額，新臺幣").fill("700");
  await expect(join(page)).toBeDisabled(); await expect(split(page)).toContainText("分攤尚未完成");
  await expect(payer(page)).toContainText("NT$400／另一半 NT$281");
  await evidence(page, info, "invalid-split");
  await payer(page).click(); await expect(page.getByLabel("你 金額", { exact: true })).toHaveValue("400"); await expect(page.getByLabel("另一半 金額", { exact: true })).toHaveValue("281"); await expect(page.locator("#entry-control-error")).toContainText("還差 NT$19");
  await modal(page).getByRole("button", { name: "取消", exact: true }).click();
  await split(page).click(); await expect(page.getByLabel("你 分攤", { exact: true })).toHaveValue("600"); await expect(page.getByLabel("另一半 分攤", { exact: true })).toHaveValue("81"); await expect(page.locator("#entry-control-error")).toContainText("還差 NT$19");
  await modal(page).getByRole("button", { name: "取消", exact: true }).click();
  expect(state.posts).toHaveLength(0);
  await setPayer(page, "both", ["400", "300"]); await setSplit(page, "exact", ["600", "100"]);
  await expect(join(page)).toBeEnabled();
});

test("IME, Enter, disabled reasons, inline association and first-invalid focus", async ({ page }, info) => {
  const { state } = await entryBrowser(page);
  await expect(join(page)).toBeDisabled(); await expect(page.locator("#entry-disabled-reason")).toContainText("整數");
  await page.locator("[data-entry] form").dispatchEvent("submit");
  await expect(page.getByLabel("金額，新臺幣")).toBeFocused(); await expect(page.getByLabel("金額，新臺幣")).toHaveAttribute("aria-describedby", "entry-amountTwd-error");
  await page.getByLabel("金額，新臺幣").fill("681"); await page.getByLabel("金額，新臺幣").press("Enter"); await expect(page.getByLabel("用途", { exact: true })).toBeFocused();
  await page.getByLabel("用途", { exact: true }).fill(" 晚餐 ");
  const purpose = page.getByLabel("用途", { exact: true });
  await purpose.dispatchEvent("compositionstart", { data: "餐" }); await expect(join(page)).toBeDisabled();
  await purpose.dispatchEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true }); expect(state.posts).toHaveLength(0);
  await purpose.dispatchEvent("compositionend", { data: "餐" }); await expect(join(page)).toBeEnabled();
  await purpose.dispatchEvent("keydown", { key: "Enter", keyCode: 229 }); expect(state.posts).toHaveLength(0);
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 420 });
  await purpose.press("Enter"); await expect(join(page)).toBeFocused(); await expect(join(page)).toBeInViewport(); expect(state.posts).toHaveLength(0);
  const actionRect = await join(page).evaluate(node => { const rect = node.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: innerHeight }; });
  expect(actionRect.top).toBeGreaterThanOrEqual(0); expect(actionRect.bottom).toBeLessThanOrEqual(actionRect.height);
  await evidence(page, info, "keyboard-reduced-viewport", { actionRect });
  await page.setViewportSize({ width: page.viewportSize()!.width, height: info.project.name.endsWith("393") ? 852 : 844 });
  await evidence(page, info, "ime-and-keyboard", { postsBeforeExplicitActivation: state.posts.length });
  await page.keyboard.press("Enter"); await expect.poll(() => state.posts.length).toBe(1); expect(state.posts[0]!.body.description).toBe("晚餐");
});

test("incomplete percentages do not pretend to be equal and default snapshot stays frozen", async ({ page }, info) => {
  const { state } = await entryBrowser(page, { weights: { [OWNER]: "2", [PARTNER]: "1" } }); await fillEntry(page);
  await expect(split(page)).toContainText("你 2：另一半 1 分攤");
  state.weights = { [OWNER]: "1", [PARTNER]: "1" }; state.version += 1;
  await page.getByLabel("重新整理帳本").click(); await expect(split(page)).toContainText("你 2：另一半 1 分攤");
  await setSplit(page, "percentage", ["", "100"]); await expect(join(page)).toBeDisabled(); await expect(split(page)).toContainText("分攤尚未完成");
  await setSplit(page, "percentage", ["33.333", "66.667"]); await expect(join(page)).toBeDisabled();
  await setSplit(page, "weights"); await expect(split(page)).toContainText("你 2：另一半 1 分攤");
  state.mode = "drop"; await join(page).click(); await expect(page.locator("[data-write-outcome]")).toContainText("尚未確認");
  await page.getByRole("button", { name: "確認並完成這筆", exact: true }).click(); await expect.poll(() => state.posts.length).toBe(2); expect(state.posts[1]!.bytes).toBe(state.posts[0]!.bytes);
  await evidence(page, info, "frozen-default-replay", { posts: state.posts });
});

for (const type of ["expense", "income", "transfer"] as const) test(`correction hydrates actual stored ${type} with historical exact shares`, async ({ page }, info) => {
  const row: V2LedgerTransaction = { id: "00000000-0000-4000-8000-000000000077", ledgerId: LEDGER, status: "posted", version: 3, createdAt: "2026-08-17T00:00:00Z", occurredOn: "2026-08-17", type, amountTwd: "681", description: "歷史餐費", category: "餐飲", categoryId: null, note: "保留原備註", splitMethod: type === "transfer" ? "none" : "percentage", payments: type === "transfer" ? [{ userId: PARTNER, amountTwd: "681" }] : [{ userId: OWNER, amountTwd: "400" }, { userId: PARTNER, amountTwd: "281" }], shares: type === "transfer" ? [{ userId: OWNER, amountTwd: "681" }] : [{ userId: OWNER, amountTwd: "600" }, { userId: PARTNER, amountTwd: "81" }] };
  const original = structuredClone(row);
  const fixture = await entryBrowser(page, { rows: [row], weights: { [OWNER]: "0", [PARTNER]: "1" } }); const bootstrap = fixture.snapshot();
  await page.locator("[data-transaction-id]").filter({ hasText: "歷史餐費" }).first().click(); await page.getByRole("button", { name: "編輯", exact: true }).click();
  await expect(page.getByLabel("用途", { exact: true })).toHaveValue("歷史餐費"); await expect(page.getByLabel("金額，新臺幣")).toHaveValue("681");
  if (type === "transfer") { await expect(payer(page)).toContainText("另一半 → 你"); await expect(split(page)).toHaveCount(0); }
  else { await expect(payer(page)).toContainText("你 NT$400／另一半 NT$281"); await expect(split(page)).toContainText(`沿用這筆${type === "income" ? "分配" : "分攤"} · 你 NT$600／另一半 NT$81`); }
  await expect(page.getByTestId("entry-more-summary")).toContainText("2026-08-17 · 餐飲 · 備註：保留原備註");
  await evidence(page, info, `correction-${type}`);
  await page.getByText("更多", { exact: true }).click(); await expect(page.getByLabel("交易類型")).toHaveValue(type); await expect(page.getByLabel("交易日期")).toHaveValue("2026-08-17"); await expect(page.getByLabel("分類", { exact: true })).toHaveValue("餐飲"); await expect(page.getByLabel("備註")).toHaveValue("保留原備註");
  await page.getByLabel("用途", { exact: true }).fill("修改歷史餐費"); await page.getByRole("button", { name: "儲存修改", exact: true }).click();
  await expect.poll(() => fixture.state.posts.length).toBe(1);
  const expected = normalizeTransactionDraft({ ...correctionDraft(bootstrap, OWNER, "2026-09-25", "oracle", original), description: "修改歷史餐費" });
  expect(fixture.state.posts[0]!.body).toMatchObject({ action: "replace", expectedVersion: 3, replacement: expected });
  await evidence(page, info, `correction-${type}-command`, { actual: fixture.state.posts[0], expected });
});

test("More retains non-default values and 200% text remains reachable without overflow", async ({ page }, info) => {
  const { state } = await entryBrowser(page); await fillEntry(page);
  await page.getByText("更多", { exact: true }).click();
  await page.getByLabel("交易日期").fill("2026-08-17"); await page.getByLabel("分類", { exact: true }).fill("餐飲"); await page.getByLabel("備註").fill("兩人晚餐的原始備註");
  await evidence(page, info, "more-expanded");
  await page.getByText("更多", { exact: true }).click(); await expect(page.getByTestId("entry-more-summary")).toContainText("2026-08-17 · 餐飲 · 備註：兩人晚餐的原始備註");
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await evidence(page, info, "200-percent-text");
  await split(page).click(); await modal(page).getByRole("combobox").selectOption("percentage"); await evidence(page, info, "percentage-200-percent-text");
  await modal(page).getByRole("button", { name: "取消", exact: true }).click(); await expect(split(page)).toBeFocused();
  await join(page).focus(); await expect(join(page)).toBeFocused(); expect(state.posts).toHaveLength(0);
});


test("switching both to transfer requires an explicit sender and never dispatches a guessed direction", async ({ page }, info) => {
  const { state } = await entryBrowser(page); await fillEntry(page); await setPayer(page, "both", ["400", "281"]);
  await page.getByText("更多", { exact: true }).click(); await page.getByLabel("交易類型").selectOption("transfer");
  await expect(payer(page)).toContainText("發送人尚未選擇"); await expect(join(page)).toBeDisabled(); expect(state.posts).toHaveLength(0);
  await payer(page).click(); await expect(modal(page).getByRole("combobox")).toHaveValue("both"); await expect(modal(page).getByRole("combobox").locator('option:checked')).toHaveText("請選擇一位發送人");
  await modal(page).getByRole("combobox").selectOption("partner"); await modal(page).getByRole("button", { name: "套用" }).click();
  await expect(payer(page)).toContainText("另一半 → 你"); await expect(join(page)).toBeEnabled();
  await evidence(page, info, "explicit-transfer-sender"); await join(page).click(); await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0]!.body).toMatchObject({ type: "transfer", payments: [{ userId: PARTNER, amountTwd: "681" }], shares: [{ userId: OWNER, amountTwd: "681" }], splitMethod: "none" });
});

test("second-member controls retain Ledger order, full kernel preview and associated incomplete errors", async ({ page }, info) => {
  await entryBrowser(page, { actor: PARTNER }); await fillEntry(page);
  await payer(page).click(); const select = modal(page).getByRole("combobox");
  expect(await select.locator('option').evaluateAll(options => options.slice(0, 2).map(option => (option as HTMLOptionElement).value))).toEqual(["partner", "self"]);
  await select.selectOption("both"); expect(await modal(page).locator('[data-member-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-member-id')))).toEqual([OWNER, PARTNER]);
  await modal(page).getByRole("button", { name: "取消", exact: true }).click();
  await split(page).click(); await expect(modal(page).getByTestId("split-control-preview")).toContainText("另一半 NT$341／你 NT$340");
  await select.selectOption("percentage"); expect(await modal(page).locator('[data-member-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-member-id')))).toEqual([OWNER, PARTNER]);
  await select.selectOption("exact"); expect(await modal(page).locator('[data-member-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-member-id')))).toEqual([OWNER, PARTNER]);
  await modal(page).getByRole("button", { name: "取消", exact: true }).click(); await page.getByLabel("金額，新臺幣").fill("");
  await payer(page).click(); await select.selectOption("both"); await expect(page.getByLabel("你 金額", { exact: true })).toHaveAttribute("aria-describedby", "entry-control-error");
  await evidence(page, info, "ledger-order-and-incomplete-association");
});
