import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";

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
 *   AGENT_MODEL_PROVIDER=google|openai|anthropic
 *   AGENT_MODEL=model-id (e.g. "gemini-3.1-flash-lite", "gpt-4o-mini", "claude-haiku-4-20250514")
 *
 * API Keys:
 *   GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY (for Google, dual-fallback supported)
 *   OPENAI_API_KEY (for OpenAI)
 *   ANTHROPIC_API_KEY (for Anthropic)
 */

export type Provider = "google" | "openai" | "anthropic";

export function getModel(modelId?: string) {
  const { modelId: id, provider } = getModelConfig(modelId);

  switch (provider) {
    case "openai":
      return openai(id);
    case "anthropic":
      return anthropic(id);
    case "google":
    default:
      // Google's provider factory is built lazily with the resolved key so
      // that test-time env mutations are honored at each call.
      const apiKey = getModelConfig(id).apiKey ?? "";
      return createGoogleGenerativeAI({ apiKey })(id);
  }
}
