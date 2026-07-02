/**
 * Secretary tools — thin adapter.
 *
 * The tool schema, description, parameter shape, and executor for
 * every secretary tool live in `./secretary-tool-registry`. This file
 * only keeps the historical public surface (`ToolContext`,
 * `SecretaryDeps`, `secretaryToolDeclarations`, `executeSecretaryTool`)
 * so existing callers keep working.
 *
 * Adding a new tool = adding an entry to `SECRETARY_TOOLS` in the
 * registry. There is nothing to do here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FunctionDeclaration } from "@google/genai";

import {
  dispatchSecretaryTool,
  geminiDeclarations,
  type ToolContext,
} from "./secretary-tool-registry";

export type { ToolContext };

export interface SecretaryDeps {
  db: SupabaseClient;
  coupleId: number;
}

/**
 * Gemini `FunctionDeclaration[]` for every secretary tool. Derived
 * from the registry; do not edit by hand.
 */
export const secretaryToolDeclarations: FunctionDeclaration[] = geminiDeclarations();

/**
 * Execute a secretary tool by name. Routes through the registry.
 * Unknown tool names return `{ error }` rather than throwing so the
 * LLM gets a recoverable error on its next turn.
 */
export async function executeSecretaryTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  return dispatchSecretaryTool(name, args, ctx);
}
