import { spawn } from "node:child_process";
import { createV30TestDatabase } from "./v3-0-test-db";

async function main() {
  const adminUrl = process.env.V3_PG_ADMIN_URL;
  if (!adminUrl) throw new Error("V3_PG_ADMIN_URL is required; PostgreSQL validation cannot silently skip");
  const tls = process.argv.includes("--tls");
  if (tls && !process.env.V3_TEST_TLS_CA) throw new Error("V3_TEST_TLS_CA is required for TLS verification");
  const db = await createV30TestDatabase(adminUrl);
  try {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", ...Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "SHELL"].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : [])) };
    Object.assign(env, {
      V3_TEST_TLS_CA: process.env.V3_TEST_TLS_CA,
      DATABASE_URL: db.url, V3_TEST_DATABASE_URL: db.url, V2_LEDGER_ENABLED: "1", V2_LINE_INBOX_ENABLED: "1", NODE_ENV: "test",
      LINE_CHANNEL_SECRET: "ci_stub", LINE_CHANNEL_ACCESS_TOKEN: "ci_stub", GEMINI_API_KEY: "ci_stub",
      SUPABASE_URL: "https://ci.stub", SUPABASE_SECRET_KEY: "ci_stub", COUPLE_SETUP_CODE: "ci_stub_couple_setup_code_20",
      LINE_LOGIN_CHANNEL_ID: "200000000", NEXT_PUBLIC_LIFF_ID: "ci-stub", LIFF_SESSION_SECRET: "ci_stub_liff_session_secret_32_chars",
      APP_URL: "http://localhost:3119", CRON_SECRET: "ci_stub_cron_secret",
    });
    const child = spawn("pnpm", ["exec", "tsx", "--test", tls ? "src/lib/db/connection-config.pg.test.ts" : "src/lib/v3-0-correctness.pg.test.ts"], { env, stdio: "inherit" });
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await db.dispose();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
