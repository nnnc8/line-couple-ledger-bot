import { Pool, type PoolClient } from "pg";

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not configured");
    }
    pool = new Pool({
      connectionString,
      ssl: connectionString.includes("supabase") ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

let mockWithTx: (<T>(callback: (client: any) => Promise<T>) => Promise<T>) | null = null;

export function setMockWithTx(mock: typeof mockWithTx) {
  mockWithTx = mock;
}

export async function withTx<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (mockWithTx) {
    return mockWithTx(callback);
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
