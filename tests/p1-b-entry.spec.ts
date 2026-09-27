import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { ENTRY_RECOVERY_KEY } from "../src/lib/v2-entry-operation";
import { entryBrowser, fillEntry, LEDGER, OTHER, OWNER, PARTNER } from "./fixtures/p1-b-browser";

test.use({ video: "on" });
const unknown = "尚未確認是否已加入，請勿再記一次。";
const status = (page: Page) => page.locator("[data-write-outcome]");
async function capture(page: Page, info: TestInfo, name: string) {
  const directory = `output/playwright/p1-b/${info.project.name}`;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

test("normal create commits row, balance and next payer together without a bootstrap refresh", async ({ page }, info) => {
  const { state } = await entryBrowser(page); await fillEntry(page);
  const reads = state.requests.filter(path => path.endsWith("/bootstrap")).length;
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(status(page)).toContainText("已加入晚餐 NT$681");
  await expect(page.getByRole("heading", { name: "你目前多付" })).toBeVisible();
  await expect(page.getByText("下次建議由 另一半 付款", { exact: true })).toBeVisible();
  await expect(page.locator("summary").filter({ hasText: "晚餐" })).toBeVisible();
  expect(state.requests.filter(path => path.endsWith("/bootstrap"))).toHaveLength(reads);
  expect(state.posts).toHaveLength(1); expect(JSON.parse(state.posts[0]!.recovery!).phase).toBe("submitting");
  await expect(page.getByLabel("金額（新台幣）")).toHaveValue("");
  await capture(page, info, "normal-committed");
});

test("double tap owns one operation and guards switching while submitting", async ({ page }, info) => {
  const { state } = await entryBrowser(page); state.mode = "delay"; await fillEntry(page);
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  await page.locator("form").first().dispatchEvent("submit");
  await page.getByLabel("切換帳本").selectOption(OTHER);
  await expect(page.getByLabel("切換帳本")).toHaveValue(LEDGER);
  await expect(status(page)).toContainText("正在加入");
  await expect(page.getByLabel("用途", { exact: true })).toBeDisabled();
  await capture(page, info, "submitting");
  expect(state.posts).toHaveLength(1); state.release!();
  await expect(status(page)).toContainText("已加入晚餐");
});

test("commit then dropped response reloads UNKNOWN and explicit replay returns original result with identical body/key", async ({ page }, info) => {
  const { state } = await entryBrowser(page); state.mode = "drop"; await fillEntry(page);
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(status(page)).toContainText(unknown); expect(state.effects).toBe(1);
  await expect(page.getByLabel("用途", { exact: true })).toHaveValue("晚餐");
  await expect(page.getByLabel("用途", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "儲存交易" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "儲存中…" })).toHaveCount(0);
  await capture(page, info, "unknown");
  await page.reload(); await expect(status(page)).toContainText(unknown);
  expect(state.posts).toHaveLength(1);
  await capture(page, info, "reload-recovery");
  await page.getByRole("button", { name: "確認並完成這筆" }).click();
  await expect(status(page)).toContainText("已加入晚餐 NT$681");
  expect(state.posts[1]!.bytes).toBe(state.posts[0]!.bytes); expect(state.posts[1]!.key).toBe(state.posts[0]!.key);
  expect(state.posts[1]!.endpoint).toBe(state.posts[0]!.endpoint); expect(state.effects).toBe(1);
});

test("compatible partial commit plus GET 500 stays COMMITTED, including reload and read-only retry", async ({ page }, info) => {
  const { state } = await entryBrowser(page); state.mode = "partial"; state.failRead = true; await fillEntry(page);
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(status(page)).toContainText("已加入晚餐 NT$681。其他紀錄暫時無法更新。");
  expect(JSON.parse((await page.evaluate(key => sessionStorage.getItem(key), ENTRY_RECOVERY_KEY))!).phase).toBe("committed");
  await capture(page, info, "committed-read-failed");
  state.failRead = false; await page.reload();
  await expect(status(page)).toContainText("已加入晚餐 NT$681");
  expect(state.posts).toHaveLength(1);
});

for (const mode of ["malformed", "wrong-scope"] as const) test(`${mode} 2xx cannot claim success`, async ({ page }) => {
  const { state } = await entryBrowser(page); state.mode = mode; await fillEntry(page);
  await page.getByRole("button", { name: "儲存交易" }).click(); await expect(status(page)).toContainText(unknown);
  await expect(page.getByText("已加入晚餐", { exact: false })).toHaveCount(0);
});

test("storage unavailable or incorrect read-back prevents POST and keeps editing", async ({ page }) => {
  const { state } = await entryBrowser(page); await fillEntry(page);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException("quota", "QuotaExceededError"); }; });
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(status(page)).toContainText("尚未送出，輸入內容仍保留");
  await expect(page.getByLabel("用途", { exact: true })).toBeEnabled();
  await page.getByLabel("用途", { exact: true }).fill("保留輸入"); expect(state.posts).toHaveLength(0);
});

test("recovery identity mismatch reveals no stored financial content and cannot replay", async ({ page }, info) => {
  const { state } = await entryBrowser(page); state.mode = "drop"; await fillEntry(page, "私人用途");
  await page.getByRole("button", { name: "儲存交易" }).click(); await expect(status(page)).toContainText(unknown);
  state.actor = PARTNER; state.rows = []; await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "其他登入身分" })).toBeVisible();
  await expect(page.getByRole("button", { name: "確認並完成這筆" })).toHaveCount(0);
  await expect(page.getByText("私人用途", { exact: false })).toHaveCount(0);
  expect(state.posts).toHaveLength(1); await capture(page, info, "identity-mismatch");
});

test("recovery couple mismatch cannot hydrate even when actor and ledger IDs match", async ({ page }) => {
  const { state } = await entryBrowser(page); state.mode = "drop"; await fillEntry(page);
  await page.getByRole("button", { name: "儲存交易" }).click(); await expect(status(page)).toContainText(unknown);
  state.coupleId = 2; await page.reload(); await expect(page.getByRole("alert").filter({ hasText: "身分／帳本不符" })).toBeVisible();
  await expect(page.getByRole("button", { name: "確認並完成這筆" })).toHaveCount(0); expect(state.posts).toHaveLength(1);
});

test("Ledger A recovery takes priority over URL B without activating or moving a write to B", async ({ page }, info) => {
  const { state } = await entryBrowser(page); state.mode = "drop"; await fillEntry(page);
  await page.getByRole("button", { name: "儲存交易" }).click(); await expect(status(page)).toContainText(unknown);
  const before = state.requests.length;
  await page.goto(`/?v2Ledger=${OTHER}`); await expect(status(page)).toContainText(unknown);
  await expect(page.getByText("先確認「共同生活」這筆記帳的結果，再前往連結指定的帳本。")).toBeVisible();
  expect(state.requests.slice(before).some(path => path.includes(`${OTHER}/`))).toBe(false);
  await capture(page, info, "scope-mismatch");
  await page.getByRole("button", { name: "確認並完成這筆" }).click(); await expect(status(page)).toContainText("已加入晚餐");
  expect(state.posts[1]!.bytes).toBe(state.posts[0]!.bytes); expect(state.posts[1]!.endpoint).toBe(state.posts[0]!.endpoint);
  await page.getByRole("button", { name: "繼續前往指定帳本" }).click();
  await expect(page.getByLabel("切換帳本")).toHaveValue(OTHER); expect(state.effects).toBe(1);
});

test("unknown followed by 401 remains unknown with original operation", async ({ page }) => {
  const { state } = await entryBrowser(page); state.mode = "drop"; await fillEntry(page);
  await page.getByRole("button", { name: "儲存交易" }).click(); await expect(status(page)).toContainText(unknown);
  state.mode = "unauthorized"; await page.getByRole("button", { name: "確認並完成這筆" }).click();
  await expect.poll(() => state.posts.length).toBe(2);
  await expect(status(page)).toContainText(unknown); expect(state.posts[1]!.bytes).toBe(state.posts[0]!.bytes);
  await expect(page.getByLabel("用途", { exact: true })).toBeDisabled();
});

test("authorized A recovery remains available when the linked Ledger no longer exists", async ({ page }) => {
  const { state } = await entryBrowser(page); state.mode = "drop"; await fillEntry(page);
  await page.getByRole("button", { name: "儲存交易" }).click(); await expect(status(page)).toContainText(unknown);
  const unavailable = "00000000-0000-4000-8000-000000000099";
  await page.goto(`/?v2Ledger=${unavailable}`); await expect(status(page)).toContainText(unknown);
  await expect(status(page)).toContainText("連結指定的帳本目前無法開啟");
  await expect(page.getByLabel("切換帳本")).toHaveValue(LEDGER);
  await page.getByRole("button", { name: "確認並完成這筆" }).click();
  await expect(status(page)).toContainText("已加入晚餐");
  expect(state.posts[1]!.bytes).toBe(state.posts[0]!.bytes); expect(state.posts[1]!.endpoint).toBe(state.posts[0]!.endpoint);
  expect(state.requests.some(path => path.includes(unavailable))).toBe(false);
});

test("an actor change in the existing document is detected before replay POST", async ({ page }) => {
  const { state } = await entryBrowser(page); state.mode = "drop"; await fillEntry(page);
  await page.getByRole("button", { name: "儲存交易" }).click(); await expect(status(page)).toContainText(unknown);
  state.actor = PARTNER;
  await page.getByRole("button", { name: "確認並完成這筆" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "登入身分已變更" })).toBeVisible();
  expect(state.posts).toHaveLength(1);
});

test("a new authorization failure hides cached financial content without discarding commit proof", async ({ page }) => {
  const { state } = await entryBrowser(page); state.mode = "partial"; await fillEntry(page, "保留完成證據");
  await page.route(`**/api/app/v2/ledgers/${LEDGER}/bootstrap`, route => route.fulfill({ status: 403, json: { error: "scope no longer authorized" } }));
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "存取權限" })).toBeVisible();
  await expect(page.getByText("保留完成證據", { exact: false })).toHaveCount(0);
  const record = JSON.parse((await page.evaluate(key => sessionStorage.getItem(key), ENTRY_RECOVERY_KEY))!);
  expect(record.phase).toBe("committed"); expect(record.proof.transaction.description).toBe("保留完成證據");
  expect(state.posts).toHaveLength(1);
});

test("timeout after dispatch becomes unknown and preserves the exact recovery operation", async ({ page }) => {
  const { state } = await entryBrowser(page); state.mode = "delay"; await fillEntry(page);
  await page.clock.install();
  await page.getByRole("button", { name: "儲存交易" }).click(); await expect.poll(() => state.posts.length).toBe(1);
  await page.clock.fastForward(30_001); await expect(status(page)).toContainText(unknown);
  const saved = JSON.parse((await page.evaluate(key => sessionStorage.getItem(key), ENTRY_RECOVERY_KEY))!);
  expect(saved.body).toEqual(state.posts[0]!.body); expect(saved.phase).toBe("unknown");
  state.release!();
});

test("correction drop-response reload replay retains original replacement and expected version", async ({ page }) => {
  const { state } = await entryBrowser(page); await fillEntry(page);
  await page.getByRole("button", { name: "儲存交易" }).click(); await expect(status(page)).toContainText("已加入晚餐");
  await page.locator("summary").filter({ hasText: "晚餐" }).click(); await page.getByRole("button", { name: "編輯", exact: true }).click();
  await page.getByLabel("用途", { exact: true }).fill("更正晚餐"); state.mode = "drop";
  await page.getByRole("button", { name: "儲存修改" }).click(); await expect(status(page)).toContainText("尚未確認是否已修改");
  await page.reload(); await expect(status(page)).toContainText("尚未確認是否已修改");
  await page.getByRole("button", { name: "確認並完成這筆" }).click(); await expect(status(page)).toContainText("已修改更正晚餐");
  expect(state.posts[2]!.bytes).toBe(state.posts[1]!.bytes); expect(state.posts[2]!.key).toBe(state.posts[1]!.key); expect(state.effects).toBe(2);
});

test("first rejection preserves editable draft and unchanged retry reuses the key", async ({ page }) => {
  const { state } = await entryBrowser(page); state.mode = "reject"; await fillEntry(page);
  await page.getByRole("button", { name: "儲存交易" }).click(); await expect(status(page)).toContainText("尚未加入");
  await expect(page.getByLabel("用途", { exact: true })).toHaveValue("晚餐"); await expect(page.getByLabel("用途", { exact: true })).toBeEnabled();
  expect(await page.evaluate(key => sessionStorage.getItem(key), ENTRY_RECOVERY_KEY)).toBeNull();
  state.mode = "normal"; await page.getByRole("button", { name: "儲存交易" }).click(); await expect(status(page)).toContainText("已加入晚餐");
  expect(state.posts[1]!.bytes).toBe(state.posts[0]!.bytes);
});

test("one create/correction draft requires explicit keep or discard", async ({ page }) => {
  await entryBrowser(page); await fillEntry(page); await page.getByRole("button", { name: "儲存交易" }).click(); await expect(status(page)).toContainText("已加入晚餐");
  await fillEntry(page, "還在編輯"); await page.locator("summary").filter({ hasText: "晚餐" }).click();
  page.once("dialog", dialog => dialog.dismiss()); await page.getByRole("button", { name: "編輯", exact: true }).click();
  await expect(page.getByLabel("用途", { exact: true })).toHaveValue("還在編輯");
  page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "編輯", exact: true }).click();
  await expect(page.getByLabel("用途", { exact: true })).toHaveValue("晚餐"); await expect(page.getByLabel("分攤方式")).toHaveValue("exact");
  await expect(page.getByText("沿用這筆分攤", { exact: false })).toBeVisible(); expect(await page.getByLabel("金額（新台幣）").count()).toBe(1);
});

test("creating a Ledger after discarding A opens a usable draft in the new Ledger", async ({ page }) => {
  const { state } = await entryBrowser(page); await fillEntry(page, "放棄的 A 輸入");
  let finish: (() => void) | undefined;
  await page.route("**/api/app/v2/ledgers", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise<void>(resolve => { finish = resolve; });
    return route.fulfill({ json: { ledger: { id: OTHER } } });
  });
  await page.getByRole("button", { name: "建立帳本" }).click();
  await page.getByLabel("帳本名稱").fill("旅行帳本");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "建立", exact: true }).click();
  await expect.poll(() => Boolean(finish)).toBe(true);
  await expect(page.getByLabel("金額（新台幣）")).toBeDisabled();
  finish!();
  await expect(page.getByLabel("切換帳本")).toHaveValue(OTHER);
  await expect(page.getByLabel("金額（新台幣）")).toBeEnabled();
  await expect(page.getByLabel("用途", { exact: true })).toHaveValue("");
  await fillEntry(page, "B 的第一筆");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(status(page)).toContainText("已加入B 的第一筆");
  expect(state.posts).toHaveLength(1); expect(state.posts[0]!.endpoint).toContain(OTHER);
});

for (const failedRead of [false, true]) test(`correction success preserves commit when refresh ${failedRead ? "fails" : "succeeds"}`, async ({ page }, info) => {
  const { state } = await entryBrowser(page); await fillEntry(page); await page.getByRole("button", { name: "儲存交易" }).click(); await expect(status(page)).toContainText("已加入晚餐");
  await page.locator("summary").filter({ hasText: "晚餐" }).click(); await page.getByRole("button", { name: "編輯", exact: true }).click();
  await page.getByLabel("用途", { exact: true }).fill("修改晚餐"); state.failRead = failedRead;
  if (!failedRead) await capture(page, info, "correction-draft");
  await page.getByRole("button", { name: "儲存修改" }).click();
  await expect(status(page)).toContainText("已修改修改晚餐 NT$681");
  if (failedRead) await expect(status(page)).toContainText("其他紀錄暫時無法更新");
  await expect(page.locator("summary").filter({ hasText: "晚餐（已作廢）" })).toBeVisible();
  expect(state.effects).toBe(2); expect(state.posts[1]!.body.expectedVersion).toBe(1);
  await capture(page, info, failedRead ? "correction-read-failed" : "correction");
});

test("a stale posted receipt cannot downgrade balance/next payer or resurrect a later void", async ({ page }) => {
  const { state } = await entryBrowser(page); state.mode = "drop"; await fillEntry(page);
  await page.getByRole("button", { name: "儲存交易" }).click(); await expect(status(page)).toContainText(unknown);
  state.rows[0]!.status = "voided"; state.rows[0]!.version = 2; state.version = 3;
  await page.reload(); await expect(status(page)).toContainText(unknown); await expect(page.getByRole("heading", { name: "目前很平衡" })).toBeVisible();
  await page.getByRole("button", { name: "確認並完成這筆" }).click(); await expect(status(page)).toContainText("已加入晚餐");
  await expect(page.getByRole("heading", { name: "目前很平衡" })).toBeVisible();
  await expect(page.locator("summary").filter({ hasText: "晚餐（已作廢）" })).toBeVisible();
  await expect(page.getByText("下次建議由", { exact: false })).toHaveCount(0); expect(state.effects).toBe(1);
});

test("a stale posted receipt cannot resurrect a replaced transaction", async ({ page }) => {
  const { state } = await entryBrowser(page); state.mode = "drop"; await fillEntry(page);
  await page.getByRole("button", { name: "儲存交易" }).click(); await expect(status(page)).toContainText(unknown);
  const old = state.rows[0]!;
  state.rows = [{ ...old, status: "voided", version: 2, replacedByTransactionId: OTHER }, { ...old, id: OTHER, description: "較新修正版", replacesTransactionId: old.id }]; state.version = 4;
  await page.reload(); await expect(status(page)).toContainText(unknown);
  await page.getByRole("button", { name: "確認並完成這筆" }).click(); await expect(status(page)).toContainText("已加入晚餐");
  await expect(page.locator("summary").filter({ hasText: "晚餐（已作廢）" })).toBeVisible();
  await expect(page.locator("summary").filter({ hasText: "較新修正版" })).toBeVisible();
});

test("partner login odd 681 uses kernel member order and opening defaults despite a background change", async ({ page }) => {
  const { state } = await entryBrowser(page); state.actor = PARTNER; await page.reload(); await fillEntry(page);
  await expect(page.getByTestId("entry-preview")).toContainText("另一半 NT$341、你 NT$340");
  state.weights = { [OWNER]: "0", [PARTNER]: "1" }; state.version += 1;
  await page.getByLabel("重新整理帳本").click(); await expect(page.getByTestId("entry-preview")).toContainText("另一半 NT$341、你 NT$340");
  await page.getByRole("button", { name: "儲存交易" }).click(); await expect(status(page)).toContainText("已加入晚餐");
  expect(state.posts[0]!.body.shares).toEqual([{ userId: OWNER, amountTwd: "341" }, { userId: PARTNER, amountTwd: "340" }]);
  await fillEntry(page, "下一筆"); await expect(page.getByTestId("entry-preview")).toContainText("另一半 NT$0、你 NT$681");
});

test("midnight preserves the current draft date and opens the next draft with today's Taipei date", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-09-25T15:59:59Z"));
  const { state } = await entryBrowser(page); await fillEntry(page);
  await page.getByText("更多設定", { exact: true }).click();
  await expect(page.getByLabel("交易日期")).toHaveValue("2026-09-25");
  await page.clock.setFixedTime(new Date("2026-09-25T16:00:01Z"));
  await expect(page.getByLabel("交易日期")).toHaveValue("2026-09-25");
  await page.getByRole("button", { name: "儲存交易" }).click(); await expect(status(page)).toContainText("已加入晚餐");
  expect(state.posts[0]!.body.occurredOn).toBe("2026-09-25");
  await page.getByText("更多設定", { exact: true }).click();
  await expect(page.getByLabel("交易日期")).toHaveValue("2026-09-26");
});

test("recovery persistence overhead is bounded and stores only submitted operations", async ({ page }, info) => {
  const { state } = await entryBrowser(page); await fillEntry(page);
  expect(await page.evaluate(key => sessionStorage.getItem(key), ENTRY_RECOVERY_KEY)).toBeNull();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    const samples: { bytes: number; milliseconds: number }[] = [];
    Object.assign(window, { entryStorageSamples: samples });
    Storage.prototype.setItem = function(key, value) { const start = performance.now(); original.call(this, key, value); if (key === "v2.entry-operation.v1") samples.push({ bytes: new TextEncoder().encode(value).byteLength, milliseconds: performance.now() - start }); };
  });
  await page.getByRole("button", { name: "儲存交易" }).click(); await expect(status(page)).toContainText("已加入晚餐");
  const measurements = await page.evaluate(() => (window as unknown as { entryStorageSamples: { bytes: number; milliseconds: number }[] }).entryStorageSamples);
  expect(measurements).toHaveLength(2); expect(measurements.every(sample => sample.bytes < 32000)).toBe(true); expect(state.posts).toHaveLength(1);
  mkdirSync("output/playwright/p1-b", { recursive: true }); writeFileSync(`output/playwright/p1-b/storage-${info.project.name}.json`, JSON.stringify(measurements, null, 2));
});
