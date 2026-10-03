import type { Page } from "@playwright/test";
import { calculateLedgerBalance } from "../../src/lib/v2-ledger";
import type { V2Attachment, V2LedgerTransaction } from "../../src/lib/types";
import { A, B, OWNER, PARTNER, navigationBrowser, row } from "./p1-c-browser";

export { A, B, OWNER, PARTNER, deferred, switchLedger } from "./p1-c-browser";
export const transactionId = (index: number) => `00000000-0000-4000-8000-${String(1000 + index).padStart(12, "0")}`;
export const IDS = { future: transactionId(1), long: transactionId(2), huge: transactionId(3), expense: transactionId(4), income: transactionId(5), transfer: transactionId(6), both: transactionId(7), yesterday: transactionId(60), crossYear: transactionId(61), old: transactionId(70), replacement: transactionId(71), voided: transactionId(72) };
export const LONG_PURPOSE = "兩人一起到臺東旅行第三天，和家人朋友共進晚餐，包含臨時加點餐點、飲料以及打包帶回家的點心與早餐";
export const LONG_NOTE = "這是完整備註，應該在詳情清楚換行。".repeat(12) + "https://example.invalid/" + "receipt-context-".repeat(20);
// Browser canonical data respects the existing kernel's 100 billion TWD limit.
// The pure display helper separately proves amounts beyond Number's safe range.
export const HUGE_AMOUNT = "100000000000";
export const HUGE_DISPLAY = "NT$100,000,000,000";

export function timelineRows(): V2LedgerTransaction[] {
  const rows: V2LedgerTransaction[] = Array.from({ length: 59 }, (_, index) => {
    const item = row(A, transactionId(index + 1), `日常紀錄 ${String(index + 1).padStart(2, "0")}`);
    return { ...item, occurredOn: index === 0 ? "2026-09-28" : "2026-09-25", createdAt: `2026-09-25T${String(23 - Math.floor(index / 60)).padStart(2, "0")}:${String(59 - index).padStart(2, "0")}:00Z` };
  });
  Object.assign(rows[1]!, { description: LONG_PURPOSE, note: LONG_NOTE, category: "餐飲" });
  Object.assign(rows[2]!, { description: "大額紀錄", amountTwd: HUGE_AMOUNT, payments: [{ userId: OWNER, amountTwd: HUGE_AMOUNT }], shares: [{ userId: OWNER, amountTwd: "50000000000" }, { userId: PARTNER, amountTwd: "50000000000" }] });
  Object.assign(rows[3]!, { description: "單人付款晚餐", note: LONG_NOTE, category: "餐飲", categoryId: "stored-archived-category" });
  Object.assign(rows[4]!, { description: "旅館退款", type: "income", amountTwd: "100", payments: [{ userId: PARTNER, amountTwd: "100" }], shares: [{ userId: OWNER, amountTwd: "50" }, { userId: PARTNER, amountTwd: "50" }] });
  Object.assign(rows[5]!, { description: "兩人轉帳", type: "transfer", splitMethod: "none", payments: [{ userId: OWNER, amountTwd: "200" }], shares: [{ userId: PARTNER, amountTwd: "200" }] });
  Object.assign(rows[6]!, { description: "兩人合付晚餐", payments: [{ userId: OWNER, amountTwd: "120" }, { userId: PARTNER, amountTwd: "80" }] });
  rows.push({ ...row(A, IDS.yesterday, "昨日買菜"), occurredOn: "2026-09-24" });
  rows.push({ ...row(A, IDS.crossYear, "去年家用"), occurredOn: "2025-12-31" });
  rows.push({ ...row(A, IDS.old, "原始晚餐"), status: "voided", version: 2, replacedByTransactionId: IDS.replacement });
  rows.push({ ...row(A, IDS.replacement, "修正後晚餐"), replacesTransactionId: IDS.old, occurredOn: "2026-09-23" });
  rows.push({ ...row(A, IDS.voided, "已作廢早餐"), status: "voided", version: 2, occurredOn: "2026-09-22" });
  rows.push(row(B, transactionId(80), "旅行帳本車票"));
  return rows;
}

export async function timelineBrowser(page: Page, options: { rows?: V2LedgerTransaction[]; searchPageSize?: number } = {}) {
  const fixture = await navigationBrowser(page);
  fixture.state.rows = options.rows ?? timelineRows();
  const attachments = new Map<string, V2Attachment[]>();
  const mutationReceipts = new Map<string, { bytes: string; response: Record<string, unknown> }>();
  const actions = {
    mutations: [] as Array<{ transactionId: string; body: Record<string, unknown> }>,
    attachmentRequests: [] as Array<{ method: string; path: string; body?: Record<string, unknown> }>,
    failAfterMutation: false, attachmentFailure: false, historyFailure: false, dropNextMutationResponse: false,
  };
  attachments.set(IDS.expense, [{ id: "fixture-existing-receipt", ledgerId: A, transactionId: IDS.expense, mimeType: "application/pdf", sizeBytes: 128, status: "ready", createdAt: "2026-09-25T02:00:00Z", url: "https://receipt.example.invalid/existing.pdf" }]);
  await page.route("**/api/app/v2/ledgers/*/transactions*", async route => {
    if (route.request().method() === "POST") return route.fallback();
    if (actions.historyFailure) return route.fulfill({ status: 500, json: { error: "fixture Search read failure" } });
    const params = new URL(route.request().url()).searchParams, ledgerId = new URL(route.request().url()).pathname.split("/")[5]!;
    const query = (params.get("q") ?? "").toLocaleLowerCase();
    const transactions = fixture.state.rows.filter(item => item.ledgerId === ledgerId
      && (!query || [item.description, item.category, item.note].some(value => value?.toLocaleLowerCase().includes(query)))
      && (!params.get("type") || item.type === params.get("type"))
      && (!params.get("payerUserId") || item.payments.some(payment => payment.userId === params.get("payerUserId")))
      && (!params.get("categoryId") || item.categoryId === params.get("categoryId"))
      && (!params.get("from") || (item.occurredOn ?? "") >= params.get("from")!)
      && (!params.get("to") || (item.occurredOn ?? "") <= params.get("to")!));
    const start = Number(params.get("cursor") ?? "0"), end = start + (options.searchPageSize ?? transactions.length);
    return route.fulfill({ json: { transactions: transactions.slice(start, end), nextCursor: end < transactions.length ? String(end) : null } });
  });
  await page.route("**/api/app/v2/transactions/*/mutate", async route => {
    const id = new URL(route.request().url()).pathname.split("/")[5]!, body = route.request().postDataJSON() as Record<string, unknown>;
    actions.mutations.push({ transactionId: id, body });
    const receiptKey = `${id}:${body.idempotencyKey}`, bytes = route.request().postData()!, receipt = mutationReceipts.get(receiptKey);
    if (receipt) return receipt.bytes === bytes ? route.fulfill({ json: receipt.response }) : route.fulfill({ status: 409, json: { error: "fixture immutable mutation conflict" } });
    const respond = (response: Record<string, unknown>) => {
      mutationReceipts.set(receiptKey, { bytes, response: JSON.parse(JSON.stringify(response)) });
      if (actions.dropNextMutationResponse) { actions.dropNextMutationResponse = false; return route.abort("failed"); }
      return route.fulfill({ json: response });
    };
    const original = fixture.state.rows.find(item => item.id === id);
    if (!original || original.version !== body.expectedVersion) return route.fulfill({ status: 409, json: { error: "fixture version conflict" } });
    if (body.action === "replace") {
      const replacement: V2LedgerTransaction = { ...body.replacement as V2LedgerTransaction, id: transactionId(100 + actions.mutations.length), ledgerId: original.ledgerId, status: "posted", version: 1, createdAt: "2026-09-25T23:59:59Z", replacesTransactionId: original.id };
      original.status = "voided"; original.version! += 1; original.replacedByTransactionId = replacement.id;
      fixture.state.rows = [replacement, ...fixture.state.rows]; fixture.state.version += 2;
      if (actions.failAfterMutation) fixture.state.failReads.set(original.ledgerId, 500);
      const latest = fixture.snapshot(original.ledgerId);
      return respond({ ok: true, replacedTransactionId: original.id, transaction: replacement, balance: latest.balance, version: original.version, ledgerVersion: latest.ledger.version });
    }
    if (body.action !== "void" && body.action !== "restore") return route.fulfill({ status: 422, json: { error: "fixture unsupported action" } });
    original.status = body.action === "void" ? "voided" : "posted"; original.version! += 1; fixture.state.version += 1;
    if (actions.failAfterMutation) fixture.state.failReads.set(original.ledgerId, 500);
    const balance = calculateLedgerBalance(fixture.state.rows.filter(item => item.ledgerId === original.ledgerId), { ledgerId: original.ledgerId, memberIds: [OWNER, PARTNER] });
    return respond({ ok: true, transactionId: original.id, status: original.status, version: original.version, balance: Object.fromEntries(Object.entries(balance).map(([key, amount]) => [key, String(amount)])), ledgerVersion: fixture.state.version });
  });
  await page.route("**/api/app/v2/transactions/*/attachments", route => {
    const id = new URL(route.request().url()).pathname.split("/")[5]!;
    return route.fulfill({ json: { attachments: attachments.get(id) ?? [] } });
  });
  await page.route("**/api/app/v2/attachments", route => {
    const body = route.request().postDataJSON(); actions.attachmentRequests.push({ method: route.request().method(), path: "/api/app/v2/attachments", body });
    if (actions.attachmentFailure) return route.fulfill({ status: 500, json: { error: "fixture 收據上傳失敗" } });
    const attachment: V2Attachment = { id: "fixture-uploaded-receipt", ledgerId: body.ledgerId, transactionId: body.transactionId, mimeType: body.mimeType, sizeBytes: body.sizeBytes, status: "uploaded", createdAt: "2026-09-25T04:00:00Z", url: "https://receipt.example.invalid/uploaded.pdf" };
    attachments.set(body.transactionId, [...attachments.get(body.transactionId) ?? [], attachment]);
    return route.fulfill({ json: { attachment, signedUpload: { signedUrl: "https://fixture.supabase.co/upload" } } });
  });
  await page.route("https://fixture.supabase.co/upload", route => {
    const headers = { "access-control-allow-origin": "*", "access-control-allow-methods": "PUT, OPTIONS", "access-control-allow-headers": "content-type" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    actions.attachmentRequests.push({ method: route.request().method(), path: "signed-upload" }); return route.fulfill({ status: 200, headers, body: "" });
  });
  await page.route("**/api/app/v2/attachments/*/complete", route => { actions.attachmentRequests.push({ method: route.request().method(), path: new URL(route.request().url()).pathname }); return route.fulfill({ json: { ok: true } }); });
  await page.route("**/api/app/v2/attachments/*", route => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const path = new URL(route.request().url()).pathname, id = path.split("/")[5]!;
    actions.attachmentRequests.push({ method: "DELETE", path });
    if (actions.attachmentFailure) return route.fulfill({ status: 500, json: { error: "fixture 收據刪除失敗" } });
    for (const [transaction, items] of attachments) attachments.set(transaction, items.filter(item => item.id !== id));
    return route.fulfill({ json: { ok: true } });
  });
  return { ...fixture, actions, attachments };
}
