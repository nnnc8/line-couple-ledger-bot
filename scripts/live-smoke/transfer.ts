import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool, type PoolClient } from "pg";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
if (existsSync(".env")) process.loadEnvFile(".env");

import { HttpError } from "../../src/lib/http-error";
import { loadGroupBalances } from "../../src/lib/balance-loader";
import { taipeiToday } from "../../src/lib/ledger-shared";
import { PendingActionService } from "../../src/lib/pending-action-service";
import type {
  ActionResult,
  PendingActionContext,
} from "../../src/lib/pending-action-types";
import { getOrCreateSmokeTenant } from "../../src/lib/smoke/smoke-tenant";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function assertConfirmed(
  result: ActionResult,
  label: string,
): asserts result is ActionResult & {
  result: "confirmed";
  settlement_id: string;
  settlement_version: number;
  balance: NonNullable<ActionResult["balance"]>;
} {
  assert.equal(result.result, "confirmed", `${label}: expected confirmed`);
  assert.ok(result.settlement_id, `${label}: missing settlement_id`);
  assert.ok(result.settlement_version, `${label}: missing settlement_version`);
  assert.ok(result.balance, `${label}: missing authoritative balance`);
}

function isConflict(error: unknown, message: string): boolean {
  return (
    error instanceof HttpError &&
    error.status === 409 &&
    error.message === message
  );
}

type Tenant = Awaited<ReturnType<typeof getOrCreateSmokeTenant>>;

interface GroupSnapshot {
  expenses: number;
  splits: number;
  mirrors: number;
  settlements: number;
  activities: number;
  notifications: number;
  pendingActions: number;
  expenseTotal: number;
}

async function snapshotGroup(
  client: PoolClient,
  groupId: string,
): Promise<GroupSnapshot> {
  const result = await client.query<GroupSnapshot>(
    `SELECT
       (SELECT count(*)::int FROM public.expenses WHERE group_id = $1::uuid) AS expenses,
       (SELECT count(*)::int
          FROM public.expense_splits es
          JOIN public.expenses e ON e.id = es.expense_id
         WHERE e.group_id = $1::uuid) AS splits,
       (SELECT count(*)::int
          FROM public.expenses mirror
          JOIN public.expenses source
            ON source.id = mirror.mirror_source_expense_id
         WHERE source.group_id = $1::uuid
           AND mirror.mirror_kind = 'shared_share') AS mirrors,
       (SELECT count(*)::int FROM public.settlements WHERE group_id = $1::uuid) AS settlements,
       (SELECT count(*)::int FROM public.activity_events WHERE group_id = $1::uuid) AS activities,
       (SELECT count(*)::int FROM public.notifications WHERE group_id = $1::uuid) AS notifications,
       (SELECT count(*)::int FROM public.pending_actions WHERE group_id = $1::uuid) AS "pendingActions",
       (SELECT coalesce(sum(amount_twd), 0)::int
          FROM public.expenses
         WHERE group_id = $1::uuid
           AND mirror_kind IS NULL
           AND deleted_at IS NULL) AS "expenseTotal"`,
    [groupId],
  );
  return result.rows[0]!;
}

async function assertBalances(
  db: SupabaseClient,
  tenant: Tenant,
  ownerBalance: number,
  label: string,
) {
  const balances = Object.fromEntries(
    (await loadGroupBalances(db, tenant.group.id)).map((row) => [
      row.userId,
      row.balanceTwd,
    ]),
  );
  assert.equal(
    balances[tenant.owner.id],
    ownerBalance,
    `${label}: owner balance`,
  );
  assert.equal(
    balances[tenant.partner.id],
    ownerBalance === 0 ? 0 : -ownerBalance,
    `${label}: partner balance`,
  );
}

async function cleanupRun(
  pool: Pool,
  groupId: string,
  sourcePrefix: string,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT id FROM public.groups WHERE id = $1::uuid FOR UPDATE",
      [groupId],
    );

    const actions = await client.query<{ id: string }>(
      `SELECT id::text
         FROM public.pending_actions
        WHERE group_id = $1::uuid
          AND (
            source_event_id LIKE $2
            OR idempotency_key LIKE $2
          )
        FOR UPDATE`,
      [groupId, `${sourcePrefix}%`],
    );
    const actionIds = actions.rows.map((row) => row.id);

    const expenses =
      actionIds.length === 0
        ? { rows: [] as Array<{ id: string }> }
        : await client.query<{ id: string }>(
            `SELECT id::text
               FROM public.expenses
              WHERE source_action_id = ANY($1::uuid[])
              FOR UPDATE`,
            [actionIds],
          );
    const expenseIds = expenses.rows.map((row) => row.id);

    if (expenseIds.length > 0) {
      await client.query(
        `DELETE FROM public.assistant_tasks
          WHERE related_pending_action_id = ANY($1::uuid[])
             OR related_expense_id = ANY($2::uuid[])`,
        [actionIds, expenseIds],
      );
      await client.query(
        `DELETE FROM public.expense_splits
          WHERE expense_id = ANY($1::uuid[])
             OR expense_id IN (
               SELECT id FROM public.expenses
                WHERE mirror_source_expense_id = ANY($1::uuid[])
             )`,
        [expenseIds],
      );
      await client.query(
        `DELETE FROM public.expenses
          WHERE mirror_source_expense_id = ANY($1::uuid[])
            AND mirror_kind = 'shared_share'`,
        [expenseIds],
      );
      await client.query(
        "DELETE FROM public.expenses WHERE id = ANY($1::uuid[])",
        [expenseIds],
      );
    } else if (actionIds.length > 0) {
      await client.query(
        `DELETE FROM public.assistant_tasks
          WHERE related_pending_action_id = ANY($1::uuid[])`,
        [actionIds],
      );
    }

    const settlements =
      actionIds.length === 0
        ? { rows: [] as Array<{ id: string }> }
        : await client.query<{ id: string }>(
            `SELECT id::text
               FROM public.settlements
              WHERE source_action_id = ANY($1::uuid[])
                 OR void_source_action_id = ANY($1::uuid[])
              FOR UPDATE`,
            [actionIds],
          );
    const settlementIds = settlements.rows.map((row) => row.id);

    if (settlementIds.length > 0) {
      await client.query(
        `DELETE FROM public.activity_events
          WHERE group_id = $1::uuid
            AND entity_id = ANY($2::text[])`,
        [groupId, settlementIds],
      );
      await client.query(
        `DELETE FROM public.notifications
          WHERE group_id = $1::uuid
            AND entity_id = ANY($2::text[])`,
        [groupId, settlementIds],
      );
      await client.query(
        `DELETE FROM public.settlements
          WHERE id = ANY($1::uuid[])`,
        [settlementIds],
      );
    }
    if (actionIds.length > 0) {
      await client.query(
        "DELETE FROM public.pending_actions WHERE id = ANY($1::uuid[])",
        [actionIds],
      );
    }

    const residue = await client.query<{ count: number }>(
      `SELECT (
         (SELECT count(*) FROM public.pending_actions
           WHERE source_event_id LIKE $1 OR idempotency_key LIKE $1)
         + (SELECT count(*) FROM public.settlements
           WHERE source_action_id = ANY($2::uuid[])
              OR void_source_action_id = ANY($2::uuid[]))
       )::int AS count`,
      [`${sourcePrefix}%`, actionIds],
    );
    assert.equal(residue.rows[0]!.count, 0, "cleanup left run residue");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function verifyMovementLedger(
  pool: Pool,
  groupId: string,
  sourcePrefix: string,
  expectedSettlements: number,
  expectedMovements: number,
) {
  const client = await pool.connect();
  try {
    const rows = await client.query<{
      id: string;
      source_action_id: string;
      void_source_action_id: string | null;
      activity_count: number;
      notification_count: number;
    }>(
      `SELECT s.id::text,
              s.source_action_id::text,
              s.void_source_action_id::text,
              (SELECT count(*)::int
                 FROM public.activity_events a
                WHERE a.group_id = s.group_id
                  AND a.entity_type = 'settlement'
                  AND a.entity_id = s.id::text) AS activity_count,
              (SELECT count(*)::int
                 FROM public.notifications n
                WHERE n.group_id = s.group_id
                  AND n.entity_type = 'settlement'
                  AND n.entity_id = s.id::text) AS notification_count
         FROM public.settlements s
         JOIN public.pending_actions p ON p.id = s.source_action_id
        WHERE s.group_id = $1::uuid
          AND p.source_event_id LIKE $2
        ORDER BY s.created_at`,
      [groupId, `${sourcePrefix}%`],
    );
    assert.equal(rows.rowCount, expectedSettlements, "settlement row count");

    let activityTotal = 0;
    let notificationTotal = 0;
    const confirmedActionIds: string[] = [];
    for (const row of rows.rows) {
      const expected = row.void_source_action_id ? 2 : 1;
      assert.equal(
        row.activity_count,
        expected,
        `${row.id}: activity must be exactly once per movement`,
      );
      assert.equal(
        row.notification_count,
        expected,
        `${row.id}: notification must be exactly once per movement`,
      );
      activityTotal += row.activity_count;
      notificationTotal += row.notification_count;
      confirmedActionIds.push(row.source_action_id);
      if (row.void_source_action_id) {
        confirmedActionIds.push(row.void_source_action_id);
      }
    }
    assert.equal(activityTotal, expectedMovements, "activity total");
    assert.equal(notificationTotal, expectedMovements, "notification total");

    const dedupes = await client.query<{
      action_id: string;
      count: number;
    }>(
      `SELECT action_id, count(*)::int AS count
         FROM (
           SELECT action_id,
                  n.id
             FROM unnest($1::uuid[]) AS action_id
             LEFT JOIN public.notifications n
               ON n.dedupe_key LIKE ('action:' || action_id::text || ':%')
         ) q
        GROUP BY action_id`,
      [confirmedActionIds],
    );
    for (const row of dedupes.rows) {
      assert.equal(
        row.count,
        1,
        `${row.action_id}: queued notification must be exactly once`,
      );
    }
  } finally {
    client.release();
  }
}

async function main() {
  const databaseUrl = requireEnv("DATABASE_URL");
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseSecretKey = requireEnv("SUPABASE_SECRET_KEY");
  const sourcePrefix = `transfer-smoke:${Date.now()}:${randomUUID().slice(0, 8)}`;
  const date = taipeiToday();
  const db: SupabaseClient = createClient(supabaseUrl, supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("supabase")
      ? { rejectUnauthorized: false }
      : undefined,
    max: 2,
    allowExitOnIdle: true,
  });
  const service = new PendingActionService();
  let tenant: Tenant | null = null;
  let runError: unknown = null;
  let cleanupError: unknown = null;

  const metadata = (label: string, key = `${sourcePrefix}:${label}`) => ({
    source: "transfer_smoke",
    sourceEventId: `${sourcePrefix}:${label}`,
    idempotencyKey: key,
  });

  try {
    tenant = await getOrCreateSmokeTenant(db);
    const ownerContext: PendingActionContext = {
      db,
      user: tenant.owner,
    };
    const groupId = tenant.group.id;
    const ownerId = tenant.owner.id;
    const client = await pool.connect();
    try {
      const baseline = await snapshotGroup(client, groupId);
      assert.deepEqual(
        baseline,
        {
          expenses: 0,
          splits: 0,
          mirrors: 0,
          settlements: 0,
          activities: 0,
          notifications: 0,
          pendingActions: 0,
          expenseTotal: 0,
        },
        "smoke group must be isolated and empty before the run",
      );
    } finally {
      client.release();
    }
    await assertBalances(db, tenant, 0, "baseline");

    const transfer = async (
      direction: "me_to_partner" | "partner_to_me",
      amountTwd: number,
      label: string,
      key = `${sourcePrefix}:${label}`,
    ) => {
      const result = await service.proposeTransfer(
        ownerContext,
        {
          type: "transfer",
          groupId,
          direction,
          amountTwd,
          occurredOn: date,
          notes: `live smoke ${label}`,
          idempotencyKey: key,
        },
        metadata(label, key),
      );
      return result;
    };

    const settle = async (
      direction: "me_to_partner" | "partner_to_me",
      label: string,
      amountTwd?: number,
    ) =>
      service.proposeSettlement(
        ownerContext,
        {
          type: "settle",
          groupId,
          direction,
          ...(amountTwd === undefined ? {} : { amountTwd }),
          idempotencyKey: `${sourcePrefix}:${label}`,
        },
        metadata(label),
      );

    const voidSettlement = async (
      settlementId: string,
      expectedVersion: number,
      label: string,
    ) =>
      service.proposeVoidSettlement(
        ownerContext,
        {
          type: "void_settlement",
          settlementId,
          expectedVersion,
          idempotencyKey: `${sourcePrefix}:${label}`,
        },
        metadata(label),
      );

    console.log("1/6 zero-balance transfers in both directions");
    const zeroOut = await transfer("me_to_partner", 101, "zero-out");
    assertConfirmed(zeroOut, "zero-out");
    assert.equal(zeroOut.balance.after_by_user_id[ownerId], 101);
    await assertBalances(db, tenant, 101, "zero-out");
    const zeroOutVoid = await voidSettlement(
      zeroOut.settlement_id,
      zeroOut.settlement_version,
      "zero-out-void",
    );
    assertConfirmed(zeroOutVoid, "zero-out-void");
    await assertBalances(db, tenant, 0, "zero-out void");

    await assert.rejects(
      () =>
        voidSettlement(
          zeroOut.settlement_id,
          zeroOut.settlement_version,
          "zero-out-stale-void",
        ),
      (error) => isConflict(error, "stale_action"),
      "second void must be 409 stale_action",
    );

    const zeroIn = await transfer("partner_to_me", 102, "zero-in");
    assertConfirmed(zeroIn, "zero-in");
    assert.equal(zeroIn.balance.after_by_user_id[ownerId], -102);
    await assertBalances(db, tenant, -102, "zero-in");
    const zeroInVoid = await voidSettlement(
      zeroIn.settlement_id,
      zeroIn.settlement_version,
      "zero-in-void",
    );
    assertConfirmed(zeroInVoid, "zero-in-void");
    await assertBalances(db, tenant, 0, "zero-in void");

    console.log("2/6 reverse and overpay crossing zero");
    const debt = await transfer("partner_to_me", 300, "debt");
    assertConfirmed(debt, "debt");
    await assertBalances(db, tenant, -300, "debt");
    const overpay = await transfer("me_to_partner", 450, "overpay");
    assertConfirmed(overpay, "overpay");
    assert.equal(overpay.balance.before_by_user_id[ownerId], -300);
    assert.equal(overpay.balance.after_by_user_id[ownerId], 150);
    await assertBalances(db, tenant, 150, "overpay");

    console.log("3/6 partial and full partner-to-me settlement");
    const partial = await settle("partner_to_me", "partial-settle", 50);
    assertConfirmed(partial, "partial settle");
    await assertBalances(db, tenant, 100, "partial settle");
    const full = await settle("partner_to_me", "full-settle");
    assertConfirmed(full, "full settle");
    assert.equal(full.balance.after_by_user_id[ownerId], 0);
    await assertBalances(db, tenant, 0, "full settle");

    console.log("4/6 concurrent full settlement");
    const concurrentDebt = await transfer(
      "partner_to_me",
      700,
      "concurrent-debt",
    );
    assertConfirmed(concurrentDebt, "concurrent debt");
    const pendingA = await service.proposeSettlementPending(
      ownerContext,
      {
        type: "settle",
        groupId,
        direction: "me_to_partner",
        idempotencyKey: `${sourcePrefix}:concurrent-a`,
      },
      metadata("concurrent-a"),
    );
    const pendingB = await service.proposeSettlementPending(
      ownerContext,
      {
        type: "settle",
        groupId,
        direction: "me_to_partner",
        idempotencyKey: `${sourcePrefix}:concurrent-b`,
      },
      metadata("concurrent-b"),
    );
    assert.equal(pendingA.result, "pending");
    assert.equal(pendingB.result, "pending");
    assert.ok("action_id" in pendingA, "concurrent A missing action_id");
    assert.ok("action_id" in pendingB, "concurrent B missing action_id");
    const concurrent = await Promise.all([
      service.confirm(ownerContext, pendingA.action_id, true),
      service.confirm(ownerContext, pendingB.action_id, true),
    ]);
    assert.deepEqual(
      concurrent.map((result) => result.result).sort(),
      ["confirmed", "stale"],
      "only one concurrent full settle may succeed",
    );
    await assertBalances(db, tenant, 0, "concurrent settle");

    console.log("5/6 scoped idempotency");
    const idempotencyKey = `${sourcePrefix}:idempotent`;
    const idempotentFirst = await transfer(
      "me_to_partner",
      111,
      "idempotent",
      idempotencyKey,
    );
    assertConfirmed(idempotentFirst, "idempotent first");
    const idempotentRepeat = await transfer(
      "me_to_partner",
      111,
      "idempotent",
      idempotencyKey,
    );
    assert.equal(
      idempotentRepeat.result,
      "already_done",
      "same key + payload must reuse the confirmed action",
    );
    await assert.rejects(
      () =>
        transfer(
          "me_to_partner",
          112,
          "idempotent-conflict",
          idempotencyKey,
        ),
      (error) => isConflict(error, "idempotency_conflict"),
      "same key + different payload must be 409 idempotency_conflict",
    );
    const idempotentRows = await db
      .from("pending_actions")
      .select("id", { count: "exact" })
      .eq("requested_by_user_id", ownerId)
      .eq("action_type", "transfer")
      .eq("idempotency_key", idempotencyKey);
    if (idempotentRows.error) throw idempotentRows.error;
    assert.equal(idempotentRows.count, 1, "idempotent action row count");
    const idempotentVoid = await voidSettlement(
      idempotentFirst.settlement_id,
      idempotentFirst.settlement_version,
      "idempotent-void",
    );
    assertConfirmed(idempotentVoid, "idempotent void");
    await assertBalances(db, tenant, 0, "idempotent void");

    console.log("6/6 audit, notification, and analytics isolation");
    await verifyMovementLedger(pool, groupId, sourcePrefix, 9, 12);
    const endClient = await pool.connect();
    try {
      const end = await snapshotGroup(endClient, groupId);
      assert.equal(end.expenses, 0, "transfer must not create expenses");
      assert.equal(end.splits, 0, "transfer must not create splits");
      assert.equal(end.mirrors, 0, "transfer must not create private mirrors");
      assert.equal(end.expenseTotal, 0, "transfer must not affect expense analytics");
      assert.equal(end.settlements, 9);
      assert.equal(end.activities, 12);
      assert.equal(end.notifications, 12);
      assert.equal(end.pendingActions, 13);
    } finally {
      endClient.release();
    }
  } catch (error) {
    runError = error;
  } finally {
    if (tenant) {
      try {
        await cleanupRun(pool, tenant.group.id, sourcePrefix);
        await tenant.cleanup();
      } catch (error) {
        cleanupError = error;
      }
    }
    await pool.end();
  }

  if (runError && cleanupError) {
    throw new AggregateError(
      [runError, cleanupError],
      "transfer smoke and cleanup both failed",
    );
  }
  if (runError) throw runError;
  if (cleanupError) throw cleanupError;

  const residue = await db
    .from("pending_actions")
    .select("id", { count: "exact", head: true })
    .like("source_event_id", `${sourcePrefix}%`);
  if (residue.error) throw residue.error;
  assert.equal(residue.count, 0, "post-cleanup source_event residue");
  console.log("Transfer live smoke passed; verified zero run residue.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
