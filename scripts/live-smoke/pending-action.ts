import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

import { getOrCreateSmokeTenant } from "../../src/lib/smoke/smoke-tenant";
import { runPendingActionSmoke } from "../../src/lib/smoke/pending-action-smoke";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main() {
  console.log("Starting Pending Action Live Smoke Test...");

  const databaseUrl = requireEnv("DATABASE_URL");
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseSecretKey = requireEnv("SUPABASE_SECRET_KEY");

  const db = createClient(supabaseUrl, supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let tenant: Awaited<ReturnType<typeof getOrCreateSmokeTenant>> | null = null;
  let runError: unknown = null;
  let cleanupError: unknown = null;

  try {
    tenant = await getOrCreateSmokeTenant(db);

    console.log(`Smoke Tenant Resolved:`);
    console.log(`  Owner User ID: ${tenant.owner.id}`);
    console.log(`  Partner User ID: ${tenant.partner.id}`);
    console.log(`  Group ID: ${tenant.group.id} (${tenant.group.name})`);

    await runPendingActionSmoke({
      databaseUrl,
      db,
      owner: tenant.owner,
      partner: tenant.partner,
      group: tenant.group,
    });
  } catch (error) {
    runError = error;
  } finally {
    if (tenant) {
      try {
        await tenant.cleanup();
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  if (runError && cleanupError) {
    throw new AggregateError(
      [runError, cleanupError],
      "Pending action smoke run and tenant cleanup both failed",
    );
  }
  if (runError) {
    throw runError;
  }
  if (cleanupError) {
    throw cleanupError;
  }

  console.log("Pending Action Live Smoke Test finished successfully!");
}

main().catch((err) => {
  console.error("Smoke test failed with error:");
  console.error(err);
  process.exit(1);
});
