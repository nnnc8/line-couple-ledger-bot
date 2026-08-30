import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { classifyLineDeliveryError } from "./line-delivery-error";
import { scheduleV2NotificationOutboxDrain } from "./v2-notification-drain";

test("V2 outbox payloads remain bounded LINE text fields", () => {
  const payload = { title: "Ledger 有新支出", message: "晚餐 NT$860" };
  const text = [payload.title, payload.message].filter(Boolean).join("\n").slice(0, 5_000);
  assert.equal(text, "Ledger 有新支出\n晚餐 NT$860");
});

test("LINE delivery classification dead-letters permanent client errors and retries temporary failures", () => {
  assert.deepEqual(classifyLineDeliveryError(new Error("400 - Bad Request")), {
    disposition: "permanent",
    operationError: "LINE delivery HTTP 400",
  });
  assert.equal(classifyLineDeliveryError(new Error("401 unauthorized")).disposition, "permanent");
  assert.equal(classifyLineDeliveryError(new Error("403 forbidden")).disposition, "permanent");
  assert.equal(classifyLineDeliveryError(new Error("429 rate limited")).disposition, "transient");
  assert.equal(classifyLineDeliveryError(new Error("500 upstream")).disposition, "transient");
  assert.equal(classifyLineDeliveryError(new Error("timeout")).disposition, "transient");
});

test("opportunistic drain is registered after the response path and does not wait for LINE", async () => {
  const callbacks: Array<() => Promise<void>> = [];
  let calls = 0;
  scheduleV2NotificationOutboxDrain(
    (callback) => callbacks.push(callback),
    { db: {} as SupabaseClient, lineChannelAccessToken: "test-token" },
    7,
    async (_input, limit) => {
      calls += 1;
      assert.equal(limit, 7);
      return 0;
    },
  );
  assert.equal(calls, 0);
  assert.equal(callbacks.length, 1);
  await callbacks[0]!();
  assert.equal(calls, 1);
});
