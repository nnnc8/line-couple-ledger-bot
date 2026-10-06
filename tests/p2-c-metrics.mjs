/** Local production-build comparison. Read-only mocked APIs; browser-clock paint proxies. */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const { chromium, devices, expect } = require("@playwright/test");
const [stage = "after", baseURL = "http://localhost:3119", output = `output/playwright/p2-c/metrics/${stage}`] = process.argv.slice(2);
if (!["before", "after"].includes(stage)) throw new Error("Stage must be before or after");
const directory = resolve(output);
mkdirSync(directory, { recursive: true });
const OWNER = "00000000-0000-4000-8000-000000000001", PARTNER = "00000000-0000-4000-8000-000000000002";
const LEDGER = "00000000-0000-4000-8000-000000000010";
const id = index => `00000000-0000-4000-8000-${String(1000 + index).padStart(12, "0")}`;
const rows = Array.from({ length: 65 }, (_, index) => {
  const amountTwd = index === 3 ? "100000000000" : "400", half = (BigInt(amountTwd) / 2n).toString();
  const type = index === 1 ? "income" : index === 2 || index === 4 ? "transfer" : "expense";
  const sender = index === 4 ? PARTNER : OWNER, receiver = index === 4 ? OWNER : PARTNER;
  return {
    id: id(index), ledgerId: LEDGER, type, amountTwd,
    payments: type === "transfer" ? [{ userId: sender, amountTwd }] : [{ userId: OWNER, amountTwd: half }, { userId: PARTNER, amountTwd: half }],
    shares: type === "transfer" ? [{ userId: receiver, amountTwd }] : [{ userId: OWNER, amountTwd: half }, { userId: PARTNER, amountTwd: half }],
    occurredOn: index === 0 ? "2026-10-04" : index < 49 ? "2026-10-03" : index < 59 ? "2026-10-02" : "2025-12-31",
    description: index === 5 ? "一起買了很多生活用品，完整用途在詳情中閱讀，時間軸只顯示兩行，這是一筆用來比較長文字排版的日常紀錄" : `效能紀錄 ${String(index + 1).padStart(2, "0")}`,
    category: "生活", categoryId: null, note: index === 25 ? "詳細備註：核對返回原紀錄的焦點和捲動位置。" : null,
    splitMethod: type === "transfer" ? "none" : "equal", status: "posted", version: 1,
    createdAt: new Date(Date.UTC(2026, 9, 3, 18, 0, 0) - index * 1000).toISOString(),
    replacesTransactionId: index === 6 ? id(65) : null, replacedByTransactionId: null,
  };
});
rows.push(
  { ...rows[6], id: id(65), description: "已更新的舊紀錄", status: "voided", version: 2, replacesTransactionId: null, replacedByTransactionId: id(6) },
  { ...rows[7], id: id(66), description: "已作廢的歷史紀錄", status: "voided", version: 2, replacesTransactionId: null, replacedByTransactionId: null },
  { ...rows[8], id: id(67), description: "已刪除的歷史紀錄", status: "deleted", version: 2, replacesTransactionId: null, replacedByTransactionId: null },
);
const ledger = { id: LEDGER, coupleId: 1, name: "共同生活", color: "#173B63", status: "active", version: 7, activeForUser: true,
  createdAt: "2026-09-25T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z",
  members: [{ userId: OWNER, role: "owner" }, { userId: PARTNER, role: "partner" }], defaultShares: { [OWNER]: "1", [PARTNER]: "1" } };
const bootstrap = { ledger, transactions: rows, balance: { [OWNER]: "0", [PARTNER]: "0" }, nextPayer: null };

async function setup(page) {
  const requests = [], bootstrapResponses = [], scripts = new Map(), responseWork = [];
  await page.addInitScript(() => {
    window.liff = { init: async () => {}, isLoggedIn: () => true, login: () => {}, getIDToken: () => "fixture-id-token", isInClient: () => true, closeWindow: () => {} };
    const m = window.p2cMetrics = { responses: [], initial: null, phase: null, actions: [] };
    const nativeFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      m.responses.push({ path: String(args[0]), at: performance.now() });
      return response;
    };
    document.addEventListener("click", () => { if (m.phase && m.phase.startAt === null) m.phase.startAt = performance.now(); }, true);
    const observe = () => {
      const count = document.querySelectorAll("button[data-transaction-id]").length;
      if (!m.initial && count > 0) {
        m.initial = { rowsAtCommit: count, committedAt: performance.now() };
        requestAnimationFrame(() => requestAnimationFrame(() => { m.initial.paintAt = performance.now(); }));
      }
      const phase = m.phase;
      if (!phase || phase.startAt === null || phase.scheduled) return;
      const detail = Boolean(new URLSearchParams(location.search).get("v2Transaction"));
      const ready = phase.kind === "append" ? count >= 40 : phase.kind === "detail-open" ? detail && count === 0 : !detail && count > 0;
      if (!ready) return;
      phase.scheduled = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        m.actions.push({ kind: phase.kind, startAt: phase.startAt, paintAt: performance.now(), durationMs: performance.now() - phase.startAt,
          rowCount: document.querySelectorAll("button[data-transaction-id]").length, scrollY,
          focusedRowId: document.activeElement?.getAttribute("data-transaction-id"),
          focusedTestId: document.activeElement?.getAttribute("data-testid"),
          focusedDetailHeading: document.activeElement?.hasAttribute("data-detail-heading") ?? false });
        m.phase = null;
      }));
    };
    new MutationObserver(observe).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.route("https://static.line-scdn.net/**", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    requests.push({ method: request.method(), path });
    let data;
    if (path === "/api/app/session" && request.method() === "POST") data = { ok: true };
    else if (request.method() !== "GET") throw new Error(`Unexpected write in read-only metrics: ${request.method()} ${path}`);
    else if (path === "/api/app/v2/context") data = { today: "2026-10-03", user: { id: OWNER, label: "你", role: "owner" }, users: [{ id: OWNER, label: "你", role: "owner" }, { id: PARTNER, label: "另一半", role: "partner" }] };
    else if (path === "/api/app/v2/ledgers") data = { ledgers: [ledger] };
    else if (path === `/api/app/v2/ledgers/${LEDGER}/bootstrap`) data = bootstrap;
    else if (path === `/api/app/v2/ledgers/${LEDGER}/categories`) data = { categories: [] };
    else if (/\/transactions\/[^/]+\/attachments$/.test(path)) data = { attachments: [] };
    else throw new Error(`Unexpected metrics API: ${request.method()} ${path}`);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  page.on("response", response => {
    if (!response.url().startsWith(baseURL)) return;
    const path = new URL(response.url()).pathname;
    if (path.endsWith(".js")) responseWork.push(response.body().then(body => scripts.set(path, gzipSync(body, { level: 6 }).byteLength)));
    if (path.endsWith("/bootstrap")) responseWork.push(response.body().then(body => {
      const data = JSON.parse(body.toString());
      bootstrapResponses.push({ path, bytes: body.byteLength, transactionCount: data.transactions.length });
    }));
  });
  return { requests, bootstrapResponses, scripts, responseWork };
}

async function paint(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function action(page, state, kind, operation, ready) {
  const offset = state.requests.length;
  await page.evaluate(kind => { window.p2cMetrics.phase = { kind, startAt: null, scheduled: false }; }, kind);
  await operation(); await ready();
  await page.waitForFunction(kind => window.p2cMetrics.actions.some(item => item.kind === kind), kind);
  await paint(page); await page.waitForTimeout(200);
  return { ...(await page.evaluate(kind => window.p2cMetrics.actions.find(item => item.kind === kind), kind)),
    requestCount: state.requests.length - offset, requests: state.requests.slice(offset), url: page.url() };
}

async function main() {
  const browser = await chromium.launch(), samples = [];
  try {
    for (let run = 0; run < 3; run += 1) {
      const context = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, baseURL });
      const page = await context.newPage(), state = await setup(page);
      await page.goto(`/?v2Ledger=${LEDGER}`);
      await expect(page.locator("button[data-transaction-id]").first()).toBeVisible();
      await page.waitForFunction(() => window.p2cMetrics.initial?.paintAt !== undefined);
      await page.waitForLoadState("networkidle"); await Promise.all(state.responseWork);
      const initial = await page.evaluate(() => window.p2cMetrics.initial), responses = await page.evaluate(() => window.p2cMetrics.responses);
      const responseAt = responses.find(item => item.path.endsWith("/bootstrap"))?.at;
      const initialRows = await page.locator("button[data-transaction-id]").count();
      const initialDates = await page.locator("[data-timeline-date]").evaluateAll(elements => elements.map(element => element.getAttribute("data-timeline-date")));
      if (stage === "after") expect(initialRows).toBe(20);
      const startupRequests = [...state.requests], initialScripts = Object.fromEntries(state.scripts);
      const initialGzipJsBytes = [...state.scripts.values()].reduce((sum, bytes) => sum + bytes, 0);
      if (run === 0) await page.screenshot({ path: `${directory}/home-390.png`, fullPage: true });
      const append = stage === "after" ? await action(page, state, "append", () => page.getByRole("button", { name: "更早紀錄", exact: true }).click(), () => expect(page.locator("button[data-transaction-id]")).toHaveCount(40))
        : { available: false, reason: "Baseline renders all bootstrap rows; no client 20-to-40 render-window control." };
      if (stage === "after") {
        expect(append.requestCount).toBe(0);
        append.rowIds = await page.locator("button[data-transaction-id]").evaluateAll(elements => elements.map(element => element.getAttribute("data-transaction-id")));
        append.dates = await page.locator("[data-timeline-date]").evaluateAll(elements => elements.map(element => element.getAttribute("data-timeline-date")));
        expect(new Set(append.rowIds).size).toBe(40);
        expect(new Set(append.dates).size).toBe(append.dates.length);
      }
      const origin = page.locator("button[data-transaction-id]").nth(25);
      await origin.scrollIntoViewIfNeeded(); await origin.focus(); await paint(page);
      const originState = await origin.evaluate(element => ({ id: element.dataset.transactionId, top: element.getBoundingClientRect().top, scrollY }));
      const detail = await action(page, state, "detail-open", () => origin.click(), () => expect(page.getByTestId("surface-heading")).toContainText("紀錄詳情"));
      const transactionGets = detail.requests.filter(item => item.method === "GET" && /^\/api\/app\/v2\/transactions\/[^/]+$/.test(item.path));
      expect(transactionGets).toHaveLength(0);
      if (run === 0) await page.screenshot({ path: `${directory}/detail-390.png`, fullPage: true });
      const candidateBack = page.getByTestId("transaction-detail-back");
      const backControl = await candidateBack.count() ? candidateBack : page.getByRole("button", { name: "返回帳本", exact: true });
      const back = await action(page, state, "detail-back", () => backControl.click(), () => expect(page.locator(`button[data-transaction-id="${originState.id}"]`)).toBeVisible());
      const restored = await page.locator(`button[data-transaction-id="${originState.id}"]`).evaluate(element => ({ id: element.dataset.transactionId, top: element.getBoundingClientRect().top, scrollY, focused: document.activeElement === element }));
      const restoration = { origin: originState, restored, rowOffsetDeltaPx: restored.top - originState.top, scrollDeltaPx: restored.scrollY - originState.scrollY };
      if (stage === "after") { expect(restored.focused).toBe(true); expect(Math.abs(restoration.rowOffsetDeltaPx)).toBeLessThanOrEqual(2); }
      if (run === 0) await page.screenshot({ path: `${directory}/back-390.png`, fullPage: true });
      samples.push({ run, initialGzipJsBytes, initialScripts, bootstrapResponses: state.bootstrapResponses, bootstrapTransactionCount: bootstrap.transactions.length,
        initialHomeDomRows: initialRows, initialDates, startupRequestCount: startupRequests.length, startupRequests,
        initialTimeline: { ...initial, bootstrapFetchResolvedAt: responseAt, responseToTwoFramePaintMs: responseAt === undefined ? null : initial.paintAt - responseAt },
        append, detail, back, restoration, browserClock: await page.evaluate(() => window.p2cMetrics) });
      await context.close();
    }
  } finally { await browser.close(); }
  const report = { stage, baseURL, fixture: { totalTransactions: rows.length, effectivePosted: 65, historicalReplaced: 1, historicalVoided: 1, historicalDeleted: 1 },
    method: "Node 22 / production next start; identical complete 68-row bootstrap fixture with 65 effective posted rows; 3 fresh Chromium 390x844 contexts; no throttling or concurrent builds/tests; gzip level 6 on actual loaded initial-route JS response bodies; actual bootstrap body byte length; browser fetch-resolution/DOM-mutation/input-to-two-rAF paint proxies; request traces settle 200ms after actions. Read-only API mocks except LIFF session initialization. No physical LINE latency/picker/HEIC claim.", samples };
  writeFileSync(`${directory}/metrics.json`, `${JSON.stringify(report, null, 2)}\n`);
  if (stage === "after") {
    const before = JSON.parse(readFileSync(join(dirname(directory), "before", "metrics.json"), "utf8"));
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const summarize = metrics => ({
      initialGzipJsBytes: median(metrics.samples.map(sample => sample.initialGzipJsBytes)),
      bootstrapTransactionCount: metrics.samples[0].bootstrapResponses[0].transactionCount,
      bootstrapResponseBytes: metrics.samples[0].bootstrapResponses[0].bytes,
      initialHomeDomRows: metrics.samples[0].initialHomeDomRows,
      initialTimelineResponseToTwoFramePaintMs: median(metrics.samples.map(sample => sample.initialTimeline.responseToTwoFramePaintMs)),
      appendMs: metrics.stage === "after" ? median(metrics.samples.map(sample => sample.append.durationMs)) : null,
      detailOpenMs: median(metrics.samples.map(sample => sample.detail.durationMs)),
      detailBackMs: median(metrics.samples.map(sample => sample.back.durationMs)),
      startupRequestCounts: metrics.samples.map(sample => sample.startupRequestCount),
      appendRequestCounts: metrics.stage === "after" ? metrics.samples.map(sample => sample.append.requestCount) : null,
      detailOpenRequestCounts: metrics.samples.map(sample => sample.detail.requestCount),
      detailBackRequestCounts: metrics.samples.map(sample => sample.back.requestCount),
      allReturnsRestoreOriginFocus: metrics.samples.every(sample => sample.restoration.restored.focused),
      maximumReturnOffsetDeltaPx: Math.max(...metrics.samples.map(sample => Math.abs(sample.restoration.rowOffsetDeltaPx))),
    });
    const baseline = summarize(before), candidate = summarize(report);
    writeFileSync(join(dirname(directory), "summary.json"), `${JSON.stringify({
      baselineSha: "aa9799cdb78fab7bc91d0648113e77a76b58f70d", method: report.method,
      baseline, candidate, incrementalGzipJsBytes: candidate.initialGzipJsBytes - baseline.initialGzipJsBytes,
      fixtureIsLiveAccountData: false,
    }, null, 2)}\n`);
  }
  console.log(`${directory}/metrics.json`);
}
await main();
