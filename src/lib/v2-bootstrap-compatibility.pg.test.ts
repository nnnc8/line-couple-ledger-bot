/**
 * Opt-in PostgreSQL proof for the incident bootstrap deployment.
 *
 * The target must contain only the two production V2 migrations plus the
 * standalone incident-freeze migration. It must be local; a remote URL is a
 * hard failure rather than an accidental production test.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { webhook } from "@line/bot-sdk";
import { Pool } from "pg";
import test, { after, before } from "node:test";

import {
  createV2Ledger,
  createV2Proposal,
  createV2RecurringRule,
  createV2Transaction,
  getV2LedgerBootstrap,
  listV2LedgerTransactions,
  listV2UserLedgers,
  runDueV2RecurringRules,
  toggleV2RecurringRule,
  confirmV2Proposal,
  mutateV2Transaction,
} from "./v2-ledger-service";
import { handleLineEvent } from "./line-webhook-service";
import { dispatchV2LineInbox } from "./v2-line-inbox-dispatch";
import { V2_FINANCIAL_MAINTENANCE_MESSAGE, V2IncidentFreezeError } from "./v2-incident-freeze";
import { getBuildVersion } from "./version";

const databaseUrl = process.env.V2_BOOTSTRAP_TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
if (databaseUrl) {
  const hostname = new URL(databaseUrl).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error("V2_BOOTSTRAP_TEST_DATABASE_URL must point to localhost");
  }
}
if (!enabled) {
  console.warn("[v2-bootstrap-compatibility.pg.test.ts] SKIPPED — set V2_BOOTSTRAP_TEST_DATABASE_URL");
}

const coupleId = Number(process.env.V2_BOOTSTRAP_TEST_COUPLE_ID ?? "1");
const testKey = `bootstrap:${randomUUID()}`;
let ownerId = "";
let partnerId = "";
let pool: Pool | null = null;
let ledgerId: string | null = null;
let proposalId: string | null = null;
let recurringId: string | null = null;
let inboxId: number | null = null;

function dbPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: databaseUrl });
  return pool;
}

async function query<T extends object = Record<string, unknown>>(text: string, values: unknown[] = []) {
  return dbPool().query<T>(text, values);
}

function expense(description: string, amountTwd: number) {
  return {
    type: "expense" as const,
    amountTwd,
    occurredOn: "2026-08-14",
    description,
    category: "測試",
    splitMethod: "equal" as const,
    payments: [{ userId: ownerId, amountTwd }],
  };
}

before(async () => {
  if (!enabled) return;
  process.env.DATABASE_URL = databaseUrl;
  process.env.V2_LEDGER_ENABLED = "1";
  process.env.V2_LINE_INBOX_ENABLED = "1";
  process.env.V2_INCIDENT_BOOTSTRAP_ONLY = "1";
  const members = await query<{ id: string; role: "owner" | "partner" }>(
    `select id, role
       from public.users
      where couple_id = $1
      order by case role when 'owner' then 0 else 1 end`,
    [coupleId],
  );
  assert.equal(members.rows.length, 2);
  ownerId = members.rows.find((member) => member.role === "owner")?.id ?? "";
  partnerId = members.rows.find((member) => member.role === "partner")?.id ?? "";
  assert.ok(ownerId);
  assert.ok(partnerId);
  const unexpected = await query<{ name: string }>(
    `select name from (values
       ('ledger_v2.categories'),
       ('ledger_v2.transactions.category_id'),
       ('ledger_v2.transactions.replaces_transaction_id'),
       ('ledger_v2.recurring_rules.category_id'),
       ('ledger_v2.line_inbox.max_attempts'),
       ('ledger_v2.notification_outbox.max_attempts')
     ) as expected(name)
     where case
       when name = 'ledger_v2.categories' then to_regclass(name) is not null
       when name like '%.%' then split_part(name, '.', 3) in (
         select column_name from information_schema.columns
          where table_schema = split_part(expected.name, '.', 1)
            and table_name = split_part(expected.name, '.', 2)
       )
       else false
     end`,
  );
  assert.deepEqual(unexpected.rows, []);
  const freeze = await query<{ active_plane: string; mutation_fence: boolean; financial_writes_enabled: boolean }>(
    `select active_plane, mutation_fence, financial_writes_enabled
       from ledger_v2.writer_control where couple_id = $1`,
    [coupleId],
  );
  assert.deepEqual(freeze.rows[0], { active_plane: "v2", mutation_fence: false, financial_writes_enabled: true });
});

after(async () => {
  if (!enabled || !pool) return;
  await query("update ledger_v2.writer_control set financial_writes_enabled = true where couple_id = $1", [coupleId]);
  if (inboxId !== null) await query("delete from ledger_v2.line_inbox where id = $1", [inboxId]);
  if (recurringId) await query("delete from ledger_v2.recurring_rules where id = $1", [recurringId]);
  if (proposalId) await query("delete from ledger_v2.proposals where id = $1", [proposalId]);
  if (ledgerId) {
    await query("delete from ledger_v2.notification_outbox where payload->>'ledgerId' = $1", [ledgerId]);
    await query("delete from ledger_v2.command_receipts where ledger_id = $1", [ledgerId]);
    await query("delete from ledger_v2.transaction_events where ledger_id = $1", [ledgerId]);
    await query("delete from ledger_v2.transactions where ledger_id = $1", [ledgerId]);
    await query("delete from ledger_v2.ledgers where id = $1", [ledgerId]);
  }
  await pool.end();
  pool = null;
});

test("current production schema supports bootstrap reads, safe writes, freeze, and version boundary", { skip: !enabled }, async () => {
  const createdLedger = await createV2Ledger(coupleId, ownerId, { name: `Bootstrap ${testKey.slice(-8)}`, idempotencyKey: `${testKey}:ledger` }) as { ledger: { id: string } };
  ledgerId = createdLedger.ledger.id;

  const listed = await listV2UserLedgers(coupleId, ownerId);
  assert.equal(listed.some((ledger) => ledger.id === ledgerId), true);
  const read = await getV2LedgerBootstrap(coupleId, ledgerId);
  assert.equal(read.ledger.members.length, 2);
  assert.deepEqual(read.balance, { [ownerId]: "0", [partnerId]: "0" });

  const written = await createV2Transaction(coupleId, ownerId, ledgerId, expense("bootstrap write", 100), `${testKey}:transaction`) as { transaction: { id: string } };
  assert.ok(written.transaction.id);
  const history = await listV2LedgerTransactions(coupleId, ownerId, ledgerId, { limit: 10 });
  assert.equal(history.transactions.some((transaction) => transaction.description === "bootstrap write"), true);

  const proposal = await createV2Proposal(coupleId, ownerId, {
    ledgerId,
    commands: [expense("bootstrap proposal", 20)],
  }, `${testKey}:proposal`) as { proposalId: string };
  proposalId = proposal.proposalId;
  const recurring = await createV2RecurringRule(coupleId, ownerId, ledgerId, {
    name: "bootstrap recurring",
    amountTwd: 30,
    frequency: "monthly",
    nextRunDate: "2026-08-14",
    splitMethod: "equal",
    payments: [{ userId: ownerId, amountTwd: 30 }],
  }) as { recurring: { id: string } };
  recurringId = recurring.recurring.id;

  await query("update ledger_v2.writer_control set financial_writes_enabled = false where couple_id = $1", [coupleId]);
  await assert.rejects(
    () => createV2Transaction(coupleId, ownerId, ledgerId!, expense("blocked", 1), `${testKey}:blocked`),
    (error: unknown) => error instanceof V2IncidentFreezeError && error.status === 503 && error.message === V2_FINANCIAL_MAINTENANCE_MESSAGE,
  );
  await assert.rejects(
    () => mutateV2Transaction(coupleId, ownerId, written.transaction.id, { action: "replace", expectedVersion: 1, replacement: expense("unsafe replace", 2) }),
    V2IncidentFreezeError,
  );
  await assert.rejects(() => confirmV2Proposal(coupleId, ownerId, proposalId!), V2IncidentFreezeError);
  await assert.rejects(() => toggleV2RecurringRule(coupleId, ownerId, recurringId!, { active: false }), V2IncidentFreezeError);
  assert.equal(await runDueV2RecurringRules("2026-08-14"), 0);

  const beforeLineTransactions = await query<{ count: string }>(
    "select count(*)::text as count from ledger_v2.transactions where ledger_id = $1",
    [ledgerId],
  );
  const lineEvent = {
    type: "message",
    webhookEventId: `${testKey}:deterministic-line`,
    timestamp: Date.now(),
    replyToken: `${testKey}:reply`,
    source: { type: "user", userId: `line-${ownerId}` },
    message: { type: "text", id: `${testKey}:message`, text: "晚餐 1 我付" },
  } as unknown as webhook.Event;
  const lineSupabase = {
    from(table: string) {
      assert.equal(table, "users");
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          return {
            data: {
              id: ownerId,
              couple_id: coupleId,
              role: "owner",
              line_user_id: `line-${ownerId}`,
            },
            error: null,
          };
        },
      };
    },
  } as never;
  await assert.rejects(
    () => handleLineEvent(lineEvent, {
      lineClient: {
        replyMessage: async () => undefined as never,
        getMessageContent: async () => undefined as never,
        pushMessage: async () => undefined as never,
      } as never,
      supabase: lineSupabase,
      gemini: undefined as never,
      setupCode: "bootstrap-test",
    }),
    (error: unknown) => error instanceof V2IncidentFreezeError && error.status === 503,
  );
  const afterLineTransactions = await query<{ count: string }>(
    "select count(*)::text as count from ledger_v2.transactions where ledger_id = $1",
    [ledgerId],
  );
  assert.equal(afterLineTransactions.rows[0]?.count, beforeLineTransactions.rows[0]?.count);

  const inbox = await query<{ id: number }>(
    `insert into ledger_v2.line_inbox (channel, webhook_event_id, source_user_id, payload)
     values ('bootstrap-test', $1, $2, $3::jsonb) returning id`,
    [`${testKey}:line`, `line-${ownerId}`, JSON.stringify({ type: "message", text: "晚餐 1 我付" })],
  );
  inboxId = inbox.rows[0]!.id;
  assert.equal(await dispatchV2LineInbox(undefined as never, 1), 0);
  assert.deepEqual(
    (await query<{ status: string; attempt_count: number }>("select status, attempt_count from ledger_v2.line_inbox where id = $1", [inboxId])).rows[0],
    { status: "received", attempt_count: 0 },
  );

  const frozenRead = await getV2LedgerBootstrap(coupleId, ledgerId);
  assert.equal(frozenRead.transactions.some((transaction) => transaction.description === "bootstrap write"), true);
  assert.deepEqual(getBuildVersion({ VERCEL_GIT_COMMIT_SHA: "bootstrap-test-sha", VERCEL_ENV: "production", BUILD_TIMESTAMP: "2026-08-14T00:00:00.000Z" }), {
    commitSha: "bootstrap-test-sha",
    environment: "production",
    buildTimestamp: "2026-08-14T00:00:00.000Z",
  });
});
