import { existsSync } from "node:fs";
import { Pool } from "pg";

import { buildV2MigrationPlan, migrationPlanDigest } from "../src/lib/v2-migration";
import { loadV2LegacySnapshot } from "../src/lib/v2-migration-db";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
if (existsSync(".env")) process.loadEnvFile(".env");

const coupleId = Number(process.env.V2_COUPLE_ID ?? "1");
const shouldApply = process.argv.includes("--apply");

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertApplyGate(): void {
  if (!shouldApply || process.env.V2_CUTOVER_APPLY !== "1") {
    throw new Error("refusing to change writer plane: pass --apply and set V2_CUTOVER_APPLY=1");
  }
  if (!Number.isInteger(coupleId) || coupleId <= 0) {
    throw new Error("V2_COUPLE_ID must be a positive integer");
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
    // Stop every V1 financial writer while the control row changes. The
    // database trigger in the workflow migration remains the lasting guard.
    await client.query("lock table public.groups, public.expenses, public.expense_splits, public.settlements in share mode");

    const members = await client.query<{ count: string }>(
      "select count(*)::text as count from public.users where couple_id = $1",
      [coupleId],
    );
    if (members.rows[0]?.count !== "2") throw new Error("cutover requires exactly two couple members");

    const batchKey = process.env.V2_MIGRATION_BATCH_KEY ?? `v2:${coupleId}:%`;
    const batch = await client.query<{ id: string; status: string; summary: { coupleId?: number; quarantine?: number; digest?: string } | null }>(
      `select id, status, summary
         from ledger_v2.migration_batches
        where batch_key ${batchKey.endsWith("%") ? "like" : "="} $1
        order by created_at desc
        limit 1
        for update`,
      [batchKey],
    );
    const verified = batch.rows[0];
    if (!verified || verified.status !== "verified") throw new Error("a verified V2 migration batch is required");
    if (verified.summary?.coupleId !== coupleId || verified.summary?.quarantine !== 0) {
      throw new Error("migration batch does not prove a zero-quarantine reconciliation for this couple");
    }
    const currentSnapshot = await loadV2LegacySnapshot(client, coupleId);
    const currentPlan = buildV2MigrationPlan(currentSnapshot);
    const currentDigest = migrationPlanDigest(currentPlan);
    if (currentPlan.quarantine.length > 0) {
      throw new Error(`cutover source snapshot has ${currentPlan.quarantine.length} quarantined rows`);
    }
    if (verified.summary?.digest !== currentDigest) {
      throw new Error("V1 source changed after migration; create a new verified migration batch before cutover");
    }

    const control = await client.query<{ active_plane: "v1" | "v2"; mutation_fence: boolean; writer_epoch: string }>(
      `select active_plane, mutation_fence, writer_epoch
         from ledger_v2.writer_control
        where couple_id = $1
        for update`,
      [coupleId],
    );
    const current = control.rows[0];
    if (!current) throw new Error("writer_control row is missing; apply V2 schema first");
    if (current.active_plane !== "v1" || current.mutation_fence) {
      throw new Error("cutover requires the unfenced V1 writer plane");
    }

    await client.query(
      `update ledger_v2.writer_control
          set mutation_fence = true, updated_at = now()
        where couple_id = $1`,
      [coupleId],
    );
    await client.query(
      `update ledger_v2.writer_control
          set active_plane = 'v2', writer_epoch = writer_epoch + 1,
              mutation_fence = false, updated_at = now()
        where couple_id = $1`,
      [coupleId],
    );
    await client.query("COMMIT");
    console.log(JSON.stringify({ coupleId, batchId: verified.id, activePlane: "v2", writerEpoch: Number(current.writer_epoch) + 1 }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("V2 cutover refused or failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
