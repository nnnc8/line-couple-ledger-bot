import type { SupabaseClient } from "@supabase/supabase-js";
import { type FunctionDeclaration } from "@google/genai";
import {
  accountantToolDeclarations,
  dispatchAccountantTool,
} from "./accountant-tool-registry";

export interface ToolContext {
  db: SupabaseClient;
  groupId: string;
  userId: string;
  coupleId: number;
}

export const toolDeclarations: FunctionDeclaration[] = accountantToolDeclarations();

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  return dispatchAccountantTool(name, args, ctx);
}
