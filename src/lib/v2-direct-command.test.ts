import assert from "node:assert/strict";
import test from "node:test";
import { classifyV2DirectCommand } from "./v2-direct-command";

test("complete deterministic grammar preserves amount, payer, receiver and explicit Ledger", () => {
  assert.deepEqual(classifyV2DirectCommand("晚餐 NT$1,000 我付 記在 韓國旅行"), { kind: "expense", amountTwd: 1000, description: "晚餐", payer: "self", ledgerName: "韓國旅行" });
  assert.deepEqual(classifyV2DirectCommand("退款 120 她收到"), { kind: "income", amountTwd: 120, description: "退款", receiver: "partner" });
  assert.deepEqual(classifyV2DirectCommand("我轉帳 300 給她"), { kind: "transfer", amountTwd: 300, description: "LINE 轉帳", payer: "self" });
  assert.equal(classifyV2DirectCommand("晚餐 ５００ 我付")?.amountTwd, 500);
});

test("the complete input must match: no partial amounts or inferred semantics", () => {
  for (const text of [
    "不要記帳，晚餐 500 我付", "不要記帳晚餐 500 我付", "拒絕晚餐 500 我付", "晚餐 500 我付嗎",
    "晚餐 500.50 我付", "晚餐 -500 我付", "晚餐 USD 500 我付", "晚餐 $500 我付", "晚餐 5,00 我付",
    "2026/09/12 晚餐 500 我付", "晚餐 2 人 500 我付", "晚餐 500 我付，飲料 60 她付", "晚餐 500 我付\n飲料 60 她付",
    "昨天晚餐 500 我付", "借款 500 我付", "我收到餐廳退款 500，這筆原本我付", "晚餐 500", "晚餐 500 我付 分攤不確定",
    "晚餐 500 我付 記在 A 記在 B", "晚餐 500 我付 記在 ", "晚餐 100000001 我付", "我轉帳 300 給我", "我轉帳 300",
  ]) assert.equal(classifyV2DirectCommand(text), null, text);
});
