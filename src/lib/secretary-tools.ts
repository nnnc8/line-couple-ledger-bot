/**
 * Secretary Tools for Gemini function calling.
 *
 * Extends the accountant read-tools with secretary-specific actions:
 * propose edits, search for recent expenses, manage tasks, remember patterns.
 *
 * All write actions return pending_action / task — LLM never writes directly.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { type FunctionDeclaration, Type } from "@google/genai";

import { executeTool as executeAccountantTool } from "./accountant-tools";
import type { ToolContext } from "./accountant-tools";
import { ledgerQueryService } from "./services";
import { RuleService } from "./rule-service";
import { TaskService } from "./task-service";
import { buildUpdateExpenseAction } from "./pending-action-builders";

/* ─── Types ─── */

export type { ToolContext };

export interface SecretaryDeps {
  db: SupabaseClient;
  coupleId: number;
}

/* ─── Constants ─── */

/* ─── Tool Declarations ─── */

export const secretaryToolDeclarations: FunctionDeclaration[] = [
  // ── Read tools (reuse accountant) ──
  {
    name: "query_expenses",
    description:
      "自由查帳。不指定 limit 只回聚合摘要。有 limit 才回明細（最多 20 筆）。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        date_from: { type: Type.STRING, description: "起始 YYYY-MM-DD" },
        date_to: { type: Type.STRING, description: "結束 YYYY-MM-DD" },
        category: { type: Type.STRING, description: "大分類 enum" },
        category_label: { type: Type.STRING, description: "細分類 label" },
        limit: { type: Type.INTEGER, description: "回傳筆數上限 1-20" },
        type: {
          type: Type.STRING,
          enum: ["shared", "private", "all"],
          description: "帳本類型",
        },
      },
    },
  },
  {
    name: "get_recent_expenses",
    description:
      "查最近 N 筆支出（含共同與私人）。用於「剛剛那筆」、「上一筆」等指代查詢。",
    parameters: {
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
  },
  {
    name: "get_balance_summary",
    description: "查詢目前誰欠誰多少，含 breakdown。",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_budget_status",
    description: "取得當月預算使用狀態。（已停用）",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_open_tasks",
    description: "查詢目前待處理的秘書任務（待分類、待補資料等）。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: { type: Type.INTEGER, description: "回傳筆數上限，預設 10" },
      },
    },
  },
  {
    name: "get_user_memories",
    description: "查詢已儲存的使用者偏好與規則（商家規則、分帳習慣等）。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        kind: {
          type: Type.STRING,
          enum: ["merchant_rule", "category_rule", "split_rule", "routine", "wording_preference"],
          description: "規則類型，不傳則全部",
        },
      },
    },
  },

  // ── Propose tools ──
  {
    name: "record_expense",
    description:
      "記帳。直接建立一筆支出並寫入帳本。",
    parameters: {
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
  },
  {
    name: "propose_update_expense",
    description:
      "修改最近一筆支出。用於「剛剛那筆改私人」、「上一筆改分類」等情境，直接套用修改。",
    parameters: {
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
  },
  {
    name: "propose_settlement",
    description: "建議結清。直接建立結清。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        amount_twd: { type: Type.INTEGER, description: "結清金額" },
        note: { type: Type.STRING, description: "備註" },
      },
      required: ["amount_twd"],
    },
  },
  {
    name: "propose_merchant_rule",
    description:
      "直接建立商家規則。例如「之後 Uber 都私人交通」。",
    parameters: {
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
  },

  // ── Secretary helper tools ──
  {
    name: "create_task",
    description:
      "建立一筆秘書待辦任務。用於需要追蹤但不需要帳務確認的情境（例如：建議使用者整理分類）。",
    parameters: {
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
  },
];

/* ─── Tool Executor ─── */

export async function executeSecretaryTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  // Delegate to accountant tools for read operations
  switch (name) {
    case "query_expenses":
    case "get_balance_summary":
    case "get_budget_status":
      return executeAccountantTool(name, args, ctx);

    case "get_recent_expenses":
      return getRecentExpenses(ctx, args);

    case "get_open_tasks":
      return getOpenTasksTool(ctx, args);

    case "get_user_memories":
      return getUserMemories(ctx, args);

    case "record_expense":
      return recordExpense(ctx, args);

    case "propose_update_expense":
      return proposeUpdateExpense(ctx, args);

    case "propose_settlement":
      return proposeSettlement(ctx, args);

    case "propose_merchant_rule":
      return proposeMerchantRule(ctx, args);

    case "create_task":
      return createSecretaryTask(ctx, args);

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/* ─── get_recent_expenses ─── */

async function getRecentExpenses(ctx: ToolContext, args: Record<string, unknown>) {
  return ledgerQueryService.recentExpenses(
    { db: ctx.db, groupId: ctx.groupId, userId: ctx.userId },
    {
      limit: z.number().int().min(1).max(10).default(5).parse(args.limit ?? 5),
      ledger: z
        .enum(["shared", "private", "all"])
        .default("all")
        .parse(args.ledger ?? "all"),
    },
  );
}

/* ─── get_open_tasks ─── */

async function getOpenTasksTool(ctx: ToolContext, args: Record<string, unknown>) {
  const limit = z.number().int().min(1).max(20).default(10).parse(args.limit ?? 10);
  const tasks = await new TaskService(ctx.db).listOpenTasks({
    coupleId: ctx.coupleId,
    groupId: ctx.groupId,
    limit,
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

/* ─── get_user_memories ─── */

async function getUserMemories(ctx: ToolContext, args: Record<string, unknown>) {
  const kind = z
    .enum(["merchant_rule", "category_rule", "split_rule", "routine", "wording_preference"])
    .optional()
    .parse(args.kind);

  const memories = await new RuleService(ctx.db).listMemories({
    coupleId: ctx.coupleId,
    groupId: ctx.groupId,
    userId: ctx.userId,
    kind,
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

/* ─── record_expense ─── */

async function recordExpense(ctx: ToolContext, args: Record<string, unknown>) {
  return executeAccountantTool("record_expense", args, ctx);
}

/* ─── propose_update_expense ─── */

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

async function proposeUpdateExpense(
  ctx: ToolContext,
  args: Record<string, unknown>,
) {
  try {
    const params = updateExpenseParams.parse(args);
    const action = await buildUpdateExpenseAction(ctx, params.expense_id, params.updates);

    const changedFields = Object.keys(action.updates)
      .map((k) => fieldLabel(k))
      .filter(Boolean)
      .join("、");

    const { data: expense } = await ctx.db
      .from("expenses")
      .select("description")
      .eq("id", params.expense_id)
      .single();

    return {
      pending_action: action,
      message: `已為你修改：${expense?.description ?? "支出"}（${changedFields}）。`,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "修改支出失敗",
    };
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

/* ─── propose_settlement ─── */

async function proposeSettlement(ctx: ToolContext, args: Record<string, unknown>) {
  return executeAccountantTool("settle_debt", args, ctx);
}

/* ─── propose_merchant_rule ─── */

const merchantRuleParams = z.object({
  merchant: z.string().min(1).max(100),
  rule: z.object({
    ledger: z.enum(["shared", "private"]).optional(),
    category: z.string().optional(),
    tag: z.string().optional(),
    paid_by: z.enum(["self", "partner"]).optional(),
  }),
});

async function proposeMerchantRule(
  ctx: ToolContext,
  args: Record<string, unknown>,
) {
  const params = merchantRuleParams.parse(args);
  const result = await new RuleService(ctx.db).createMerchantRule({
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

/* ─── create_secretary_task ─── */

const createTaskParams = z.object({
  type: z.enum([
    "budget_warning",
    "duplicate_expense_review",
    "tag_cleanup",
  ]),
  title: z.string().min(1).max(200),
  summary: z.string().optional(),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
});

async function createSecretaryTask(
  ctx: ToolContext,
  args: Record<string, unknown>,
) {
  const params = createTaskParams.parse(args);

  const result = await new TaskService(ctx.db).createSecretaryTask({
    coupleId: ctx.coupleId,
    groupId: ctx.groupId,
    userId: ctx.userId,
    type: params.type,
    title: params.title,
    summary: params.summary,
    priority: params.priority,
    source: "line",
  });

  return {
    task_id: result.taskId,
    message: result.message,
  };
}
