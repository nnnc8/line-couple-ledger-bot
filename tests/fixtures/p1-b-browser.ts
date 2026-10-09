import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { calculateLedgerBalance, recommendNextPayer } from "../../src/lib/v2-ledger";
import type { V2CreateTransactionResult, V2LedgerBootstrap, V2LedgerTransaction } from "../../src/lib/types";

export const OWNER = "00000000-0000-4000-8000-000000000001", PARTNER = "00000000-0000-4000-8000-000000000002";
export const LEDGER = "00000000-0000-4000-8000-000000000010", OTHER = "00000000-0000-4000-8000-000000000020";
type Mode = "normal" | "drop" | "malformed" | "partial" | "reject" | "unauthorized" | "wrong-scope" | "delay";
type Receipt = V2CreateTransactionResult & { replacedTransactionId?: string; version?: number };

export async function entryBrowser(page: Page, options: { actor?: string; weights?: Record<string, string>; rows?: V2LedgerTransaction[]; legacyInline?: boolean } = {}) {
  await page.clock.setFixedTime(new Date("2026-09-25T04:00:00Z"));
  const state = {
    actor: options.actor ?? OWNER, coupleId: 1, mode: "normal" as Mode, failRead: false, version: 1,
    weights: options.weights ?? { [OWNER]: "1", [PARTNER]: "1" }, rows: options.rows ?? [] as V2LedgerTransaction[],
    requests: [] as string[], posts: [] as Array<{ endpoint: string; body: Record<string, unknown>; bytes: string; key: string | undefined; recovery: string | null }>,
    receipts: new Map<string, { body: string; response: Receipt }>(), effects: 0,
    release: null as (() => void) | null,
  };
  const snapshot = (ledgerId = LEDGER): V2LedgerBootstrap => {
    const rows = state.rows.filter(row => row.ledgerId === ledgerId);
    const balance = calculateLedgerBalance(rows, { ledgerId, memberIds: [OWNER, PARTNER] });
    const next = recommendNextPayer(balance, [OWNER, PARTNER]);
    return { ledger: { id: ledgerId, name: ledgerId === LEDGER ? "共同生活" : "旅行帳本", color: "#173B63", status: "active", version: state.version, createdAt: "2026-09-25T00:00:00Z", updatedAt: "2026-09-25T00:00:00Z", coupleId: state.coupleId, members: [{ userId: OWNER, role: "owner" }, { userId: PARTNER, role: "partner" }], defaultShares: { ...state.weights } }, transactions: rows,
      balance: Object.fromEntries(Object.entries(balance).map(([id, amount]) => [id, String(amount)])), nextPayer: next ? { ...next, amountTwd: String(next.amountTwd) } : null };
  };
  await page.addInitScript(() => { window.liff = { init: async () => undefined, isLoggedIn: () => true, login: () => undefined, getIDToken: () => "fixture-id-token", isInClient: () => true, closeWindow: () => undefined }; });
  await page.route("https://static.line-scdn.net/**", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  page.on("request", request => { const url = new URL(request.url()); if (url.pathname.startsWith("/api/")) state.requests.push(`${request.method()} ${url.pathname}`); });
  await page.route("**/api/app/session", route => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/app/v2/context", route => route.fulfill({ json: { today: "2026-09-25", user: { id: state.actor, label: "你", role: state.actor === OWNER ? "owner" : "partner" }, users: [{ id: OWNER, label: state.actor === OWNER ? "你" : "另一半", role: "owner" }, { id: PARTNER, label: state.actor === PARTNER ? "你" : "另一半", role: "partner" }] } }));
  await page.route("**/api/app/v2/ledgers", route => route.fulfill({ json: { ledgers: [snapshot().ledger, snapshot(OTHER).ledger] } }));
  await page.route("**/api/app/v2/ledgers/*/bootstrap", route => state.failRead ? route.fulfill({ status: 500, json: { error: "fixture read failure" } }) : route.fulfill({ json: snapshot(route.request().url().includes(OTHER) ? OTHER : LEDGER) }));
  await page.route("**/api/app/v2/ledgers/*/categories", route => route.fulfill({ json: { categories: [] } }));
  await page.route("**/api/app/v2/ledgers/*/activate", route => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/app/v2/transactions/*/attachments", route => route.fulfill({ json: { attachments: [] } }));
  const post = async (route: Route, replace: boolean) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { transactions: state.rows, nextCursor: null } });
    const request = route.request(), body = request.postDataJSON(), bytes = request.postData()!;
    const ledgerId = replace ? state.rows.find(row => request.url().includes(row.id))?.ledgerId ?? LEDGER : request.url().includes(OTHER) ? OTHER : LEDGER;
    const endpoint = new URL(request.url()).pathname;
    const recovery = await page.evaluate(() => sessionStorage.getItem("v2.entry-operation.v1")).catch(() => null);
    state.posts.push({ endpoint, body, bytes, key: request.headers()["idempotency-key"], recovery });
    if (state.mode === "delay") await new Promise<void>(resolve => { state.release = resolve; });
    if (state.mode === "reject" || state.mode === "unauthorized") return route.fulfill({ status: state.mode === "reject" ? 422 : 401, json: { error: "請檢查輸入或登入狀態" } });
    const receiptKey = `${state.actor}:${endpoint}:${body.idempotencyKey}`;
    let receipt = state.receipts.get(receiptKey);
    if (receipt && receipt.body !== bytes) return route.fulfill({ status: 409, json: { error: "key conflict" } });
    if (!receipt) {
      const command = replace ? body.replacement : body;
      const originalId = replace ? endpoint.split("/")[5] : undefined;
      const original = state.rows.find(row => row.id === originalId);
      if (replace && (!original || original.version !== body.expectedVersion || original.status !== "posted")) return route.fulfill({ status: 409, json: { error: "version conflict" } });
      const tx: V2LedgerTransaction = { ...command, id: `00000000-0000-4000-8000-${String(100 + state.effects).padStart(12, "0")}`, ledgerId, status: "posted", version: 1, createdAt: "2026-09-25T00:00:01Z", ...(replace ? { replacesTransactionId: originalId } : {}) };
      if (original) { original.status = "voided"; original.version! += 1; original.replacedByTransactionId = tx.id; }
      state.rows = [tx, ...state.rows]; state.effects += 1; state.version += replace ? 2 : 1;
      const latest = snapshot(ledgerId);
      receipt = { body: bytes, response: { transaction: tx as V2CreateTransactionResult["transaction"], balance: latest.balance, nextPayer: latest.nextPayer, ledgerVersion: latest.ledger.version, ...(replace ? { replacedTransactionId: originalId, version: body.expectedVersion + 1 } : {}) } };
      // Real receipts are immutable even if a later mutation changes the current row.
      receipt = JSON.parse(JSON.stringify(receipt));
      state.receipts.set(receiptKey, receipt!);
    }
    const response = receipt!.response;
    if (state.mode === "drop") { state.mode = "normal"; return route.abort("failed"); }
    if (state.mode === "malformed") return route.fulfill({ status: 201, json: { ok: true } });
    if (state.mode === "wrong-scope") return route.fulfill({ status: 201, json: { ...response, transaction: { ...response.transaction, ledgerId: OTHER } } });
    if (replace || state.mode === "partial") {
      const partial: Partial<Receipt> = { ...response };
      delete partial.nextPayer;
      return route.fulfill({ status: 201, json: partial });
    }
    return route.fulfill({ status: 201, json: response });
  };
  await page.route("**/api/app/v2/ledgers/*/transactions*", route => post(route, false));
  await page.route("**/api/app/v2/transactions/*/mutate", route => post(route, true));
  await page.goto("/");
  await expect(options.legacyInline ? page.getByLabel("金額，新臺幣") : page.getByTestId("quick-entry-trigger")).toBeVisible();
  return { state, snapshot };
}

export async function openEntry(page: Page) {
  if (!await page.getByLabel("金額，新臺幣").isVisible()) await page.getByTestId("quick-entry-trigger").click();
  await expect(page.getByLabel("金額，新臺幣")).toBeVisible();
}

/** Exercise an outer P1-C intent while the native host makes background UI inert.
 * Actual P2-D pointer/keyboard flows close/discard before switching surfaces. */
export async function outerIntentClick(page: Page, target: Locator) {
  if (await page.locator("dialog[open][data-full-height]").count()) await target.evaluate(node => (node as HTMLElement).click());
  else await target.click();
}

export async function fillEntry(page: Page, description = "晚餐", amount = "681") {
  await openEntry(page);
  await page.getByLabel("金額，新臺幣").fill(amount);
  await page.getByLabel("用途", { exact: true }).fill(description);
}

/** Home administration uses the single More host; outer intents retain existing guard tests. */
export async function homeAction(page: Page, action: "帳本設定" | "重新整理", preserveViewport = false) {
  if (preserveViewport) await page.getByTestId("home-more-trigger").evaluate(node => (node as HTMLElement).click());
  else await outerIntentClick(page, page.getByTestId("home-more-trigger"));
  await outerIntentClick(page, page.getByRole("dialog").getByRole("button", { name: action, exact: true }));
}
export async function homeSurface(page: Page, name: string, preserveViewport = false) {
  if (name === "帳本設定") return homeAction(page, "帳本設定", preserveViewport);
  const target = page.getByRole("button", { name: name === "搜尋" ? "搜尋紀錄" : name, exact: true });
  if (preserveViewport) await target.evaluate(node => (node as HTMLElement).click()); else await outerIntentClick(page, target);
}
