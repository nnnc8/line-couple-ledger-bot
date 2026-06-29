import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";

/**
 * Unified model provider resolver.
 *
 * Supports multiple LLM providers through environment variable configuration.
 * Falls back to gemini-3.1-flash-lite when no provider/model is specified.
 *
 * Configuration:
 *   AGENT_MODEL_PROVIDER=google|openai|anthropic
 *   AGENT_MODEL=model-id (e.g. "gemini-3.1-flash-lite", "gpt-4o-mini", "claude-haiku-4-20250514")
 *
 * API Keys:
 *   GEMINI_API_KEY (for Google)
 *   OPENAI_API_KEY (for OpenAI)
 *   ANTHROPIC_API_KEY (for Anthropic)
 */

export type Provider = "google" | "openai" | "anthropic";

function detectProvider(modelId: string): Provider {
  if (modelId.startsWith("gpt-") || modelId.startsWith("o1") || modelId.startsWith("o3")) {
    return "openai";
  }
  if (modelId.startsWith("claude-")) {
    return "anthropic";
  }
  return "google";
}

export function getModel(modelId?: string) {
  const id = modelId || process.env.AGENT_MODEL || "gemini-3.1-flash-lite";
  const provider = (process.env.AGENT_MODEL_PROVIDER as Provider) || detectProvider(id);

  switch (provider) {
    case "openai":
      return openai(id);
    case "anthropic":
      return anthropic(id);
    case "google":
    default:
      return google(id);
  }
}
