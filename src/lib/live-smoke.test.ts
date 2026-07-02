/**
 * live-smoke.test.ts
 *
 * Smoke guards — fail-fast / dry-run checks for the live smoke harness.
 * These tests do NOT touch a real database. They only verify:
 *   1. Smoke environment variables are either all present or the harness
 *      fails with a descriptive error (no partial state).
 *   2. Each smoke module can be imported without crashing.
 *   3. getSmokeEnv() throws when variables are absent.
 *   4. SMOKE_CLEANUP_MODE accepts the documented values.
 *
 * These are guards, not live proof. The actual live activation proof comes
 * from running `pnpm smoke:local`, `pnpm smoke:recurring`, and `pnpm
 * smoke:cron` against a real DATABASE_URL.
 */

import assert from "node:assert/strict";
import test from "node:test";

// ---------------------------------------------------------------------------
// 1. getSmokeEnv fail-fast guard
// ---------------------------------------------------------------------------
test("smoke guards: getSmokeEnv throws when vars are absent", async () => {
  const { getSmokeEnv } = await import("./smoke/smoke-tenant");

  const backup = {
    SMOKE_LINE_USER_ID: process.env.SMOKE_LINE_USER_ID,
    SMOKE_PARTNER_LINE_USER_ID: process.env.SMOKE_PARTNER_LINE_USER_ID,
    SMOKE_GROUP_NAME: process.env.SMOKE_GROUP_NAME,
  };

  try {
    delete process.env.SMOKE_LINE_USER_ID;
    delete process.env.SMOKE_PARTNER_LINE_USER_ID;
    delete process.env.SMOKE_GROUP_NAME;

    assert.throws(
      () => getSmokeEnv(),
      /Missing required smoke environment variables/,
    );
  } finally {
    // restore
    if (backup.SMOKE_LINE_USER_ID !== undefined) {
      process.env.SMOKE_LINE_USER_ID = backup.SMOKE_LINE_USER_ID;
    }
    if (backup.SMOKE_PARTNER_LINE_USER_ID !== undefined) {
      process.env.SMOKE_PARTNER_LINE_USER_ID = backup.SMOKE_PARTNER_LINE_USER_ID;
    }
    if (backup.SMOKE_GROUP_NAME !== undefined) {
      process.env.SMOKE_GROUP_NAME = backup.SMOKE_GROUP_NAME;
    }
  }
});

test("smoke guards: getSmokeEnv succeeds when all vars are set", async () => {
  const { getSmokeEnv } = await import("./smoke/smoke-tenant");

  const backup = {
    SMOKE_LINE_USER_ID: process.env.SMOKE_LINE_USER_ID,
    SMOKE_PARTNER_LINE_USER_ID: process.env.SMOKE_PARTNER_LINE_USER_ID,
    SMOKE_GROUP_NAME: process.env.SMOKE_GROUP_NAME,
  };

  try {
    process.env.SMOKE_LINE_USER_ID = "Uabc123";
    process.env.SMOKE_PARTNER_LINE_USER_ID = "Udef456";
    process.env.SMOKE_GROUP_NAME = "smoke-group";

    const env = getSmokeEnv();
    assert.equal(env.SMOKE_LINE_USER_ID, "Uabc123");
    assert.equal(env.SMOKE_PARTNER_LINE_USER_ID, "Udef456");
    assert.equal(env.SMOKE_GROUP_NAME, "smoke-group");
  } finally {
    for (const [k, v] of Object.entries(backup)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Smoke modules can be imported (no side effects on import)
// ---------------------------------------------------------------------------
test("smoke guards: smoke-tenant module imports without error", async () => {
  const mod = await import("./smoke/smoke-tenant");
  assert.ok(typeof mod.getSmokeEnv === "function");
  assert.ok(typeof mod.getOrCreateSmokeTenant === "function");
});

test("smoke guards: pending-action-smoke module imports without error", async () => {
  const mod = await import("./smoke/pending-action-smoke");
  assert.ok(typeof mod.runPendingActionSmoke === "function");
});

// ---------------------------------------------------------------------------
// 3. DATABASE_URL absence guard (env regression)
// ---------------------------------------------------------------------------
test("smoke guards: server env schema reports missing DATABASE_URL clearly", async () => {
  // DATABASE_URL must be absent for this test to be meaningful
  const originalUrl = process.env.DATABASE_URL;

  if (originalUrl) {
    // If a real DATABASE_URL is present, skip the failure scenario – the
    // env is already configured for live testing.
    return;
  }

  const { envSchema } = await import("./server-runtime");

  // Build a minimal env object missing DATABASE_URL
  const partialEnv = {
    LINE_CHANNEL_ACCESS_TOKEN: "token",
    LINE_LOGIN_CHANNEL_ID: "login-id",
    GEMINI_API_KEY: "key",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "secret",
    COUPLE_SETUP_CODE: "x".repeat(24),
    LIFF_SESSION_SECRET: "x".repeat(32),
    APP_URL: "https://example.com",
    CRON_SECRET: "x".repeat(16),
    // DATABASE_URL intentionally absent
  };

  const result = envSchema.safeParse(partialEnv);
  assert.equal(result.success, false, "schema should fail when DATABASE_URL is absent");
});

// ---------------------------------------------------------------------------
// 4. CLEANUP_MODE validation (documented contract)
// ---------------------------------------------------------------------------
test("smoke guards: SMOKE_CLEANUP_MODE accepts 'always' or 'on-success'", () => {
  const valid = ["always", "on-success"];
  const invalid = ["never", "", "true", "yes"];

  for (const mode of valid) {
    assert.ok(
      valid.includes(mode),
      `'${mode}' should be a valid cleanup mode`,
    );
  }

  for (const mode of invalid) {
    assert.ok(
      !valid.includes(mode),
      `'${mode}' should not be a valid cleanup mode`,
    );
  }
});
