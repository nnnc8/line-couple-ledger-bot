import { existsSync } from "node:fs";
import { Client } from "pg";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
if (existsSync(".env")) process.loadEnvFile(".env");

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const r1 = await c.query(
      `select rolname, rolsuper, rolbypassrls
       from pg_roles
       where rolname in ('service_role', 'ledger_runtime')
       order by rolname`,
    );
    console.log("roles:");
    for (const r of r1.rows) console.log(" ", r);

    const r2 = await c.query(
      `select
         has_table_privilege('service_role', 'public.agent_events', 'INSERT') as ins,
         has_table_privilege('service_role', 'public.agent_events', 'SELECT') as sel,
         has_table_privilege('service_role', 'public.agent_events', 'UPDATE') as upd`,
    );
    console.log("service_role privileges on agent_events:", r2.rows[0]);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
