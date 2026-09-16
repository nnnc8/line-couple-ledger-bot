import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { Pool } from "pg";
import { Readable } from "node:stream";
import { agentChatService } from "./services";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GoogleGenAI } from "@google/genai";
import { requireLocalTestUrl } from "../../scripts/v3-0-test-db";
import { activateV2Ledger, createV2Ledger, createV2Transaction, settleAllV2Ledger, getV2LedgerBootstrap, createV2LedgerCategory, updateV2LedgerCategory, updateV2LedgerDefaultShares, createV2RecurringRule, createV2Proposal, mutateV2Transaction, createV2TransactionInputSchema } from "./v2-ledger-service";
import { proposeV2LineText } from "./v2-line-proposal";
import { dispatchV2LineInbox } from "./v2-line-inbox-dispatch";
import { claimV2LineInbox, finishV2LineInbox, releaseV2LineInboxForMaintenance, resetStaleV2LineInboxLeases } from "./v2-inbox-worker";
import type { BotDependencies } from "./line-webhook-service";

const url = requireLocalTestUrl(process.env.V3_TEST_DATABASE_URL).href;
process.env.DATABASE_URL = url;
process.env.V2_LEDGER_ENABLED = "1";
const pool = new Pool({ connectionString: url });
const owner = "11111111-1111-4111-8111-111111111111";
const partner = "22222222-2222-4222-8222-222222222222";
const outsider = "33333333-3333-4333-8333-333333333333";
const user = { id: owner, couple_id: 1, role: "owner" as const, line_user_id: "line-owner" };
let ledgerA: string;
let ledgerB: string;

function fakeDb(fail = false, onLookup?: () => Promise<void>): SupabaseClient {
  return { from() {
    const chain = {
      select() { return chain; }, eq() { return chain; }, neq() { return chain; },
      async maybeSingle() { await onLookup?.(); if (fail) throw new Error("ECONNRESET: synthetic database failure"); return { data: user, error: null }; },
      async single() { if (fail) throw new Error("ECONNRESET: synthetic database failure"); return { data: { id: partner }, error: null }; },
    };
    return chain;
  } } as unknown as SupabaseClient;
}

function dependencies(options: { databaseFailure?: boolean; replyFailure?: boolean; providerTimeout?: boolean } = {}): BotDependencies {
  return {
    supabase: fakeDb(options.databaseFailure), setupCode: "local-test-only",
    gemini: options.providerTimeout ? { models: { async generateContent() { throw new Error("ETIMEDOUT: synthetic provider timeout"); } } } as unknown as GoogleGenAI : undefined as unknown as GoogleGenAI,
    lineClient: {
      async replyMessage() { if (options.replyFailure) throw new Error("synthetic LINE reply failure"); return {} as never; },
      async getMessageContent() { throw new Error("unexpected media call"); },
      async pushMessage() { throw new Error("unexpected push call"); },
    },
  };
}

function expense(amount = "100", description = "scope test") {
  return { type: "expense", amountTwd: amount, occurredOn: "2026-09-13", description, splitMethod: "equal", payments: [{ userId: owner, amountTwd: amount }] };
}

async function count() {
  const result = await pool.query<{ count: string }>("select count(*)::text as count from ledger_v2.transactions");
  return Number(result.rows[0]!.count);
}

async function enqueue(text: string, eventId = randomUUID()) {
  const payload = { type: "message", source: { type: "user", userId: "line-owner" }, replyToken: "local-test-token", webhookEventId: eventId, timestamp: Date.parse("2026-09-13T00:00:00Z"), message: { type: "text", id: eventId, text } };
  await pool.query("insert into ledger_v2.line_inbox (channel, webhook_event_id, source_user_id, payload) values ('v3-test', $1, 'line-owner', $2::jsonb) on conflict (provider, channel, webhook_event_id) do nothing", [eventId, JSON.stringify(payload)]);
  return eventId;
}

async function inboxState(eventId: string) {
  const row = await pool.query<{ status: string; attempt_count: number; last_error: string | null }>("select status, attempt_count, last_error from ledger_v2.line_inbox where webhook_event_id = $1", [eventId]);
  return row.rows[0]!;
}

before(async () => {
  const marker = await pool.query("select baseline from public.v3_test_fixture");
  assert.equal(marker.rows[0].baseline, "dad6ffaa9bbe00308f356b78175e0ccfa617326a");
  const a = await createV2Ledger(1, owner, { name: "共同生活" }) as { ledger: { id: string } };
  const b = await createV2Ledger(1, owner, { name: "旅行" }) as { ledger: { id: string } };
  ledgerA = a.ledger.id; ledgerB = b.ledger.id;
  await activateV2Ledger(1, owner, ledgerA);
});
after(async () => { await pool.end(); });

const unsupported = [
  ["refusal", "不要記帳，晚餐 500 我付"],
  ["negation", "我沒有付晚餐 500"],
  ["multi-command", "晚餐 500 我付，飲料 60 她付"],
  ["decimal", "晚餐 500.50 我付"],
  ["foreign currency", "晚餐 USD 500 我付"],
  ["date-like integers", "2026/09/12 晚餐 500 我付"],
  ["ambiguous numbers", "晚餐 2 人 500 我付"],
  ["unsupported kind", "借款 500 我付"],
  ["missing payer", "晚餐 500"],
  ["unknown shares", "晚餐 500 我付 分攤還沒決定"],
  ["relative date", "昨天晚餐 500 我付"],
  ["refund with old payer", "我收到餐廳退款 500，這筆原本我付"],
];
for (const [name, text] of unsupported) {
  test(`F1 ${name}: zero financial write`, async () => {
    const before = await count();
    const result = await proposeV2LineText({ db: fakeDb(), user, text: text!, sourceEventId: randomUUID(), sourceEventTimestamp: Date.parse("2026-09-13T00:00:00Z"), source: "text" });
    assert.notEqual(result.kind, "posted");
    assert.equal(await count(), before);
  });
}

test("F1 supported deterministic expense, income and transfer preserve normal entry", async () => {
  for (const text of ["晚餐 500 我付", "退款 120 我收到", "我轉帳 300 給她"]) {
    const result = await proposeV2LineText({ db: fakeDb(), user, text, sourceEventId: randomUUID(), source: "text" });
    assert.equal(result.kind, "posted", text);
  }
});

test("F1 audio and AI-derived sources never inherit direct-save eligibility", async () => {
  for (const source of ["audio", "ai"] as const) {
    const before = await count();
    const result = await proposeV2LineText({ db: fakeDb(), user, text: "晚餐 500 我付", sourceEventId: randomUUID(), source });
    assert.notEqual(result.kind, "posted");
    assert.equal(await count(), before);
  }
});

test("F1 explicit Ledger must match exactly, never by substring", async () => {
  const result = await proposeV2LineText({ db: fakeDb(), user, text: "晚餐 500 我付 記在 共同", sourceEventId: randomUUID(), source: "text" });
  assert.equal(result.kind, "needs_ledger");
});

test("F4 same scope replay and concurrent duplicate have one canonical effect", async () => {
  const key = randomUUID(); const before = await count();
  const results = await Promise.all([1, 2].map(() => createV2Transaction(1, owner, ledgerA, expense(), key)));
  const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(wire(results[0]), wire(results[1]));
  assert.deepEqual(wire(await createV2Transaction(1, owner, ledgerA, expense(), key)), wire(results[0]));
  assert.equal(await count(), before + 1);
});

test("F4 same key in another Ledger must not replay the first Ledger", async () => {
  const key = randomUUID();
  await createV2Transaction(1, owner, ledgerA, expense(), key);
  const before = await count();
  const b = await createV2Transaction(1, owner, ledgerB, expense(), key) as { transaction: { ledgerId: string } };
  assert.equal(b.transaction.ledgerId, ledgerB);
  assert.equal(await count(), before + 1);
});

test("F4 conflicting payload has no effect; another operation has its own scope", async () => {
  const key = randomUUID();
  await createV2Transaction(1, owner, ledgerA, expense(), key);
  const before = await count();
  await assert.rejects(() => createV2Transaction(1, owner, ledgerA, expense("101"), key));
  assert.equal(await count(), before);
  const settled = await settleAllV2Ledger(1, owner, ledgerA, {}, key) as { settled: boolean };
  assert.equal(typeof settled.settled, "boolean");
});

test("F4 receipt replay cannot bypass actor membership", async () => {
  const key = randomUUID();
  await createV2Transaction(1, owner, ledgerA, expense(), key);
  await assert.rejects(() => createV2Transaction(1, outsider, ledgerA, expense(), key));
});

test("PG canonical insert rollback is atomic when an event insert fails", async () => {
  const before = await count();
  await pool.query("create function public.v3_fail_event() returns trigger language plpgsql as $$ begin raise exception 'synthetic event failure' using errcode = '40001'; end $$");
  await pool.query("create trigger v3_fail_event before insert on ledger_v2.transaction_events for each row execute function public.v3_fail_event()");
  try { await assert.rejects(() => createV2Transaction(1, owner, ledgerA, expense(), randomUUID()), /synthetic event failure/); }
  finally { await pool.query("drop trigger v3_fail_event on ledger_v2.transaction_events; drop function public.v3_fail_event()"); }
  assert.equal(await count(), before);
});

test("PG writer active-plane, mutation fence and maintenance prevent financial effects", async () => {
  const before = await count();
  for (const values of [["v1", false, true], ["v2", true, true], ["v2", false, false]]) {
    await pool.query("update ledger_v2.writer_control set active_plane = $1, mutation_fence = $2, financial_writes_enabled = $3 where couple_id = 1", values);
    try { await assert.rejects(() => createV2Transaction(1, owner, ledgerA, expense(), randomUUID())); }
    finally { await pool.query("update ledger_v2.writer_control set active_plane = 'v2', mutation_fence = false, financial_writes_enabled = true where couple_id = 1"); }
  }
  await assert.rejects(() => pool.query("insert into public.expenses (couple_id) values (1)"), /fenced/);
  assert.equal(await count(), before);
});

for (const [name, text, options] of [
  ["temporary DB failure", "晚餐 17 我付", { databaseFailure: true }],
  ["provider timeout", "請幫我記這筆餐費", { providerTimeout: true }],
] as const) {
  test(`F5 ${name} remains retryable`, async () => {
    const id = await enqueue(text);
    try {
      await dispatchV2LineInbox(dependencies(options), 1);
      assert.equal((await inboxState(id)).status, "failed");
    } finally { await pool.query("delete from ledger_v2.line_inbox where webhook_event_id = $1", [id]); }
  });
}

test("F5 explicit clarification is terminal without financial writes", async () => {
  const before = await count(); const id = await enqueue("晚餐 金額不確定");
  try { await dispatchV2LineInbox(dependencies(), 1); assert.equal((await inboxState(id)).status, "ignored"); }
  finally { await pool.query("delete from ledger_v2.line_inbox where webhook_event_id = $1", [id]); }
  assert.equal(await count(), before);
});

test("F5 successful accounting survives reply failure and duplicate webhook", async () => {
  const before = await count(); const id = await enqueue("午餐 71 我付");
  try {
    await dispatchV2LineInbox(dependencies({ replyFailure: true }), 1);
    assert.equal((await inboxState(id)).status, "processed");
    await enqueue("午餐 71 我付", id);
    assert.equal(await dispatchV2LineInbox(dependencies(), 1), 0);
    assert.equal(await count(), before + 1);
  } finally { await pool.query("delete from ledger_v2.line_inbox where webhook_event_id = $1", [id]); }
});

test("F5 maintenance preserves an unclaimed event and attempt budget", async () => {
  const id = await enqueue("午餐 72 我付");
  await pool.query("update ledger_v2.writer_control set financial_writes_enabled = false");
  try {
    assert.equal(await dispatchV2LineInbox(dependencies(), 1), 0);
    assert.equal((await inboxState(id)).status, "received");
    assert.equal((await inboxState(id)).attempt_count, 0);
  } finally {
    await pool.query("update ledger_v2.writer_control set financial_writes_enabled = true");
    await pool.query("delete from ledger_v2.line_inbox where webhook_event_id = $1", [id]);
  }
});


const wire = (value: unknown) => JSON.parse(JSON.stringify(value));

test("F4 canonical spelling and participant order replay the same transaction", async () => {
  const key = randomUUID();
  const input = { ...expense(), payments: [{ userId: owner, amountTwd: "70" }, { userId: partner, amountTwd: "30" }] };
  const first = await createV2Transaction(1, owner, ledgerA, input, key);
  const again = await createV2Transaction(1, owner, ledgerA, { ...input, amountTwd: 100, category: null, note: null, categoryId: null, payments: [{ userId: partner, amountTwd: 30 }, { userId: owner, amountTwd: 70 }] }, key);
  assert.deepEqual(wire(first), wire(again));
});

test("F4 historical receipts replay in place; ambiguous Ledger/actor reuse fails closed", async () => {
  const key = randomUUID(); const input = expense("86", "historical receipt");
  const result = await createV2Transaction(1, owner, ledgerA, input, key) as { transaction: { id: string } };
  const oldHash = createHash("sha256").update(JSON.stringify({ ...createV2TransactionInputSchema.parse(input), idempotencyKey: undefined })).digest("hex");
  await pool.query("update ledger_v2.command_receipts set idempotency_key = $1, request_hash = $2 where result->'transaction'->>'id' = $3", [key, oldHash, result.transaction.id]);
  const before = await count();
  assert.deepEqual(wire(await createV2Transaction(1, owner, ledgerA, input, key)), wire(result));
  await assert.rejects(() => createV2Transaction(1, owner, ledgerB, input, key), /範圍/);
  await assert.rejects(() => createV2Transaction(1, partner, ledgerA, input, key), /範圍/);
  await assert.rejects(() => settleAllV2Ledger(1, owner, ledgerA, {}, key));
  const saved = await pool.query("select request_hash from ledger_v2.command_receipts where idempotency_key = $1", [key]);
  assert.equal(saved.rows[0].request_hash, oldHash);
  assert.equal(await count(), before);
});

test("F4 every receipt-backed operation preserves authorized retry and resource scope", async () => {
  const key = randomUUID();
  const a = await createV2LedgerCategory(1, owner, ledgerA, { name: "scope-category", idempotencyKey: key }) as { category: { id: string } };
  assert.deepEqual(wire(await createV2LedgerCategory(1, owner, ledgerA, { name: "scope-category", idempotencyKey: key })), wire(a));
  const b = await createV2LedgerCategory(1, owner, ledgerB, { name: "scope-category", idempotencyKey: key }) as { category: { id: string } };
  assert.notEqual(a.category.id, b.category.id);
  const changed = await updateV2LedgerCategory(1, owner, a.category.id, { name: "renamed", idempotencyKey: key });
  assert.deepEqual(wire(await updateV2LedgerCategory(1, owner, a.category.id, { name: "renamed", idempotencyKey: key })), wire(changed));
  const changedB = await updateV2LedgerCategory(1, owner, b.category.id, { name: "renamed", idempotencyKey: key }) as { category: { id: string } };
  assert.equal(changedB.category.id, b.category.id);
  const defaults = { shares: [{ userId: owner, weight: "1" }, { userId: partner, weight: "1" }], idempotencyKey: key };
  const shares = await updateV2LedgerDefaultShares(1, owner, ledgerA, defaults);
  assert.deepEqual(wire(await updateV2LedgerDefaultShares(1, owner, ledgerA, defaults)), wire(shares));
  const rule = { name: "scope-rule", amountTwd: "22", frequency: "monthly", nextRunDate: "2026-10-01", splitMethod: "equal", payments: [{ userId: owner, amountTwd: "22" }], idempotencyKey: key };
  const recurring = await createV2RecurringRule(1, owner, ledgerA, rule);
  assert.deepEqual(wire(await createV2RecurringRule(1, owner, ledgerA, rule)), wire(recurring));
  const proposal = { ledgerId: ledgerA, commands: [expense()] };
  const draft = await createV2Proposal(1, owner, proposal, key);
  assert.deepEqual(wire(await createV2Proposal(1, owner, proposal, key)), wire(draft));
  const ledger = await createV2Ledger(1, owner, { name: "receipt-created", idempotencyKey: key });
  assert.deepEqual(wire(await createV2Ledger(1, owner, { name: "receipt-created", idempotencyKey: key })), wire(ledger));
  const transaction = await createV2Transaction(1, owner, ledgerA, expense(), key) as { transaction: { id: string } };
  const voidInput = { action: "void", expectedVersion: 1, idempotencyKey: key };
  const voided = await mutateV2Transaction(1, owner, transaction.transaction.id, voidInput);
  assert.deepEqual(wire(await mutateV2Transaction(1, owner, transaction.transaction.id, voidInput)), wire(voided));
  const restored = await mutateV2Transaction(1, owner, transaction.transaction.id, { action: "restore", expectedVersion: 2, idempotencyKey: key });
  assert.deepEqual(wire(await mutateV2Transaction(1, owner, transaction.transaction.id, { action: "restore", expectedVersion: 2, idempotencyKey: key })), wire(restored));
  const replace = { action: "replace", expectedVersion: 3, replacement: expense("103", "replacement"), idempotencyKey: key };
  const replaced = await mutateV2Transaction(1, owner, transaction.transaction.id, replace);
  assert.deepEqual(wire(await mutateV2Transaction(1, owner, transaction.transaction.id, replace)), wire(replaced));
  for (const operation of [
    () => createV2LedgerCategory(1, outsider, ledgerA, { name: "scope-category", idempotencyKey: key }),
    () => updateV2LedgerCategory(1, outsider, a.category.id, { name: "renamed", idempotencyKey: key }),
    () => updateV2LedgerDefaultShares(1, outsider, ledgerA, defaults),
    () => createV2RecurringRule(1, outsider, ledgerA, rule),
    () => createV2Proposal(1, outsider, proposal, key),
    () => createV2Ledger(1, outsider, { name: "receipt-created", idempotencyKey: key }),
    () => mutateV2Transaction(1, outsider, transaction.transaction.id, replace),
  ]) await assert.rejects(operation);
});

test("F5 malformed input is a permanent business failure without a provider or write", async () => {
  const id = await enqueue("malformed"); const before = await count();
  await pool.query("update ledger_v2.line_inbox set payload = jsonb_set(payload, '{message,text}', '42'::jsonb) where webhook_event_id = $1", [id]);
  try {
    await dispatchV2LineInbox(dependencies(), 1);
    assert.equal((await inboxState(id)).status, "dead_letter");
    assert.equal((await inboxState(id)).last_error, "malformed LINE event");
    assert.equal(await count(), before);
  } finally { await pool.query("delete from ledger_v2.line_inbox where webhook_event_id = $1", [id]); }
});

test("PG inbox claim token prevents an old worker from overwriting a new lease", async () => {
  const id = await enqueue("晚餐 金額不確定");
  try {
    const [first] = await claimV2LineInbox(1); assert(first);
    assert.equal((await claimV2LineInbox(1)).length, 0);
    await pool.query("update ledger_v2.line_inbox set lease_until = now() - interval '1 second' where webhook_event_id = $1", [id]);
    assert.equal(await resetStaleV2LineInboxLeases(), 1);
    const [second] = await claimV2LineInbox(1); assert(second);
    assert.equal((await inboxState(id)).attempt_count, 2);
    // Invoke both baseline (id) and current (claim) APIs to reproduce the same
    // stale-worker overwrite at the database boundary.
    const oldClaim = "lease_token" in first ? first : (first as { id: number }).id as unknown as typeof first;
    await finishV2LineInbox(oldClaim, "processed");
    assert.equal((await inboxState(id)).status, "processing");
    await releaseV2LineInboxForMaintenance(oldClaim);
    assert.equal((await inboxState(id)).status, "processing");
    assert.equal(await releaseV2LineInboxForMaintenance(second), true);
    assert.equal((await inboxState(id)).status, "received");
    assert.equal((await inboxState(id)).attempt_count, first.attempt_count);
    const [third] = await claimV2LineInbox(1); assert(third);
    assert.equal(await finishV2LineInbox(third, "ignored"), true);
    assert.equal((await inboxState(id)).status, "ignored");
  } finally { await pool.query("delete from ledger_v2.line_inbox where webhook_event_id = $1", [id]); }
});

test("PG all canonical transactions retain payment/share totals and independent zero-sum balances", async () => {
  const invalid = await pool.query(`select t.id from ledger_v2.transactions t
    where t.amount_twd <> (select coalesce(sum(p.amount_twd),0) from ledger_v2.transaction_payments p where p.transaction_id=t.id)
       or t.amount_twd <> (select coalesce(sum(s.amount_twd),0) from ledger_v2.transaction_shares s where s.transaction_id=t.id)`);
  assert.equal(invalid.rowCount, 0);
  const couples = await pool.query("select couple_id from public.users group by couple_id having count(*) <> 2");
  assert.equal(couples.rowCount, 0);
});


test("F1 real audio dispatch preserves the STT source and creates only a proposal", async () => {
  const before = await count(); const id = await enqueue("audio");
  const original = agentChatService.transcribeAudio;
  agentChatService.transcribeAudio = async () => "晚餐 81 我付 記在 共同生活";
  const deps = dependencies();
  deps.lineClient.getMessageContent = async () => Readable.from([Buffer.from("synthetic audio")]);
  await pool.query("update ledger_v2.line_inbox set payload = jsonb_set(payload, '{message,type}', '\"audio\"'::jsonb) where webhook_event_id = $1", [id]);
  try {
    assert.equal(await dispatchV2LineInbox(deps, 1), 1);
    assert.equal((await inboxState(id)).status, "processed");
    assert.equal(await count(), before);
  } finally {
    agentChatService.transcribeAudio = original;
    await pool.query("delete from ledger_v2.line_inbox where webhook_event_id = $1", [id]);
  }
});

test("F1 AI-generated candidate output creates a proposal, never a canonical transaction", async () => {
  const before = await count();
  const gemini = { models: { async generateContent() { return { text: JSON.stringify({ version: 1, commands: [{ kind: "expense", amountTwd: 17, payer: "self", description: "晚餐", ledgerName: "共同生活" }] }) }; } } } as unknown as GoogleGenAI;
  const result = await proposeV2LineText({ db: fakeDb(), user, text: "請幫我記這筆餐費", sourceEventId: randomUUID(), source: "text", gemini });
  assert.equal(result.kind, "created");
  assert.equal(await count(), before);
});

test("F5 temporary DB failure recovers to exactly one canonical effect", async () => {
  const before = await count(); const id = await enqueue("晚餐 82 我付 記在 共同生活");
  try {
    await dispatchV2LineInbox(dependencies({ databaseFailure: true }), 1);
    assert.equal((await inboxState(id)).status, "failed");
    assert.equal(await count(), before);
    await pool.query("update ledger_v2.line_inbox set next_attempt_at = now() where webhook_event_id = $1", [id]);
    assert.equal(await dispatchV2LineInbox(dependencies(), 1), 1);
    assert.equal((await inboxState(id)).status, "processed");
    assert.equal((await inboxState(id)).attempt_count, 2);
    assert.equal(await count(), before + 1);
    assert.equal(await dispatchV2LineInbox(dependencies(), 1), 0);
  } finally { await pool.query("delete from ledger_v2.line_inbox where webhook_event_id = $1", [id]); }
});

test("F5 freeze racing a claim releases the lease without consuming an attempt", async () => {
  const before = await count(); const id = await enqueue("晚餐 83 我付 記在 共同生活");
  const deps = dependencies();
  deps.supabase = fakeDb(false, async () => { await pool.query("update ledger_v2.writer_control set financial_writes_enabled = false where couple_id = 1"); });
  try {
    assert.equal(await dispatchV2LineInbox(deps, 1), 0);
    assert.equal((await inboxState(id)).status, "received");
    assert.equal((await inboxState(id)).attempt_count, 0);
    assert.equal(await count(), before);
    await pool.query("update ledger_v2.writer_control set financial_writes_enabled = true where couple_id = 1");
    assert.equal(await dispatchV2LineInbox(dependencies(), 1), 1);
    assert.equal(await count(), before + 1);
  } finally {
    await pool.query("update ledger_v2.writer_control set financial_writes_enabled = true where couple_id = 1");
    await pool.query("delete from ledger_v2.line_inbox where webhook_event_id = $1", [id]);
  }
});

test("F4 LINE event identity cannot create a second effect after its active Ledger changes", async () => {
  const before = await count(); const sourceEventId = randomUUID();
  await activateV2Ledger(1, owner, ledgerA);
  const args = { db: fakeDb(), user, text: "晚餐 84 我付", sourceEventId, source: "text" as const };
  assert.equal((await proposeV2LineText(args)).kind, "posted");
  await activateV2Ledger(1, owner, ledgerB);
  await assert.rejects(() => proposeV2LineText(args), /範圍/);
  assert.equal(await count(), before + 1);
});

test("PG Ledger balances are independent and remain zero-sum after a canonical write", async () => {
  const beforeB = (await getV2LedgerBootstrap(1, ledgerB)).balance;
  await createV2Transaction(1, owner, ledgerA, expense("127", "independent Ledger proof"), randomUUID());
  const afterA = (await getV2LedgerBootstrap(1, ledgerA)).balance;
  const afterB = (await getV2LedgerBootstrap(1, ledgerB)).balance;
  assert.deepEqual(afterB, beforeB);
  for (const balance of [afterA, afterB]) assert.equal(Object.values(balance).reduce((sum, value) => sum + BigInt(value), 0n), 0n);
});


test("F5 commit-before-ack replay remains processed after the active Ledger changes", async () => {
  await activateV2Ledger(1, owner, ledgerA);
  const before = await count(); const id = await enqueue("晚餐 85 我付");
  try {
    assert.equal(await dispatchV2LineInbox(dependencies(), 1), 1);
    assert.equal(await count(), before + 1);
    // Recreate a worker crash after canonical commit but before its inbox ack.
    await pool.query("update ledger_v2.line_inbox set status = 'processing', processed_at = null, lease_until = now() - interval '1 second' where webhook_event_id = $1", [id]);
    await activateV2Ledger(1, owner, ledgerB);
    assert.equal(await dispatchV2LineInbox(dependencies(), 1), 1);
    assert.equal((await inboxState(id)).status, "processed");
    assert.equal(await count(), before + 1);
  } finally { await pool.query("delete from ledger_v2.line_inbox where webhook_event_id = $1", [id]); }
});
