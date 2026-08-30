import { Pool } from "pg";

type Action = "status" | "freeze" | "unfreeze";

export interface IncidentWriterState {
  coupleId: number;
  activePlane: string;
  mutationFence: boolean;
  financialWritesEnabled: boolean;
  updatedAt: string;
}

interface QueueHealth {
  notificationOutbox: {
    pending: number;
    due: number;
    leased: number;
    sent: number;
    failed: number;
    deadLetter: number;
    oldestActionableSeconds: number | null;
  };
  lineInbox: {
    received: number;
    processed: number;
    ignored: number;
    failed: number;
    processing: number;
    deadLetter: number;
    oldestActionableSeconds: number | null;
  };
}

function usage(): never {
  throw new Error(
    "用法：pnpm incident:v2:status | pnpm incident:v2:freeze -- --apply | pnpm incident:v2:unfreeze -- --apply",
  );
}

export function parseAction(argv: string[]): { action: Action; apply: boolean } {
  const action = argv[0];
  if (action !== "status" && action !== "freeze" && action !== "unfreeze") usage();
  const apply = argv.slice(1).includes("--apply");
  if (action === "status" && apply) throw new Error("status 是唯讀命令，不需要 --apply");
  return { action, apply };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 必須明確設定；此 CLI 不會回退到 DATABASE_URL 或其他隱含目標`);
  return value;
}

function coupleId(): number {
  const value = Number(requiredEnv("V2_INCIDENT_COUPLE_ID"));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("V2_INCIDENT_COUPLE_ID 必須是正整數");
  return value;
}

function assertMutationGate(databaseUrl: string) {
  if (process.env.V2_INCIDENT_FREEZE_APPLY !== "1") {
    throw new Error("freeze/unfreeze 必須同時設定 V2_INCIDENT_FREEZE_APPLY=1");
  }
  if (process.env.V2_INCIDENT_ALLOW_REMOTE !== "1") {
    const hostname = new URL(databaseUrl).hostname;
    if (!(hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1")) {
      throw new Error("遠端資料庫 mutation 需要額外設定 V2_INCIDENT_ALLOW_REMOTE=1");
    }
  }
}

function poolFor(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("supabase") ? { rejectUnauthorized: false } : undefined,
    max: 1,
  });
}

async function readState(pool: Pool, id: number, lock = false): Promise<IncidentWriterState> {
  const result = await pool.query<{
    couple_id: number;
    active_plane: string;
    mutation_fence: boolean;
    financial_writes_enabled: boolean;
    updated_at: string;
  }>(
    `select couple_id, active_plane, mutation_fence, financial_writes_enabled, updated_at
       from ledger_v2.writer_control
      where couple_id = $1
      ${lock ? "for update" : ""}`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`writer_control 找不到 couple_id=${id}`);
  return {
    coupleId: row.couple_id,
    activePlane: row.active_plane,
    mutationFence: row.mutation_fence,
    financialWritesEnabled: row.financial_writes_enabled,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function readQueueHealth(pool: Pool): Promise<QueueHealth> {
  const [outbox, inbox] = await Promise.all([
    pool.query<{ pending: string; due: string; leased: string; sent: string; failed: string; dead_letter: string; oldest_actionable_seconds: string | null }>(
      `select
         count(*) filter (where status = 'pending')::text as pending,
         count(*) filter (where status in ('pending', 'failed') and next_attempt_at <= now() and (lease_until is null or lease_until < now()))::text as due,
         count(*) filter (where status = 'sending' and lease_until >= now())::text as leased,
         count(*) filter (where status = 'sent')::text as sent,
         count(*) filter (where status = 'failed')::text as failed,
         count(*) filter (where status = 'dead_letter')::text as dead_letter,
         extract(epoch from now() - min(created_at) filter (where status in ('pending', 'failed') and next_attempt_at <= now() and (lease_until is null or lease_until < now())))::text as oldest_actionable_seconds
       from ledger_v2.notification_outbox`,
    ),
    pool.query<{ received: string; processed: string; ignored: string; failed: string; processing: string; dead_letter: string; oldest_actionable_seconds: string | null }>(
      `select
         count(*) filter (where status = 'received')::text as received,
         count(*) filter (where status = 'processed')::text as processed,
         count(*) filter (where status = 'ignored')::text as ignored,
         count(*) filter (where status = 'failed')::text as failed,
         count(*) filter (where status = 'processing')::text as processing,
         count(*) filter (where status = 'dead_letter')::text as dead_letter,
         extract(epoch from now() - min(received_at) filter (where status in ('received', 'failed') and next_attempt_at <= now() and (lease_until is null or lease_until < now())))::text as oldest_actionable_seconds
       from ledger_v2.line_inbox`,
    ),
  ]);
  const outboxRow = outbox.rows[0]!;
  const inboxRow = inbox.rows[0]!;
  return {
    notificationOutbox: {
      pending: Number(outboxRow.pending), due: Number(outboxRow.due), leased: Number(outboxRow.leased), sent: Number(outboxRow.sent), failed: Number(outboxRow.failed), deadLetter: Number(outboxRow.dead_letter),
      oldestActionableSeconds: outboxRow.oldest_actionable_seconds === null ? null : Number(outboxRow.oldest_actionable_seconds),
    },
    lineInbox: {
      received: Number(inboxRow.received), processed: Number(inboxRow.processed), ignored: Number(inboxRow.ignored), failed: Number(inboxRow.failed), processing: Number(inboxRow.processing), deadLetter: Number(inboxRow.dead_letter),
      oldestActionableSeconds: inboxRow.oldest_actionable_seconds === null ? null : Number(inboxRow.oldest_actionable_seconds),
    },
  };
}

function printResult(action: Action, prior: IncidentWriterState | null, result: IncidentWriterState, queueHealth: QueueHealth) {
  console.log(JSON.stringify({
    action,
    couple_id: result.coupleId,
    active_plane: result.activePlane,
    prior_financial_writes_enabled: prior?.financialWritesEnabled ?? null,
    result_financial_writes_enabled: result.financialWritesEnabled,
    mutation_fence: result.mutationFence,
    timestamp: new Date().toISOString(),
    writer_updated_at: result.updatedAt,
    queue_health: queueHealth,
  }, null, 2));
}

async function main() {
  const { action, apply } = parseAction(process.argv.slice(2));
  const databaseUrl = requiredEnv("V2_INCIDENT_DATABASE_URL");
  const id = coupleId();
  if (action !== "status" && !apply) {
    throw new Error(`${action} 是 mutation；必須明確加上 --apply`);
  }
  if (action !== "status") assertMutationGate(databaseUrl);

  const pool = poolFor(databaseUrl);
  try {
    if (action === "status") {
      printResult(action, null, await readState(pool, id), await readQueueHealth(pool));
      return;
    }
    await pool.query("begin");
    const prior = await readState(pool, id, true);
    if (prior.activePlane !== "v2") {
      throw new Error(`active_plane=${prior.activePlane}；只允許在 V2 writer 狀態下操作 incident freeze`);
    }
    if (prior.mutationFence) {
      throw new Error("mutation_fence=true；writer transition 尚未完成，拒絕變更 incident freeze");
    }
    const enabled = action === "unfreeze";
    await pool.query(
      `update ledger_v2.writer_control
          set financial_writes_enabled = $2, updated_at = now()
        where couple_id = $1`,
      [id, enabled],
    );
    const result = await readState(pool, id, true);
    await pool.query("commit");
    printResult(action, prior, result, await readQueueHealth(pool));
  } catch (error) {
    await pool.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
