import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
if (existsSync(".env")) process.loadEnvFile(".env");

import { buildV2MigrationPlan, migrationPlanDigest } from "../src/lib/v2-migration";
import { loadV2LegacySnapshot } from "../src/lib/v2-migration-db";

const outputPath = resolve(process.argv[2] ?? "artifacts/v2-migration-plan.json");
const coupleId = Number(process.argv[3] ?? process.env.V2_COUPLE_ID ?? "1");

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function serializeBigInt(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializeBigInt);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, serializeBigInt(item)]),
  );
}

async function main() {
  if (!Number.isInteger(coupleId) || coupleId <= 0) throw new Error("couple id must be a positive integer");
  const pool = new Pool({
    connectionString: requiredEnv("DATABASE_URL"),
    ssl: process.env.DATABASE_URL?.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const client = await pool.connect();
    try {
      const snapshot = await loadV2LegacySnapshot(client, coupleId);
      const plan = buildV2MigrationPlan(snapshot);
      const payload = {
        generatedAt: new Date().toISOString(),
        source: {
          coupleId,
          users: snapshot.users.length,
          groups: snapshot.groups.length,
          expenses: snapshot.expenses.length,
          settlements: snapshot.settlements.length,
        },
        digest: migrationPlanDigest(plan),
        quarantineCount: plan.quarantine.length,
        excludedMirrorCount: plan.excludedMirrorExpenseIds.length,
        excludedPrivateCount: plan.excludedPrivateExpenseIds.length,
        plan,
      };
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, JSON.stringify(serializeBigInt(payload), null, 2) + "\n");
      console.log(JSON.stringify({
        output: outputPath,
        digest: payload.digest,
        ledgers: plan.ledgers.length,
        transactions: plan.transactions.length,
        quarantined: plan.quarantine.length,
        excludedMirrors: plan.excludedMirrorExpenseIds.length,
        excludedPrivate: plan.excludedPrivateExpenseIds.length,
      }, null, 2));
      if (plan.quarantine.length > 0) process.exitCode = 2;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("V2 migration planning failed:", error);
  process.exitCode = 1;
});
