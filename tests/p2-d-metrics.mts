/** Production-build browser-clock measurements; all financial responses are mocks. */
import { chromium, devices, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { entryBrowser } from "./fixtures/p1-b-browser";

type Metrics = {
  quickAt?: number; quickFocusMs?: number; quickPaintMs?: number;
  addAt?: number; pendingPaintMs?: number; canonicalAt?: number; canonicalPaintMs?: number;
  dialogLogicalCloseMs?: number; dialogCloseCssMs?: number;
  pendingScheduled?: boolean; canonicalScheduled?: boolean; quickScheduled?: boolean;
  storage: Array<{ phase: string | null; durationMs: number }>;
};
declare global { interface Window { p2dMetrics: Metrics } }

const [stage = "after", baseURL = "http://localhost:3120", output = `output/playwright/p2-d/metrics/${stage}`] = process.argv.slice(2);
if (!["before", "after"].includes(stage)) throw new Error("Stage must be before or after");
const directory = resolve(output);
mkdirSync(directory, { recursive: true });
const browser = await chromium.launch();
const samples = [];
try {
  for (let run = 0; run < 20; run++) {
    const context = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, baseURL });
    const page = await context.newPage();
    // tsx names callbacks with an esbuild helper. Browser init scripts are serialized,
    // so include that helper in the same script rather than depending on Node globals.
    const originalInit = page.addInitScript.bind(page);
    page.addInitScript = async (script, argument) => {
      if (typeof script === "function") await originalInit({ content: `globalThis.__name = value => value; (${script.toString()})(${JSON.stringify(argument)});` });
      else await originalInit(script, argument);
    };
    page.on("pageerror", error => { throw error; });
    await page.addInitScript(({ stage }) => {
      const metrics: Metrics = window.p2dMetrics = { storage: [] };
      const originalWrite = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        const started = performance.now();
        originalWrite.call(this, key, value);
        if (key === "v2.entry-operation.v1") metrics.storage.push({ phase: JSON.parse(value).phase ?? null, durationMs: performance.now() - started });
      };
      const originalJson = Response.prototype.json;
      Response.prototype.json = async function() {
        const body = await originalJson.call(this);
        if (body?.transaction && body.balance && Object.hasOwn(body, "nextPayer") && body.ledgerVersion) metrics.canonicalAt = performance.now();
        return body;
      };
      document.addEventListener("click", event => {
        const button = (event.target as Element).closest("button");
        if (button?.dataset.testid === "quick-entry-trigger") metrics.quickAt = performance.now();
        if (button?.textContent?.trim() === "加入") metrics.addAt = performance.now();
      }, true);
      const observe = () => {
        const host = document.querySelector<HTMLDialogElement>("dialog");
        if (metrics.quickAt !== undefined && host?.open && !metrics.quickScheduled && document.activeElement?.getAttribute("data-entry-field") === "amountTwd") {
          metrics.quickScheduled = true;
          metrics.quickFocusMs = performance.now() - metrics.quickAt;
          requestAnimationFrame(() => requestAnimationFrame(() => { metrics.quickPaintMs = performance.now() - metrics.quickAt!; }));
        }
        if (metrics.addAt !== undefined && document.querySelector('form[aria-busy="true"]') && !metrics.pendingScheduled) {
          metrics.pendingScheduled = true;
          requestAnimationFrame(() => requestAnimationFrame(() => { metrics.pendingPaintMs = performance.now() - metrics.addAt!; }));
        }
        if (metrics.canonicalAt !== undefined && document.querySelector('button[data-transaction-id]') && document.querySelector('[data-write-outcome="committed"]') && !metrics.canonicalScheduled) {
          metrics.canonicalScheduled = true;
          if (stage === "after" && host && !host.open) {
            metrics.dialogLogicalCloseMs = performance.now() - metrics.canonicalAt;
            metrics.dialogCloseCssMs = Math.max(...getComputedStyle(host).transitionDuration.split(",").map(value => Number.parseFloat(value) * 1000));
          }
          requestAnimationFrame(() => requestAnimationFrame(() => { metrics.canonicalPaintMs = performance.now() - metrics.canonicalAt!; }));
        }
      };
      new MutationObserver(observe).observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
    }, { stage });
    const fixture = await entryBrowser(page, { legacyInline: stage === "before" });
    await page.waitForLoadState("networkidle");
    const startupRequests = [...fixture.state.requests];
    const beforeOpen = fixture.state.requests.length;
    if (stage === "after") {
      await page.getByTestId("quick-entry-trigger").click();
      await page.waitForFunction(() => window.p2dMetrics.quickPaintMs !== undefined);
    }
    const openRequests = fixture.state.requests.slice(beforeOpen);
    await page.getByLabel("金額，新臺幣").fill("681");
    await page.getByLabel("用途", { exact: true }).fill("晚餐");
    fixture.state.mode = "delay";
    const beforeAdd = fixture.state.requests.length;
    await page.getByRole("button", { name: "加入", exact: true }).click();
    await page.waitForFunction(() => window.p2dMetrics.pendingPaintMs !== undefined);
    await expect.poll(() => Boolean(fixture.state.release)).toBe(true);
    fixture.state.release!();
    await page.waitForFunction(() => window.p2dMetrics.canonicalPaintMs !== undefined);
    await page.waitForLoadState("networkidle");
    const createRequests = fixture.state.requests.slice(beforeAdd);
    const bootstrapRequests = createRequests.filter(path => path.endsWith("/bootstrap"));
    expect(openRequests).toHaveLength(0); expect(bootstrapRequests).toHaveLength(0);
    expect(fixture.state.posts).toHaveLength(1); expect(fixture.state.effects).toBe(1);
    if (stage === "after") await expect(page.locator('button[data-transaction-id]')).toBeFocused();
    samples.push({ run, metrics: await page.evaluate(() => window.p2dMetrics), startupRequests, openRequests, createRequests, blockingBootstrapCount: bootstrapRequests.length });
    await context.close();
  }
} finally { await browser.close(); }

const percentile = (values: number[], percentile: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1)] : null;
};
const fields = ["quickFocusMs", "quickPaintMs", "pendingPaintMs", "canonicalPaintMs", "dialogLogicalCloseMs", "dialogCloseCssMs"] as const;
const summary = Object.fromEntries(fields.map(field => {
  const values = samples.flatMap(sample => sample.metrics[field] === undefined ? [] : [sample.metrics[field]!]);
  return [field, { n: values.length, median: percentile(values, .5), p75: percentile(values, .75), p95: percentile(values, .95), maximum: values.length ? Math.max(...values) : null }];
}));
const writes = samples.flatMap(sample => sample.metrics.storage.map(write => write.durationMs));
const report = { stage, baseURL, browser: "Chromium", viewport: "390×844", samples: 20, processNodeVersion: process.version,
  method: "Identical production builds; 20 fresh browser contexts per stage; no throttling, concurrent builds or test suites; canonical APIs/LIFF mocked with kernel-backed P1-B fixture; pending request held until pending paint proxy is recorded; MutationObserver followed by two requestAnimationFrame callbacks estimates painted frames; response timing starts after parsing complete canonical JSON and excludes network. Fixed fixture date. Close logical removal and CSS duration recorded separately. No physical LINE/keyboard or reliable population SLA claim.",
  baselineQuickEntry: stage === "before" ? "Unavailable: baseline has a persistent inline form. Pending/canonical measurements remain comparable." : undefined,
  summary, sessionStorageWriteMs: { n: writes.length, median: percentile(writes, .5), p75: percentile(writes, .75), p95: percentile(writes, .95), maximum: Math.max(...writes) },
  requestBudget: { open: samples.map(sample => sample.openRequests.length), create: samples.map(sample => sample.createRequests.length), blockingBootstrap: samples.map(sample => sample.blockingBootstrapCount) }, raw: samples };
writeFileSync(`${directory}/metrics.json`, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ path: `${directory}/metrics.json`, summary, requestBudget: report.requestBudget }));
