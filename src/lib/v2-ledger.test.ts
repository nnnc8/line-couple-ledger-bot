import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSettleAllTransfer,
  calculateLedgerBalance,
  calculateTransactionDelta,
  recommendNextPayer,
  splitEqual,
  splitExact,
  splitPercentage,
  splitWeights,
  twdToString,
  type V2LedgerMemberSet,
  type V2Transaction,
} from "./v2-ledger";

const ledger: V2LedgerMemberSet = {
  ledgerId: "ledger-trip",
  memberIds: ["alice", "bob"],
};

function expense(overrides: Partial<V2Transaction> = {}): V2Transaction {
  return {
    ledgerId: ledger.ledgerId,
    type: "expense",
    amountTwd: 101,
    payments: [{ userId: "alice", amountTwd: 101 }],
    shares: [
      { userId: "alice", amountTwd: 51 },
      { userId: "bob", amountTwd: 50 },
    ],
    ...overrides,
  };
}

test("TWD allocation is integer, deterministic, and sums exactly", () => {
  assert.deepEqual(splitEqual(101, ledger.memberIds), { alice: 51n, bob: 50n });
  assert.deepEqual(splitExact("101", ledger.memberIds, { alice: 60, bob: 41 }), {
    alice: 60n,
    bob: 41n,
  });
  assert.deepEqual(splitPercentage(101, ledger.memberIds, [50, 50]), {
    alice: 51n,
    bob: 50n,
  });
  assert.deepEqual(splitWeights(101, ledger.memberIds, [3, 2]), {
    alice: 61n,
    bob: 40n,
  });
});

test("expense delta supports multiple payers independently from shares", () => {
  const delta = calculateTransactionDelta(
    expense({
      amountTwd: 100,
      payments: [
        { userId: "alice", amountTwd: 60 },
        { userId: "bob", amountTwd: 40 },
      ],
      shares: [
        { userId: "alice", amountTwd: 50 },
        { userId: "bob", amountTwd: 50 },
      ],
    }),
    ledger,
  );
  assert.deepEqual(delta, { alice: 10n, bob: -10n });
});

test("income delta uses received payment minus entitled share in reverse", () => {
  const delta = calculateTransactionDelta(
    expense({
      type: "income",
      amountTwd: 100,
      payments: [{ userId: "alice", amountTwd: 100 }],
      shares: [
        { userId: "alice", amountTwd: 50 },
        { userId: "bob", amountTwd: 50 },
      ],
    }),
    ledger,
  );
  assert.deepEqual(delta, { alice: -50n, bob: 50n });
});

test("transfer is a first-class zero-sum transaction", () => {
  const delta = calculateTransactionDelta(
    expense({
      type: "transfer",
      amountTwd: 30,
      payments: [{ userId: "bob", amountTwd: 30 }],
      shares: [{ userId: "alice", amountTwd: 30 }],
    }),
    ledger,
  );
  assert.deepEqual(delta, { alice: -30n, bob: 30n });
});

test("ledger balance excludes voided/deleted rows and never crosses ledgers", () => {
  const balance = calculateLedgerBalance(
    [
      expense(),
      expense({
        id: "voided",
        amountTwd: 80,
        payments: [{ userId: "bob", amountTwd: 80 }],
        shares: [
          { userId: "alice", amountTwd: 40 },
          { userId: "bob", amountTwd: 40 },
        ],
        status: "voided",
      }),
    ],
    ledger,
  );
  assert.deepEqual(balance, { alice: 50n, bob: -50n });
});

test("settle-all recommends only the debtor's outstanding amount", () => {
  const balance = { alice: 51n, bob: -51n };
  assert.deepEqual(recommendNextPayer(balance, ledger.memberIds), {
    payerUserId: "bob",
    payeeUserId: "alice",
    amountTwd: 51n,
  });
  assert.deepEqual(buildSettleAllTransfer(ledger, balance), {
    ledgerId: ledger.ledgerId,
    type: "transfer",
    amountTwd: 51n,
    payments: [{ userId: "bob", amountTwd: 51n }],
    shares: [{ userId: "alice", amountTwd: 51n }],
  });
  assert.equal(buildSettleAllTransfer(ledger, { alice: 0, bob: 0 }), null);
});

test("invalid participant and conservation inputs are rejected", () => {
  assert.throws(
    () => calculateTransactionDelta(expense({ ledgerId: "other" }), ledger),
    /another ledger/,
  );
  assert.throws(
    () =>
      calculateTransactionDelta(
        expense({
          payments: [{ userId: "alice", amountTwd: 100 }],
        }),
        ledger,
      ),
    /payments must sum/,
  );
  assert.throws(() => splitPercentage(100, ledger.memberIds, [30, 30]), /sum to 100/);
  assert.throws(() => splitWeights(100, ledger.memberIds, [0, 0]), /positive sum/);
  assert.throws(() => calculateTransactionDelta(expense({
    type: "transfer",
    amountTwd: 30,
    payments: [{ userId: "alice", amountTwd: 30 }],
    shares: [{ userId: "alice", amountTwd: 30 }],
  }), ledger), /differ/);
  assert.throws(() => calculateTransactionDelta(expense({
    payments: [{ userId: "alice", amountTwd: 0 }],
  }), ledger), /positive/);
});

test("wire values stay integer strings", () => {
  assert.equal(twdToString(1234567890n), "1234567890");
});
