import { existsSync } from "node:fs";
import { Client } from "pg";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
if (existsSync(".env")) process.loadEnvFile(".env");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const r = await client.query(
      `select
         to_regclass('public.agent_events') as regclass,
         (select current_user) as connected_as,
         (select version()) as pg_version`,
    );
    console.log("connected as:", r.rows[0].connected_as);
    console.log("pg_version:", r.rows[0].pg_version);
    console.log("agent_events regclass:", r.rows[0].regclass);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
