/**
 * Couple Ledger V2's small, deterministic accounting kernel.
 *
 * Amounts are accepted as safe integers or integer strings at the boundary
 * and represented as bigint internally. The database/API contract is
 * amount_twd bigint; no currency conversion belongs in this module.
 */

export type V2TransactionType = "expense" | "income" | "transfer";
export type V2SplitMethod = "none" | "equal" | "exact" | "percentage" | "weights";
export type V2TransactionStatus = "posted" | "voided" | "deleted";
export type TwdInput = bigint | number | string;

export interface V2Payment {
  userId: string;
  amountTwd: TwdInput;
}

export interface V2Share {
  userId: string;
  amountTwd: TwdInput;
}

export interface V2Transaction {
  id?: string;
  ledgerId: string;
  type: V2TransactionType;
  amountTwd: TwdInput;
  payments: V2Payment[];
  shares: V2Share[];
  status?: V2TransactionStatus;
  occurredOn?: string;
  description?: string;
  category?: string | null;
  note?: string | null;
  splitMethod?: V2SplitMethod;
  createdAt?: string;
  version?: number;
}

export interface V2LedgerMemberSet {
  ledgerId: string;
  memberIds: readonly [string, string];
}

export interface V2SettlementTransfer {
  ledgerId: string;
  type: "transfer";
  amountTwd: bigint;
  payments: [V2Payment];
  shares: [V2Share];
}

export interface V2NextPayer {
  payerUserId: string;
  payeeUserId: string;
  amountTwd: bigint;
}

const MAX_TWD = 100_000_000_000n;

function assertMemberPair(memberIds: readonly string[]): asserts memberIds is [string, string] {
  if (memberIds.length !== 2 || !memberIds[0] || !memberIds[1] || memberIds[0] === memberIds[1]) {
    throw new Error("a ledger must contain exactly two different members");
  }
}

function normalizeTwd(value: TwdInput, label = "amount_twd"): bigint {
  let normalized: bigint;
  if (typeof value === "bigint") {
    normalized = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
    normalized = BigInt(value);
  } else if (/^(0|[1-9][0-9]*)$/.test(value)) {
    normalized = BigInt(value);
  } else {
    throw new Error(`${label} must be a non-negative integer`);
  }
  if (normalized < 0n || normalized > MAX_TWD) {
    throw new Error(`${label} is outside the supported TWD range`);
  }
  return normalized;
}

function normalizeSignedTwd(value: TwdInput, label = "balance_twd"): bigint {
  let normalized: bigint;
  if (typeof value === "bigint") {
    normalized = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
    normalized = BigInt(value);
  } else if (/^-?(0|[1-9][0-9]*)$/.test(value)) {
    normalized = BigInt(value);
  } else {
    throw new Error(`${label} must be an integer`);
  }
  if (normalized < -MAX_TWD || normalized > MAX_TWD) {
    throw new Error(`${label} is outside the supported TWD range`);
  }
  return normalized;
}

function assertPositiveTwd(value: TwdInput, label: string): bigint {
  const normalized = normalizeTwd(value, label);
  if (normalized <= 0n) throw new Error(`${label} must be positive`);
  return normalized;
}

function assertUniqueMembers(memberIds: readonly string[], label: string): void {
  if (new Set(memberIds).size !== memberIds.length) {
    throw new Error(`${label} contains a duplicate user`);
  }
}

function assertExactMembers(
  memberIds: readonly [string, string],
  values: readonly { userId: string }[],
  label: string,
): void {
  assertUniqueMembers(values.map((value) => value.userId), label);
  if (values.length !== 2 || values.some((value) => !memberIds.includes(value.userId))) {
    throw new Error(`${label} must contain exactly the ledger's two members`);
  }
}

function sumAmounts(values: readonly { amountTwd: TwdInput }[], label: string): bigint {
  return values.reduce((sum, value) => sum + normalizeTwd(value.amountTwd, label), 0n);
}

function allocateProportionally(
  amountTwd: bigint,
  memberIds: readonly [string, string],
  numerators: readonly [bigint, bigint],
  denominator: bigint,
): Record<string, bigint> {
  if (denominator <= 0n || numerators.some((value) => value < 0n) || numerators[0] + numerators[1] !== denominator) {
    throw new Error("split weights must be non-negative and have a positive sum");
  }
  const first = (amountTwd * numerators[0]) / denominator;
  const second = (amountTwd * numerators[1]) / denominator;
  let remainder = amountTwd - first - second;
  const remainders: [bigint, bigint] = [
    (amountTwd * numerators[0]) % denominator,
    (amountTwd * numerators[1]) % denominator,
  ];
  const result: Record<string, bigint> = {
    [memberIds[0]]: first,
    [memberIds[1]]: second,
  };
  // Stable tie-break: the ledger's member order. Never use payer identity to
  // decide who receives an odd TWD.
  const order = remainders[0] >= remainders[1] ? [0, 1] : [1, 0];
  for (const index of order) {
    if (remainder === 0n) break;
    result[memberIds[index]!]! += 1n;
    remainder -= 1n;
  }
  return result;
}

export function splitEqual(
  amountTwd: TwdInput,
  memberIds: readonly [string, string],
): Record<string, bigint> {
  const amount = assertPositiveTwd(amountTwd, "amount_twd");
  assertMemberPair(memberIds);
  return allocateProportionally(amount, memberIds, [1n, 1n], 2n);
}

export function splitExact(
  amountTwd: TwdInput,
  memberIds: readonly [string, string],
  shares: Record<string, TwdInput>,
): Record<string, bigint> {
  const amount = assertPositiveTwd(amountTwd, "amount_twd");
  assertMemberPair(memberIds);
  const entries = memberIds.map((userId) => ({ userId, amountTwd: shares[userId] ?? 0 }));
  if (Object.keys(shares).some((userId) => !memberIds.includes(userId))) {
    throw new Error("exact shares contain a non-member");
  }
  if (entries.some((entry) => normalizeTwd(entry.amountTwd, "share amount") < 0n)) {
    throw new Error("exact shares must be non-negative");
  }
  if (sumAmounts(entries, "share amount") !== amount) {
    throw new Error("exact shares must sum to amount_twd");
  }
  return Object.fromEntries(entries.map((entry) => [entry.userId, normalizeTwd(entry.amountTwd)]));
}

function percentageBasisPoints(value: number): bigint {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error("percentages must be between 0 and 100");
  }
  const basisPoints = Math.round(value * 100);
  if (Math.abs(value * 100 - basisPoints) > 1e-8) {
    throw new Error("percentages support at most two decimal places");
  }
  return BigInt(basisPoints);
}

export function splitPercentage(
  amountTwd: TwdInput,
  memberIds: readonly [string, string],
  percentages: readonly [number, number],
): Record<string, bigint> {
  const amount = assertPositiveTwd(amountTwd, "amount_twd");
  assertMemberPair(memberIds);
  const basisPoints: [bigint, bigint] = [percentageBasisPoints(percentages[0]), percentageBasisPoints(percentages[1])];
  if (basisPoints[0] + basisPoints[1] !== 10_000n) {
    throw new Error("percentages must sum to 100");
  }
  return allocateProportionally(amount, memberIds, basisPoints, 10_000n);
}

export function splitWeights(
  amountTwd: TwdInput,
  memberIds: readonly [string, string],
  weights: readonly [TwdInput, TwdInput],
): Record<string, bigint> {
  const amount = assertPositiveTwd(amountTwd, "amount_twd");
  assertMemberPair(memberIds);
  const normalized: [bigint, bigint] = [normalizeTwd(weights[0], "weight"), normalizeTwd(weights[1], "weight")];
  return allocateProportionally(amount, memberIds, normalized, normalized[0] + normalized[1]);
}

export function validateV2Transaction(
  transaction: V2Transaction,
  ledger: V2LedgerMemberSet,
): void {
  assertMemberPair(ledger.memberIds);
  if (transaction.ledgerId !== ledger.ledgerId) throw new Error("transaction belongs to another ledger");
  const amount = assertPositiveTwd(transaction.amountTwd, "amount_twd");
  assertUniqueMembers(transaction.payments.map((payment) => payment.userId), "payments");
  if (transaction.type === "transfer") {
    if (transaction.payments.length !== 1 || transaction.shares.length !== 1) {
      throw new Error("transfer requires one payment and one share");
    }
    if (transaction.shares.some((share) => !ledger.memberIds.includes(share.userId))) {
      throw new Error("shares contain a non-member");
    }
    if (transaction.payments[0]!.userId === transaction.shares[0]!.userId) {
      throw new Error("transfer payer and receiver must differ");
    }
  } else {
    assertExactMembers(ledger.memberIds, transaction.shares, "shares");
    if (transaction.payments.length < 1 || transaction.payments.length > 2) {
      throw new Error("expense and income require one or two payments");
    }
  }
  if (transaction.payments.some((payment) => !ledger.memberIds.includes(payment.userId))) {
    throw new Error("payments contain a non-member");
  }
  if (transaction.payments.some((payment) => normalizeTwd(payment.amountTwd, "payment amount") <= 0n)) {
    throw new Error("payment amounts must be positive");
  }
  if (sumAmounts(transaction.payments, "payment amount") !== amount) {
    throw new Error("payments must sum to amount_twd");
  }
  if (sumAmounts(transaction.shares, "share amount") !== amount) {
    throw new Error("shares must sum to amount_twd");
  }
}

export function calculateTransactionDelta(
  transaction: V2Transaction,
  ledger: V2LedgerMemberSet,
): Record<string, bigint> {
  validateV2Transaction(transaction, ledger);
  const delta: Record<string, bigint> = Object.fromEntries(ledger.memberIds.map((userId) => [userId, 0n]));
  const payments = new Map(transaction.payments.map((payment) => [payment.userId, normalizeTwd(payment.amountTwd)]));
  const shares = new Map(transaction.shares.map((share) => [share.userId, normalizeTwd(share.amountTwd)]));
  for (const userId of ledger.memberIds) {
    const payment = payments.get(userId) ?? 0n;
    const share = shares.get(userId) ?? 0n;
    delta[userId] = transaction.type === "income" ? share - payment : payment - share;
  }
  return delta;
}

export function calculateLedgerBalance(
  transactions: readonly V2Transaction[],
  ledger: V2LedgerMemberSet,
): Record<string, bigint> {
  const balance: Record<string, bigint> = Object.fromEntries(ledger.memberIds.map((userId) => [userId, 0n]));
  for (const transaction of transactions) {
    if ((transaction.status ?? "posted") !== "posted") continue;
    const delta = calculateTransactionDelta(transaction, ledger);
    for (const userId of ledger.memberIds) balance[userId] += delta[userId]!;
  }
  if (balance[ledger.memberIds[0]!]! + balance[ledger.memberIds[1]!]! !== 0n) {
    throw new Error("ledger balance must be zero-sum");
  }
  return balance;
}

export function recommendNextPayer(
  balance: Record<string, TwdInput>,
  memberIds: readonly [string, string],
): V2NextPayer | null {
  assertMemberPair(memberIds);
  const first = normalizeSignedTwd(balance[memberIds[0]] ?? 0, "balance");
  const second = normalizeSignedTwd(balance[memberIds[1]] ?? 0, "balance");
  if (first + second !== 0n) throw new Error("balance must be zero-sum");
  if (first === 0n) return null;
  return first < 0n
    ? { payerUserId: memberIds[0], payeeUserId: memberIds[1], amountTwd: -first }
    : { payerUserId: memberIds[1], payeeUserId: memberIds[0], amountTwd: -second };
}

export function buildSettleAllTransfer(
  ledger: V2LedgerMemberSet,
  balance: Record<string, TwdInput>,
): V2SettlementTransfer | null {
  const recommendation = recommendNextPayer(balance, ledger.memberIds);
  if (!recommendation) return null;
  return {
    ledgerId: ledger.ledgerId,
    type: "transfer",
    amountTwd: recommendation.amountTwd,
    payments: [{ userId: recommendation.payerUserId, amountTwd: recommendation.amountTwd }],
    shares: [{ userId: recommendation.payeeUserId, amountTwd: recommendation.amountTwd }],
  };
}

export function twdToString(value: TwdInput): string {
  return normalizeTwd(value).toString();
}
