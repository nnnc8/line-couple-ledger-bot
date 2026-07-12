import { createGoogleGenerativeAI } from "@ai-sdk/google";

import { getModelConfig } from "./server-env";

/**
 * Unified model provider resolver.
 *
 * Public API (`getModel(modelId?)`) is unchanged. The actual env reads
 * (GEMINI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, AGENT_MODEL, etc.) now
 * live in `server-env.ts` so that no production code other than
 * `db/tx.ts` touches `process.env` directly.
 *
 * Configuration:
 *   AGENT_MODEL=model-id (e.g. "gemini-3.1-flash-lite")
 *
 * API Keys:
 *   GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY (for Google, dual-fallback supported)
 */

export function getModel(modelId?: string) {
  const { modelId: id, apiKey } = getModelConfig(modelId);
  return createGoogleGenerativeAI({ apiKey: apiKey ?? "" })(id);
}
