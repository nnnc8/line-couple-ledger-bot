import { chromium, webkit, devices, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homeBrowser, A, PARTNER, OWNER, deferred, LARGE_BALANCE, LONG_NAME, type HomeFixtureOptions } from "./fixtures/p2-e-browser";

const stage = process.argv[2] ?? "after", baseURL = process.argv[3] ?? "http://localhost:3119";
const states: { name: string; options?: HomeFixtureOptions; loading?: boolean; fail?: boolean; stale?: boolean; text?: number }[] = [
  { name: "self-positive", options: { balance: "2480", nextPayer: PARTNER } },
  { name: "partner-positive", options: { balance: "-2480", nextPayer: OWNER } },
  { name: "balanced", options: { balance: "0", nextPayer: null } },
  { name: "zero-records", options: { count: 0 } },
  { name: "initial-loading", loading: true }, { name: "initial-read-failure", fail: true },
  { name: "stale-known-data", options: { balance: "2480", nextPayer: PARTNER }, stale: true },
  { name: "long-name", options: { name: LONG_NAME } },
  { name: "large-balance", options: { balance: LARGE_BALANCE, nextPayer: PARTNER } },
  { name: "text-200", options: { name: LONG_NAME, balance: LARGE_BALANCE, nextPayer: PARTNER }, text: 200 },
  { name: "no-ledger", options: { noLedger: true } },
];
async function capture(page: Page, path: string, fixture: Awaited<ReturnType<typeof homeBrowser>>, state: string) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: `${path}.png`, animations: "disabled" });
  await page.screenshot({ path: `${path}-full.png`, fullPage: true, animations: "disabled" });
  const dom = await page.evaluate(() => {
    const box = (node: Element | null) => { if (!node) return null; const r = node.getBoundingClientRect(), css = getComputedStyle(node); return { tag: node.tagName, text: node.textContent, top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height, fontSize: css.fontSize, lineHeight: css.lineHeight, weight: css.fontWeight, color: css.color, background: css.backgroundColor, backgroundImage: css.backgroundImage }; };
    const boundary = document.querySelector('[data-testid="home-entry-action"]')?.getBoundingClientRect().top ?? innerHeight;
    const rows = [...document.querySelectorAll('[data-testid="ledger-timeline"] button[data-transaction-id]')];
    return { viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth, textSize: getComputedStyle(document.documentElement).fontSize,
      header: box(document.querySelector('h1')), balance: box(document.querySelector('[data-testid="ledger-balance"]')), nextPayer: box([...document.querySelectorAll('p')].find(node => node.textContent?.startsWith("下次建議由")) ?? null),
      cta: box(document.querySelector('[data-testid="quick-entry-trigger"]')), headerActions: [...document.querySelectorAll('header button')].map(box), initialDomRows: rows.length,
      fullyVisibleRows: rows.filter(node => { const r = node.getBoundingClientRect(); return r.top >= 0 && r.bottom <= boundary; }).length,
      activeElement: document.activeElement?.id, dialogs: document.querySelectorAll('dialog[open]').length };
  });
  if (stage === "after") {
    expect(dom.scrollWidth, state).toBeLessThanOrEqual(dom.viewport.width);
    for (const target of dom.headerActions) { expect(target!.width).toBeGreaterThanOrEqual(44); expect(target!.height).toBeGreaterThanOrEqual(44); }
    if (["self-positive", "partner-positive", "balanced"].includes(state)) {
      expect(dom.fullyVisibleRows).toBeGreaterThanOrEqual(3); expect(dom.header!.top).toBeGreaterThanOrEqual(0);
      expect(dom.cta!.bottom).toBeLessThanOrEqual(dom.viewport.height); expect(dom.cta!.height).toBeGreaterThanOrEqual(52);
    }
  }
  writeFileSync(`${path}.json`, JSON.stringify({ stage, state, baseURL, dom, requests: fixture.state.requests }, null, 2));
}
async function main() {
  for (const [engine, launch] of [["chromium", chromium], ["webkit", webkit]] as const) {
    const browser = await launch.launch();
    for (const viewport of [{ width: 390, height: 844 }, { width: 393, height: 852 }]) {
      const directory = `docs/evidence/p2-e/${stage}/${engine}-${viewport.width}`; mkdirSync(directory, { recursive: true });
      for (const state of states) {
        const context = await browser.newContext({ ...devices["iPhone 13"], viewport, baseURL }), page = await context.newPage();
        await context.addInitScript("window.__name = value => value;");
        const fixture = await homeBrowser(page, state.options), hold = deferred();
        if (state.loading) fixture.state.holdReads.set(A, hold);
        if (state.fail) fixture.state.failReads.set(A, 500);
        try {
          await fixture.goto();
          if (state.options?.noLedger) await expect(page.getByRole("heading", { name: "還沒有帳本" })).toBeVisible();
          else if (state.loading) await expect(page.locator("[data-timeline-skeleton]")).toHaveCount(3);
          else if (state.fail) await expect(page.getByRole("button", { name: "重新讀取" })).toBeVisible();
          else await fixture.ready();
          if (state.stale) {
            fixture.state.failReads.set(A, 500);
            if (stage === "before") await page.getByLabel("重新整理帳本").click();
            else { await page.getByTestId("home-more-trigger").click(); await page.getByRole("dialog").getByRole("button", { name: "重新整理", exact: true }).click(); }
            await expect(page.getByRole("button", { name: "重新讀取" })).toBeVisible();
          }
          if (state.text) await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
          await capture(page, `${directory}/${state.name}`, fixture, state.name);
          if (stage === "after" && state.name === "self-positive") { await page.getByTestId("home-more-trigger").click(); await capture(page, `${directory}/home-more`, fixture, "home-more"); }
        } finally { hold.release(); await context.close(); }
      }
    }
    await browser.close();
  }
}
void main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
