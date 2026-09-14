import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { createV30TestDatabase } from "./v3-0-test-db";

async function main() {
  const adminUrl = process.env.V3_PG_ADMIN_URL;
  if (!adminUrl) throw new Error("V3_PG_ADMIN_URL is required for the isolated release suites");
  const command = process.argv[2];
  if (!["test:tx", "test:precutover", "test:incident"].includes(command ?? "")) throw new Error("Select test:tx, test:precutover or test:incident");
  const db = await createV30TestDatabase(adminUrl, command === "test:incident" ? "pre-category" : "full");
  try {
    if (command === "test:incident") {
      const client = new Client({ connectionString: db.url });
      await client.connect();
      try { await client.query(readFileSync("tests/fixtures/v3-0-pre-category.sql", "utf8")); }
      finally { await client.end(); }
    }
    // Deliberately omit DATABASE_URL/Supabase secrets: the three legacy REST
    // smoke tests are outside V3-0 and must never fall through to production.
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", V2_TEST_DATABASE_URL: db.url, V2_LEDGER_ENABLED: "1",
      ...Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "SHELL"].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : [])) };
    const child = spawn("pnpm", [command!], { env, stdio: "inherit" });
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally { await db.dispose(); }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
