import { existsSync, readFileSync } from "node:fs";
import { Client } from "pg";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
if (existsSync(".env")) process.loadEnvFile(".env");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const path = process.argv[2] ?? "supabase/migrations/202607080001_agent_events.sql";
  const sql = readFileSync(path, "utf8");

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // Idempotency: detect table presence first, then apply only if missing.
    const existing = await client.query(
      `select to_regclass('public.agent_events') as regclass`,
    );
    if (existing.rows[0]?.regclass) {
      console.log(
        `Skipping apply: public.agent_events already present (regclass=${existing.rows[0].regclass})`,
      );
    } else {
      console.log(`Applying ${path} (${sql.length} bytes)`);
      await client.query(sql);
      console.log("Migration applied successfully");
    }

    const tableCheck = await client.query(
      `select to_regclass('public.agent_events') as regclass`,
    );
    console.log("agent_events regclass:", tableCheck.rows[0]?.regclass ?? "MISSING");

    const indexCheck = await client.query(
      `select indexname from pg_indexes where schemaname='public' and tablename='agent_events' order by indexname`,
    );
    console.log(
      "Indexes:",
      indexCheck.rows.map((r) => r.indexname).join(", ") || "(none)",
    );

    const uniqueCheck = await client.query(
      `select indexname, indexdef from pg_indexes where schemaname='public' and tablename='agent_events' and indexname='agent_events_source_event_uniq'`,
    );
    console.log(
      "Unique partial index present:",
      uniqueCheck.rowCount === 1 ? "yes" : "NO",
    );
    if (uniqueCheck.rowCount === 1) {
      console.log("Definition:", uniqueCheck.rows[0].indexdef);
    }

    const grantCheck = await client.query(
      `select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privs
       from information_schema.role_table_grants
       where table_schema='public' and table_name='agent_events'
       group by grantee
       order by grantee`,
    );
    console.log("Grants:");
    if (grantCheck.rowCount === 0) {
      console.log("  (none)");
    }
    for (const r of grantCheck.rows) {
      console.log(`  ${r.grantee}: ${r.privs}`);
    }

    const rlsCheck = await client.query(
      `select relname, relrowsecurity, relforcerowsecurity
       from pg_class where relname='agent_events' and relnamespace='public'::regnamespace`,
    );
    console.log(
      "RLS:",
      rlsCheck.rows[0]
        ? `rowsecurity=${rlsCheck.rows[0].relrowsecurity}, force=${rlsCheck.rows[0].relforcerowsecurity}`
        : "table not found",
    );

    // Confirm service_role can actually insert (smoke test the grant, since grants
    // on tables without explicit column grants can be misleading in some setups).
    const srClient = new Client({ connectionString: url });
    await srClient.connect();
    try {
      // We need a valid couple + user to insert; use smoke-tenant helper if present.
      const dbUrl = process.env.SUPABASE_URL;
      const srKey = process.env.SUPABASE_SECRET_KEY;
      if (dbUrl && srKey) {
        const { createClient } = await import("@supabase/supabase-js");
        const supa = createClient(dbUrl, srKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: couples } = await supa
          .from("couples")
          .select("id")
          .limit(1);
        const { data: users } = await supa
          .from("users")
          .select("id")
          .limit(1);
        if (couples?.length && users?.length) {
          const probe = await supa
            .from("agent_events")
            .insert({
              couple_id: couples[0].id,
              group_id: null,
              user_id: users[0].id,
              source: "system",
              source_event_id: `apply-migration-probe-${Date.now()}`,
              kind: "text_other",
              status: "completed",
              input_text: "probe",
              reply_text: "probe",
            })
            .select("id")
            .single();
          if (probe.error) {
            console.log("service_role insert probe FAILED:", probe.error.message);
          } else {
            console.log("service_role insert probe OK, id:", probe.data.id);
            await supa.from("agent_events").delete().eq("id", probe.data.id);
          }
        } else {
          console.log("service_role insert probe SKIPPED: no couple/user rows");
        }
      }
    } finally {
      await srClient.end();
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Migration runner failed:", err);
  process.exit(1);
});
