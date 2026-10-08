import { chromium, devices, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { platform, release } from "node:os";
import { homeBrowser, A, B } from "./fixtures/p2-e-browser";

type Probe = { marks: Record<string, number>; start: (name: string) => void; cls: number; layoutShiftSupported: boolean; longTasks: number[] };
declare global { interface Window { p2eProbe: Probe } }
type Sample = { scenario: string; run: number; startupRequests: string[]; requestWaterfall: { method: string; path: string; startMs: number; durationMs: number | null }[]; initialRows: number; bootstrapBytes: number; quickEntryOpenRequests: number; marks: Record<string, number>; cls: number; layoutShiftSupported: boolean; longTasks: number[] };
const stage = process.argv[2] ?? "after", baseURL = process.argv[3] ?? "http://localhost:3119";
const directory = `docs/evidence/p2-e/metrics/${stage}`;
mkdirSync(directory, { recursive: true });

async function main() {
  const browser = await chromium.launch(), samples: Sample[] = [];
  for (const scenario of ["empty", "50-rows", "mixed-200-rows"]) for (let run = 0; run < 20; run++) {
    const context = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, baseURL });
    await context.addInitScript("window.__name = value => value;");
    const page = await context.newPage(), fixture = await homeBrowser(page, { count: scenario === "empty" ? 0 : scenario === "50-rows" ? 50 : 200, useRealClock: true });
    if (scenario.startsWith("mixed")) for (const [index, item] of fixture.state.rows.entries()) {
      if (item.ledgerId !== A) continue;
      item.occurredOn = `2026-09-${25 - index % 4}`;
      if (index % 7 === 0) item.type = "income";
      if (index % 11 === 0) { item.type = "transfer"; item.splitMethod = "none"; item.shares = [{ userId: item.shares[1]!.userId, amountTwd: "200" }]; }
      if (index % 17 === 0) item.status = "voided";
    }
    if (scenario.startsWith("mixed")) for (const [index, item] of fixture.state.rows.entries()) {
      const replacement = fixture.state.rows[index + 1];
      if (item.ledgerId === A && item.status === "voided" && replacement?.ledgerId === A && replacement.status === "posted") {
        item.replacedByTransactionId = replacement.id; item.version = 2;
        replacement.replacesTransactionId = item.id;
      }
    }
    // Repeatable simulated transport latency, not production LIFF/4G timing.
    await page.route("**/api/app/**", async route => { await new Promise(resolve => setTimeout(resolve, 30)); await route.fallback(); });
    await page.addInitScript(() => {
      const probe: Probe = { marks: {}, cls: 0, layoutShiftSupported: PerformanceObserver.supportedEntryTypes.includes("layout-shift"), longTasks: [], start: () => undefined };
      window.p2eProbe = probe;
      if (probe.layoutShiftSupported) new PerformanceObserver(list => { for (const entry of list.getEntries()) { const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number }; if (!shift.hadRecentInput) probe.cls += shift.value; } }).observe({ type: "layout-shift", buffered: true });
      if (PerformanceObserver.supportedEntryTypes.includes("longtask")) new PerformanceObserver(list => { probe.longTasks.push(...list.getEntries().map(entry => entry.duration)); }).observe({ type: "longtask", buffered: true });
      const watch = (name: string, ready: () => boolean, started: number) => {
        let scheduled = false;
        const observer = new MutationObserver(check);
        function check() {
          if (scheduled || !ready()) return;
          scheduled = true; observer.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => { probe.marks[name] = performance.now() - started; }));
        }
        observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); check();
      };
      const usable = () => Boolean(document.querySelector('[data-testid="quick-entry-trigger"]') && document.querySelector('[data-testid="ledger-balance"] h2') && document.querySelector('[data-testid="ledger-timeline"]'));
      watch("homeUsablePaintMs", usable, 0);
      probe.start = name => {
        const start = performance.now();
        if (name === "switch") {
          watch("switchIdentityPaintMs", () => document.querySelector('h1')?.textContent === "旅行" && !document.body.textContent?.includes("一起生活"), start);
          watch("switchUsablePaintMs", () => document.querySelector('h1')?.textContent === "旅行" && usable(), start);
        } else watch("quickEntryFeedbackPaintMs", () => Boolean(document.querySelector('dialog[open] [data-entry-field="amountTwd"]') && document.activeElement?.getAttribute("data-entry-field") === "amountTwd"), start);
      };
    });
    await fixture.goto(); await fixture.ready();
    await expect.poll(() => page.evaluate(() => window.p2eProbe.marks.homeUsablePaintMs)).toBeGreaterThan(0);
    await expect.poll(() => fixture.state.requests.filter(item => item.path.endsWith("/categories")).length).toBe(1);
    await expect.poll(() => fixture.state.requests.every(item => item.finishedAt !== undefined)).toBe(true);
    const startupRequests = fixture.state.requests.map(item => `${item.method} ${item.path}`);
    const firstRequest = fixture.state.requests[0]!.at;
    const requestWaterfall = fixture.state.requests.map(item => ({ method: item.method, path: item.path,
      startMs: item.at - firstRequest, durationMs: item.finishedAt === undefined ? null : item.finishedAt - item.at }));
    const initialRows = await page.getByTestId("ledger-timeline").locator("button[data-transaction-id]").count();
    const bootstrapBytes = Buffer.byteLength(JSON.stringify(fixture.snapshot(A)));
    await page.getByTestId("ledger-name-trigger").click();
    await page.getByRole("dialog").locator(`[data-ledger-option="${B}"]`).evaluate(node => { window.p2eProbe.start("switch"); (node as HTMLElement).click(); });
    await expect(page.getByTestId("surface-heading")).toHaveText("旅行"); await fixture.ready();
    await expect.poll(() => page.evaluate(() => window.p2eProbe.marks.switchUsablePaintMs)).toBeGreaterThan(0);
    await expect.poll(() => fixture.state.requests.filter(item => item.path.endsWith(`${B}/categories`)).length).toBe(1);
    const before = fixture.state.requests.length;
    await page.getByTestId("quick-entry-trigger").evaluate(node => { window.p2eProbe.start("quick"); (node as HTMLElement).click(); });
    await expect.poll(() => page.evaluate(() => window.p2eProbe.marks.quickEntryFeedbackPaintMs)).toBeGreaterThan(0);
    expect(fixture.state.requests).toHaveLength(before);
    const measured = await page.evaluate(() => { const probe = window.p2eProbe; return { marks: probe.marks, cls: probe.cls, layoutShiftSupported: probe.layoutShiftSupported, longTasks: probe.longTasks }; });
    samples.push({ scenario, run, startupRequests, requestWaterfall, initialRows, bootstrapBytes, quickEntryOpenRequests: fixture.state.requests.length - before, ...measured });
    await context.close();
  }
  await browser.close();
  const percentile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
  const summaries = ["empty", "50-rows", "mixed-200-rows"].map(scenario => {
    const group = samples.filter(sample => sample.scenario === scenario);
    return { scenario, samples: group.length, marks: Object.fromEntries(Object.keys(group[0]!.marks).map(key => { const values = group.map(sample => sample.marks[key]!); return [key, { median: percentile(values, 0.5), p75: percentile(values, 0.75), p95: percentile(values, 0.95) }]; })),
      startupRequestCounts: [...new Set(group.map(sample => sample.startupRequests.length))], initialRows: [...new Set(group.map(sample => sample.initialRows))], maxCLS: Math.max(...group.map(sample => sample.cls)), maxLongTaskMs: Math.max(0, ...group.flatMap(sample => sample.longTasks)) };
  });
  writeFileSync(`${directory}/performance.json`, JSON.stringify({ stage, baseURL, os: `${platform()} ${release()}`, browser: `Chromium ${browser.version()}`, node: process.version,
    device: "Local macOS browser emulation of iPhone 13, not a physical iPhone or LINE host", viewport: "390x844", text: "100%", network: "mocked 30ms delay per API; no throughput throttle", encodedPayload: "not measured; mocked JSON is uncompressed",
    cache: "fresh contexts, warm production server", clock: "native browser performance.now and requestAnimationFrame; fixture fake clock disabled",
    method: "20 samples per fixture, production next start, mocked LIFF/auth/APIs with 30ms delay per API; MutationObserver readiness to two requestAnimationFrames. Browser paint proxy; not physical LINE/4G or a production SLA. CLS excludes recent input. Long tasks reported without attribution; transport payload is decoded fixture JSON, no payload reduction claimed.", summaries, samples }, null, 2));
}
void main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
