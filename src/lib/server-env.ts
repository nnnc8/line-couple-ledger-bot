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

export type AgentProvider = "google" | "openai" | "anthropic";

/** Provider-keyed model config. Resolution rules:
 *  - provider: AGENT_MODEL_PROVIDER | heuristic from model id
 *  - modelId:  AGENT_MODEL       | "gemini-3.1-flash-lite"
 *  - apiKey:   provider-specific env | (google: dual-fallback)
 */
export interface ModelConfig {
  provider: AgentProvider;
  modelId: string;
  apiKey: string | null;
}

function detectProvider(modelId: string): AgentProvider {
  if (
    modelId.startsWith("gpt-") ||
    modelId.startsWith("o1") ||
    modelId.startsWith("o3")
  ) {
    return "openai";
  }
  if (modelId.startsWith("claude-")) {
    return "anthropic";
  }
  return "google";
}

function readApiKey(provider: AgentProvider): string | null {
  if (provider === "google") {
    return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? null;
  }
  if (provider === "openai") {
    return process.env.OPENAI_API_KEY ?? null;
  }
  return process.env.ANTHROPIC_API_KEY ?? null;
}

/** Resolve model config at call time (so test env mutations are honored). */
export function getModelConfig(modelId?: string): ModelConfig {
  const resolvedId = modelId ?? process.env.AGENT_MODEL ?? "gemini-3.1-flash-lite";
  const provider =
    (process.env.AGENT_MODEL_PROVIDER as AgentProvider | undefined) ??
    detectProvider(resolvedId);
  return {
    provider,
    modelId: resolvedId,
    apiKey: readApiKey(provider),
  };
}
