import { outerIntentClick } from "./p1-b-browser";
import { expect, type Page, type Route } from "@playwright/test";
import { calculateLedgerBalance, recommendNextPayer } from "../../src/lib/v2-ledger";
import type { V2CreateTransactionResult, V2LedgerBootstrap, V2LedgerTransaction } from "../../src/lib/types";
export { fillEntry, openEntry, outerIntentClick } from "./p1-b-browser";
export const OWNER = "00000000-0000-4000-8000-000000000001", PARTNER = "00000000-0000-4000-8000-000000000002";
export const A = "00000000-0000-4000-8000-000000000010", B = "00000000-0000-4000-8000-000000000020", C = "00000000-0000-4000-8000-000000000030";
export const TA = "00000000-0000-4000-8000-000000000011", TB = "00000000-0000-4000-8000-000000000021";
export const names: Record<string, string> = { [A]: "共同生活", [B]: "旅行", [C]: "家庭" };
export function row(ledgerId: string, id: string, description: string): V2LedgerTransaction {
  return { id, ledgerId, description, type: "expense", amountTwd: "200", payments: [{ userId: OWNER, amountTwd: "200" }], shares: [{ userId: OWNER, amountTwd: "100" }, { userId: PARTNER, amountTwd: "100" }], status: "posted", occurredOn: "2026-09-25", createdAt: "2026-09-25T00:00:00Z", version: 1, splitMethod: "equal", category: null, categoryId: null, note: null };
}
type Hold = { release: () => void; promise: Promise<void> };
export function deferred(): Hold { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { release, promise }; }
export async function navigationBrowser(page: Page, { holdLiffInit = false } = {}) {
  await page.clock.setFixedTime(new Date("2026-09-25T04:00:00Z"));
  const state = {
    names: { ...names }, createFailure: false, createHold: null as Hold | null,
    rows: [row(A, TA, "A 專屬晚餐"), row(B, TB, "B 專屬車票")], ledgerIds: [A, B, C], defaultId: A, version: 1,
    requests: [] as { method: string; path: string; at: number; finishedAt?: number }[],
    posts: [] as { endpoint: string; bytes: string; body: Record<string, unknown>; key?: string }[],
    failReads: new Map<string, number>(), failActivations: new Set<string>(), holdReads: new Map<string, Hold>(), holdActivations: new Map<string, Hold>(),
    holdSecondary: new Map<string, Hold>(), secondaryFailures: new Set<string>(), mode: "normal" as "normal" | "delay" | "drop" | "partial", postHold: null as Hold | null,
    effects: 0, receipts: new Map<string, V2CreateTransactionResult>(),
  };
  const snapshot = (ledgerId: string): V2LedgerBootstrap => {
    const transactions = state.rows.filter(item => item.ledgerId === ledgerId), balance = calculateLedgerBalance(transactions, { ledgerId, memberIds: [OWNER, PARTNER] }), next = recommendNextPayer(balance, [OWNER, PARTNER]);
    return JSON.parse(JSON.stringify({ ledger: { id: ledgerId, name: state.names[ledgerId], color: "#173B63", status: "active", activeForUser: ledgerId === state.defaultId, version: state.version, createdAt: "2026-09-25T00:00:00Z", updatedAt: "2026-09-25T00:00:00Z", coupleId: 1, members: [{ userId: OWNER, role: "owner" }, { userId: PARTNER, role: "partner" }], defaultShares: { [OWNER]: "1", [PARTNER]: "1" } }, transactions, balance: Object.fromEntries(Object.entries(balance).map(([id, amount]) => [id, String(amount)])), nextPayer: next ? { ...next, amountTwd: String(next.amountTwd) } : null }));
  };
  await page.addInitScript(({ holdLiffInit }) => {
    Object.assign(window, { releaseLiff: null, liff: {
      init: () => holdLiffInit ? new Promise<void>(resolve => Object.assign(window, { releaseLiff: resolve })) : Promise.resolve(),
      isLoggedIn: () => true, login: () => undefined, getIDToken: () => "fixture-id-token", isInClient: () => true, closeWindow: () => undefined,
    } });
  }, { holdLiffInit });
  await page.route("https://static.line-scdn.net/**", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  const trace = new Map<unknown, typeof state.requests[number]>();
  page.on("request", request => { const url = new URL(request.url()); if (url.pathname.startsWith("/api/")) { const item = { method: request.method(), path: url.pathname + url.search, at: performance.now() }; state.requests.push(item); trace.set(request, item); } });
  page.on("requestfinished", request => { const item = trace.get(request); if (item) item.finishedAt = performance.now(); });
  page.on("requestfailed", request => { const item = trace.get(request); if (item) item.finishedAt = performance.now(); });
  await page.route("**/api/app/session", route => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/app/v2/context", route => route.fulfill({ json: { today: "2026-09-25", user: { id: OWNER, label: "你", role: "owner" }, users: [{ id: OWNER, label: "你", role: "owner" }, { id: PARTNER, label: "另一半", role: "partner" }] } }));
  await page.route("**/api/app/v2/ledgers", async route => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { ledgers: state.ledgerIds.map(id => snapshot(id).ledger) } });
    if (state.createHold) await state.createHold.promise;
    if (state.createFailure) return route.fulfill({ status: 500, json: { error: "帳本暫時無法建立" } });
    const id = "00000000-0000-4000-8000-000000000040";
    state.names[id] = route.request().postDataJSON().name;
    state.ledgerIds.push(id); state.defaultId = id;
    return route.fulfill({ status: 201, json: { ledger: snapshot(id).ledger } });
  });
  await page.route("**/api/app/v2/ledgers/*/bootstrap", async route => {
    const id = new URL(route.request().url()).pathname.split("/")[5]!, captured = snapshot(id), failure = state.failReads.get(id), hold = state.holdReads.get(id);
    if (hold) await hold.promise;
    return failure ? route.fulfill({ status: failure, json: { error: `${state.names[id]} fixture read failure` } }) : route.fulfill({ json: captured });
  });
  await page.route("**/api/app/v2/ledgers/*/activate", async route => {
    const id = new URL(route.request().url()).pathname.split("/")[5]!, failure = state.failActivations.has(id), hold = state.holdActivations.get(id);
    if (hold) await hold.promise;
    if (failure) return route.fulfill({ status: 500, json: { error: "preference fixture failure" } });
    state.defaultId = id; return route.fulfill({ json: { ok: true } });
  });
  for (const kind of ["categories", "recurring", "statistics"]) await page.route(`**/api/app/v2/ledgers/*/${kind}`, async route => {
    const id = new URL(route.request().url()).pathname.split("/")[5]!, key = `${id}/${kind}`, hold = state.holdSecondary.get(key), failed = state.secondaryFailures.has(key);
    if (hold) await hold.promise;
    if (failed) return route.fulfill({ status: 500, json: { error: `stale ${state.names[id]} ${kind}` } });
    return route.fulfill({ json: kind === "statistics" ? { byType: { expense: id === A ? "200" : "300" }, byCategory: {}, paidBy: {}, borneBy: {} } : { [kind]: [] } });
  });
  await page.route("**/api/app/v2/transactions/*/attachments", route => route.fulfill({ json: { attachments: [] } }));
  await page.route("**/api/app/v2/proposals/*", route => route.fulfill({ json: { status: "pending" } }));
  await page.route("**/api/app/v2/ledgers/*/transactions*", async (route: Route) => {
    const url = new URL(route.request().url()), id = url.pathname.split("/")[5]!;
    if (route.request().method() !== "POST") {
      const hold = state.holdSecondary.get(`${id}/history`); if (hold) await hold.promise;
      const query = url.searchParams.get("q") ?? "";
      return route.fulfill({ json: { transactions: state.rows.filter(item => item.ledgerId === id && (item.description ?? "").includes(query)), nextCursor: null } });
    }
    const request = route.request(), bytes = request.postData()!, body = request.postDataJSON();
    state.posts.push({ endpoint: url.pathname, bytes, body, key: request.headers()["idempotency-key"] });
    if (state.mode === "delay") { state.postHold = deferred(); await state.postHold.promise; }
    const key = `${id}:${body.idempotencyKey}`;
    let receipt = state.receipts.get(key);
    if (!receipt) {
      const transaction = { ...body, id: `00000000-0000-4000-8000-${String(500 + state.effects).padStart(12, "0")}`, ledgerId: id, status: "posted", version: 1, createdAt: "2026-09-25T00:00:01Z" };
      state.rows = [transaction, ...state.rows]; state.effects += 1; state.version += 1;
      const latest = snapshot(id); receipt = { transaction, balance: latest.balance, nextPayer: latest.nextPayer, ledgerVersion: state.version }; state.receipts.set(key, receipt!);
    }
    if (state.mode === "drop") { state.mode = "normal"; return route.abort("failed"); }
    if (state.mode === "partial") { const partial: Partial<V2CreateTransactionResult> = { ...receipt }; delete partial.nextPayer; return route.fulfill({ status: 201, json: partial }); }
    return route.fulfill({ status: 201, json: receipt });
  });
  return { state, snapshot, goto: async (path = "/") => { await page.goto(path); }, ready: async () => { await expect(page.getByTestId("quick-entry-trigger")).toBeVisible(); } };
}
export async function switchLedger(page: Page, id: string) { await outerIntentClick(page, page.getByTestId("ledger-name-trigger")); await page.getByRole("dialog").locator(`[data-ledger-option="${id}"]`).click(); }
export const activationRequests = (state: Awaited<ReturnType<typeof navigationBrowser>>["state"]) => state.requests.filter(item => item.method === "POST" && item.path.endsWith("/activate"));
