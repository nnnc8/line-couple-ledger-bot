import { generateObject } from "ai";
import { z } from "zod";

import { getModel } from "./model-provider";
import {
  isChineseCategoryTag,
  isGenericCategoryTag,
  normalizeCategoryTag,
} from "./category-tags";

export {
  isChineseCategoryTag,
  isGenericCategoryTag,
  normalizeCategoryTag,
} from "./category-tags";

export const categoryClassificationSchema = z
  .object({
    tag: z.string().trim().min(1).max(40),
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

export type CategoryClassificationGenerator = (
  input: CategoryClassificationInput,
) => Promise<unknown>;

const CLASSIFICATION_TIMEOUT_MS = 4_000;

export interface CategoryClassificationInput {
  description: string;
  merchant?: string | null;
  groupName?: string | null;
  fallbackTag: string;
  history: Array<{
    tag: string;
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
  tag: string;
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
    return result("停車費", 0.9, "parking");
  }
  if (/cube|卡費|信用卡|國泰卡/.test(normalized)) {
    return result("信用卡費", 0.8, "card bill");
  }
  if (/加油|油資|fuel/.test(normalized)) {
    return result("油資", 0.9, "fuel");
  }
  if (/車貸/.test(normalized)) {
    return result("車貸", 0.9, "car loan");
  }
  if (/etag|etc|國道|收費站|通行/.test(normalized)) {
    return result("通行費", 0.85, "toll");
  }
  if (/牌照稅|燃料稅|稅金/.test(normalized)) {
    return result("稅金", 0.85, "tax");
  }
  if (/保險/.test(normalized)) {
    return result("保險費", 0.85, "insurance");
  }
  if (/藥局|醫院|診所|藥品|藥/.test(normalized)) {
    return result("醫療", 0.9, "medical");
  }
  if (/保桿|鈑金|烤漆|保養|機油|維修|避震|檢查|除碳|隔熱紙|行車記錄|車牌框|鋁圈|工資|修逗號/.test(normalized)) {
    return result("維修保養", 0.85, "maintenance");
  }
  if (/拼多多|鞋|百貨|購物/.test(normalized)) {
    return result("購物", 0.8, "shopping");
  }
  if (/高鐵|台鐵|火車|捷運|公車|客運|uber|計程車|交通|車資/.test(normalized)) {
    return result(historyLabel(input, "交通") ?? "交通", 0.8, "transport");
  }
  if (/咖啡|飲料|手搖|茶|酒|喝/.test(expenseText)) {
    return result(foodGroup ? "飲料" : "餐飲", 0.85, "drink");
  }
  if (/甜點|蛋糕|冰|布丁|餅乾/.test(expenseText)) {
    return result(foodGroup ? "甜點" : "餐飲", 0.85, "dessert");
  }
  if (/超市|市場|生鮮|水果|蔬菜|全聯|家樂福|costco/i.test(normalized)) {
    return result("生鮮", 0.8, "groceries");
  }
  if (
    foodGroup ||
    /早餐|午餐|晚餐|宵夜|餐|飯|麵|漢堡|便當|火鍋|拉麵|越南|料理|吃/.test(
      normalized,
    )
  ) {
    return result("餐飲", 0.85, "food group");
  }

  const learned = historyLabel(input);
  if (learned) return result(learned, 0.65, "history");
  return result(normalizeCategoryTag(input.fallbackTag) ?? "其他", 0.4, "fallback");
}

export async function classifyExpenseCategory(
  input: CategoryClassificationInput,
  generator: CategoryClassificationGenerator = generateCategoryClassification,
): Promise<CategoryClassification> {
  const fallback = fallbackCategoryClassification(input);
  if (fallback.confidence >= 0.65) return fallback;
  try {
    const parsed = categoryClassificationSchema.parse(
      await withTimeout(generator(input), CLASSIFICATION_TIMEOUT_MS),
    );
    const tag = normalizeCategoryTag(parsed.tag);
    if (parsed.confidence < 0.35 || !tag || !isChineseCategoryTag(tag)) return fallback;
    return { ...parsed, tag };
  } catch {
    return fallback;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("category classification timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function generateCategoryClassification(
  input: CategoryClassificationInput,
): Promise<unknown> {
  const response = await generateObject({
    model: getModel(),
    system: "你是帳務分類器。輸出 tag（自由繁體中文標籤，1 到 40 字）。tag 可參考歷史標籤但也可以是新的簡短標籤。",
    messages: [{
      role: "user",
      content: JSON.stringify({
        expense: {
          description: input.description,
          merchant: input.merchant,
          fallbackTag: input.fallbackTag,
          groupName: input.groupName,
        },
        recentHistory: input.history.slice(0, 30),
        rules: [
          "共同帳分群組判斷分類；不要把餐點或店名直接當分類。",
          "飲食群組把餐點收斂為餐飲、飲料、甜點、生鮮、其他。",
          "停車費固定 停車費；油資固定 油資。",
          "只回 JSON；不能新增金額、不能改權限。",
          "回傳 tag（自由繁體中文標籤，1-40 字）。",
        ],
      }),
    }],
    temperature: 0,
    schema: categoryClassificationSchema,
  });
  return response.object;
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
    tag: source.tag,
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
  tag: string,
  confidence: number,
  reason: string,
): CategoryClassification {
  return { tag: cleanLabel(tag), confidence, reason };
}

function historyLabel(input: CategoryClassificationInput, preferredTag?: string) {
  const current = normalize(`${input.merchant ?? ""} ${input.description}`);
  return input.history.find(
    (entry) =>
      (!preferredTag || entry.tag === preferredTag) &&
      !isGenericCategoryTag(entry.tag) &&
      current &&
      normalize(`${entry.merchant ?? ""} ${entry.description}`).includes(current),
  )?.tag;
}

function cleanLabel(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 40);
}

function normalize(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}
