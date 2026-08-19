import assert from "node:assert/strict";
import test from "node:test";

import { getBuildVersion } from "./version";

test("version metadata exposes only deployment identity fields", () => {
  assert.deepEqual(
    getBuildVersion({
      VERCEL_GIT_COMMIT_SHA: "abc123",
      VERCEL_ENV: "preview",
      BUILD_TIMESTAMP: "2026-08-14T00:00:00.000Z",
      DATABASE_URL: "must-not-leak",
      SUPABASE_SECRET_KEY: "must-not-leak",
    }),
    {
      commitSha: "abc123",
      environment: "preview",
      buildTimestamp: "2026-08-14T00:00:00.000Z",
    },
  );
});

test("version metadata has safe fallbacks", () => {
  assert.deepEqual(getBuildVersion({}), {
    commitSha: "unknown",
    environment: "unknown",
    buildTimestamp: null,
  });
});

test("version metadata ignores blank platform values and prefers an explicit release SHA", () => {
  assert.deepEqual(
    getBuildVersion({
      RELEASE_SHA: "  release123  ",
      VERCEL_GIT_COMMIT_SHA: "",
      GIT_COMMIT_SHA: "git123",
      VERCEL_ENV: "",
      NODE_ENV: "production",
      BUILD_TIMESTAMP: "",
      VERCEL_BUILD_TIMESTAMP: "2026-08-19T08:00:00.000Z",
    }),
    {
      commitSha: "release123",
      environment: "production",
      buildTimestamp: "2026-08-19T08:00:00.000Z",
    },
  );
});
