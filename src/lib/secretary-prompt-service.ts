import type { SupabaseClient } from "@supabase/supabase-js";

import type { ToolContext } from "./accountant-tools";
import { RuleService } from "./rule-service";
import { TaskService } from "./task-service";
import { loadGroupBalances } from "./balance-loader";

const PROMPT_BODY = `你的任務是幫他們管理共同帳務：
- 記帳、改帳、查帳
- 追蹤待處理的事
- 記得對方的習慣

**語氣：** 親切、自然、像真人秘書。用「我」、「你」、「\${partnerName}」稱呼。偶爾用「好喔」、「沒問題」、「我幫你」、「收到～」。
不要假裝是 AI，你就是一個在幫他們顧帳的朋友。

**規則：**
1. ⚠️ **記帳必須用 record_expense 工具！** 當用戶訊息包含「記」、「新增」、「幫我記」、「加一筆」、「記一筆」、「記帳」等關鍵字時，**你必須**呼叫 record_expense 工具。如果金額或描述不清楚，可以先問，但絕對不可以只回覆「處理完成」而沒有實際呼叫工具。
2. **記帳後必須確認結果：** 工具回傳的 message 欄位（已為您建立一筆...）要原封不動地當作最終回覆，不要再加油添醋。
3. 金額都是正整數新台幣。
4. 分類使用英文 enum：food / transport / shopping / entertainment / housing / utilities / health / education / travel / other。
   category_label 使用自由中文標籤如「餐飲」、「交通」、「共享機車」等。
5. 預設共同帳 shared，只有明確說「私人」才用 private。
6. 「我付」= self，「他付 / 她付 / 對方付 / 另一半付」= partner。
7. 回覆繁體中文，簡潔親切。
8. 不確定的時候先問，不要自己決定。
9. 如果使用者說「剛剛那筆」、「上一筆」，用 get_recent_expenses 查最近的支出再判斷。
10. 如果使用者說「之後XX都OO」，用 propose_merchant_rule 建立規則建議。
11. 如果使用者問「有什麼還沒處理」，用 get_open_tasks 查詢任務。
12. 如果商家名稱有已存的 approved merchant_rule，自動套用不用再問。
13. 涉及另一半的變動（結清、規則等），要告知對方。
14. 如果使用者意圖模糊，主動問清楚而不是亂猜。
15. ⚠️ **共享帳群組規則：** 如果使用者要記共同帳（shared），訊息中必須包含群組名稱。如果你無法從訊息中辨識群組名，不要呼叫 record_expense，直接回覆請使用者指定群組。
16. ⚠️ **回覆確認規則：** 記帳成功後，回覆必須包含「帳別（共同/私人）、群組名稱（如有）、金額、付款人」四項資訊，確保使用者知道記到了哪裡。
17. ⚠️ **自主通知另一半的決策：** 如果你的回覆內容涉及重要的共同變動（例如建立或修改了新商家規則、共同分帳模式、提出結清等），且你認為另一半【非常有必要】知道這件事，請在你的最終文字回覆最尾端加上標籤「[通知另一半]」；如果是私人帳、私人查帳、私人閒聊，或不重要的資訊，【絕對不要】加此標籤。`;

interface BalanceRow {
  user_id: string;
  balance_twd: number;
}

export class SecretaryPromptService {
  private readonly taskService: Pick<TaskService, "listOpenTasks">;
  private readonly ruleService: Pick<RuleService, "listMemories">;
  private readonly getBalances: (groupId: string) => Promise<BalanceRow[]>;

  constructor(input: {
    db: SupabaseClient;
    taskService?: Pick<TaskService, "listOpenTasks">;
    ruleService?: Pick<RuleService, "listMemories">;
    getBalances?: (groupId: string) => Promise<BalanceRow[]>;
  }) {
    this.taskService = input.taskService ?? new TaskService(input.db);
    this.ruleService = input.ruleService ?? new RuleService(input.db);
    this.getBalances =
      input.getBalances ??
      (async (groupId) => {
        try {
          const rows = await loadGroupBalances(input.db, groupId);
          return rows.map((row) => ({
            user_id: row.userId,
            balance_twd: row.balanceTwd,
          }));
        } catch {
          return [];
        }
      });
  }

  async buildPrompt(input: {
    ctx: ToolContext;
    today: string;
    userName: string;
    partnerName: string;
  }): Promise<string> {
    const balanceInfo = await this.buildBalanceInfo(
      input.ctx.groupId,
      input.ctx.userId,
      input.userName,
    );
    const taskInfo = await this.buildTaskInfo(input.ctx);
    const rulesInfo = await this.buildRulesInfo(input.ctx);
    const groupNames = await this.listGroupNames(input.ctx);
    const groupInfo = groupNames.length > 0
      ? `可用群組：${groupNames.join("、")}。`
      : "";
    const intro = `你是「帳務秘書」，一個住在 LINE 裡的貼心記帳助手，服務 ${input.userName} 和 ${input.partnerName}（一對伴侶）。
今天是 ${input.today}。${groupInfo}${balanceInfo}${taskInfo ? ` ${taskInfo}` : ""}${rulesInfo ? ` ${rulesInfo}` : ""}`;

    return `${intro}

${PROMPT_BODY.replaceAll("${partnerName}", input.partnerName)}`;
  }

  private async buildBalanceInfo(
    groupId: string,
    userId: string,
    userName: string,
  ): Promise<string> {
    const balances = await this.getBalances(groupId);
    const myBalance =
      balances.find((balance) => balance.user_id === userId)?.balance_twd ?? 0;
    if (myBalance > 0) {
      return `目前：另一半欠 ${userName} NT$${myBalance}`;
    }
    if (myBalance < 0) {
      return `目前：${userName} 欠另一半 NT$${Math.abs(myBalance)}`;
    }
    return "目前帳務已結清。";
  }

  private async buildTaskInfo(ctx: ToolContext): Promise<string> {
    const tasks = await this.taskService.listOpenTasks({
      coupleId: ctx.coupleId,
      groupId: ctx.groupId,
      limit: 5,
    });
    return tasks.length > 0 ? `目前有 ${tasks.length} 件待處理任務。` : "";
  }

  private async buildRulesInfo(ctx: ToolContext): Promise<string> {
    const merchantRules = await this.ruleService.listMemories({
      coupleId: ctx.coupleId,
      groupId: ctx.groupId,
      kind: "merchant_rule",
      limit: 5,
    });
    const approvedRules = merchantRules
      .filter((memory) => memory.approved_at)
      .map((memory) => `${memory.key} → ${JSON.stringify(memory.value)}`);
    return approvedRules.length > 0
      ? `已知商家規則：${approvedRules.join("、")}`
      : "";
  }

  private async listGroupNames(ctx: ToolContext): Promise<string[]> {
    try {
      const { data } = await ctx.db
        .from("groups")
        .select("name")
        .eq("couple_id", ctx.coupleId)
        .is("archived_at", null);
      return (data ?? []).map((g: { name: string }) => g.name);
    } catch {
      return [];
    }
  }
}
