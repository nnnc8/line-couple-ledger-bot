/**
 * PostgreSQL regression test for the category migration's deferred-trigger
 * failure. Run against a localhost database restored to the pre-category
 * production shape with V2_TEST_DATABASE_URL.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "pg";

const databaseUrl = process.env.V2_TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);

if (databaseUrl) {
  const hostname = new URL(databaseUrl).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error("V2_TEST_DATABASE_URL must point to localhost; production/remote rehearsal is refused");
  }
}

if (!enabled) {
  console.warn("[v2-category-migration.pg.test.ts] SKIPPED — set V2_TEST_DATABASE_URL to an isolated pre-category PostgreSQL database");
}

const migrationSql = readFileSync("supabase/migrations/20260813041139_v2_ledger_categories.sql", "utf8");

function originalMigrationOrder(sql: string): string {
  const ddlStart = sql.indexOf("create index if not exists transactions_category_idx");
  const updateStart = sql.indexOf("-- Preserve existing V2 text categories");
  const categoryRlsStart = sql.indexOf("alter table ledger_v2.categories enable row level security;");
  assert(ddlStart >= 0 && updateStart > ddlStart && categoryRlsStart > updateStart, "category migration markers changed");
  const ddlBlock = sql.slice(ddlStart, updateStart);
  return `${sql.slice(0, ddlStart)}${sql.slice(updateStart, categoryRlsStart)}${ddlBlock}${sql.slice(categoryRlsStart)}`;
}

async function schemaState(client: Client) {
  const result = await client.query<{
    categories: string | null;
    category_index: string | null;
    transaction_category_column: boolean;
    recurring_category_column: boolean;
  }>(`
    select
      to_regclass('ledger_v2.categories')::text as categories,
      to_regclass('ledger_v2.transactions_category_idx')::text as category_index,
      exists (
        select 1 from information_schema.columns
         where table_schema = 'ledger_v2' and table_name = 'transactions' and column_name = 'category_id'
      ) as transaction_category_column,
      exists (
        select 1 from information_schema.columns
         where table_schema = 'ledger_v2' and table_name = 'recurring_rules' and column_name = 'category_id'
      ) as recurring_category_column
  `);
  return result.rows[0]!;
}

test("old category order fails with SQLSTATE 55006 and corrected order is atomic", { skip: !enabled }, async () => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const before = await schemaState(client);
    assert.equal(before.categories, null);
    assert.equal(before.category_index, null);
    assert.equal(before.transaction_category_column, false);
    assert.equal(before.recurring_category_column, false);

    const trigger = await client.query<{
      tgname: string;
      conname: string;
      tgdeferrable: boolean;
      tginitdeferred: boolean;
      condeferrable: boolean;
      condeferred: boolean;
    }>(`
      select t.tgname, c.conname, t.tgdeferrable, t.tginitdeferred,
             c.condeferrable, c.condeferred
        from pg_trigger t
        join pg_constraint c on c.oid = t.tgconstraint
        join pg_class r on r.oid = t.tgrelid
        join pg_namespace n on n.oid = r.relnamespace
       where n.nspname = 'ledger_v2'
         and r.relname = 'transactions'
         and t.tgname = 'transaction_integrity_on_header'
    `);
    assert.deepEqual(trigger.rows[0], {
      tgname: "transaction_integrity_on_header",
      conname: "transaction_integrity_on_header",
      tgdeferrable: true,
      tginitdeferred: true,
      condeferrable: true,
      condeferred: true,
    });

    await client.query("begin");
    let oldFailure: unknown;
    try {
      await client.query(originalMigrationOrder(migrationSql));
    } catch (error) {
      oldFailure = error;
    }
    assert(oldFailure, "the original migration order must fail");
    assert.equal((oldFailure as { code?: string }).code, "55006");
    assert.match(String((oldFailure as { message?: string }).message), /pending trigger events/);
    await client.query("rollback");

    const afterRollback = await schemaState(client);
    assert.equal(afterRollback.categories, null);
    assert.equal(afterRollback.category_index, null);
    assert.equal(afterRollback.transaction_category_column, false);
    assert.equal(afterRollback.recurring_category_column, false);

    await client.query("begin");
    await client.query(migrationSql);
    await client.query("set constraints all immediate");
    const counts = await client.query<{ categories: string; linked: string; transactions: string; payments: string; shares: string }>(`
      select
        (select count(*)::text from ledger_v2.categories) as categories,
        (select count(*)::text from ledger_v2.transactions where category_id is not null) as linked,
        (select count(*)::text from ledger_v2.transactions) as transactions,
        (select count(*)::text from ledger_v2.transaction_payments) as payments,
        (select count(*)::text from ledger_v2.transaction_shares) as shares
    `);
    assert.deepEqual(counts.rows[0], { categories: "24", linked: "101", transactions: "223", payments: "223", shares: "438" });
    await client.query("rollback");

    const final = await schemaState(client);
    assert.equal(final.categories, null);
    assert.equal(final.transaction_category_column, false);
    assert.equal(final.recurring_category_column, false);
  } finally {
    await client.end();
  }
});
