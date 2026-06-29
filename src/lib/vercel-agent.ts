import { generateText } from "ai";
import { z } from "zod";

import { executeSecretaryTool } from "./secretary-tools";
import type { ToolContext } from "./accountant-tools";
import { getModel } from "./model-provider";

/* ─── Zod Schemas for Tools ─── */

const recordExpenseSchema = z.object({
  description: z.string().describe("支出說明"),
  amount_twd: z.number().int().positive().describe("金額 TWD 整數"),
  tag: z.string().optional().describe("自由標籤"),
  paid_by: z.enum(["self", "partner"]).describe("誰付的"),
  ledger: z.enum(["shared", "private"]).optional().describe("共同或私人帳"),
  expense_date: z.string().optional().describe("YYYY-MM-DD"),
  merchant: z.string().optional().describe("商家名稱"),
});

const proposeUpdateExpenseSchema = z.object({
  expense_id: z.string().uuid().describe("要修改的支出 ID"),
  updates: z.object({
    ledger: z.enum(["shared", "private"]).optional().describe("改成共同或私人"),
    tag: z.string().optional().describe("標籤"),
    description: z.string().optional().describe("說明"),
    amount_twd: z.number().int().positive().optional().describe("金額"),
    paid_by: z.enum(["self", "partner"]).optional().describe("誰付"),
    expense_date: z.string().optional().describe("日期"),
  }).describe("要修改的欄位（只傳要改的）"),
});

const proposeSettlementSchema = z.object({
  amount_twd: z.number().int().positive().describe("結清金額"),
  note: z.string().optional().describe("備註"),
});

const proposeMerchantRuleSchema = z.object({
  merchant: z.string().describe("商家名稱"),
  rule: z.object({
    ledger: z.enum(["shared", "private"]).optional(),
    tag: z.string().optional(),
    paid_by: z.enum(["self", "partner"]).optional(),
  }).describe("規則內容"),
});

const createTaskSchema = z.object({
  type: z.enum([
    "confirm_expense",
    "fix_uncertain_receipt",
    "budget_warning",
    "duplicate_expense_review",
    "merchant_rule_suggestion",
    "tag_cleanup",
  ]).describe("任務類型"),
  title: z.string().describe("任務標題"),
  summary: z.string().optional().describe("任務摘要"),
  priority: z.enum(["low", "normal", "high"]).optional().describe("優先級"),
});

const queryExpensesSchema = z.object({
  date_from: z.string().optional().describe("起始 YYYY-MM-DD"),
  date_to: z.string().optional().describe("結束 YYYY-MM-DD"),
  category: z.string().optional().describe("大分類 enum"),
  category_label: z.string().optional().describe("細分類 label"),
  limit: z.number().int().min(1).max(20).optional().describe("回傳筆數上限 1-20"),
  type: z.enum(["shared", "private", "all"]).optional().describe("帳本類型"),
});

const getRecentExpensesSchema = z.object({
  limit: z.number().int().min(1).max(10).optional().describe("筆數，預設 5，最多 10"),
  ledger: z.enum(["shared", "private", "all"]).optional().describe("預設 all"),
});

const getBalanceSummarySchema = z.object({});

const getOpenTasksSchema = z.object({
  limit: z.number().int().optional().describe("回傳筆數上限，預設 10"),
});

const getUserMemoriesSchema = z.object({
  kind: z.enum(["merchant_rule", "category_rule", "split_rule", "routine", "wording_preference"]).optional().describe("規則類型，不傳則全部"),
});

/* ─── Mapper function ─── */

export function mapMessages(messages: any[]): any[] {
  return messages.map((msg) => {
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.parts)) {
      content = msg.parts.map((p: any) => p.text || "").join("\n");
    } else if (typeof msg.parts === "string") {
      content = msg.parts;
    }
    return {
      role: msg.role === "model" ? "assistant" : msg.role,
      content,
    };
  });
}

export interface VercelAgentResult {
  answer: string;
  toolCallCount: number;
  pendingActions: any[];
  newTasks: string[];
  notifyPartner: boolean;
  partnerMessage: string | null;
}

export async function runVercelAgent(
  messages: any[],
  systemInstruction: string,
  ctx: ToolContext,
): Promise<VercelAgentResult> {
  const pendingActions: any[] = [];
  const newTasks: string[] = [];
  let notifyPartner = false;
  let partnerMessage: string | null = null;
  let toolCallCount = 0;

  const coreMessages = mapMessages(messages);

  const result = await generateText({
    model: getModel(),
    system: systemInstruction,
    messages: coreMessages,
    maxSteps: 8,
    tools: {
      record_expense: {
        description: "記帳。直接寫入一筆支出，不需使用者再按確認。",
        parameters: recordExpenseSchema,
        execute: async (args: any) => {
          toolCallCount++;
          const res = (await executeSecretaryTool("record_expense", args, ctx)) as any;
          if (res?.pending_action) pendingActions.push(res.pending_action);
          return res;
        },
      },
      propose_update_expense: {
        description: "修改最近一筆支出。用於「剛剛那筆改私人」、「上一筆改分類」等情境。",
        parameters: proposeUpdateExpenseSchema,
        execute: async (args: any) => {
          toolCallCount++;
          notifyPartner = true;
          const res = (await executeSecretaryTool("propose_update_expense", args, ctx)) as any;
          if (res?.pending_action) pendingActions.push(res.pending_action);
          return res;
        },
      },
      propose_settlement: {
        description: "建議或建立結清。直接寫入，不需使用者再按確認。",
        parameters: proposeSettlementSchema,
        execute: async (args: any) => {
          toolCallCount++;
          notifyPartner = true;
          const res = (await executeSecretaryTool("propose_settlement", args, ctx)) as any;
          if (res?.pending_action) pendingActions.push(res.pending_action);
          return res;
        },
      },
      propose_merchant_rule: {
        description: "建立商家自動套用規則（如之後 Uber 都私人交通）。",
        parameters: proposeMerchantRuleSchema,
        execute: async (args: any) => {
          toolCallCount++;
          const res = (await executeSecretaryTool("propose_merchant_rule", args, ctx)) as any;
          if (res?.pending_action) pendingActions.push(res.pending_action);
          return res;
        },
      },
      create_task: {
        description: "建立一筆秘書待辦任務。",
        parameters: createTaskSchema,
        execute: async (args: any) => {
          toolCallCount++;
          const res = (await executeSecretaryTool("create_task", args, ctx)) as any;
          if (res?.task_id) newTasks.push(String(res.task_id));
          return res;
        },
      },
      query_expenses: {
        description: "自由查帳。不指定 limit 只回聚合摘要。有 limit 才回明細（最多 20 筆）。",
        parameters: queryExpensesSchema,
        execute: async (args: any) => {
          toolCallCount++;
          return executeSecretaryTool("query_expenses", args, ctx);
        },
      },
      get_recent_expenses: {
        description: "查最近 N 筆支出（含共同與私人）。用於「剛剛那筆」、「上一筆」等指代查詢。",
        parameters: getRecentExpensesSchema,
        execute: async (args: any) => {
          toolCallCount++;
          return executeSecretaryTool("get_recent_expenses", args, ctx);
        },
      },
      get_balance_summary: {
        description: "查詢目前誰欠誰多少，含 breakdown。",
        parameters: getBalanceSummarySchema,
        execute: async () => {
          toolCallCount++;
          return executeSecretaryTool("get_balance_summary", {}, ctx);
        },
      },
      get_open_tasks: {
        description: "查詢目前待處理的秘書任務。",
        parameters: getOpenTasksSchema,
        execute: async (args: any) => {
          toolCallCount++;
          return executeSecretaryTool("get_open_tasks", args, ctx);
        },
      },
      get_user_memories: {
        description: "查詢已儲存的使用者偏好與規則。",
        parameters: getUserMemoriesSchema,
        execute: async (args: any) => {
          toolCallCount++;
          return executeSecretaryTool("get_user_memories", args, ctx);
        },
      },
    },
  } as any);

  let answer = result.text || "處理完成。";

  // Parse [通知另一半] tag if present
  const notifyTag = "[通知另一半]";
  if (answer.includes(notifyTag)) {
    notifyPartner = true;
    answer = answer.replace(notifyTag, "").trim();
  } else {
    notifyPartner = false;
  }

  if (notifyPartner) {
    partnerMessage = answer.slice(0, 200);
  }

  return {
    answer,
    toolCallCount,
    pendingActions,
    newTasks,
    notifyPartner,
    partnerMessage,
  };
}
