export function tagColor(tag: string | null | undefined): string {
  const safeTag = tag || "其他";
  let hash = 5381;
  for (let i = 0; i < safeTag.length; i++) {
    hash = ((hash << 5) + hash + safeTag.charCodeAt(i)) >>> 0;
  }
  const hue = (hash * 137.508) % 360;
  return `hsl(${Math.round(hue)}, 65%, 50%)`;
}

export function tagTint(tag: string | null | undefined): string {
  const safeTag = tag || "其他";
  let hash = 5381;
  for (let i = 0; i < safeTag.length; i++) {
    hash = ((hash << 5) + hash + safeTag.charCodeAt(i)) >>> 0;
  }
  const hue = (hash * 137.508) % 360;
  return `hsl(${Math.round(hue)}, 65%, 50%, 0.12)`;
}

export const tagPreset = [
  "餐飲",
  "交通",
  "生鮮",
  "居家",
  "娛樂",
  "購物",
  "醫療",
  "旅行",
  "飲料",
  "甜點",
  "咖啡",
  "日用品",
  "保險",
  "稅金",
  "油資",
  "停車費",
  "通行費",
  "維修保養",
  "車貸",
  "信用卡費",
  "轉帳",
] as const;

export function displayTag(expense: { tag: string }): string {
  return expense.tag || "其他";
}
