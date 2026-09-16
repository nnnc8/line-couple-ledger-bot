import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";

function loopbackPostgresUrl(value: string): URL {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || ["host", "hostaddr", "database", "dbname"].some((key) => url.searchParams.has(key))) {
    throw new Error("PostgreSQL tests require loopback without connection target overrides");
  }
  return url;
}

export function requireLocalTestUrl(value: string | undefined): URL {
  if (!value) throw new Error("V3_TEST_DATABASE_URL is required; critical PostgreSQL tests must not skip");
  const url = loopbackPostgresUrl(value);
  if (!/^\/v3_0_test_[a-z0-9_]+$/.test(url.pathname)) {
    throw new Error("V3 tests require a newly created v3_0_test_* database on loopback");
  }
  return url;
}

export async function createV30TestDatabase(adminUrl: string, profile: "full" | "pre-category" = "full") {
  const admin = loopbackPostgresUrl(adminUrl);
  const name = `v3_0_test_${randomUUID().replaceAll("-", "")}`;
  const control = new Client({ connectionString: admin.href });
  await control.connect();
  let created = false;
  try {
    for (const role of ["anon", "authenticated", "service_role", "ledger_runtime"]) {
      const result = await control.query("select 1 from pg_roles where rolname = $1", [role]);
      if (!result.rowCount) await control.query(`create role ${role} nologin`);
    }
    await control.query(`create database ${name}`);
    created = true;
    const target = new URL(admin.href);
    target.pathname = `/${name}`;
    requireLocalTestUrl(target.href);
    const db = new Client({ connectionString: target.href });
    await db.connect();
    try {
      await db.query(readFileSync("tests/fixtures/v3-0-public.sql", "utf8"));
      const migrations = [
        "20260812050029_add_couple_ledger_v2_shadow.sql",
        "20260812053946_add_couple_ledger_v2_workflows.sql",
        "20260813031549_v2_transaction_lineage.sql",
        ...(profile === "full" ? ["20260813041139_v2_ledger_categories.sql", "20260813043813_v2_recurring_semantics.sql"] : []),
        "20260814024223_v2_incident_write_freeze.sql",
        ...(profile === "full" ? ["20260819081500_grant_v2_categories_to_ledger_runtime.sql"] : []),
      ];
      for (const migration of migrations) {
        await db.query("begin");
        try {
          await db.query(readFileSync(`supabase/migrations/${migration}`, "utf8"));
          await db.query("commit");
        } catch (error) {
          await db.query("rollback");
          throw error;
        }
      }
      await db.query("insert into ledger_v2.writer_control (couple_id, active_plane, mutation_fence) values (1, 'v2', false), (2, 'v2', false) on conflict (couple_id) do update set active_plane = 'v2', mutation_fence = false");
      await db.query("create table public.v3_test_fixture (baseline text not null)");
      await db.query("insert into public.v3_test_fixture values ($1)", ["dad6ffaa9bbe00308f356b78175e0ccfa617326a"]);
    } finally {
      await db.end();
    }
    return {
      url: target.href,
      async dispose() {
        try { await control.query(`drop database ${name} with (force)`); }
        finally { await control.end(); }
      },
    };
  } catch (error) {
    if (created) await control.query(`drop database ${name} with (force)`);
    await control.end();
    throw error;
  }
}
