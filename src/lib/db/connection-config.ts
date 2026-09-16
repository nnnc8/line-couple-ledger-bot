import { readFileSync } from "node:fs";
import { checkServerIdentity } from "node:tls";
import type { PoolConfig } from "pg";

export function databasePoolConfig(connectionString: string, env: Pick<NodeJS.ProcessEnv, "NODE_ENV"> & { DATABASE_SSL_CA?: string } = process.env): PoolConfig {
  let url: URL;
  try { url = new URL(connectionString); }
  catch { throw new Error("DATABASE_URL is not a valid PostgreSQL URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) throw new Error("DATABASE_URL requires a PostgreSQL host");
  if (url.searchParams.has("host") || url.searchParams.has("hostaddr")) throw new Error("DATABASE_URL host overrides are not supported");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const local = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  const mode = url.searchParams.get("sslmode");
  const sslValue = url.searchParams.get("ssl");
  const disabled = mode === "disable" || sslValue === "false" || sslValue === "0";
  if (mode === "no-verify" || (disabled && (!local || env.NODE_ENV === "production"))) throw new Error("PostgreSQL TLS verification cannot be disabled");
  const caPath = url.searchParams.get("sslrootcert");
  const certPath = url.searchParams.get("sslcert");
  const keyPath = url.searchParams.get("sslkey");
  const useTls = !local || env.NODE_ENV === "production" || Boolean(mode && mode !== "disable")
    || sslValue === "true" || sslValue === "1" || Boolean(env.DATABASE_SSL_CA || caPath || certPath || keyPath);
  // pg's connection-string parser replaces explicit TLS options when SSL URL
  // parameters are present. Resolve certificates here and remove that override.
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("ssl") || key === "uselibpqcompat") url.searchParams.delete(key);
  }
  return {
    connectionString: url.href,
    ssl: useTls ? {
      rejectUnauthorized: true,
      checkServerIdentity: (_host, certificate) => checkServerIdentity(hostname, certificate),
      ...(env.DATABASE_SSL_CA ? { ca: env.DATABASE_SSL_CA } : caPath ? { ca: readFileSync(caPath, "utf8") } : {}),
      ...(certPath ? { cert: readFileSync(certPath, "utf8") } : {}),
      ...(keyPath ? { key: readFileSync(keyPath, "utf8") } : {}),
    } : false,
  };
}
