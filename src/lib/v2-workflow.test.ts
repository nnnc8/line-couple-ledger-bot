import assert from "node:assert/strict";
import test from "node:test";

import {
  createV2ProposalInputSchema,
  createV2RecurringRuleInputSchema,
  createV2TransactionInputSchema,
} from "./v2-ledger-service";
import { parseV2AiProposalResponse } from "./v2-line-proposal";

test("V2 proposal input is TWD-only and bounded to a small atomic batch", () => {
  const parsed = createV2ProposalInputSchema.parse({
    ledgerId: "10000000-0000-4000-8000-000000000001",
    commands: [{
      type: "expense",
      amountTwd: "101",
      occurredOn: "2026-08-12",
      description: "晚餐",
      payments: [{ userId: "20000000-0000-4000-8000-000000000002", amountTwd: "101" }],
      shares: [
        { userId: "20000000-0000-4000-8000-000000000001", amountTwd: "51" },
        { userId: "20000000-0000-4000-8000-000000000002", amountTwd: "50" },
      ],
    }],
  });
  assert.equal(parsed.commands[0]?.amountTwd, "101");
  assert.throws(() => createV2ProposalInputSchema.parse({
    ledgerId: "10000000-0000-4000-8000-000000000001",
    commands: Array.from({ length: 21 }, () => parsed.commands[0]),
  }));
});

test("V2 transaction and recurring contracts reject non-TWD or malformed scope fields", () => {
  const base = {
    type: "expense" as const,
    amountTwd: "100",
    occurredOn: "2026-08-12",
    description: "房租",
    payments: [{ userId: "20000000-0000-4000-8000-000000000001", amountTwd: "100" }],
    shares: [
      { userId: "20000000-0000-4000-8000-000000000001", amountTwd: "50" },
      { userId: "20000000-0000-4000-8000-000000000002", amountTwd: "50" },
    ],
  };
  assert.equal(createV2TransactionInputSchema.parse(base).amountTwd, "100");
  assert.throws(() => createV2TransactionInputSchema.parse({ ...base, currency: "USD" }), /Unrecognized key/);
  assert.throws(() => createV2TransactionInputSchema.parse({ ...base, amountTwd: "100.5" }), /非負整數/);
  assert.equal(createV2RecurringRuleInputSchema.parse({
    name: "房租",
    amountTwd: "100",
    frequency: "monthly",
    nextRunDate: "2026-08-12",
    splitMethod: "weights",
    payments: base.payments,
    shares: base.shares,
  }).frequency, "monthly");
  assert.equal(createV2RecurringRuleInputSchema.parse({
    name: "房租",
    amountTwd: "100",
    frequency: "monthly",
    nextRunDate: "2026-08-12",
    splitMethod: "weights",
    payments: base.payments,
  }).shares, undefined);
  assert.throws(() => createV2RecurringRuleInputSchema.parse({
    name: "房租",
    amountTwd: "100",
    frequency: "monthly",
    nextRunDate: "2026-08-12",
    splitMethod: "exact",
    payments: base.payments,
  }), /必須指定 shares/);
});

test("LINE AI adapter accepts only a bounded proposal shape and never an accounting command", () => {
  const candidate = parseV2AiProposalResponse(JSON.stringify({
    kind: "expense",
    amountTwd: 580,
    description: "晚餐",
    payer: "self",
    ledgerName: "共同生活",
  }));
  assert.deepEqual(candidate, {
    kind: "expense",
    amountTwd: 580,
    description: "晚餐",
    payer: "self",
    ledgerName: "共同生活",
  });
  assert.deepEqual(parseV2AiProposalResponse(JSON.stringify({ kind: "settle_all" })), { kind: "settle_all" });
  assert.equal(parseV2AiProposalResponse(JSON.stringify({ kind: "expense", amountTwd: 580, description: "晚餐" })), null);
  assert.equal(parseV2AiProposalResponse(JSON.stringify({ kind: "expense", amountTwd: 580, description: "晚餐", payer: "self", currency: "USD" })), null);
  assert.equal(parseV2AiProposalResponse("not json"), null);
});
