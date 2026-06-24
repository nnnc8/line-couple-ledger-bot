import type { GoogleGenAI } from "@google/genai";
import { z } from "zod";

import { categories, type Category } from "./ledger";

export const categoryClassificationSchema = z
  .object({
    category: z.enum(categories),
    categoryLabel: z.string().trim().min(1).max(40),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().max(120).default(""),
  })
  .strict();

export const geminiCategoryClassificationJsonSchema = Object.fromEntries(
  Object.entries(z.toJSONSchema(categoryClassificationSchema)).filter(
    ([key]) => key !== "$schema",
  ),
);

export type CategoryClassification = z.infer<typeof categoryClassificationSchema>;

export interface CategoryClassificationInput {
  description: string;
  merchant?: string | null;
  groupName?: string | null;
  fallbackCategory: Category;
  history: Array<{
    category: Category;
    categoryLabel: string;
    description: string;
    merchant?: string | null;
  }>;
}

export interface PrivateMirrorSource {
  sourceExpenseId: string;
  requesterUserId: string;
  description: string;
  merchant: string | null;
  notes: string | null;
  category: Category;
  categoryLabel: string;
  expenseDate: string;
  splits: Record<string, number>;
  deletedAt: string | null;
}

export function fallbackCategoryClassification(
  input: CategoryClassificationInput,
): CategoryClassification {
  const normalized = normalize(
    `${input.groupName ?? ""} ${input.merchant ?? ""} ${input.description}`,
  );
  const expenseText = normalize(`${input.merchant ?? ""} ${input.description}`);
  const foodGroup = /吃|餐|食|喝|food|meal/i.test(input.groupName ?? "");

  if (/停車|parking/.test(normalized)) {
    return result("transport", "停車費", 0.9, "parking");
  }
  if (/加油|油資|fuel/.test(normalized)) {
    return result("transport", "油資", 0.9, "fuel");
  }
  if (/高鐵|台鐵|火車|捷運|公車|客運|uber|計程車|交通|車資/.test(normalized)) {
    return result("transport", historyLabel(input, "transport") ?? "交通", 0.8, "transport");
  }
  if (/咖啡|飲料|手搖|茶|酒|喝/.test(expenseText)) {
    return result("food", foodGroup ? "飲料" : "餐飲", 0.85, "drink");
  }
  if (/甜點|蛋糕|冰|布丁|餅乾/.test(expenseText)) {
    return result("food", foodGroup ? "甜點" : "餐飲", 0.85, "dessert");
  }
  if (/超市|市場|生鮮|水果|蔬菜|全聯|家樂福|costco/i.test(normalized)) {
    return result(foodGroup ? "groceries" : "groceries", "生鮮", 0.8, "groceries");
  }
  if (
    foodGroup ||
    /早餐|午餐|晚餐|宵夜|餐|飯|麵|漢堡|便當|火鍋|拉麵|越南|料理|吃/.test(
      normalized,
    )
  ) {
    return result("food", foodGroup ? "餐飲" : "餐飲", 0.85, "food group");
  }

  const learned = historyLabel(input, input.fallbackCategory);
  if (learned) return result(input.fallbackCategory, learned, 0.65, "history");
  return result(input.fallbackCategory, categoryLabel(input.fallbackCategory), 0.4, "fallback");
}

export async function classifyExpenseCategory(
  input: CategoryClassificationInput,
  gemini?: GoogleGenAI,
): Promise<CategoryClassification> {
  const fallback = fallbackCategoryClassification(input);
  if (!gemini) return fallback;
  try {
    const response = await gemini.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: JSON.stringify({
        expense: {
          description: input.description,
          merchant: input.merchant,
          fallbackCategory: input.fallbackCategory,
          groupName: input.groupName,
        },
        recentHistory: input.history.slice(0, 30),
        rules: [
          "共同帳分群組判斷分類；不要把餐點或店名直接當分類。",
          "飲食群組把餐點收斂為餐飲、飲料、甜點、生鮮、其他。",
          "停車費固定 transport + 停車費；油資固定 transport + 油資。",
          "只回 JSON；不能新增金額、不能改權限。",
        ],
      }),
      config: {
        systemInstruction:
          "你是帳務分類器。輸出 category 與 categoryLabel。category 必須是允許 enum；categoryLabel 用繁體中文、1 到 40 字、可重複用歷史分類。",
        responseMimeType: "application/json",
        responseJsonSchema: geminiCategoryClassificationJsonSchema,
        temperature: 0,
        maxOutputTokens: 220,
      },
    });
    const parsed = categoryClassificationSchema.parse(
      JSON.parse(response.text ?? "{}"),
    );
    if (parsed.confidence < 0.35) return fallback;
    return { ...parsed, categoryLabel: cleanLabel(parsed.categoryLabel) };
  } catch {
    return fallback;
  }
}

export function buildPrivateMirrorDraft(source: PrivateMirrorSource) {
  const share = source.splits[source.requesterUserId] ?? 0;
  if (!Number.isSafeInteger(share) || share <= 0) return null;
  return {
    ledger: "private" as const,
    groupId: null,
    mirrorKind: "shared_share" as const,
    mirrorSourceExpenseId: source.sourceExpenseId,
    description: source.description,
    merchant: source.merchant,
    notes: source.notes,
    category: source.category,
    categoryLabel: source.categoryLabel,
    amountTwd: share,
    paidByUserId: source.requesterUserId,
    createdByUserId: source.requesterUserId,
    expenseDate: source.expenseDate,
    splitMethod: "equal" as const,
    splits: { [source.requesterUserId]: share },
    deletedAt: source.deletedAt,
  };
}

export function splitBootstrapExpenses<
  T extends {
    group_id: string | null;
    ledger: "shared" | "private";
    created_by_user_id: string;
  },
>(expenses: T[], activeGroupId: string, userId: string) {
  return {
    sharedExpenses: expenses.filter(
      (expense) =>
        expense.ledger === "shared" && expense.group_id === activeGroupId,
    ),
    privateExpenses: expenses.filter(
      (expense) =>
        expense.ledger === "private" && expense.created_by_user_id === userId,
    ),
  };
}

function result(
  category: Category,
  categoryLabel: string,
  confidence: number,
  reason: string,
): CategoryClassification {
  return { category, categoryLabel: cleanLabel(categoryLabel), confidence, reason };
}

function historyLabel(input: CategoryClassificationInput, category: Category) {
  const current = normalize(`${input.merchant ?? ""} ${input.description}`);
  return input.history.find(
    (entry) =>
      entry.category === category &&
      entry.categoryLabel !== "其他" &&
      entry.categoryLabel !== "other" &&
      current &&
      normalize(`${entry.merchant ?? ""} ${entry.description}`).includes(current),
  )?.categoryLabel;
}

function categoryLabel(category: Category) {
  return (
    {
      food: "餐飲",
      transport: "交通",
      groceries: "生鮮",
      household: "居家",
      entertainment: "娛樂",
      shopping: "購物",
      medical: "醫療",
      travel: "旅行",
      other: "其他",
    } as const
  )[category];
}

function cleanLabel(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 40);
}

function normalize(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}
