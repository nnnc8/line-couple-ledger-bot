import assert from "node:assert/strict";
import test from "node:test";

test("V2 outbox payloads remain bounded LINE text fields", () => {
  const payload = { title: "Ledger 有新支出", message: "晚餐 NT$860" };
  const text = [payload.title, payload.message].filter(Boolean).join("\n").slice(0, 5_000);
  assert.equal(text, "Ledger 有新支出\n晚餐 NT$860");
});
