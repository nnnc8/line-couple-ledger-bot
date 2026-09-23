import assert from "node:assert/strict";
import test from "node:test";

import {
  createV2ProposalInputSchema,
  createV2RecurringRuleInputSchema,
  createV2TransactionInputSchema,
} from "./v2-ledger-service";
import { parseV2AiProposalCommandsResponse, parseV2AiProposalResponse, parseV2LineIncome, parseV2LineTransfer, v2LineProposalText } from "./v2-line-proposal";
import { reviseV2ProposalInputSchema, v2ProposalConfirmationSchema, v2ProposalDetailSchema } from "./v2-proposal-contract";

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

test("LINE AI adapter validates versioned multi-command and income/refund proposals", () => {
  const parsed = parseV2AiProposalCommandsResponse(JSON.stringify({
    version: 1,
    commands: [
      { kind: "expense", amountTwd: 860, description: "晚餐", payer: "self" },
      { kind: "expense", amountTwd: 320, description: "Uber", payer: "partner" },
      { kind: "income", amountTwd: 800, description: "飯店退費", receiver: "partner" },
    ],
  }));
  assert.equal(parsed?.version, 1);
  assert.deepEqual(parsed?.commands.map((command) => command.kind), ["expense", "expense", "income"]);
  assert.equal(parseV2AiProposalCommandsResponse(JSON.stringify({ version: 2, commands: [] })), null);
  assert.equal(parseV2AiProposalCommandsResponse(JSON.stringify({ version: 1, commands: [{ kind: "income", amountTwd: 800, description: "退款", payer: "self" }] })), null);
});

test("LINE deterministic parser distinguishes refunds from partner transfers", () => {
  assert.equal(parseV2LineIncome("退款1000退到我這邊 一人一半")?.receiver, "self");
  assert.equal(parseV2LineIncome("飯店退費800她收到")?.receiver, "partner");
  assert.equal(parseV2LineIncome("她轉500給我"), null);
  assert.deepEqual(parseV2LineTransfer("她轉500給我"), { amountTwd: 500, payer: "partner" });
});

test("LINE direct-post acknowledgement includes a safe V2 undo deep link", () => {
  const text = v2LineProposalText({ kind: "posted", transactionId: "10000000-0000-4000-8000-000000000001", ledgerId: "20000000-0000-4000-8000-000000000002", ledgerName: "共同生活", amountTwd: 500, description: "晚餐" });
  assert.match(text, /已記錄/);
  assert.match(text, /撤銷|LIFF/);
});

test("V3-1 proposal detail contract is explicit, bounded, and rejects unreviewable fields", () => {
  const owner = "20000000-0000-4000-8000-000000000001";
  const partner = "20000000-0000-4000-8000-000000000002";
  const command = {
    commandIndex: 0,
    commandId: "10000000-0000-4000-8000-000000000001:0",
    ledgerId: "10000000-0000-4000-8000-000000000002",
    ledgerName: "共同生活",
    type: "expense" as const,
    amountTwd: "100",
    occurredOn: "2026-09-22",
    description: "晚餐",
    category: "餐飲",
    categoryId: null,
    note: null,
    splitMethod: "equal" as const,
    payments: [{ userId: owner, amountTwd: "100" }],
    shares: [{ userId: owner, amountTwd: "50" }, { userId: partner, amountTwd: "50" }],
    validation: { state: "valid" as const, issues: [] },
  };
  const detail = v2ProposalDetailSchema.parse({
    proposalId: "10000000-0000-4000-8000-000000000001",
    coupleId: 1,
    createdAt: "2026-09-22T11:00:00.000Z",
    ledgerId: "10000000-0000-4000-8000-000000000002",
    ledgerName: "共同生活",
    ledgerVersion: 4,
    currentLedgerVersion: 4,
    status: "proposed",
    commands: [command],
    commandCount: 1,
    expiresAt: "2026-09-22T12:00:00.000Z",
    source: null,
    sourceSummary: null,
    revision: { revision: 1, parentProposalId: null, rootProposalId: "10000000-0000-4000-8000-000000000001", reason: null, source: null },
    validation: { state: "valid", issues: [], clarifications: [] },
    result: { proposal: { revision: 1 } },
  });
  assert.equal(detail.commands[0]?.shares[1]?.amountTwd, "50");
  const confirmation = v2ProposalConfirmationSchema.parse({
    proposalId: detail.proposalId,
    status: "confirmed",
    transactions: [{ amountTwd: "100" }],
    balance: { [owner]: "-50", [partner]: "50" },
    nextPayer: { payerUserId: owner, payeeUserId: partner, amountTwd: "50" },
    ledgerVersion: 5,
  });
  assert.equal(confirmation.balance[owner], "-50");
  assert.throws(() => v2ProposalDetailSchema.parse({ ...detail, commands: [{ ...command, currency: "USD" }] }));
  assert.throws(() => reviseV2ProposalInputSchema.parse({ commands: [] }));
});
