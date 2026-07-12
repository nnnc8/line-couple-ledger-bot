const GENERIC_CATEGORY_TAGS = new Set(["other", "其他"]);

export function normalizeCategoryTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 40);
  return normalized && !isGenericCategoryTag(normalized) ? normalized : null;
}

export function isGenericCategoryTag(value: unknown): boolean {
  return typeof value === "string" && GENERIC_CATEGORY_TAGS.has(value.normalize("NFKC").trim().toLowerCase());
}

export function isChineseCategoryTag(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}
