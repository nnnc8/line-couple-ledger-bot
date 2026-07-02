import { z } from "zod";

export function actionResultErrorMessage(result: { result: string }) {
  switch (result.result) {
    case "stale":
      return "此草稿對應之交易狀態已改變，請重新讀取。";
    case "expired":
      return "操作已過期，請重新再試。";
    case "cancelled":
      return "操作已取消。";
    case "not_found":
      return "找不到這個操作。";
    case "already_done":
      return "這個操作已處理。";
    default:
      return "暫時無法處理";
  }
}

export function parsePositiveMoney(value: unknown) {
  return z.coerce.number().int().positive().max(100_000_000).parse(value);
}

export function parseDescription(value: unknown) {
  return z.string().trim().min(1).max(100).parse(value);
}

export function parseOptionalText(value: unknown, maxLength: number) {
  if (value === null || value === undefined || value === "") return null;
  return z.string().trim().max(maxLength).parse(value);
}

export function parseOptionalUuid(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return z.string().parse(value);
}

export function parseSplitMethod(value: unknown) {
  return z.enum(["equal", "exact", "percentage"]).catch("equal").parse(value);
}

export function normalizePendingTag(value: unknown) {
  const parsed =
    typeof value === "string" && value.trim().length
      ? value.trim()
      : "其他";
  return parsed.slice(0, 40);
}

export function splitEntries(expenseId: string, splits: Record<string, number>) {
  return Object.entries(splits).map(([userId, amountTwd]) => ({
    expense_id: expenseId,
    user_id: userId,
    amount_twd: amountTwd,
  }));
}

export function normalizeActionSplits(value: unknown): Record<string, number> | undefined {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const userId =
          "user_id" in item && typeof item.user_id === "string" ? item.user_id : null;
        const amount =
          "amount_twd" in item && typeof item.amount_twd === "number"
            ? item.amount_twd
            : null;
        return userId && Number.isSafeInteger(amount) ? [[userId, amount]] : [];
      }),
    );
  }
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(([, amount]) => Number.isSafeInteger(amount)),
  ) as Record<string, number>;
}

export function cleanCategoryLabel(value: string) {
  return value
    .normalize("NFKC")
    .replace(/nt\$?/gi, "")
    .replace(/[0-9,]+/g, "")
    .replace(/我付|你付|他付|她付|付款|付|元|塊/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 40);
}
