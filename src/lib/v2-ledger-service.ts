import { createHash, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { z } from "zod";

import { HttpError } from "./http-error";
import { withTx } from "./db/tx";
import { nextRecurringDate } from "./ledger";
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
  type V2Payment,
  type V2Share,
  type V2Transaction,
  type V2TransactionType,
  type V2TransactionStatus,
  type TwdInput,
} from "./v2-ledger";

const twdInputSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^(0|[1-9][0-9]*)$/, "TWD 必須是非負整數"),
]);

const idempotencyKeySchema = z.string().trim().min(1).max(100);

export const createLedgerInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict();

const defaultShareInputSchema = z.object({
  userId: z.string().uuid(),
  weight: twdInputSchema,
}).strict();

export const updateV2LedgerDefaultSharesInputSchema = z.object({
  shares: z.array(defaultShareInputSchema).length(2),
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict();

const participantAmountSchema = z.object({
  userId: z.string().uuid(),
  amountTwd: twdInputSchema,
}).strict();

const v2TransactionTypeFields = {
  type: z.enum(["expense", "income", "transfer"]),
  amountTwd: twdInputSchema,
  occurredOn: z.iso.date(),
  description: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(40).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  splitMethod: z.enum(["none", "equal", "exact", "percentage", "weights"]).optional(),
  payments: z.array(participantAmountSchema).min(1).max(2),
  shares: z.array(participantAmountSchema).min(1).max(2).optional(),
  percentages: z.tuple([z.number().min(0).max(100), z.number().min(0).max(100)]).optional(),
  exactShares: z.record(z.string().uuid(), twdInputSchema).optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
} as const;

export const createV2TransactionInputSchema = z.object(v2TransactionTypeFields).strict();

export const settleAllInputSchema = z.object({
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict();

export const createV2ProposalInputSchema = z.object({
  ledgerId: z.string().uuid(),
  commands: z.array(createV2TransactionInputSchema.omit({ idempotencyKey: true })).min(1).max(20),
  expiresInSeconds: z.number().int().min(30).max(15 * 60).optional(),
}).strict();

export const v2LineProposalDraftSchema = z.object({
  ledgerId: z.string().uuid(),
  type: z.enum(["expense", "income", "transfer"]),
  amountTwd: twdInputSchema,
  occurredOn: z.iso.date(),
  description: z.string().trim().min(1).max(120),
  payments: z.array(participantAmountSchema).min(1).max(2),
  shares: z.array(participantAmountSchema).min(1).max(2).optional(),
  splitMethod: z.enum(["none", "equal", "exact", "percentage", "weights"]).optional(),
  category: z.string().trim().min(1).max(40).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
}).strict();

export type V2LineProposalDraft = z.infer<typeof v2LineProposalDraftSchema>;

const recurringFrequencySchema = z.enum(["weekly", "monthly", "yearly"]);
const recurringRuleIdSchema = z.string().uuid();

export const createV2RecurringRuleInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  amountTwd: twdInputSchema.refine((value) => BigInt(value) > 0n, "金額必須大於 0"),
  frequency: recurringFrequencySchema,
  nextRunDate: z.iso.date(),
  endDate: z.iso.date().nullable().optional(),
  splitMethod: z.enum(["equal", "exact", "percentage", "weights"]),
  payments: z.array(participantAmountSchema).min(1).max(2),
  shares: z.array(participantAmountSchema).min(1).max(2).optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict().superRefine((value, context) => {
  if (!value.shares && value.splitMethod !== "weights") {
    context.addIssue({ code: "custom", path: ["shares"], message: "非 weights recurring rule 必須指定 shares" });
  }
});

export const toggleV2RecurringRuleInputSchema = z.object({
  active: z.boolean(),
}).strict();

export const mutateV2TransactionInputSchema = z.object({
  action: z.enum(["void", "restore", "replace"]),
  expectedVersion: z.number().int().positive(),
  replacement: createV2TransactionInputSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.action === "replace" && !value.replacement) {
    context.addIssue({ code: "custom", path: ["replacement"], message: "replace 需要 replacement" });
  }
  if (value.action !== "replace" && value.replacement) {
    context.addIssue({ code: "custom", path: ["replacement"], message: "只有 replace 可以附帶 replacement" });
  }
});

export type CreateV2RecurringRuleInput = z.infer<typeof createV2RecurringRuleInputSchema>;

export type CreateLedgerInput = z.infer<typeof createLedgerInputSchema>;
export type CreateV2TransactionInput = z.infer<typeof createV2TransactionInputSchema>;
export type CreateV2ProposalInput = z.infer<typeof createV2ProposalInputSchema>;
export type UpdateV2LedgerDefaultSharesInput = z.infer<typeof updateV2LedgerDefaultSharesInputSchema>;

interface RecurringRuleRow extends QueryResultRow {
  id: string;
  couple_id: number;
  ledger_id: string;
  created_by_user_id: string;
  name: string;
  amount_twd: string | number;
  frequency: "weekly" | "monthly" | "yearly";
  anchor_day: number;
  next_run_date: string;
  end_date: string | null;
  active: boolean;
  split_method: "equal" | "exact" | "percentage" | "weights";
  payments: unknown;
  shares: unknown;
  version: number;
  created_at: string;
  updated_at: string;
}

interface LedgerRow extends QueryResultRow {
  id: string;
  couple_id: number;
  name: string;
  color: string;
  status: "active" | "archived";
  version: number;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

interface MemberRow extends QueryResultRow {
  user_id: string;
  role: "owner" | "partner";
}

interface DefaultShareRow extends QueryResultRow {
  user_id: string;
  weight: string | number;
}

interface TransactionRow extends QueryResultRow {
  id: string;
  ledger_id: string;
  couple_id: number;
  type: V2TransactionType;
  amount_twd: string | number;
  occurred_on: string;
  description: string;
  category: string | null;
  note: string | null;
  split_method: "none" | "equal" | "exact" | "percentage" | "weights";
  status: "posted" | "voided" | "deleted";
  version: number;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

interface TransactionMutationRow extends QueryResultRow {
  id: string;
  ledger_id: string;
  couple_id: number;
  status: V2TransactionStatus;
  version: number;
  voided_at: string | null;
}

interface ChildRow extends QueryResultRow {
  transaction_id: string;
  user_id: string;
  amount_twd: string | number;
}

interface LoadedLedger {
  row: LedgerRow;
  members: V2LedgerMemberSet;
  memberRoles: Record<string, "owner" | "partner">;
  defaultWeights: [bigint, bigint];
  transactions: V2Transaction[];
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function asBigint(value: string | number | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function serializedTransaction(transaction: V2Transaction) {
  return {
    ...transaction,
    amountTwd: twdToString(transaction.amountTwd),
    payments: transaction.payments.map((payment) => ({
      ...payment,
      amountTwd: twdToString(payment.amountTwd),
    })),
    shares: transaction.shares.map((share) => ({
      ...share,
      amountTwd: twdToString(share.amountTwd),
    })),
  };
}

function serializedBalance(balance: Record<string, bigint>) {
  return Object.fromEntries(Object.entries(balance).map(([userId, amount]) => [userId, amount.toString()]));
}

async function assertV2Writer(client: PoolClient, coupleId: number): Promise<void> {
  const result = await client.query<{ active_plane: string; mutation_fence: boolean }>(
    `select active_plane, mutation_fence
       from ledger_v2.writer_control
      where couple_id = $1
      for update`,
    [coupleId],
  );
  const control = result.rows[0];
  if (!control || control.active_plane !== "v2" || control.mutation_fence) {
    throw new HttpError(409, "V2 writer 尚未啟用或目前正在切換");
  }
}

async function setActiveLedger(client: PoolClient, coupleId: number, userId: string, ledgerId: string): Promise<void> {
  await client.query(
    `insert into ledger_v2.user_preferences (user_id, couple_id, active_ledger_id)
     values ($1, $2, $3)
     on conflict (user_id) do update
       set couple_id = excluded.couple_id,
           active_ledger_id = excluded.active_ledger_id,
           updated_at = now()`,
    [userId, coupleId, ledgerId],
  );
}

async function loadLedger(client: PoolClient, coupleId: number, ledgerId: string, lock = false): Promise<LoadedLedger> {
  const ledgerResult = await client.query<LedgerRow>(
    `select id, couple_id, name, color, status, version, created_by_user_id,
            created_at, updated_at
       from ledger_v2.ledgers
      where id = $1 and couple_id = $2
      ${lock ? "for update" : ""}`,
    [ledgerId, coupleId],
  );
  const row = ledgerResult.rows[0];
  if (!row) throw new HttpError(404, "Ledger 不存在");
  if (row.status !== "active") throw new HttpError(409, "Ledger 已封存");

  const [memberResult, defaultResult, transactionResult, paymentResult, shareResult] = await Promise.all([
    client.query<MemberRow>(
      `select lm.user_id, u.role
         from ledger_v2.ledger_members lm
         join public.users u on u.id = lm.user_id and u.couple_id = lm.couple_id
        where lm.ledger_id = $1 and lm.couple_id = $2
        order by case u.role when 'owner' then 0 else 1 end`,
      [ledgerId, coupleId],
    ),
    client.query<DefaultShareRow>(
      `select user_id, weight
         from ledger_v2.ledger_default_shares
        where ledger_id = $1 and couple_id = $2
        order by user_id`,
      [ledgerId, coupleId],
    ),
    client.query<TransactionRow>(
      `select id, ledger_id, couple_id, type, amount_twd, occurred_on,
              description, category, note, split_method, status, version,
              created_by_user_id, created_at, updated_at
         from ledger_v2.transactions
        where ledger_id = $1 and couple_id = $2
        order by occurred_on desc, created_at desc, id desc`,
      [ledgerId, coupleId],
    ),
    client.query<ChildRow>(
      `select transaction_id, user_id, amount_twd
         from ledger_v2.transaction_payments
        where ledger_id = $1 and couple_id = $2`,
      [ledgerId, coupleId],
    ),
    client.query<ChildRow>(
      `select transaction_id, user_id, amount_twd
         from ledger_v2.transaction_shares
        where ledger_id = $1 and couple_id = $2`,
      [ledgerId, coupleId],
    ),
  ]);

  if (memberResult.rows.length !== 2 || defaultResult.rows.length !== 2) {
    throw new HttpError(500, "Ledger 成員或預設分攤設定損壞");
  }
  const memberIds = memberResult.rows.map((member) => member.user_id);
  if (memberIds[0] === memberIds[1]) throw new HttpError(500, "Ledger 成員設定損壞");
  const members: V2LedgerMemberSet = {
    ledgerId,
    memberIds: [memberIds[0]!, memberIds[1]!],
  };
  const defaultByUser = new Map(defaultResult.rows.map((entry) => [entry.user_id, asBigint(entry.weight)]));
  const defaultWeights: [bigint, bigint] = [
    defaultByUser.get(members.memberIds[0]!) ?? 0n,
    defaultByUser.get(members.memberIds[1]!) ?? 0n,
  ];
  if (defaultWeights[0] <= 0n || defaultWeights[1] <= 0n) {
    throw new HttpError(500, "Ledger 預設分攤權重損壞");
  }
  const paymentsByTransaction = new Map<string, V2Payment[]>();
  for (const payment of paymentResult.rows) {
    const list = paymentsByTransaction.get(payment.transaction_id) ?? [];
    list.push({ userId: payment.user_id, amountTwd: asBigint(payment.amount_twd) });
    paymentsByTransaction.set(payment.transaction_id, list);
  }
  const sharesByTransaction = new Map<string, V2Share[]>();
  for (const share of shareResult.rows) {
    const list = sharesByTransaction.get(share.transaction_id) ?? [];
    list.push({ userId: share.user_id, amountTwd: asBigint(share.amount_twd) });
    sharesByTransaction.set(share.transaction_id, list);
  }
  const transactions = transactionResult.rows.map((transaction) => ({
    id: transaction.id,
    ledgerId,
    type: transaction.type,
    amountTwd: asBigint(transaction.amount_twd),
    payments: paymentsByTransaction.get(transaction.id) ?? [],
    shares: sharesByTransaction.get(transaction.id) ?? [],
    status: transaction.status,
    occurredOn: transaction.occurred_on,
    description: transaction.description,
    category: transaction.category,
    note: transaction.note,
    splitMethod: transaction.split_method,
    createdAt: transaction.created_at,
    version: transaction.version,
  }));
  return {
    row,
    members,
    memberRoles: Object.fromEntries(memberResult.rows.map((member) => [member.user_id, member.role])),
    defaultWeights,
    transactions,
  };
}

async function assertCoupleHasExactlyTwoMembers(client: PoolClient, coupleId: number): Promise<void> {
  const result = await client.query<{ count: string }>(
    `select count(*)::text as count from public.users where couple_id = $1`,
    [coupleId],
  );
  if (result.rows[0]?.count !== "2") {
    throw new HttpError(409, "Couple 必須正好有兩位成員");
  }
}

async function findReceipt(client: PoolClient, coupleId: number, idempotencyKey: string, hash: string) {
  const result = await client.query<{ request_hash: string; result: unknown }>(
    `select request_hash, result
       from ledger_v2.command_receipts
      where couple_id = $1 and idempotency_key = $2
      for update`,
    [coupleId, idempotencyKey],
  );
  const receipt = result.rows[0];
  if (!receipt) return null;
  if (receipt.request_hash !== hash) throw new HttpError(409, "同一 idempotency key 對應到不同請求");
  return receipt.result;
}

async function saveReceipt(
  client: PoolClient,
  coupleId: number,
  ledgerId: string | null,
  idempotencyKey: string,
  hash: string,
  result: unknown,
  userId: string,
): Promise<void> {
  await client.query(
    `insert into ledger_v2.command_receipts
      (couple_id, ledger_id, idempotency_key, request_hash, status, result, created_by_user_id)
     values ($1, $2, $3, $4, 'applied', $5::jsonb, $6)`,
    [coupleId, ledgerId, idempotencyKey, hash, JSON.stringify(result), userId],
  );
}

function buildShares(
  input: CreateV2TransactionInput,
  ledger: LoadedLedger,
): V2Share[] {
  const amount = input.amountTwd;
  if (input.shares) return input.shares.map((share) => ({ userId: share.userId, amountTwd: share.amountTwd }));
  if (input.type === "transfer") throw new HttpError(422, "轉帳必須指定收款人");
  switch (input.splitMethod ?? "weights") {
    case "equal":
      return Object.entries(splitEqual(amount, ledger.members.memberIds)).map(([userId, amountTwd]) => ({ userId, amountTwd }));
    case "weights":
      return Object.entries(splitWeights(amount, ledger.members.memberIds, ledger.defaultWeights)).map(([userId, amountTwd]) => ({ userId, amountTwd }));
    case "exact":
      if (!input.exactShares) throw new HttpError(422, "exact 分攤需要 shares");
      return Object.entries(splitExact(amount, ledger.members.memberIds, input.exactShares)).map(([userId, amountTwd]) => ({ userId, amountTwd }));
    case "percentage":
      if (!input.percentages) throw new HttpError(422, "percentage 分攤需要 percentages");
      return Object.entries(splitPercentage(amount, ledger.members.memberIds, input.percentages)).map(([userId, amountTwd]) => ({ userId, amountTwd }));
    default:
      throw new HttpError(422, "不支援的分攤方式");
  }
}

async function assertLedgerMember(client: PoolClient, coupleId: number, userId: string, ledgerId: string): Promise<void> {
  const result = await client.query<{ id: string }>(
    `select l.id
       from ledger_v2.ledgers l
       join ledger_v2.ledger_members lm
         on lm.ledger_id = l.id and lm.couple_id = l.couple_id
      where l.id = $1 and l.couple_id = $2 and l.status = 'active' and lm.user_id = $3`,
    [ledgerId, coupleId, userId],
  );
  if (!result.rows[0]) throw new HttpError(404, "Ledger 不存在或無權限");
}

async function insertTransaction(
  client: PoolClient,
  ledger: LoadedLedger,
  actorUserId: string,
  input: CreateV2TransactionInput,
): Promise<{ transaction: V2Transaction; balance: Record<string, bigint> }> {
  const shares = buildShares(input, ledger);
  const transaction: V2Transaction = {
    ledgerId: ledger.members.ledgerId,
    type: input.type,
    amountTwd: input.amountTwd,
    payments: input.payments,
    shares,
    occurredOn: input.occurredOn,
    description: input.description,
    category: input.category ?? null,
    note: input.note ?? null,
    splitMethod: input.type === "transfer" ? "none" : input.splitMethod ?? "weights",
    version: 1,
  };
  calculateTransactionDelta(transaction, ledger.members);
  const id = randomUUID();
  await client.query(
    `insert into ledger_v2.transactions
      (id, couple_id, ledger_id, type, amount_twd, occurred_on, description,
       category, note, split_method, created_by_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      ledger.row.couple_id,
      ledger.members.ledgerId,
      input.type,
      twdToString(input.amountTwd),
      input.occurredOn,
      input.description,
      input.category ?? null,
      input.note ?? null,
      input.type === "transfer" ? "none" : input.splitMethod ?? "weights",
      actorUserId,
    ],
  );
  for (const payment of transaction.payments) {
    await client.query(
      `insert into ledger_v2.transaction_payments
        (transaction_id, ledger_id, couple_id, user_id, amount_twd)
       values ($1, $2, $3, $4, $5)`,
      [id, ledger.members.ledgerId, ledger.row.couple_id, payment.userId, twdToString(payment.amountTwd)],
    );
  }
  for (const share of transaction.shares) {
    await client.query(
      `insert into ledger_v2.transaction_shares
        (transaction_id, ledger_id, couple_id, user_id, amount_twd)
       values ($1, $2, $3, $4, $5)`,
      [id, ledger.members.ledgerId, ledger.row.couple_id, share.userId, twdToString(share.amountTwd)],
    );
  }
  const postedTransaction = { ...transaction, id };
  await client.query(
    `insert into ledger_v2.transaction_events
      (couple_id, ledger_id, transaction_id, actor_user_id, action, after_state)
     values ($1, $2, $3, $4, 'create', $5::jsonb)`,
    [ledger.row.couple_id, ledger.members.ledgerId, id, actorUserId, JSON.stringify(serializedTransaction(postedTransaction))],
  );
  await client.query(
    `update ledger_v2.ledgers
        set version = version + 1, updated_at = now()
      where id = $1 and couple_id = $2`,
    [ledger.members.ledgerId, ledger.row.couple_id],
  );
  const recipientUserId = ledger.members.memberIds.find((userId) => userId !== actorUserId);
  if (recipientUserId) {
    await client.query(
      `insert into ledger_v2.notification_outbox
        (couple_id, recipient_user_id, kind, dedupe_key, payload)
       values ($1, $2, 'ledger_transaction', $3, $4::jsonb)
       on conflict (dedupe_key) do nothing`,
      [
        ledger.row.couple_id,
        recipientUserId,
        `v2:transaction:${id}:user:${recipientUserId}`,
        JSON.stringify({
          title: transaction.type === "expense" ? "Ledger 有新支出" : transaction.type === "income" ? "Ledger 有新收入" : "Ledger 有新轉帳",
          message: `${transaction.description ?? "交易"} NT$${twdToString(transaction.amountTwd)}`,
          ledgerId: ledger.members.ledgerId,
          transactionId: id,
        }),
      ],
    );
  }
  const balance = calculateLedgerBalance([...ledger.transactions, postedTransaction], ledger.members);
  return { transaction: postedTransaction, balance };
}

export async function listV2Ledgers(coupleId: number) {
  return withTx(async (client) => {
    const result = await client.query<LedgerRow>(
      `select l.id, l.couple_id, l.name, l.color, l.status, l.version, l.created_by_user_id, l.created_at, l.updated_at
         from ledger_v2.ledgers l
        where l.couple_id = $1
          and exists (
            select 1 from ledger_v2.ledger_members lm
             where lm.ledger_id = l.id and lm.couple_id = l.couple_id
          )
        order by l.created_at asc, l.id asc`,
      [coupleId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      status: row.status,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  });
}

export async function listV2UserLedgers(coupleId: number, userId: string) {
  return withTx(async (client) => {
    await assertCoupleHasExactlyTwoMembers(client, coupleId);
    const result = await client.query<LedgerRow & { member_count: string | number; active_for_user: boolean }>(
      `select l.id, l.couple_id, l.name, l.color, l.status, l.version,
              l.created_by_user_id, l.created_at, l.updated_at,
              count(lm.user_id)::int as member_count,
              exists (
                select 1 from ledger_v2.user_preferences pref
                 where pref.user_id = $2
                   and pref.couple_id = l.couple_id
                   and pref.active_ledger_id = l.id
              ) as active_for_user
         from ledger_v2.ledgers l
         join ledger_v2.ledger_members lm
           on lm.ledger_id = l.id and lm.couple_id = l.couple_id
        where l.couple_id = $1
          and l.status = 'active'
          and exists (
            select 1 from ledger_v2.ledger_members mine
             where mine.ledger_id = l.id
               and mine.couple_id = l.couple_id
               and mine.user_id = $2
          )
        group by l.id
       having count(lm.user_id) = 2
        order by l.created_at asc, l.id asc`,
      [coupleId, userId],
    );
    const ordered = [...result.rows].sort((left, right) => Number(right.active_for_user) - Number(left.active_for_user));
    return ordered.map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      status: row.status,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  });
}

export async function listV2LedgerStatistics(
  coupleId: number,
  userId: string,
  ledgerId: string,
  filters: { from?: string | null; to?: string | null } = {},
) {
  return withTx(async (client) => {
    await assertLedgerMember(client, coupleId, userId, ledgerId);
    const ledger = await loadLedger(client, coupleId, ledgerId);
    const values: unknown[] = [coupleId, ledgerId];
    const where = ["t.couple_id = $1", "t.ledger_id = $2", "t.status = 'posted'"];
    if (filters.from) {
      values.push(filters.from);
      where.push(`t.occurred_on >= $${values.length}`);
    }
    if (filters.to) {
      values.push(filters.to);
      where.push(`t.occurred_on <= $${values.length}`);
    }
    const result = await client.query<{
      id: string;
      type: V2TransactionType;
      category: string | null;
      amount_twd: string | number;
      user_id: string;
      payment_twd: string | number;
      share_twd: string | number;
    }>(
      `select t.id, t.type, t.category, t.amount_twd, u.id as user_id,
              coalesce(p.amount_twd, 0) as payment_twd,
              coalesce(s.amount_twd, 0) as share_twd
         from ledger_v2.transactions t
         join ledger_v2.ledger_members lm on lm.ledger_id = t.ledger_id and lm.couple_id = t.couple_id
         join public.users u on u.id = lm.user_id and u.couple_id = t.couple_id
         left join ledger_v2.transaction_payments p
           on p.transaction_id = t.id and p.user_id = u.id
         left join ledger_v2.transaction_shares s
           on s.transaction_id = t.id and s.user_id = u.id
        where ${where.join(" and ")}
          and t.type <> 'transfer'
        order by t.id, u.id`,
      values,
    );
    const byCategory: Record<string, string> = {};
    const byType: Record<string, string> = { expense: "0", income: "0", transfer: "0" };
    const paidBy: Record<string, string> = Object.fromEntries(ledger.members.memberIds.map((id) => [id, "0"]));
    const borneBy: Record<string, string> = Object.fromEntries(ledger.members.memberIds.map((id) => [id, "0"]));
    const seen = new Set<string>();
    for (const row of result.rows) {
      const amount = asBigint(row.amount_twd);
      if (!seen.has(row.id)) {
        byType[row.type] = (BigInt(byType[row.type] ?? "0") + amount).toString();
        if (row.category) byCategory[row.category] = (BigInt(byCategory[row.category] ?? "0") + amount).toString();
      }
      seen.add(row.id);
      paidBy[row.user_id] = (BigInt(paidBy[row.user_id] ?? "0") + asBigint(row.payment_twd)).toString();
      borneBy[row.user_id] = (BigInt(borneBy[row.user_id] ?? "0") + asBigint(row.share_twd)).toString();
    }
    return { from: filters.from ?? null, to: filters.to ?? null, byType, byCategory, paidBy, borneBy };
  });
}

export async function listV2LedgerTransactions(
  coupleId: number,
  userId: string,
  ledgerId: string,
  filters: { type?: string | null; category?: string | null; payerUserId?: string | null; from?: string | null; to?: string | null; q?: string | null } = {},
) {
  return withTx(async (client) => {
    await assertLedgerMember(client, coupleId, userId, ledgerId);
    const values: unknown[] = [coupleId, ledgerId];
    const where = ["t.couple_id = $1", "t.ledger_id = $2"];
    if (filters.type && ["expense", "income", "transfer"].includes(filters.type)) {
      values.push(filters.type);
      where.push(`t.type = $${values.length}`);
    }
    if (filters.category?.trim()) {
      values.push(filters.category.trim());
      where.push(`t.category = $${values.length}`);
    }
    if (filters.payerUserId) {
      values.push(filters.payerUserId);
      where.push(`exists (select 1 from ledger_v2.transaction_payments payer_filter where payer_filter.transaction_id = t.id and payer_filter.user_id = $${values.length})`);
    }
    if (filters.from) {
      values.push(filters.from);
      where.push(`t.occurred_on >= $${values.length}`);
    }
    if (filters.to) {
      values.push(filters.to);
      where.push(`t.occurred_on <= $${values.length}`);
    }
    if (filters.q?.trim()) {
      values.push(`%${filters.q.trim()}%`);
      where.push(`(t.description ilike $${values.length} or coalesce(t.note, '') ilike $${values.length} or coalesce(t.category, '') ilike $${values.length})`);
    }
    const result = await client.query<TransactionRow>(
      `select t.id, t.ledger_id, t.couple_id, t.type, t.amount_twd, t.occurred_on,
              t.description, t.category, t.note, t.split_method, t.status, t.version,
              t.created_by_user_id, t.created_at, t.updated_at
         from ledger_v2.transactions t
        where ${where.join(" and ")}
        order by t.occurred_on desc, t.created_at desc, t.id desc
        limit 200`,
      values,
    );
    const transactionIds = result.rows.map((row) => row.id);
    const [paymentResult, shareResult] = transactionIds.length
      ? await Promise.all([
          client.query<ChildRow>(
            `select transaction_id, user_id, amount_twd
               from ledger_v2.transaction_payments
              where ledger_id = $1 and couple_id = $2 and transaction_id = any($3::uuid[])`,
            [ledgerId, coupleId, transactionIds],
          ),
          client.query<ChildRow>(
            `select transaction_id, user_id, amount_twd
               from ledger_v2.transaction_shares
              where ledger_id = $1 and couple_id = $2 and transaction_id = any($3::uuid[])`,
            [ledgerId, coupleId, transactionIds],
          ),
        ])
      : [{ rows: [] as ChildRow[] }, { rows: [] as ChildRow[] }];
    const paymentsByTransaction = new Map<string, V2Payment[]>();
    for (const payment of paymentResult.rows) {
      const list = paymentsByTransaction.get(payment.transaction_id) ?? [];
      list.push({ userId: payment.user_id, amountTwd: asBigint(payment.amount_twd) });
      paymentsByTransaction.set(payment.transaction_id, list);
    }
    const sharesByTransaction = new Map<string, V2Share[]>();
    for (const share of shareResult.rows) {
      const list = sharesByTransaction.get(share.transaction_id) ?? [];
      list.push({ userId: share.user_id, amountTwd: asBigint(share.amount_twd) });
      sharesByTransaction.set(share.transaction_id, list);
    }
    return { transactions: result.rows.map((row) => ({
      id: row.id,
      ledgerId: row.ledger_id,
      type: row.type,
      amountTwd: twdToString(asBigint(row.amount_twd)),
      payments: (paymentsByTransaction.get(row.id) ?? []).map((payment) => ({ userId: payment.userId, amountTwd: twdToString(payment.amountTwd) })),
      shares: (sharesByTransaction.get(row.id) ?? []).map((share) => ({ userId: share.userId, amountTwd: twdToString(share.amountTwd) })),
      occurredOn: row.occurred_on,
      description: row.description,
      category: row.category,
      note: row.note,
      splitMethod: row.split_method,
      status: row.status,
      version: row.version,
    })) };
  });
}

export async function updateV2LedgerDefaultShares(
  coupleId: number,
  actorUserId: string,
  ledgerId: string,
  rawInput: unknown,
) {
  const input = updateV2LedgerDefaultSharesInputSchema.parse(rawInput);
  const idempotencyKey = input.idempotencyKey ?? `ledger-defaults:${ledgerId}:${randomUUID()}`;
  const hash = requestHash({ ledgerId, shares: input.shares });
  return withTx(async (client) => {
    await assertV2Writer(client, coupleId);
    const existing = await findReceipt(client, coupleId, idempotencyKey, hash);
    if (existing) return existing;
    const ledger = await loadLedger(client, coupleId, ledgerId, true);
    await assertLedgerMember(client, coupleId, actorUserId, ledgerId);
    const memberIds = new Set(ledger.members.memberIds);
    if (new Set(input.shares.map((share) => share.userId)).size !== 2 || input.shares.some((share) => !memberIds.has(share.userId) || BigInt(share.weight) <= 0n)) {
      throw new HttpError(422, "預設分攤必須是兩位成員的正整數權重");
    }
    for (const share of input.shares) {
      await client.query(
        `update ledger_v2.ledger_default_shares
            set weight = $4
          where ledger_id = $1 and couple_id = $2 and user_id = $3`,
        [ledgerId, coupleId, share.userId, twdToString(share.weight)],
      );
    }
    await client.query(
      `update ledger_v2.ledgers set version = version + 1, updated_at = now()
        where id = $1 and couple_id = $2`,
      [ledgerId, coupleId],
    );
    const result = {
      ledgerId,
      defaultShares: Object.fromEntries(input.shares.map((share) => [share.userId, twdToString(share.weight)])),
      ledgerVersion: ledger.row.version + 1,
    };
    await saveReceipt(client, coupleId, ledgerId, idempotencyKey, hash, result, actorUserId);
    return result;
  });
}

function csvCell(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const text = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${text.replaceAll('"', '""')}"`;
}

export async function exportV2LedgerCsv(
  coupleId: number,
  userId: string,
  ledgerId: string,
  filters: Parameters<typeof listV2LedgerTransactions>[3] = {},
): Promise<string> {
  const rows = (await listV2LedgerTransactions(coupleId, userId, ledgerId, filters)).transactions;
  const header = ["occurred_on", "type", "description", "category", "amount_twd", "payments", "shares", "note", "status"];
  const body = rows.map((row) => [
    row.occurredOn,
    row.type,
    row.description,
    row.category ?? "",
    row.amountTwd,
    row.payments,
    row.shares,
    row.note ?? "",
    row.status,
  ].map(csvCell).join(","));
  return [header.map(csvCell).join(","), ...body].join("\n") + "\n";
}

export async function mutateV2Transaction(
  coupleId: number,
  actorUserId: string,
  transactionId: string,
  rawInput: unknown,
) {
  const input = mutateV2TransactionInputSchema.parse(rawInput);
  const id = z.string().uuid().parse(transactionId);
  const idempotencyKey = input.idempotencyKey ?? `transaction-mutate:${id}:${randomUUID()}`;
  const hash = requestHash({
    transactionId: id,
    action: input.action,
    expectedVersion: input.expectedVersion,
    replacement: input.replacement ?? null,
  });
  return withTx(async (client) => {
    await assertV2Writer(client, coupleId);
    const existing = await findReceipt(client, coupleId, idempotencyKey, hash);
    if (existing) return existing;
    const rowResult = await client.query<TransactionMutationRow>(
      `select t.id, t.ledger_id, t.couple_id, t.status, t.version, t.voided_at
         from ledger_v2.transactions t
         join ledger_v2.ledger_members lm on lm.ledger_id = t.ledger_id and lm.couple_id = t.couple_id
        where t.id = $1 and t.couple_id = $2 and lm.user_id = $3
        for update`,
      [id, coupleId, actorUserId],
    );
    const row = rowResult.rows[0];
    if (!row) throw new HttpError(404, "Transaction 不存在或無權限");
    if (row.version !== input.expectedVersion) throw new HttpError(409, "Transaction 已被其他更新修改");
    const nextStatus = input.action === "void" ? "voided" : "posted";
    if (input.action === "void" && row.status !== "posted") throw new HttpError(409, "只有已入帳交易可以作廢");
    if (input.action === "restore" && row.status !== "voided") throw new HttpError(409, "只有已作廢交易可以恢復");
    if (input.action === "replace" && row.status !== "posted") throw new HttpError(409, "只有已入帳交易可以修改");
    if (input.action === "replace") {
      const ledger = await loadLedger(client, coupleId, row.ledger_id, true);
      const replacement = input.replacement!;
      const shares = buildShares(replacement, ledger);
      const replacementTransaction: V2Transaction = {
        ledgerId: row.ledger_id,
        type: replacement.type,
        amountTwd: replacement.amountTwd,
        payments: replacement.payments,
        shares,
      };
      calculateTransactionDelta(replacementTransaction, ledger.members);
      await client.query(
        `update ledger_v2.transactions
            set status = 'voided', version = version + 1, voided_at = now(), updated_at = now()
          where id = $1 and couple_id = $2 and version = $3`,
        [id, coupleId, input.expectedVersion],
      );
      await client.query(
        `update ledger_v2.ledgers
            set version = version + 1, updated_at = now()
          where id = $1 and couple_id = $2`,
        [row.ledger_id, coupleId],
      );
      await client.query(
        `insert into ledger_v2.transaction_events
          (couple_id, ledger_id, transaction_id, actor_user_id, action, before_state, after_state)
         values ($1, $2, $3, $4, 'update', $5::jsonb, $6::jsonb)`,
        [coupleId, row.ledger_id, id, actorUserId, JSON.stringify({ status: row.status, version: row.version }), JSON.stringify({ status: "voided", version: row.version + 1, replacement: serializedTransaction(replacementTransaction) })],
      );
      const refreshedLedger = await loadLedger(client, coupleId, row.ledger_id, true);
      const written = await insertTransaction(client, refreshedLedger, actorUserId, replacement);
      refreshedLedger.row.version += 1;
      const result = { ok: true, replacedTransactionId: id, transaction: serializedTransaction(written.transaction), balance: serializedBalance(written.balance), version: row.version + 1, ledgerVersion: refreshedLedger.row.version };
      await saveReceipt(client, coupleId, row.ledger_id, idempotencyKey, hash, result, actorUserId);
      return result;
    }
    await client.query(
      `update ledger_v2.transactions
          set status = $2, version = version + 1,
              voided_at = case when $2 = 'voided' then now() else null end,
              updated_at = now()
        where id = $1 and couple_id = $3 and version = $4`,
      [id, nextStatus, coupleId, input.expectedVersion],
    );
    await client.query(
      `update ledger_v2.ledgers
          set version = version + 1, updated_at = now()
        where id = $1 and couple_id = $2`,
      [row.ledger_id, coupleId],
    );
    await client.query(
      `insert into ledger_v2.transaction_events
        (couple_id, ledger_id, transaction_id, actor_user_id, action, before_state, after_state)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
      [
        coupleId,
        row.ledger_id,
        id,
        actorUserId,
        input.action,
        JSON.stringify({ status: row.status, version: row.version, voidedAt: row.voided_at }),
        JSON.stringify({ status: nextStatus, version: row.version + 1 }),
      ],
    );
    const ledger = await loadLedger(client, coupleId, row.ledger_id);
    const result = {
      ok: true,
      transactionId: id,
      status: nextStatus,
      version: row.version + 1,
      balance: serializedBalance(calculateLedgerBalance(ledger.transactions, ledger.members)),
      ledgerVersion: ledger.row.version,
    };
    await saveReceipt(client, coupleId, row.ledger_id, idempotencyKey, hash, result, actorUserId);
    return result;
  });
}

export async function activateV2Ledger(coupleId: number, userId: string, ledgerId: string) {
  return withTx(async (client) => {
    await assertCoupleHasExactlyTwoMembers(client, coupleId);
    const ledger = await loadLedger(client, coupleId, ledgerId);
    await assertLedgerMember(client, coupleId, userId, ledgerId);
    await setActiveLedger(client, coupleId, userId, ledgerId);
    return { ok: true, ledgerId: ledger.row.id };
  });
}

export async function createV2Ledger(coupleId: number, actorUserId: string, rawInput: unknown) {
  const input = createLedgerInputSchema.parse(rawInput);
  const idempotencyKey = input.idempotencyKey ?? `ledger:${randomUUID()}`;
  const hash = requestHash({ name: input.name, color: input.color ?? "#173B63" });
  return withTx(async (client) => {
    await assertV2Writer(client, coupleId);
    const existing = await findReceipt(client, coupleId, idempotencyKey, hash);
    if (existing) return existing;
    const membersResult = await client.query<MemberRow>(
      `select id as user_id, role
         from public.users
        where couple_id = $1
        order by case role when 'owner' then 0 else 1 end`,
      [coupleId],
    );
    if (membersResult.rows.length !== 2) throw new HttpError(409, "Couple 必須先有兩位成員");
    if (!membersResult.rows.some((member) => member.user_id === actorUserId)) {
      throw new HttpError(403, "只有 Couple 成員可以建立 Ledger");
    }
    const ledgerId = randomUUID();
    await client.query(
      `insert into ledger_v2.ledgers (id, couple_id, name, color, created_by_user_id)
       values ($1, $2, $3, $4, $5)`,
      [ledgerId, coupleId, input.name, input.color ?? "#173B63", actorUserId],
    );
    for (const member of membersResult.rows) {
      await client.query(
        `insert into ledger_v2.ledger_members (ledger_id, couple_id, user_id)
         values ($1, $2, $3)`,
        [ledgerId, coupleId, member.user_id],
      );
      await client.query(
        `insert into ledger_v2.ledger_default_shares (ledger_id, couple_id, user_id, weight)
         values ($1, $2, $3, 1)`,
        [ledgerId, coupleId, member.user_id],
      );
    }
    const result = {
      ledger: {
        id: ledgerId,
        coupleId,
        name: input.name,
        color: input.color ?? "#173B63",
        status: "active",
        defaultShares: Object.fromEntries(membersResult.rows.map((member) => [member.user_id, "1"])),
      },
    };
    await saveReceipt(client, coupleId, ledgerId, idempotencyKey, hash, result, actorUserId);
    return result;
  });
}

function serializedRecurringRule(row: RecurringRuleRow) {
  const payments = z.array(participantAmountSchema).parse(row.payments);
  const shares = z.array(participantAmountSchema).parse(row.shares);
  return {
    id: row.id,
    ledgerId: row.ledger_id,
    name: row.name,
    amountTwd: twdToString(asBigint(row.amount_twd)),
    frequency: row.frequency,
    anchorDay: row.anchor_day,
    nextRunDate: row.next_run_date,
    endDate: row.end_date,
    active: row.active,
    splitMethod: row.split_method,
    payments: payments.map((payment) => ({ userId: payment.userId, amountTwd: twdToString(payment.amountTwd) })),
    shares: shares.map((share) => ({ userId: share.userId, amountTwd: twdToString(share.amountTwd) })),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function recurringParticipants(value: readonly { userId: string; amountTwd: TwdInput }[]) {
  return value.map((entry) => ({ userId: entry.userId, amountTwd: twdToString(entry.amountTwd) }));
}

export async function listV2RecurringRules(coupleId: number, userId: string, ledgerId: string) {
  return withTx(async (client) => {
    const access = await client.query<{ id: string }>(
      `select l.id
         from ledger_v2.ledgers l
         join ledger_v2.ledger_members lm
           on lm.ledger_id = l.id and lm.couple_id = l.couple_id
        where l.id = $1 and l.couple_id = $2 and lm.user_id = $3`,
      [ledgerId, coupleId, userId],
    );
    if (!access.rows[0]) throw new HttpError(404, "Ledger 不存在或無權限");
    const result = await client.query<RecurringRuleRow>(
      `select r.id, r.couple_id, r.ledger_id, r.created_by_user_id, r.name, r.amount_twd,
              r.frequency, r.anchor_day, r.next_run_date, r.end_date, r.active,
              r.split_method, r.payments, r.shares, r.version, r.created_at, r.updated_at
         from ledger_v2.recurring_rules
        where couple_id = $1 and ledger_id = $2
        order by active desc, next_run_date asc, created_at asc, id asc`,
      [coupleId, ledgerId],
    );
    return { recurring: result.rows.map(serializedRecurringRule) };
  });
}

export async function createV2RecurringRule(
  coupleId: number,
  actorUserId: string,
  ledgerId: string,
  rawInput: unknown,
) {
  const input = createV2RecurringRuleInputSchema.parse(rawInput);
  const idempotencyKey = input.idempotencyKey ?? `recurring:${randomUUID()}`;
  const hash = requestHash({ ledgerId, ...input, idempotencyKey: undefined });
  return withTx(async (client) => {
    await assertV2Writer(client, coupleId);
    const existing = await findReceipt(client, coupleId, idempotencyKey, hash);
    if (existing) return existing;
    const ledger = await loadLedger(client, coupleId, ledgerId);
    await assertLedgerMember(client, coupleId, actorUserId, ledgerId);
    const shares = input.shares
      ? input.shares.map((share) => ({ userId: share.userId, amountTwd: share.amountTwd }))
      : Object.entries(splitWeights(input.amountTwd, ledger.members.memberIds, ledger.defaultWeights))
        .map(([userId, amountTwd]) => ({ userId, amountTwd }));
    const payments = input.payments.map((payment) => ({ userId: payment.userId, amountTwd: payment.amountTwd }));
    calculateTransactionDelta({
      ledgerId,
      type: "expense",
      amountTwd: input.amountTwd,
      payments,
      shares,
    }, ledger.members);
    if (input.endDate && input.endDate < input.nextRunDate) {
      throw new HttpError(422, "結束日期不得早於下次執行日");
    }
    const id = randomUUID();
    const row = await client.query<RecurringRuleRow>(
      `insert into ledger_v2.recurring_rules
        (id, couple_id, ledger_id, created_by_user_id, name, amount_twd,
         frequency, anchor_day, next_run_date, end_date, split_method, payments, shares)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)
       returning id, couple_id, ledger_id, created_by_user_id, name, amount_twd,
                 frequency, anchor_day, next_run_date, end_date, active,
                 split_method, payments, shares, version, created_at, updated_at`,
      [
        id,
        coupleId,
        ledgerId,
        actorUserId,
        input.name,
        twdToString(input.amountTwd),
        input.frequency,
        Number(input.nextRunDate.slice(8, 10)),
        input.nextRunDate,
        input.endDate ?? null,
        input.splitMethod,
        JSON.stringify(recurringParticipants(payments)),
        JSON.stringify(recurringParticipants(shares)),
      ],
    );
    const result = { recurring: serializedRecurringRule(row.rows[0]!) };
    await saveReceipt(client, coupleId, ledgerId, idempotencyKey, hash, result, actorUserId);
    return result;
  });
}

export async function toggleV2RecurringRule(
  coupleId: number,
  actorUserId: string,
  ruleId: string,
  rawInput: unknown,
) {
  const input = toggleV2RecurringRuleInputSchema.parse(rawInput);
  recurringRuleIdSchema.parse(ruleId);
  return withTx(async (client) => {
    await assertV2Writer(client, coupleId);
    const result = await client.query<RecurringRuleRow>(
      `update ledger_v2.recurring_rules r
          set active = $1, version = r.version + 1, updated_at = now()
        where r.id = $2 and r.couple_id = $3
          and exists (
            select 1 from ledger_v2.ledger_members lm
             where lm.ledger_id = r.ledger_id and lm.couple_id = r.couple_id and lm.user_id = $4
          )
      returning id, couple_id, ledger_id, created_by_user_id, name, amount_twd,
                frequency, anchor_day, next_run_date, end_date, active,
                split_method, payments, shares, version, created_at, updated_at`,
      [input.active, ruleId, coupleId, actorUserId],
    );
    if (!result.rows[0]) throw new HttpError(404, "Recurring rule 不存在或無權限");
    return { recurring: serializedRecurringRule(result.rows[0]) };
  });
}

/**
 * Execute at most one due occurrence per rule. The cron is deliberately
 * idempotent: recurring_runs has a unique (rule_id, scheduled_for) key, and
 * the whole occurrence plus next-date advance commits in one transaction.
 */
export async function runDueV2RecurringRules(today: string, limit = 100): Promise<number> {
  const date = z.iso.date().parse(today);
  return withTx(async (client) => {
    const writer = await client.query<{ couple_id: number }>(
      `select couple_id
         from ledger_v2.writer_control
        where active_plane = 'v2' and mutation_fence = false
        limit 1`,
    );
    if (!writer.rows[0]) return 0;
    const due = await client.query<RecurringRuleRow>(
      `select r.id, r.couple_id, r.ledger_id, r.created_by_user_id, r.name, r.amount_twd,
              r.frequency, r.anchor_day, r.next_run_date, r.end_date, r.active,
              r.split_method, r.payments, r.shares, r.version, r.created_at, r.updated_at
        from ledger_v2.recurring_rules r
        join ledger_v2.writer_control wc on wc.couple_id = r.couple_id
        where r.active and r.next_run_date <= $1
          and wc.active_plane = 'v2' and wc.mutation_fence = false
        order by next_run_date asc, created_at asc, id asc
        limit $2
        for update skip locked`,
      [date, limit],
    );
    let applied = 0;
    for (const rule of due.rows) {
      const savepoint = `v2_recurring_${applied}`;
      await client.query(`savepoint ${savepoint}`);
      try {
        await assertV2Writer(client, rule.couple_id);
        const run = await client.query<{ id: string }>(
          `insert into ledger_v2.recurring_runs (rule_id, scheduled_for, status)
           values ($1, $2, 'claimed')
           on conflict (rule_id, scheduled_for) do nothing
           returning id`,
          [rule.id, rule.next_run_date],
        );
        if (!run.rows[0]) {
          await client.query(`release savepoint ${savepoint}`);
          continue;
        }
        if (rule.end_date && rule.next_run_date > rule.end_date) {
          await client.query(
            `update ledger_v2.recurring_runs set status = 'skipped', completed_at = now(), error_code = 'past_end_date' where id = $1`,
            [run.rows[0].id],
          );
          await client.query(`update ledger_v2.recurring_rules set active = false, version = version + 1, updated_at = now() where id = $1`, [rule.id]);
          await client.query(`release savepoint ${savepoint}`);
          continue;
        }
        const ledger = await loadLedger(client, rule.couple_id, rule.ledger_id, true);
        const payments = z.array(participantAmountSchema).parse(rule.payments);
        const shares = z.array(participantAmountSchema).parse(rule.shares);
        const input: CreateV2TransactionInput = {
          type: "expense",
          amountTwd: twdToString(asBigint(rule.amount_twd)),
          occurredOn: rule.next_run_date,
          description: rule.name,
          category: null,
          note: "V2 recurring rule",
          splitMethod: rule.split_method,
          payments,
          shares,
        };
        const written = await insertTransaction(client, ledger, rule.created_by_user_id, input);
        const next = nextRecurringDate(rule.next_run_date, rule.frequency, rule.anchor_day);
        const active = !rule.end_date || next <= rule.end_date;
        await client.query(
          `update ledger_v2.recurring_runs
              set status = 'applied', transaction_id = $2, completed_at = now()
            where id = $1`,
          [run.rows[0].id, written.transaction.id],
        );
        await client.query(
          `update ledger_v2.recurring_rules
              set next_run_date = $2, active = $3, version = version + 1, updated_at = now()
            where id = $1`,
          [rule.id, next, active],
        );
        applied += 1;
        await client.query(`release savepoint ${savepoint}`);
      } catch (error) {
        await client.query(`rollback to savepoint ${savepoint}`);
        await client.query(`release savepoint ${savepoint}`);
        await client.query(`savepoint ${savepoint}_error`);
        await client.query(
          `insert into ledger_v2.recurring_runs (rule_id, scheduled_for, status, error_code, completed_at)
           values ($1, $2, 'failed', $3, now())
           on conflict (rule_id, scheduled_for) do update
             set status = 'failed', error_code = excluded.error_code, completed_at = excluded.completed_at`,
          [rule.id, rule.next_run_date, error instanceof Error ? error.message.slice(0, 200) : "unknown"],
        );
        await client.query(`release savepoint ${savepoint}_error`);
      }
    }
    return applied;
  });
}

export async function createV2ProposalFromLine(
  coupleId: number,
  actorUserId: string,
  input: CreateV2ProposalInput | V2LineProposalDraft,
  sourceEventId: string,
) {
  const idempotencyKey = `line:v2:${createHash("sha256").update(sourceEventId).digest("hex").slice(0, 80)}`;
  const draft = v2LineProposalDraftSchema.safeParse(input);
  const proposal = draft.success
    ? { ledgerId: draft.data.ledgerId, commands: [draft.data] }
    : createV2ProposalInputSchema.parse(input);
  return createV2Proposal(coupleId, actorUserId, proposal, idempotencyKey);
}

export async function enqueueV2Notification(
  coupleId: number,
  recipientUserId: string,
  kind: string,
  dedupeKey: string,
  payload: Record<string, unknown>,
) {
  return withTx(async (client) => {
    await client.query(
      `insert into ledger_v2.notification_outbox
        (couple_id, recipient_user_id, kind, dedupe_key, payload)
       values ($1, $2, $3, $4, $5::jsonb)
       on conflict (dedupe_key) do nothing`,
      [coupleId, recipientUserId, kind, dedupeKey, JSON.stringify(payload)],
    );
    return { queued: true, dedupeKey };
  });
}

export async function getV2LedgerBootstrap(coupleId: number, ledgerId: string) {
  return withTx(async (client) => {
    await assertCoupleHasExactlyTwoMembers(client, coupleId);
    const ledger = await loadLedger(client, coupleId, ledgerId);
    const balance = calculateLedgerBalance(ledger.transactions, ledger.members);
    const nextPayer = recommendNextPayer(balance, ledger.members.memberIds);
    return {
      ledger: {
        id: ledger.row.id,
        coupleId,
        name: ledger.row.name,
        color: ledger.row.color,
        status: ledger.row.status,
        version: ledger.row.version,
        members: ledger.members.memberIds.map((userId) => ({ userId, role: ledger.memberRoles[userId] })),
        defaultShares: Object.fromEntries(ledger.members.memberIds.map((userId, index) => [userId, ledger.defaultWeights[index]!.toString()])),
      },
      transactions: ledger.transactions.map(serializedTransaction),
      balance: serializedBalance(balance),
      nextPayer: nextPayer
        ? {
            payerUserId: nextPayer.payerUserId,
            payeeUserId: nextPayer.payeeUserId,
            amountTwd: nextPayer.amountTwd.toString(),
          }
        : null,
    };
  });
}

export async function createV2Transaction(
  coupleId: number,
  actorUserId: string,
  ledgerId: string,
  rawInput: unknown,
  requestIdempotencyKey?: string | null,
) {
  const input = createV2TransactionInputSchema.parse(rawInput);
  const idempotencyKey = requestIdempotencyKey ?? input.idempotencyKey ?? `transaction:${randomUUID()}`;
  const hash = requestHash({ ...input, idempotencyKey: undefined });
  return withTx(async (client) => {
    await assertV2Writer(client, coupleId);
    const existing = await findReceipt(client, coupleId, idempotencyKey, hash);
    if (existing) return existing;
    const ledger = await loadLedger(client, coupleId, ledgerId, true);
    await assertLedgerMember(client, coupleId, actorUserId, ledgerId);
    const written = await insertTransaction(client, ledger, actorUserId, input);
    ledger.row.version += 1;
    const result = {
      transaction: serializedTransaction(written.transaction),
      balance: serializedBalance(written.balance),
      ledgerVersion: ledger.row.version,
    };
    await saveReceipt(client, coupleId, ledgerId, idempotencyKey, hash, result, actorUserId);
    return result;
  });
}

export async function settleAllV2Ledger(
  coupleId: number,
  actorUserId: string,
  ledgerId: string,
  rawInput: unknown,
  requestIdempotencyKey?: string | null,
) {
  const input = settleAllInputSchema.parse(rawInput);
  const idempotencyKey = requestIdempotencyKey ?? input.idempotencyKey ?? `settle-all:${randomUUID()}`;
  const hash = requestHash({ ledgerId, operation: "settle-all" });
  return withTx(async (client) => {
    await assertV2Writer(client, coupleId);
    const existing = await findReceipt(client, coupleId, idempotencyKey, hash);
    if (existing) return existing;
    const ledger = await loadLedger(client, coupleId, ledgerId, true);
    await assertLedgerMember(client, coupleId, actorUserId, ledgerId);
    const balanceBefore = calculateLedgerBalance(ledger.transactions, ledger.members);
    const transfer = buildSettleAllTransfer(ledger.members, balanceBefore);
    if (!transfer) {
      const result = { settled: false, balance: serializedBalance(balanceBefore), ledgerVersion: ledger.row.version };
      await saveReceipt(client, coupleId, ledgerId, idempotencyKey, hash, result, actorUserId);
      return result;
    }
    const settleInput: CreateV2TransactionInput = {
      type: "transfer",
      amountTwd: transfer.amountTwd.toString(),
      occurredOn: new Date().toISOString().slice(0, 10),
      description: "全部結清",
      category: null,
      note: null,
      splitMethod: "none",
      payments: transfer.payments.map((payment) => ({
        userId: payment.userId,
        amountTwd: payment.amountTwd.toString(),
      })),
      shares: transfer.shares.map((share) => ({
        userId: share.userId,
        amountTwd: share.amountTwd.toString(),
      })),
    };
    const written = await insertTransaction(client, ledger, actorUserId, settleInput);
    ledger.row.version += 1;
    const result = {
      settled: true,
      transaction: serializedTransaction(written.transaction),
      balance: serializedBalance(written.balance),
      ledgerVersion: ledger.row.version,
    };
    await saveReceipt(client, coupleId, ledgerId, idempotencyKey, hash, result, actorUserId);
    return result;
  });
}

export async function createV2Proposal(
  coupleId: number,
  actorUserId: string,
  rawInput: unknown,
  requestIdempotencyKey?: string | null,
) {
  const input = createV2ProposalInputSchema.parse(rawInput);
  const digest = requestHash({ ledgerId: input.ledgerId, commands: input.commands });
  const idempotencyKey = requestIdempotencyKey ?? `proposal:${digest}`;
  return withTx(async (client) => {
    await assertV2Writer(client, coupleId);
    const ledger = await loadLedger(client, coupleId, input.ledgerId);
    await assertLedgerMember(client, coupleId, actorUserId, input.ledgerId);
    for (const command of input.commands) {
      const shares = buildShares(command, ledger);
      calculateTransactionDelta({
        ledgerId: ledger.members.ledgerId,
        type: command.type,
        amountTwd: command.amountTwd,
        payments: command.payments,
        shares,
      }, ledger.members);
    }
    const existing = await findReceipt(client, coupleId, idempotencyKey, digest);
    if (existing) return existing;
    const proposalId = randomUUID();
    const expiresAt = new Date(Date.now() + (input.expiresInSeconds ?? 5 * 60) * 1_000);
    await client.query(
      `insert into ledger_v2.proposals
        (id, couple_id, ledger_id, created_by_user_id, ledger_version, digest, commands, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [proposalId, coupleId, input.ledgerId, actorUserId, ledger.row.version, digest, JSON.stringify(input.commands), expiresAt.toISOString()],
    );
    await saveReceipt(client, coupleId, input.ledgerId, idempotencyKey, digest, { proposalId, ledgerId: input.ledgerId, ledgerVersion: ledger.row.version, digest, commands: input.commands, status: "proposed", expiresAt: expiresAt.toISOString() }, actorUserId);
    return {
      proposalId,
      ledgerId: input.ledgerId,
      ledgerVersion: ledger.row.version,
      digest,
      commands: input.commands,
      status: "proposed" as const,
      expiresAt: expiresAt.toISOString(),
    };
  });
}

export async function confirmV2Proposal(
  coupleId: number,
  actorUserId: string,
  proposalId: string,
) {
  return withTx(async (client) => {
    await assertV2Writer(client, coupleId);
    const proposalResult = await client.query<{
      id: string;
      ledger_id: string;
      created_by_user_id: string;
      ledger_version: number;
      digest: string;
      commands: unknown;
      status: "proposed" | "confirmed" | "cancelled" | "expired";
      expires_at: string;
      result: unknown;
    }>(
      `select id, ledger_id, created_by_user_id, ledger_version, digest, commands, status, expires_at, result
         from ledger_v2.proposals
        where id = $1 and couple_id = $2
        for update`,
      [proposalId, coupleId],
    );
    const proposal = proposalResult.rows[0];
    if (!proposal) throw new HttpError(404, "Proposal 不存在");
    await assertLedgerMember(client, coupleId, actorUserId, proposal.ledger_id);
    if (proposal.status === "confirmed") return proposal.result;
    if (proposal.status !== "proposed") throw new HttpError(409, "Proposal 已失效");
    if (new Date(proposal.expires_at).getTime() <= Date.now()) {
      await client.query(
        `update ledger_v2.proposals set status = 'expired' where id = $1`,
        [proposalId],
      );
      throw new HttpError(409, "Proposal 已過期");
    }
    const commands = z.array(createV2TransactionInputSchema.omit({ idempotencyKey: true })).parse(proposal.commands);
    const recomputedDigest = requestHash({ ledgerId: proposal.ledger_id, commands });
    if (recomputedDigest !== proposal.digest) throw new HttpError(409, "Proposal digest 不一致");
    const ledger = await loadLedger(client, coupleId, proposal.ledger_id, true);
    if (ledger.row.version !== proposal.ledger_version) {
      throw new HttpError(409, "Proposal 所在 Ledger 已變更，請重新建立草稿");
    }
    const written: Array<ReturnType<typeof serializedTransaction>> = [];
    for (const command of commands) {
      const result = await insertTransaction(client, ledger, actorUserId, command);
      written.push(serializedTransaction(result.transaction));
      ledger.transactions.push(result.transaction);
      ledger.row.version += 1;
    }
    const finalBalance = calculateLedgerBalance(ledger.transactions, ledger.members);
    const result = {
      proposalId,
      status: "confirmed" as const,
      transactions: written,
      balance: serializedBalance(finalBalance),
      ledgerVersion: ledger.row.version,
    };
    await client.query(
      `update ledger_v2.proposals
          set status = 'confirmed', confirmed_at = now(), result = $2::jsonb
        where id = $1`,
      [proposalId, JSON.stringify(result)],
    );
    return result;
  });
}

export async function cancelV2Proposal(
  coupleId: number,
  actorUserId: string,
  proposalId: string,
) {
  const id = z.string().uuid().parse(proposalId);
  return withTx(async (client) => {
    await assertV2Writer(client, coupleId);
    const proposal = await client.query<{
      id: string;
      ledger_id: string;
      status: "proposed" | "confirmed" | "cancelled" | "expired";
      result: unknown;
    }>(
      `select p.id, p.ledger_id, p.status, p.result
         from ledger_v2.proposals p
        where p.id = $1 and p.couple_id = $2
        for update`,
      [id, coupleId],
    );
    const row = proposal.rows[0];
    if (!row) throw new HttpError(404, "Proposal 不存在");
    await assertLedgerMember(client, coupleId, actorUserId, row.ledger_id);
    if (row.status === "cancelled") return { proposalId: id, status: "cancelled" as const };
    if (row.status !== "proposed") throw new HttpError(409, "Proposal 已失效或已確認");
    await client.query(
      `update ledger_v2.proposals
          set status = 'cancelled'
        where id = $1 and couple_id = $2`,
      [id, coupleId],
    );
    return { proposalId: id, status: "cancelled" as const };
  });
}

export async function getV2Proposal(
  coupleId: number,
  actorUserId: string,
  proposalId: string,
) {
  const id = z.string().uuid().parse(proposalId);
  return withTx(async (client) => {
    const result = await client.query<{
      id: string;
      ledger_id: string;
      ledger_version: number;
      status: "proposed" | "confirmed" | "cancelled" | "expired";
      commands: unknown;
      expires_at: string;
      result: unknown;
    }>(
      `select id, ledger_id, ledger_version, status, commands, expires_at, result
         from ledger_v2.proposals
        where id = $1 and couple_id = $2`,
      [id, coupleId],
    );
    const proposal = result.rows[0];
    if (!proposal) throw new HttpError(404, "Proposal 不存在");
    await assertLedgerMember(client, coupleId, actorUserId, proposal.ledger_id);
    return {
      proposalId: proposal.id,
      ledgerId: proposal.ledger_id,
      ledgerVersion: proposal.ledger_version,
      status: proposal.status,
      commands: proposal.commands,
      expiresAt: proposal.expires_at,
      result: proposal.result,
    };
  });
}
