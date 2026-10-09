import { chromium, webkit, devices, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homeBrowser } from "./fixtures/p2-e-browser";
import { fillEntry } from "./fixtures/p1-b-browser";

const baseURL = process.argv[2] ?? "http://localhost:3119";
const directory = "docs/evidence/p2-e/recordings";
mkdirSync(directory, { recursive: true });

async function main() {
  for (const [engine, launch] of [["chromium", chromium], ["webkit", webkit]] as const) {
    const browser = await launch.launch();
    const context = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, baseURL,
      recordVideo: { dir: "output/p2-e-recordings", size: { width: 390, height: 844 } } });
    await context.addInitScript("window.__name = value => value;");
    const page = await context.newPage(), fixture = await homeBrowser(page);
    await fixture.goto(); await fixture.ready();
    await page.getByTestId("home-more-trigger").click();
    await expect(page.locator("#ledger-dialog-title")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("home-more-trigger")).toBeFocused();
    await page.getByTestId("home-more-trigger").click();
    await page.getByRole("dialog").getByRole("button", { name: "帳本設定", exact: true }).click();
    await expect(page.getByTestId("surface-heading")).toContainText("帳本設定");
    await page.getByTestId("transaction-detail-back").click();
    await page.getByTestId("home-more-trigger").click();
    await page.getByRole("dialog").getByRole("button", { name: "重新整理", exact: true }).click();
    await fixture.ready();
    await fillEntry(page, "剛加入", "680");
    await page.getByRole("dialog").getByRole("button", { name: "加入", exact: true }).click();
    await expect(page.locator("[data-write-outcome]")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /剛加入，支出/ })).toBeFocused();
    expect(fixture.state.posts).toHaveLength(1);
    await page.getByTestId("quick-entry-trigger").click();
    await expect(page.getByLabel("金額，新臺幣")).toHaveValue("");
    await expect(page.getByLabel("用途", { exact: true })).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("quick-entry-trigger")).toBeFocused();
    const video = page.video()!;
    await context.close(); await video.saveAs(`${directory}/${engine}-390-home-flow.webm`);
    writeFileSync(`${directory}/${engine}-390-home-flow.json`, JSON.stringify({ engine, viewport: "390x844", baseURL,
      scope: "Local production build with mocked LIFF/auth/API; no production writes or physical LINE proof.",
      assertions: ["More heading/return focus", "Settings and scoped Back", "Refresh", "one canonical create", "row focus", "one contextual success", "fresh next draft", "Quick Entry return focus"],
      requests: fixture.state.requests, posts: fixture.state.posts }, null, 2));
    await browser.close();
  }
}
void main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
