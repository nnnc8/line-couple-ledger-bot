/**
 * server-env — single source of truth for server-side env reads.
 *
 * The only production code allowed to read `process.env` directly is
 * `src/lib/db/tx.ts` (for DATABASE_URL, with a fail-fast check). Every
 * other server module must go through this module so that:
 *
 *   - All env lookups are documented in one place.
 *   - Optional envs have explicit fallbacks (or explicit "not configured"
 *     sentinels) instead of being silently undefined at module top-level.
 *   - We can swap implementations (e.g. Vercel-only env, secrets manager)
 *     without touching every consumer.
 *
 * The `envSchema` in `server-runtime.ts` still validates the *required*
 * server env at boot; this module only adds typed accessors for the env
 * values that individual modules actually need.
 */

/** App origin used to build LIFF links inside LINE push messages. */
export function getAppUrl(): string {
  return process.env.APP_URL ?? "";
}

/** Direct DB connection string. Caller (withTx) is the only legit reader. */
export function getDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL;
}

export type AgentProvider = "google";

/** Gemini model config. Resolution rules:
 *  - modelId: AGENT_MODEL | "gemini-3.1-flash-lite"
 *  - apiKey: GEMINI_API_KEY | GOOGLE_GENERATIVE_AI_API_KEY
 */
export interface ModelConfig {
  provider: AgentProvider;
  modelId: string;
  apiKey: string | null;
}

/** Resolve model config at call time (so test env mutations are honored). */
export function getModelConfig(modelId?: string): ModelConfig {
  const resolvedId = modelId ?? process.env.AGENT_MODEL ?? "gemini-3.1-flash-lite";
  const configuredProvider = process.env.AGENT_MODEL_PROVIDER;
  if (configuredProvider && configuredProvider !== "google") {
    throw new Error("Only the Google Gemini provider is supported");
  }
  return {
    provider: "google",
    modelId: resolvedId,
    apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? null,
  };
}
