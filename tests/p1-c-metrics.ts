/** Same local production build, mocked API latency, mobile Chromium. Timings are automation-observed response-to-two-rAF proxies, not device/LINE measurements. */
import { chromium, devices, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { navigationBrowser, A, B, row, switchLedger } from "./fixtures/p1-c-browser";
const stage = process.argv[2] ?? "before", baseURL = process.argv[3] ?? "http://localhost:3110";
const directory = process.argv[4] ?? `/tmp/p1-c-context/metrics-${stage}`;
mkdirSync(directory, { recursive: true });
async function main() {
const browser = await chromium.launch();
const samples: unknown[] = [];
async function paint(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
for (let run = 0; run < 3; run += 1) {
  const context = await browser.newContext({ ...devices["iPhone 13"], baseURL }), page = await context.newPage(), fixture = await navigationBrowser(page);
  fixture.state.rows.push(...Array.from({ length: 35 }, (_, index) => row(B, `metrics-row-${index}`, `Scroll sample ${index}`)));
  await page.addInitScript(() => {
    const native = window.scrollTo.bind(window);
    Object.assign(window, { measuredScrollCalls: [] as Array<{ durationMs: number; y: number }> });
    window.scrollTo = ((...args: Parameters<typeof native>) => {
      const started = performance.now(); native(...args);
      (window as unknown as { measuredScrollCalls: Array<{ durationMs: number; y: number }> }).measuredScrollCalls.push({ durationMs: performance.now() - started, y: scrollY });
    }) as typeof window.scrollTo;
  });
  const scripts = new Map<string, number>(), scriptWork: Promise<void>[] = [];
  page.on("response", response => { if (new URL(response.url()).pathname.endsWith(".js") && response.url().startsWith(baseURL)) scriptWork.push(response.body().then(body => { scripts.set(new URL(response.url()).pathname, gzipSync(body).byteLength); })); });
  const steps: unknown[] = [];
  async function measure(label: string, action: () => Promise<unknown>, ready: () => Promise<unknown>) {
    const start = performance.now(), offset = fixture.state.requests.length;
    const scrollOffset = await page.evaluate(() => (window as unknown as { measuredScrollCalls?: unknown[] }).measuredScrollCalls?.length ?? 0);
    await action(); await ready(); await paint(page);
    const responseToPaintProxyMs = performance.now() - start;
    await page.waitForTimeout(200);
    const scrollCalls = await page.evaluate(offset => (window as unknown as { measuredScrollCalls: unknown[] }).measuredScrollCalls.slice(offset), scrollOffset);
    steps.push({ label, responseToPaintProxyMs, scrollCalls, url: page.url(), requests: fixture.state.requests.slice(offset).map(item => ({ ...item, at: item.at - start, finishedAt: item.finishedAt === undefined ? undefined : item.finishedAt - start })), count: fixture.state.requests.length - offset });
  }
  await measure("startup", () => page.goto("/"), fixture.ready);
  await Promise.all(scriptWork); const initialGzipJsBytes = [...scripts.values()].reduce((sum, bytes) => sum + bytes, 0);
  await page.screenshot({ path: `${directory}/home-${run}.png`, fullPage: true });
  if (stage === "before") {
    await measure("switch-A-B", () => page.getByRole("combobox", { name: "切換帳本" }).selectOption(B), () => expect(page.getByText("B 專屬車票", { exact: true })).toBeVisible());
    await measure("stats", () => page.getByRole("tab", { name: "統計", exact: true }).click(), () => expect(page.getByRole("tab", { name: "統計", exact: true })).toHaveAttribute("aria-selected", "true"));
    await measure("settings", () => page.getByRole("tab", { name: "設定", exact: true }).click(), () => expect(page.getByLabel("新增自訂分類")).toBeVisible());
  } else {
    await measure("dialog-open", () => page.getByRole("button", { name: "切換帳本", exact: true }).click(), () => expect(page.getByRole("dialog")).toBeVisible());
    await measure("switch-A-B", () => page.getByRole("dialog").getByRole("combobox", { name: "切換帳本" }).selectOption(B), () => expect(page.getByRole("button", { name: "查看紀錄：B 專屬車票", exact: true })).toBeVisible());
    await measure("stats", () => page.getByRole("button", { name: "收支概況", exact: true }).click(), () => expect(page.getByTestId("surface-heading")).toContainText("收支概況"));
    await page.getByRole("button", { name: "返回帳本", exact: true }).click();
    await measure("settings", () => page.getByRole("button", { name: "帳本設定", exact: true }).click(), () => expect(page.getByLabel("新增自訂分類")).toBeVisible());
    await page.getByRole("button", { name: "返回帳本", exact: true }).click();
    await page.evaluate(() => scrollTo(0, 500));
    await switchLedger(page, A); await fixture.ready(); await page.waitForTimeout(200);
    await measure("scroll-restore-B", () => switchLedger(page, B), fixture.ready);
  }
  await measure("deep-link-B", () => page.goto(`/?v2Ledger=${B}`), () => expect(page.getByText("B 專屬車票", { exact: true })).toBeVisible());
  samples.push({ run, initialGzipJsBytes, initialScripts: Object.fromEntries(scripts), steps });
  await context.close();
}
await browser.close();
writeFileSync(`${directory}/metrics.json`, `${JSON.stringify({ stage, baseURL, method: "3 fresh mobile Chromium contexts at 390x844; same mocked APIs/no network throttling; production next start; gzip computed on loaded initial-route JS response bodies; action start until ready assertion plus 2 animation frames; 200ms request settling window", samples }, null, 2)}\n`);
console.log(`${directory}/metrics.json`);

}
void main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
