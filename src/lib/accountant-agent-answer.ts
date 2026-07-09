import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "./model-provider";
import {
  agentRangeLabel,
  aggregateAgentExpenses,
  rankCategoryLabels,
  type AgentScope,
  type AgentTimeRange,
} from "./ledger-agent";

export const agentLlmAnswerSchema = z
  .object({
    answer: z.string().trim().min(1).max(1_800),
    facts: z
      .object({
        totalTwd: z.number().int().min(0),
        transactionCount: z.number().int().min(0),
        topCategoryLabel: z.string().trim().min(1).max(40).nullable(),
        topCategoryTotalTwd: z.number().int().min(0).nullable(),
      })
      .strict(),
  })
  .strict();

export let answerWithGemini = answerWithGeminiImpl;

export function setAnswerWithGemini(fn: typeof answerWithGeminiImpl) {
  answerWithGemini = fn;
}

async function answerWithGeminiImpl(
  input: {
    message: string;
    scope: AgentScope;
    timeRange: AgentTimeRange;
    aggregate: ReturnType<typeof aggregateAgentExpenses>;
    categories: ReturnType<typeof rankCategoryLabels>;
    duplicateCount: number;
    cleanupCount: number;
  },
  fallbackAnswer: string,
): Promise<{ answer: string; source: "llm" | "fallback" }> {
  const expectedFacts = {
    totalTwd: input.aggregate.totalTwd,
    transactionCount: input.aggregate.transactionCount,
    topCategoryLabel: input.categories[0]?.label ?? null,
    topCategoryTotalTwd: input.categories[0]?.totalTwd ?? null,
  };
  try {
    const response = await generateObject({
      model: getModel(),
      system:
        "你是帳務專用 AI 會計師的回覆層。只能根據提供的工具結果回答；不能新增金額、不能假設不存在的帳務、不能要求使用者打開 LIFF 才知道答案。facts 必須逐字等於輸入 facts。若有操作建議，只能描述可直接執行的動作，不要提確認流程。",
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            question: input.message,
            scope: input.scope,
            timeRange: input.timeRange,
            facts: expectedFacts,
            aggregate: input.aggregate,
            categoryRanking: input.categories.slice(0, 10),
            duplicateCount: input.duplicateCount,
            cleanupCount: input.cleanupCount,
          }),
        },
      ],
      temperature: 0.2,
      schema: agentLlmAnswerSchema,
    });
    const parsed = response.object;
    if (
      parsed.facts.totalTwd !== expectedFacts.totalTwd ||
      parsed.facts.transactionCount !== expectedFacts.transactionCount ||
      parsed.facts.topCategoryLabel !== expectedFacts.topCategoryLabel ||
      parsed.facts.topCategoryTotalTwd !== expectedFacts.topCategoryTotalTwd
    ) {
      return { answer: fallbackAnswer, source: "fallback" };
    }
    return { answer: parsed.answer, source: "llm" };
  } catch {
    return { answer: fallbackAnswer, source: "fallback" };
  }
}

export function buildAgentAnswer(input: {
  scope: AgentScope;
  timeRange: AgentTimeRange;
  aggregate: ReturnType<typeof aggregateAgentExpenses>;
  categories: ReturnType<typeof rankCategoryLabels>;
  duplicateCount: number;
  cleanupCount: number;
}) {
  const range = agentRangeLabel(input.timeRange);
  const scope =
    input.scope === "shared"
      ? "共同帳"
      : input.scope === "private"
        ? "私人帳"
        : "合併帳";
  const top = input.categories[0];
  const ranking = input.categories
    .slice(0, 5)
    .map((item, index) => `${index + 1}. ${item.label} NT$${item.totalTwd}（${item.count}筆）`)
    .join("\n");
  const parts = [
    `${range}${scope}共 ${input.aggregate.transactionCount} 筆，總額 NT$${input.aggregate.totalTwd}。`,
  ];
  if (top) parts.push(`花最多的是「${top.label}」NT$${top.totalTwd}。`);
  if (ranking) parts.push(`分類排行：\n${ranking}`);
  if (input.duplicateCount) {
    parts.push(`另外找到 ${input.duplicateCount} 組疑似重複支出，可到 LIFF 檢查。`);
  }
  if (input.cleanupCount) {
    parts.push(`有 ${input.cleanupCount} 筆「其他」可以整理成更細分類，LIFF 可直接批次套用。`);
  }
  return parts.join("\n");
}

export function buildAgentFindings(
  categories: ReturnType<typeof rankCategoryLabels>,
  duplicateCount: number,
) {
  const findings = [];
  const top = categories[0];
  if (top) {
    findings.push({
      severity: "info",
      title: "最大支出分類",
      body: `${top.label} 是目前最高分類，共 ${top.count} 筆。`,
      amountTwd: top.totalTwd,
    });
  }
  const other = categories.find(
    (item) => item.label === "其他" || item.label === "other",
  );
  if (other) {
    findings.push({
      severity: "warning",
      title: "其他分類仍需整理",
      body: "建議使用分類整理，把其他拆成高鐵、外食、咖啡、日用品等實際分類。",
      amountTwd: other.totalTwd,
    });
  }
  if (duplicateCount) {
    findings.push({
      severity: "warning",
      title: "疑似重複支出",
      body: `找到 ${duplicateCount} 組同日同額同描述的支出。`,
      amountTwd: null,
    });
  }
  return findings.slice(0, 8);
}
