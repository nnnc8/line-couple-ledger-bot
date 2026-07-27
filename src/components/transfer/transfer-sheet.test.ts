import assert from "node:assert/strict";
import test from "node:test";
import { isValidTransferAmount, transferBalanceAfter } from "./transfer-sheet";

test("transfer directions can reduce, reverse, and cross a balance", () => {
  assert.equal(transferBalanceAfter(-500, "me_to_partner", 200), -300);
  assert.equal(transferBalanceAfter(-500, "partner_to_me", 200), -700);
  assert.equal(transferBalanceAfter(-500, "me_to_partner", 800), 300);
  assert.equal(transferBalanceAfter(0, "partner_to_me", 200), -200);
});

test("transfer amount accepts only whole TWD within the public limit", () => {
  assert.equal(isValidTransferAmount("1"), true);
  assert.equal(isValidTransferAmount("100000000"), true);
  for (const value of ["", "0", "-1", "1.5", "1e3", "100000001"]) {
    assert.equal(isValidTransferAmount(value), false, value);
  }
});
