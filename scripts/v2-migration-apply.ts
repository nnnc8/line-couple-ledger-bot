import { existsSync } from "node:fs";
import { Pool, type PoolClient } from "pg";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
if (existsSync(".env")) process.loadEnvFile(".env");

import {
  buildV2MigrationPlan,
  migrationPlanDigest,
  type LegacySnapshot,
  type V2MigrationLedger,
  type V2MigrationMapEntry,
  type V2MigrationTransaction,
} from "../src/lib/v2-migration";
import { loadV2LegacySnapshot } from "../src/lib/v2-migration-db";

const coupleId = Number(process.env.V2_COUPLE_ID ?? "1");
const shouldApply = process.argv.includes("--apply");
const DEFAULT_CATEGORY_NAMES = ["餐飲", "交通", "居家", "旅遊", "娛樂", "購物", "醫療", "其他"];

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function jsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonValue(item)]),
  );
}

function normalizedTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function assertApplyGate(): void {
  if (!shouldApply || process.env.V2_MIGRATION_APPLY !== "1") {
    throw new Error("refusing to write: pass --apply and set V2_MIGRATION_APPLY=1");
  }
  if (!Number.isInteger(coupleId) || coupleId <= 0) throw new Error("V2_COUPLE_ID must be a positive integer");
}

async function loadSnapshot(client: PoolClient): Promise<LegacySnapshot> {
  return loadV2LegacySnapshot(client, coupleId);
}

async function assertWriterControl(client: PoolClient): Promise<void> {
  const result = await client.query<{ active_plane: string; mutation_fence: boolean }>(
    `select active_plane, mutation_fence
       from ledger_v2.writer_control
      where couple_id = $1
      for update`,
    [coupleId],
  );
  const control = result.rows[0];
  if (!control) throw new Error("writer_control row is missing; apply the shadow migration first");
  if (control.active_plane !== "v1" || control.mutation_fence) {
    throw new Error("migration requires active V1 writer with no V2 mutation fence");
  }
}

async function ensureLedger(client: PoolClient, ledger: V2MigrationLedger): Promise<void> {
  const existing = await client.query<{ couple_id: number; name: string; color: string; status: string }>(
    `select couple_id, name, color, status from ledger_v2.ledgers where id = $1 for update`,
    [ledger.id],
  );
  const expectedStatus = ledger.archived ? "archived" : "active";
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.couple_id !== ledger.coupleId || row.name !== ledger.name || row.color !== ledger.color || row.status !== expectedStatus) {
      throw new Error(`ledger ${ledger.id} already exists with a different identity`);
    }
  } else {
    await client.query(
      `insert into ledger_v2.ledgers
        (id, couple_id, name, color, status, created_by_user_id, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())`,
      [ledger.id, ledger.coupleId, ledger.name, ledger.color, ledger.archived ? "archived" : "active", ledger.createdByUserId, ledger.createdAt],
    );
  }
  for (const userId of ledger.memberIds) {
    await client.query(
      `insert into ledger_v2.ledger_members (ledger_id, couple_id, user_id)
       values ($1, $2, $3) on conflict (ledger_id, user_id) do nothing`,
      [ledger.id, ledger.coupleId, userId],
    );
    await client.query(
      `insert into ledger_v2.ledger_default_shares (ledger_id, couple_id, user_id, weight)
       values ($1, $2, $3, $4) on conflict (ledger_id, user_id) do nothing`,
      [ledger.id, ledger.coupleId, userId, ledger.defaultWeights[ledger.memberIds.indexOf(userId)]!.toString()],
    );
  }
  for (const name of DEFAULT_CATEGORY_NAMES) {
    await client.query(
      `insert into ledger_v2.categories (couple_id, ledger_id, name, is_default)
       values ($1, $2, $3, true)
       on conflict (ledger_id, couple_id, name) do nothing`,
      [ledger.coupleId, ledger.id, name],
    );
  }
  const members = await client.query<{ user_id: string }>(
    `select user_id from ledger_v2.ledger_members where ledger_id = $1 order by user_id`,
    [ledger.id],
  );
  const actualMemberIds = members.rows.map((row) => row.user_id).sort();
  const expectedMemberIds = [...ledger.memberIds].sort();
  if (actualMemberIds.length !== 2 || JSON.stringify(actualMemberIds) !== JSON.stringify(expectedMemberIds)) {
    throw new Error(`ledger ${ledger.id} members differ from the deterministic migration plan`);
  }
  const defaults = await client.query<{ user_id: string; weight: string | number }>(
    `select user_id, weight from ledger_v2.ledger_default_shares where ledger_id = $1 order by user_id`,
    [ledger.id],
  );
  const actualDefaults = defaults.rows.map((row) => `${row.user_id}:${row.weight}`).sort();
  const expectedDefaults = ledger.memberIds.map((userId, index) => `${userId}:${ledger.defaultWeights[index]!.toString()}`).sort();
  if (JSON.stringify(actualDefaults) !== JSON.stringify(expectedDefaults)) {
    throw new Error(`ledger ${ledger.id} defaults differ from the deterministic migration plan`);
  }
}

async function ensureTransaction(client: PoolClient, transaction: V2MigrationTransaction): Promise<void> {
  const actor = await client.query<{ id: string }>(
    `select id from public.users where id = $1 and couple_id = $2`,
    [transaction.createdByUserId, coupleId],
  );
  const actorUserId = actor.rows[0]?.id;
  if (!actorUserId) throw new Error(`transaction ${transaction.id} has no valid source actor`);
  const existing = await client.query<{
    couple_id: number;
    ledger_id: string;
    type: string;
    amount_twd: string | number;
    occurred_on: string;
    description: string;
    category: string | null;
    category_id: string | null;
    note: string | null;
    split_method: string;
    status: string;
    version: number;
    voided_at: string | null;
    created_at: string;
    source_table: string | null;
    source_id: string | null;
  }>(
    `select couple_id, ledger_id, type, amount_twd, occurred_on, description,
            category, category_id, note, split_method, status, version, voided_at, created_at,
            source_table, source_id
       from ledger_v2.transactions where id = $1 for update`,
    [transaction.id],
  );
  let inserted = false;
  if (existing.rows[0]) {
    const row = existing.rows[0];
    const categoryId = transaction.category
      ? (await client.query<{ id: string }>(
          `select id
             from ledger_v2.categories
            where couple_id = $1 and ledger_id = $2 and name = $3`,
          [coupleId, transaction.ledgerId, transaction.category],
        )).rows[0]?.id ?? null
      : null;
    if (
      row.couple_id !== coupleId ||
      row.ledger_id !== transaction.ledgerId ||
      row.type !== transaction.type ||
      BigInt(row.amount_twd) !== transaction.amountTwd ||
      row.occurred_on !== transaction.occurredOn ||
      row.description !== transaction.description ||
      row.category !== transaction.category ||
      row.category_id !== categoryId ||
      row.note !== transaction.note ||
      row.split_method !== transaction.splitMethod ||
      row.status !== transaction.status ||
      row.version !== transaction.version ||
      normalizedTimestamp(row.voided_at) !== normalizedTimestamp(transaction.voidedAt) ||
      row.source_table !== transaction.sourceTable ||
      row.source_id !== transaction.sourceId
    ) {
      throw new Error(`transaction ${transaction.id} already exists with a different source identity`);
    }
    const existingPayments = await client.query<{ user_id: string; amount_twd: string | number }>(
      `select user_id, amount_twd from ledger_v2.transaction_payments where transaction_id = $1 order by user_id`,
      [transaction.id],
    );
    const existingShares = await client.query<{ user_id: string; amount_twd: string | number }>(
      `select user_id, amount_twd from ledger_v2.transaction_shares where transaction_id = $1 order by user_id`,
      [transaction.id],
    );
    const priorPayments = existingPayments.rows.map((row) => `${row.user_id}:${row.amount_twd}`).sort();
    const priorShares = existingShares.rows.map((row) => `${row.user_id}:${row.amount_twd}`).sort();
    const plannedPayments = transaction.payments.map((row) => `${row.userId}:${row.amountTwd}`).sort();
    const plannedShares = transaction.shares.map((row) => `${row.userId}:${row.amountTwd}`).sort();
    if (JSON.stringify(priorPayments) !== JSON.stringify(plannedPayments) || JSON.stringify(priorShares) !== JSON.stringify(plannedShares)) {
      throw new Error(`transaction ${transaction.id} already exists with different child rows`);
    }
    return;
  } else {
    const categoryId = transaction.category
      ? (await client.query<{ id: string }>(
          `select id
             from ledger_v2.categories
            where couple_id = $1 and ledger_id = $2 and name = $3`,
          [coupleId, transaction.ledgerId, transaction.category],
        )).rows[0]?.id ?? null
      : null;
    await client.query(
      `insert into ledger_v2.transactions
        (id, couple_id, ledger_id, type, amount_twd, occurred_on, description,
         category, category_id, note, split_method, status, version, created_by_user_id,
         idempotency_key, legacy_group_id, source_table, source_id, voided_at,
         created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16, $17, $18, $19, $20, now())`,
      [
        transaction.id,
        coupleId,
        transaction.ledgerId,
        transaction.type,
        transaction.amountTwd.toString(),
        transaction.occurredOn,
        transaction.description,
        transaction.category,
        categoryId,
        transaction.note,
        transaction.splitMethod,
        transaction.status,
        transaction.version,
        transaction.createdByUserId,
        `migration:${transaction.sourceTable}:${transaction.sourceId}`.slice(0, 100),
        transaction.legacyGroupId,
        transaction.sourceTable,
        transaction.sourceId,
        transaction.voidedAt,
        transaction.createdAt,
      ],
    );
    inserted = true;
  }
  for (const payment of transaction.payments) {
    await client.query(
      `insert into ledger_v2.transaction_payments
        (transaction_id, ledger_id, couple_id, user_id, amount_twd)
       values ($1, $2, $3, $4, $5)
       on conflict (transaction_id, user_id) do nothing`,
      [transaction.id, transaction.ledgerId, coupleId, payment.userId, payment.amountTwd.toString()],
    );
  }
  for (const share of transaction.shares) {
    await client.query(
      `insert into ledger_v2.transaction_shares
        (transaction_id, ledger_id, couple_id, user_id, amount_twd)
       values ($1, $2, $3, $4, $5)
       on conflict (transaction_id, user_id) do nothing`,
      [transaction.id, transaction.ledgerId, coupleId, share.userId, share.amountTwd.toString()],
    );
  }
  const [payments, shares] = await Promise.all([
    client.query<{ user_id: string; amount_twd: string | number }>(
      `select user_id, amount_twd from ledger_v2.transaction_payments where transaction_id = $1 order by user_id`,
      [transaction.id],
    ),
    client.query<{ user_id: string; amount_twd: string | number }>(
      `select user_id, amount_twd from ledger_v2.transaction_shares where transaction_id = $1 order by user_id`,
      [transaction.id],
    ),
  ]);
  const expectedPayments = transaction.payments.map((row) => `${row.userId}:${row.amountTwd}`).sort();
  const expectedShares = transaction.shares.map((row) => `${row.userId}:${row.amountTwd}`).sort();
  const actualPayments = payments.rows.map((row) => `${row.user_id}:${row.amount_twd}`).sort();
  const actualShares = shares.rows.map((row) => `${row.user_id}:${row.amount_twd}`).sort();
  if (JSON.stringify(actualPayments) !== JSON.stringify(expectedPayments) || JSON.stringify(actualShares) !== JSON.stringify(expectedShares)) {
    throw new Error(`transaction ${transaction.id} child rows do not match the deterministic plan`);
  }
  if (inserted) {
    await client.query(
      `insert into ledger_v2.transaction_events
        (couple_id, ledger_id, transaction_id, actor_user_id, action, after_state)
       values ($1, $2, $3, $4, 'create', $5::jsonb)`,
      [coupleId, transaction.ledgerId, transaction.id, actorUserId, JSON.stringify(jsonValue(transaction))],
    );
  }
}

async function recordMapping(client: PoolClient, batchId: string, mapping: V2MigrationMapEntry): Promise<void> {
  const existing = await client.query<{ batch_id: string; source_row_hash: string }>(
    `select batch_id, source_row_hash
       from ledger_v2.migration_map
      where source_table = $1 and source_id = $2`,
    [mapping.sourceTable, mapping.sourceId],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].source_row_hash !== mapping.sourceRowHash) {
      throw new Error(`${mapping.sourceTable}/${mapping.sourceId} changed after an earlier migration batch`);
    }
    return;
  }
  await client.query(
    `insert into ledger_v2.migration_map
      (batch_id, source_table, source_id, source_group_id, ledger_id, transaction_id, mapping_kind, source_row_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [batchId, mapping.sourceTable, mapping.sourceId, mapping.sourceGroupId, mapping.ledgerId, mapping.transactionId, mapping.mappingKind, mapping.sourceRowHash],
  );
}

function assertReconciled(plan: ReturnType<typeof buildV2MigrationPlan>): void {
  if (plan.quarantine.length > 0) throw new Error(`migration plan has ${plan.quarantine.length} quarantined rows`);
  for (const summary of plan.summaries) {
    for (const userId of summary.ledgerId ? Object.keys(summary.oldBalance) : []) {
      if (summary.oldBalance[userId] !== summary.v2Balance[userId]) {
        throw new Error(`balance reconciliation failed for ledger ${summary.ledgerId}, user ${userId}`);
      }
    }
  }
}

async function main(): Promise<void> {
  assertApplyGate();
  const pool = new Pool({
    connectionString: requiredEnv("DATABASE_URL"),
    ssl: process.env.DATABASE_URL?.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("lock table public.groups, public.expenses, public.expense_splits, public.settlements in share mode");
    await assertWriterControl(client);
    const snapshot = await loadSnapshot(client);
    const plan = buildV2MigrationPlan(snapshot);
    assertReconciled(plan);
    const digest = migrationPlanDigest(plan);
    const batchKey = process.env.V2_MIGRATION_BATCH_KEY ?? `v2:${coupleId}:${digest}`;
    const existing = await client.query<{ id: string; status: string; summary: unknown }>(
      `select id, status, summary from ledger_v2.migration_batches where batch_key = $1 for update`,
      [batchKey],
    );
    if (existing.rows[0]?.status === "verified") {
      await client.query("COMMIT");
      console.log(JSON.stringify({ batchKey, digest, status: "already_verified" }, null, 2));
      return;
    }
    if (existing.rows[0]) throw new Error(`migration batch ${batchKey} already exists with status ${existing.rows[0].status}`);
    const batch = await client.query<{ id: string }>(
      `insert into ledger_v2.migration_batches
        (batch_key, status, source_high_watermark, started_at)
       values ($1, 'running', clock_timestamp(), clock_timestamp())
       returning id`,
      [batchKey],
    );
    const batchId = batch.rows[0]!.id;
    for (const ledger of plan.ledgers) await ensureLedger(client, ledger);
    for (const transaction of plan.transactions) await ensureTransaction(client, transaction);
    for (const mapping of plan.mappings) await recordMapping(client, batchId, mapping);
    for (const quarantine of plan.quarantine) {
      await client.query(
        `insert into ledger_v2.migration_quarantine
          (batch_id, source_table, source_id, reason, payload)
         values ($1, $2, $3, $4, $5::jsonb)`,
        [batchId, quarantine.sourceTable, quarantine.sourceId, quarantine.reason, JSON.stringify(jsonValue(quarantine.payload))],
      );
    }
    const summary = {
      digest,
      coupleId,
      ledgers: plan.ledgers.length,
      transactions: plan.transactions.length,
      quarantine: plan.quarantine.length,
      excludedMirrors: plan.excludedMirrorExpenseIds.length,
      excludedPrivate: plan.excludedPrivateExpenseIds.length,
      reconciliations: jsonValue(plan.summaries),
    };
    await client.query(
      `update ledger_v2.migration_batches
          set status = 'verified', summary = $2::jsonb, completed_at = clock_timestamp()
        where id = $1`,
      [batchId, JSON.stringify(summary)],
    );
    await client.query("COMMIT");
    console.log(JSON.stringify({ batchKey, batchId, ...summary }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("V2 migration apply refused or failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
