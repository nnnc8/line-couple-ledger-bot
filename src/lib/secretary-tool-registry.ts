/**
 * secretary-tool-registry — single source of truth for the secretary
 * tool surface.
 *
 * Before this file existed, the same set of tools was declared twice:
 *   1. `secretary-tools.ts` exposed a Gemini `FunctionDeclaration[]`
 *      that `secretary-agent.ts` could hand to a Gemini `generateContent`
 *      call directly.
 *   2. `vercel-agent.ts` re-declared each tool as a zod schema with
 *      `.describe()` plus an `execute` closure to hand to the Vercel
 *      AI SDK's `generateText`.
 *
 * The descriptions, parameter lists, and runtime argument parsing had
 * already started to drift between the two. This registry is the only
 * place where:
 *   - the tool name list lives
 *   - the LLM description lives
 *   - the Gemini `parameters` shape lives
 *   - the runtime zod parser lives
 *   - the executor lives
 *
 * Both consumers (Gemini declarations and Vercel AI SDK tools) derive
 * from the same list.
 *
 * Adding a new secretary tool = adding one entry to `SECRETARY_TOOLS`
 * below. Removing one = deleting the entry. Renaming one = changing
 * the entry. There is no second place to update.
 */
import { type FunctionDeclaration, Type } from "@google/genai";
import { z } from "zod";

import { executeTool as executeAccountantTool } from "./accountant-tools";
import type { ToolContext } from "./accountant-tools";
import { buildUpdateExpenseAction, buildDeleteExpenseAction } from "./pending-action-builders";
import { executeDirectUpdate, executeDirectDelete } from "./secretary-direct-actions";
import { suggestTag, normalizeTag } from "./tag-suggestion-service";
import { RuleService } from "./rule-service";
import { TaskService } from "./task-service";
import { ledgerQueryService } from "./services";

/* -------------------------------------------------------------------------
 * Public types
 * ------------------------------------------------------------------------- */

export type { ToolContext };

/**
 * A secretary tool definition. The description is consumed by both the
 * Gemini declaration and the Vercel `tools` entry; the `geminiParameters`
 * shape is what Gemini sees; the `zodSchema` is what the executor uses
 * to parse LLM args before they hit downstream services; the
 * `executor` does the work and returns the result that the LLM will
 * see on its next turn.
 */
export interface SecretaryToolDef {
  name: string;
  description: string;
  geminiParameters: FunctionDeclaration["parameters"];
  zodSchema: z.ZodTypeAny;
  executor: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<unknown>;
}

/* -------------------------------------------------------------------------
 * Small service-instantiation helpers
 *
 * Two services (`TaskService`, `RuleService`) used to be `new`-ed in
 * three different places. These helpers keep construction in one
 * place so a future constructor change doesn't have to be hunted
 * down across the codebase.
 * ------------------------------------------------------------------------- */
export function getTaskService(db: ToolContext["db"]): TaskService {
  return new TaskService(db);
}

export function getRuleService(db: ToolContext["db"]): RuleService {
  return new RuleService(db);
}

/* -------------------------------------------------------------------------
 * Per-tool executors
 * ------------------------------------------------------------------------- */

async function executeGetRecentExpenses(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  const parsed = getRecentExpensesSchema.parse(args);
  return ledgerQueryService.recentExpenses(
    { db: ctx.db, groupId: ctx.groupId, userId: ctx.userId },
    parsed,
  );
}

async function executeGetOpenTasks(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  const parsed = getOpenTasksSchema.parse(args);
  const tasks = await getTaskService(ctx.db).listOpenTasks({
    coupleId: ctx.coupleId,
    groupId: ctx.groupId,
    limit: parsed.limit,
  });
  return {
    count: tasks.length,
    tasks: tasks.map((t) => ({
      id: t.id,
      type: t.type,
      title: t.title,
      summary: t.summary,
      priority: t.priority,
      status: t.status,
    })),
  };
}

async function executeGetUserMemories(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  const parsed = getUserMemoriesSchema.parse(args);
  const memories = await getRuleService(ctx.db).listMemories({
    coupleId: ctx.coupleId,
    groupId: ctx.groupId,
    userId: ctx.userId,
    kind: parsed.kind,
    limit: 20,
  });
  return {
    count: memories.length,
    items: memories.map((m) => ({
      id: m.id,
      kind: m.kind,
      key: m.key,
      value: m.value,
      confidence: m.confidence,
      scope: m.scope,
      approved: !!m.approved_at,
    })),
  };
}

async function executeUpdateExpense(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  const params = updateExpenseParams.parse(args);
  try {
    const { data: expense } = await ctx.db
      .from("expenses")
      .select("ledger, created_by_user_id, deleted_at, description")
      .eq("id", params.expense_id)
      .single();

    if (!expense) {
      return { error: "找不到這筆支出。" };
    }

    const isPrivate = expense.ledger === "private"
      && expense.created_by_user_id === ctx.userId
      && !expense.deleted_at;

    if (isPrivate) {
      return executeDirectUpdate(ctx, params.expense_id, params.updates);
    }

    const action = await buildUpdateExpenseAction(ctx, params.expense_id, params.updates);
    const changedFields = Object.keys(action.updates)
      .map((k) => fieldLabel(k))
      .filter(Boolean)
      .join("、");
    return {
      pending_action: action,
      message: `已為你修改：${expense?.description ?? "支出"}（${changedFields}）。`,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "修改支出失敗" };
  }
}

async function executeDeleteExpense(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  const params = deleteExpenseParams.parse(args);
  try {
    const { data: expense } = await ctx.db
      .from("expenses")
      .select("ledger, created_by_user_id, deleted_at, description")
      .eq("id", params.expense_id)
      .single();

    if (!expense) {
      return { error: "找不到這筆支出。" };
    }

    const isPrivate = expense.ledger === "private"
      && expense.created_by_user_id === ctx.userId
      && !expense.deleted_at;

    if (isPrivate) {
      return executeDirectDelete(ctx, params.expense_id);
    }

    const action = await buildDeleteExpenseAction(ctx, params.expense_id);
    return {
      pending_action: action,
      message: `已為你刪除：${expense?.description ?? "支出"}。`,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "刪除支出失敗" };
  }
}

function fieldLabel(key: string): string {
  const map: Record<string, string> = {
    ledger: "帳本類型",
    tag: "標籤",
    description: "說明",
    amount_twd: "金額",
    paid_by_user_id: "付款人",
    expense_date: "日期",
  };
  return map[key] ?? key;
}

async function normalizeTagInArgs(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  if (typeof args.tag !== "string" || !args.tag) return args;
  try {
    const suggestions = await suggestTag(
      { db: ctx.db, coupleId: ctx.coupleId, groupId: ctx.groupId, userId: ctx.userId },
      typeof args.description === "string" ? args.description : "",
      typeof args.merchant === "string" ? args.merchant : undefined,
    );
    if (suggestions.length > 0) {
      const normalized = normalizeTag(args.tag, suggestions);
      if (normalized !== args.tag) {
        return { ...args, tag: normalized };
      }
    }
  } catch {
    // Tag suggestion is best-effort; don't block recording on failure
  }
  return args;
}

async function executeProposeMerchantRule(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  const params = merchantRuleParams.parse(args);
  const result = await getRuleService(ctx.db).createMerchantRule({
    coupleId: ctx.coupleId,
    groupId: ctx.groupId,
    userId: ctx.userId,
    merchant: params.merchant,
    rule: {
      ledger: params.rule.ledger,
      category: params.rule.category,
      tag: params.rule.tag,
      paidBy: params.rule.paid_by,
    },
    scope: "group",
    source: "line",
  });
  return {
    memory_id: result.memoryId,
    message: result.message,
    memory: result.memory,
  };
}

async function executeCreateTask(
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  const params = createTaskParams.parse(args);
  const result = await getTaskService(ctx.db).createSecretaryTask({
    coupleId: ctx.coupleId,
    groupId: ctx.groupId,
    userId: ctx.userId,
    type: params.type,
    title: params.title,
    summary: params.summary,
    priority: params.priority,
    source: "line",
  });
  return { task_id: result.taskId, message: result.message };
}

/* -------------------------------------------------------------------------
 * Zod schemas (one per tool)
 *
 * These were previously inline in `secretary-tools.ts` and re-declared
 * with `.describe()` in `vercel-agent.ts`. Only one place now.
 * ------------------------------------------------------------------------- */

const getRecentExpensesSchema = z.object({
  limit: z.number().int().min(1).max(10).default(5),
  ledger: z.enum(["shared", "private", "all"]).default("all"),
});

const getOpenTasksSchema = z.object({
  limit: z.number().int().min(1).max(20).default(10),
});

const getUserMemoriesSchema = z.object({
  kind: z
    .enum([
      "merchant_rule",
      "category_rule",
      "split_rule",
      "routine",
      "wording_preference",
    ])
    .optional(),
});

const updateExpenseParams = z.object({
  expense_id: z.string(),
  updates: z.object({
    ledger: z.enum(["shared", "private"]).optional(),
    category: z.string().optional(),
    tag: z.string().min(1).max(40).optional(),
    description: z.string().min(1).max(200).optional(),
    amount_twd: z.number().int().positive().optional(),
    paid_by: z.enum(["self", "partner"]).optional(),
    expense_date: z.string().optional(),
  }),
});

const deleteExpenseParams = z.object({
  expense_id: z.string(),
});

const merchantRuleParams = z.object({
  merchant: z.string().min(1).max(100),
  rule: z.object({
    ledger: z.enum(["shared", "private"]).optional(),
    category: z.string().optional(),
    tag: z.string().optional(),
    paid_by: z.enum(["self", "partner"]).optional(),
  }),
});

const createTaskParams = z.object({
  type: z.enum(["budget_warning", "duplicate_expense_review", "tag_cleanup"]),
  title: z.string().min(1).max(200),
  summary: z.string().optional(),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
});

/* -------------------------------------------------------------------------
 * The canonical tool list
 * ------------------------------------------------------------------------- */

export const SECRETARY_TOOLS: SecretaryToolDef[] = [
  // ── Read tools (reuse accountant) ──
  {
    name: "query_expenses",
    description: "自由查帳。不指定 limit 只回聚合摘要。有 limit 才回明細（最多 20 筆）。",
    geminiParameters: {
      type: Type.OBJECT,
      properties: {
        date_from: { type: Type.STRING, description: "起始 YYYY-MM-DD" },
        date_to: { type: Type.STRING, description: "結束 YYYY-MM-DD" },
        tag: { type: Type.STRING, description: "自由中文標籤" },
        limit: { type: Type.INTEGER, description: "回傳筆數上限 1-20" },
        type: {
          type: Type.STRING,
          enum: ["shared", "private", "all"],
          description: "帳本類型",
        },
      },
    },
    zodSchema: z.object({}).passthrough(),
    executor: (args, ctx) => executeAccountantTool("query_expenses", args, ctx),
  },
  {
    name: "get_recent_expenses",
    description: "查最近 N 筆支出（含共同與私人）。用於「剛剛那筆」、「上一筆」等指代查詢。",
    geminiParameters: {
      type: Type.OBJECT,
      properties: {
        limit: { type: Type.INTEGER, description: "筆數，預設 5，最多 10" },
        ledger: {
          type: Type.STRING,
          enum: ["shared", "private", "all"],
          description: "預設 all",
        },
      },
    },
    zodSchema: getRecentExpensesSchema,
    executor: executeGetRecentExpenses,
  },
  {
    name: "get_balance_summary",
    description: "查詢目前誰欠誰多少，含 breakdown。",
    geminiParameters: { type: Type.OBJECT, properties: {} },
    zodSchema: z.object({}).passthrough(),
    executor: (args, ctx) => executeAccountantTool("get_balance_summary", args, ctx),
  },
  {
    name: "get_open_tasks",
    description: "查詢目前待處理的秘書任務（待分類、待補資料等）。",
    geminiParameters: {
      type: Type.OBJECT,
      properties: {
        limit: { type: Type.INTEGER, description: "回傳筆數上限，預設 10" },
      },
    },
    zodSchema: getOpenTasksSchema,
    executor: executeGetOpenTasks,
  },
  {
    name: "get_user_memories",
    description: "查詢已儲存的使用者偏好與規則（商家規則、分帳習慣等）。",
    geminiParameters: {
      type: Type.OBJECT,
      properties: {
        kind: {
          type: Type.STRING,
          enum: [
            "merchant_rule",
            "category_rule",
            "split_rule",
            "routine",
            "wording_preference",
          ],
          description: "規則類型，不傳則全部",
        },
      },
    },
    zodSchema: getUserMemoriesSchema,
    executor: executeGetUserMemories,
  },

  // ── Propose tools (write to pending actions / rules / tasks) ──
  {
    name: "record_expense",
    description:
      "記帳。直接寫入一筆支出，不需使用者再按確認。**重要規則：** 共同帳（shared）的群組由系統自動處理，LLM 不需要傳入群組。私人帳（private）不需要群組。當用戶說「私人」、「自己」、「我自己的」時，ledger 必須是 \"private\"；只有用戶說「共同」、「一起」、「分攤」時才是 \"shared\"。tag 使用自由中文標籤（如「餐飲」、「交通」、「共享機車」），不確定時可省略，由後端分類器補上。",
    geminiParameters: {
      type: Type.OBJECT,
      properties: {
        description: { type: Type.STRING, description: "支出說明" },
        amount_twd: { type: Type.INTEGER, description: "金額 TWD 整數" },
        tag: { type: Type.STRING, description: "自由標籤" },
        paid_by: {
          type: Type.STRING,
          enum: ["self", "partner"],
          description: "誰付的",
        },
        ledger: {
          type: Type.STRING,
          enum: ["shared", "private"],
          description: "共同或私人帳",
        },
        expense_date: { type: Type.STRING, description: "YYYY-MM-DD" },
        merchant: { type: Type.STRING, description: "商家名稱" },
      },
      required: ["description", "amount_twd", "paid_by"],
    },
    zodSchema: z.object({}).passthrough(),
    executor: async (args, ctx) => {
      const ledger = typeof args.ledger === "string" ? args.ledger : "shared";

      const payerHint = ctx.context?.deterministicPayerHint;
      const normalizedArgs = await normalizeTagInArgs(
        typeof args.paid_by === "string" || typeof payerHint !== "string"
          ? args
          : { ...args, paid_by: payerHint },
        ctx,
      );

      if (ledger !== "private") {
        const resolvedGroupId = ctx.context?.resolvedGroupId as string | undefined;
        if (!resolvedGroupId) {
          return {
            error: "系統錯誤：共享帳未綁定群組。請確認用戶已選擇群組。",
          };
        }
        return executeAccountantTool("record_expense", normalizedArgs, { ...ctx, groupId: resolvedGroupId });
      }

      return executeAccountantTool("record_expense", normalizedArgs, ctx);
    },
  },
  {
    name: "update_expense",
    description:
      "修改一筆支出。私人帳直接修改，共同帳需確認。用於「剛剛那筆改私人」、「上一筆改分類」等情境。",
    geminiParameters: {
      type: Type.OBJECT,
      properties: {
        expense_id: { type: Type.STRING, description: "要修改的支出 ID" },
        updates: {
          type: Type.OBJECT,
          description: "要修改的欄位（只傳要改的）",
          properties: {
            ledger: {
              type: Type.STRING,
              enum: ["shared", "private"],
              description: "改成共同或私人",
            },
            tag: { type: Type.STRING, description: "標籤" },
            description: { type: Type.STRING, description: "說明" },
            amount_twd: { type: Type.INTEGER, description: "金額" },
            paid_by: {
              type: Type.STRING,
              enum: ["self", "partner"],
              description: "誰付",
            },
            expense_date: { type: Type.STRING, description: "日期" },
          },
        },
      },
      required: ["expense_id", "updates"],
    },
    zodSchema: updateExpenseParams,
    executor: executeUpdateExpense,
  },
  {
    name: "delete_expense",
    description:
      "刪除一筆支出。私人帳直接刪除，共同帳需確認。用於「刪掉上一筆」、「剛剛那筆刪了」等情境。",
    geminiParameters: {
      type: Type.OBJECT,
      properties: {
        expense_id: { type: Type.STRING, description: "要刪除的支出 ID" },
      },
      required: ["expense_id"],
    },
    zodSchema: deleteExpenseParams,
    executor: executeDeleteExpense,
  },
  {
    name: "propose_settlement",
    description: "建議或建立結清。直接寫入，不需使用者再按確認。",
    geminiParameters: {
      type: Type.OBJECT,
      properties: {
        amount_twd: { type: Type.INTEGER, description: "結清金額" },
        note: { type: Type.STRING, description: "備註" },
      },
      required: ["amount_twd"],
    },
    zodSchema: z.object({}).passthrough(),
    executor: (args, ctx) => executeAccountantTool("settle_debt", args, ctx),
  },
  {
    name: "propose_merchant_rule",
    description: "建立商家自動套用規則（如之後 Uber 都私人交通）。",
    geminiParameters: {
      type: Type.OBJECT,
      properties: {
        merchant: { type: Type.STRING, description: "商家名稱" },
        rule: {
          type: Type.OBJECT,
          description: "規則內容",
          properties: {
            ledger: {
              type: Type.STRING,
              enum: ["shared", "private"],
            },
            tag: { type: Type.STRING },
            paid_by: {
              type: Type.STRING,
              enum: ["self", "partner"],
            },
          },
        },
      },
      required: ["merchant", "rule"],
    },
    zodSchema: merchantRuleParams,
    executor: executeProposeMerchantRule,
  },

  // ── Secretary helper tools ──
  {
    name: "create_task",
    description: "建立一筆秘書待辦任務。",
    geminiParameters: {
      type: Type.OBJECT,
      properties: {
        type: {
          type: Type.STRING,
          enum: [
            "budget_warning",
            "duplicate_expense_review",
            "tag_cleanup",
          ],
        },
        title: { type: Type.STRING, description: "任務標題" },
        summary: { type: Type.STRING, description: "任務摘要" },
        priority: {
          type: Type.STRING,
          enum: ["low", "normal", "high"],
        },
      },
      required: ["type", "title"],
    },
    zodSchema: createTaskParams,
    executor: executeCreateTask,
  },
];

/* -------------------------------------------------------------------------
 * Consumers
 * ------------------------------------------------------------------------- */

const TOOL_BY_NAME = new Map(SECRETARY_TOOLS.map((t) => [t.name, t]));

/** Names of every secretary tool. */
export const SECRETARY_TOOL_NAMES: readonly string[] = SECRETARY_TOOLS.map(
  (t) => t.name,
);

/**
 * Resolve a tool definition by name. Throws if the name is not
 * registered; callers should ensure name comes from `SECRETARY_TOOL_NAMES`
 * or from a tool-call that the LLM has produced from a registered name.
 */
export function getSecretaryTool(name: string): SecretaryToolDef {
  const def = TOOL_BY_NAME.get(name);
  if (!def) {
    throw new Error(`Unknown secretary tool: ${name}`);
  }
  return def;
}

/** Look up a tool by name without throwing. Returns `undefined` if absent. */
export function findSecretaryTool(name: string): SecretaryToolDef | undefined {
  return TOOL_BY_NAME.get(name);
}

/** Build a Gemini `FunctionDeclaration[]` for all secretary tools. */
export function geminiDeclarations(): FunctionDeclaration[] {
  return SECRETARY_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.geminiParameters,
  }));
}

/**
 * Build a Vercel AI SDK `tools` object. The executor for every tool is
 * routed through `dispatchTool`, so workflow / notify-partner side
 * effects work the same way for any tool.
 */
export function vercelToolDefs(input: {
  dispatchTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}) {
  const out: Record<
    string,
    {
      description: string;
      parameters: z.ZodTypeAny;
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    }
  > = {};
  for (const tool of SECRETARY_TOOLS) {
    out[tool.name] = {
      description: tool.description,
      parameters: tool.zodSchema,
      execute: async (args) => input.dispatchTool(tool.name, args),
    };
  }
  return out;
}

/**
 * Dispatch a tool call by name. Used by `executeSecretaryTool` (the
 * thin adapter) and by `vercel-agent.ts` via `dispatchTool`.
 */
export async function dispatchSecretaryTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const tool = findSecretaryTool(name);
  if (!tool) {
    return { error: `Unknown tool: ${name}` };
  }
  return tool.executor(args, ctx);
}
