import type { Page } from "@playwright/test";
import { navigationBrowser, row, A, B, OWNER, PARTNER } from "./p1-c-browser";
export { A, B, OWNER, PARTNER, deferred, switchLedger } from "./p1-c-browser";
export const LARGE_BALANCE = "900719925474099312345";
export const LARGE_AMOUNT = "NT$900,719,925,474,099,312,345";
export const LONG_NAME = "我們一起記錄生活與旅行和家人共度每一天的共同帳本留存美好回憶直到未來每個重要時刻";
export type HomeFixtureOptions = { balance?: string; nextPayer?: string | null; name?: string; count?: number; noLedger?: boolean };

export async function homeBrowser(page: Page, options: HomeFixtureOptions = {}) {
  const fixture = await navigationBrowser(page);
  if (options.name) fixture.state.names[A] = options.name;
  if (options.noLedger) fixture.state.ledgerIds = [];
  fixture.state.rows = [
    ...Array.from({ length: options.count ?? 50 }, (_, index) => ({ ...row(A, `00000000-0000-4000-8000-${String(2000 + index).padStart(12, "0")}`, `一起生活 ${index + 1}`), createdAt: new Date(Date.parse("2026-09-25T00:00:00Z") + index * 1000).toISOString() })),
    row(B, "00000000-0000-4000-8000-000000003000", "旅行車票"),
  ];
  await page.route("**/api/app/v2/ledgers/*/bootstrap", async route => {
    const id = new URL(route.request().url()).pathname.split("/")[5]!;
    const snapshot = fixture.snapshot(id), failure = fixture.state.failReads.get(id), hold = fixture.state.holdReads.get(id);
    if (id === A && options.balance !== undefined) snapshot.balance = { [OWNER]: options.balance, [PARTNER]: String(-BigInt(options.balance)) };
    if (id === A && options.nextPayer !== undefined) snapshot.nextPayer = options.nextPayer ? { payerUserId: options.nextPayer, amountTwd: "1", payeeUserId: options.nextPayer === OWNER ? PARTNER : OWNER } : null;
    if (hold) await hold.promise;
    return failure ? route.fulfill({ status: failure, json: { error: "fixture read failure" } }) : route.fulfill({ json: snapshot });
  });
  return fixture;
}
