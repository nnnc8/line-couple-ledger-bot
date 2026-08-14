import { HttpError } from "./http-error";
import { withTx } from "./db/tx";

/**
 * User-facing, deliberately stable maintenance response for financial writes.
 * Reads remain available while this gate is closed.
 */
export const V2_FINANCIAL_MAINTENANCE_MESSAGE =
  "系統目前正在進行帳務維護，暫時無法新增或修改交易，現有帳務仍可正常查看。";

export class V2IncidentFreezeError extends HttpError {
  constructor() {
    super(503, V2_FINANCIAL_MAINTENANCE_MESSAGE);
    this.name = "V2IncidentFreezeError";
  }
}

export function isV2IncidentFreezeError(error: unknown): error is V2IncidentFreezeError {
  return (
    error instanceof V2IncidentFreezeError ||
    (error instanceof Error && error.name === "V2IncidentFreezeError")
  );
}

/**
 * Deployment-only bootstrap mode used while the additive freeze migration is
 * the only V2 schema change present. It keeps V1 read paths available, rejects
 * V2 API mutation/read routes before they reach queries for later columns, and
 * lets the LINE webhook persist durable inbox rows without dispatching them.
 */
export function isV2IncidentBootstrapOnly(env: Record<string, string | undefined> = process.env): boolean {
  return env.V2_INCIDENT_BOOTSTRAP_ONLY === "1";
}

/**
 * Reads that only use the shadow/workflow columns present before the later V2
 * migrations. Everything else stays behind the bootstrap maintenance gate.
 */
export function isV2IncidentBootstrapRead(path: readonly string[]): boolean {
  if (path[0] !== "v2") return false;
  if (path[1] === "context" && path.length === 2) return true;
  if (path[1] === "ledgers" && path.length === 2) return true;
  if (path[1] === "ledgers" && path[2] && path[3] === "bootstrap" && path.length === 4) return true;
  if (path[1] === "ledgers" && path[2] && path[3] === "transactions" && path.length === 4) return true;
  if (path[1] === "ledgers" && path[2] && path[3] === "export" && path.length === 4) return true;
  if (path[1] === "transactions" && path[2] && path[3] === "attachments" && path.length === 4) return true;
  if (path[1] === "proposals" && path[2] && path.length === 3) return true;
  return false;
}

/** Current-schema V2 writes that do not require later migrations. */
export function isV2IncidentBootstrapWrite(path: readonly string[]): boolean {
  if (path[0] !== "v2") return false;
  if (path[1] === "ledgers" && path.length === 2) return true;
  if (path[1] === "ledgers" && path[2] && path[3] && path.length === 4) {
    return ["transactions", "settle-all", "activate", "default-shares", "recurring"].includes(path[3]);
  }
  if (path[1] === "transactions" && path[2] && path[3] === "mutate" && path.length === 4) return true;
  if (path[1] === "attachments" && (path.length === 2 || (path[2] && path[3] === "complete" && path.length === 4))) return true;
  if (path[1] === "proposals" && (path.length === 2 || (path[2] && (path[3] === "confirm" || path[3] === "cancel") && path.length === 4))) return true;
  if (path[1] === "recurring" && path[2] && path[3] === "toggle" && path.length === 4) return true;
  return false;
}

export function isV2IncidentBootstrapDelete(path: readonly string[]): boolean {
  return path[0] === "v2" && path[1] === "attachments" && Boolean(path[2]) && path.length === 3;
}

/**
 * Read-only process-wide gate used before claiming durable LINE inbox work.
 * A missing row is treated as enabled so the additive migration remains
 * compatible with a pre-freeze schema; the mutation path still fails closed
 * when its writer-control row is absent.
 */
export async function areV2FinancialWritesEnabled(): Promise<boolean> {
  return withTx(async (client) => {
    const result = await client.query<{ enabled: boolean | null }>(
      `select coalesce(
                bool_and(coalesce((to_jsonb(wc)->>'financial_writes_enabled')::boolean, true)),
                true
              ) as enabled
         from ledger_v2.writer_control wc
        where active_plane = 'v2' and mutation_fence = false`,
    );
    return result.rows[0]?.enabled ?? true;
  });
}
