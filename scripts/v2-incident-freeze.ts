import { Pool } from "pg";

type Action = "status" | "freeze" | "unfreeze";

export interface IncidentWriterState {
  coupleId: number;
  activePlane: string;
  mutationFence: boolean;
  financialWritesEnabled: boolean;
  updatedAt: string;
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

function printResult(action: Action, prior: IncidentWriterState | null, result: IncidentWriterState) {
  console.log(JSON.stringify({
    action,
    couple_id: result.coupleId,
    active_plane: result.activePlane,
    prior_financial_writes_enabled: prior?.financialWritesEnabled ?? null,
    result_financial_writes_enabled: result.financialWritesEnabled,
    mutation_fence: result.mutationFence,
    timestamp: new Date().toISOString(),
    writer_updated_at: result.updatedAt,
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
      printResult(action, null, await readState(pool, id));
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
    printResult(action, prior, result);
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
