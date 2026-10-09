import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LedgerBalanceSummary, type LedgerBalanceSummaryProps } from "./ledger-balance-summary";
import { integerTwd } from "../../lib/format";

const render = (props: LedgerBalanceSummaryProps) => renderToStaticMarkup(createElement(LedgerBalanceSummary, props));
for (const [value, headline, amount] of [
  ["0", "目前很平衡", null],
  ["2480", "你目前多付", "NT$2,480"],
  ["-2480", "另一半目前多付", "NT$2,480"],
  ["900719925474099312345", "你目前多付", "NT$900,719,925,474,099,312,345"],
  ["-900719925474099312345", "另一半目前多付", "NT$900,719,925,474,099,312,345"],
] as const) test(`canonical balance ${value} has truthful copy and complete precision`, () => {
  const html = render({ selfBalance: value, nextPayerLabel: " canonical payer " });
  assert.ok(html.includes(headline));
  if (amount) { assert.ok(html.includes(amount)); }
  else { assert.ok(html.includes("下次誰方便，就由誰付款")); assert.ok(!html.includes("NT$0")); assert.ok(!html.includes("canonical payer")); }
  assert.ok(!html.includes("你欠")); assert.ok(!html.includes("全部結清"));
});
test("uses only the supplied canonical next payer", () => {
  assert.ok(render({ selfBalance: "2480", nextPayerLabel: "你" }).includes("下次建議由 你 付款"));
  assert.ok(!render({ selfBalance: "2480" }).includes("下次建議由"));
});
test("initial loading announces progress without inventing balance", () => {
  const html = render({ selfBalance: null, loading: true });
  assert.ok(html.includes('aria-busy="true"')); assert.ok(html.includes("正在載入近況"));
  assert.ok(!html.includes("NT$")); assert.ok(!html.includes("目前很平衡"));
});
test("a known snapshot stays visible during a refresh", () => {
  const html = render({ selfBalance: "2480", loading: true });
  assert.ok(html.includes("NT$2,480")); assert.ok(!html.includes("正在載入近況"));
});
test("stale known data retains its value and canonical payer", () => {
  const html = render({ selfBalance: "-2480", nextPayerLabel: "你", stale: true });
  assert.ok(html.includes("另一半目前多付")); assert.ok(html.includes("NT$2,480"));
  assert.ok(html.includes("下次建議由 你 付款")); assert.ok(html.includes("尚未更新"));
});
test("unavailable and invalid data never render a fake balance", () => {
  for (const value of [null, "", "not-an-integer", "1.5"]) {
    const html = render({ selfBalance: value });
    assert.ok(html.includes("暫時無法讀取近況")); assert.ok(!html.includes("NT$")); assert.ok(!html.includes("目前很平衡"));
  }
});
test("integer formatter preserves zero, signed and huge integer precision", () => {
  assert.equal(integerTwd(0n), "NT$0"); assert.equal(integerTwd(2480n), "NT$2,480"); assert.equal(integerTwd(-2480n), "NT$-2,480");
  assert.equal(integerTwd(900719925474099312345n), "NT$900,719,925,474,099,312,345");
});
