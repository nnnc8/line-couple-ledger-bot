import { categories } from "./ledger";

export { categories };

export type Category = (typeof categories)[number];

export const categoryMeta: Record<
  Category,
  { label: string; emoji: string; color: string; tint: string }
> = {
  food: { label: "餐飲", emoji: "🍜", color: "#f59e0b", tint: "rgba(245,158,11,.12)" },
  transport: { label: "交通", emoji: "🚌", color: "#3b82f6", tint: "rgba(59,130,246,.12)" },
  groceries: { label: "生鮮", emoji: "🥬", color: "#10b981", tint: "rgba(16,185,129,.12)" },
  household: { label: "居家", emoji: "🏠", color: "#ec4899", tint: "rgba(236,72,153,.12)" },
  entertainment: { label: "娛樂", emoji: "🎬", color: "#8b5cf6", tint: "rgba(139,92,246,.12)" },
  shopping: { label: "購物", emoji: "🛍", color: "#ef4444", tint: "rgba(239,68,68,.12)" },
  medical: { label: "醫療", emoji: "💊", color: "#06b6d4", tint: "rgba(6,182,212,.12)" },
  travel: { label: "旅行", emoji: "✈️", color: "#6366f1", tint: "rgba(99,102,241,.12)" },
  other: { label: "其他", emoji: "📦", color: "#64748b", tint: "rgba(100,116,139,.12)" },
} as const;

export const categoryList = categories.map((key) => ({
  key,
  ...categoryMeta[key],
}));

export function categoryLabel(key: string): string {
  return categoryMeta[key as Category]?.label ?? key;
}

export function categoryEmoji(key: string): string {
  return categoryMeta[key as Category]?.emoji ?? "📦";
}

export function categoryColor(key: string): string {
  return categoryMeta[key as Category]?.color ?? "#64748b";
}

export function categoryTint(key: string): string {
  return categoryMeta[key as Category]?.tint ?? "rgba(100,116,139,.12)";
}

export function displayLabel(expense: {
  category: string;
  category_label: string;
  custom_category_label?: string;
}): string {
  const custom = expense.custom_category_label?.trim();
  if (custom) return custom;
  if (expense.category_label && expense.category_label !== expense.category) {
    return expense.category_label;
  }
  return categoryLabel(expense.category);
}