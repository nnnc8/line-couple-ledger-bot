import { type ParsedIntent } from "./ledger";

function emptyIntent(intent: ParsedIntent["intent"]): ParsedIntent {
  return {
    intent,
    description: null,
    amountTwd: null,
    ledger: null,
    paidBy: null,
    expenseDate: null,
    tag: null,
  };
}

function cleanInlineDescription(value: string) {
  return value
    .replace(/[，,。.!！?？|｜]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function inferInlineTag(text: string): ParsedIntent["tag"] {
  return /早餐|午餐|晚餐|宵夜|餐|吃|喝|咖啡|飲料|漢堡|便當|火鍋|越南|拉麵|麵|飯|披薩|甜點/.test(
    text,
  )
    ? "food"
    : /車|捷運|高鐵|火車|公車|計程車|uber|停車|加油|交通/.test(text)
      ? "transport"
      : "other";
}

function normalizeGroupText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

export function parseFixedIntent(text: string): ParsedIntent | null {
  const intent = new Map<string, ParsedIntent["intent"]>([
    ["誰欠誰", "balance"],
    ["查詢目前誰欠誰", "balance"],
    ["本月共同支出", "shared_monthly"],
    ["本月私人支出", "private_monthly"],
    ["刪除剛剛那筆", "delete_last"],
    ["結清", "settle"],
    ["說明", "help"],
    ["help", "help"],
  ]).get(text.trim());
  return intent ? emptyIntent(intent) : null;
}

export function parseInlineExpenseItems(
  text: string,
  today: string,
): ParsedIntent[] {
  const matches = [
    ...text.matchAll(/(\d{1,9})\s*(?:元|塊|nt\$?)?\s*(我付|你付|他付|她付)/giu),
  ];
  if (matches.length < 2) return [];
  let cursor = 0;
  return matches.slice(0, 5).flatMap((match) => {
    const index = match.index ?? 0;
    const description = cleanInlineDescription(text.slice(cursor, index));
    cursor = index + match[0].length;
    const amountTwd = Number(match[1]);
    if (!description || !Number.isSafeInteger(amountTwd) || amountTwd <= 0)
      return [];
    return [
      {
        intent: "record_expense",
        description,
        amountTwd,
        ledger: /私人/.test(text) ? "private" : "shared",
        paidBy: match[2] === "我付" ? "self" : "partner",
        expenseDate: today,
        tag: inferInlineTag(`${text} ${description}`),
      } satisfies ParsedIntent,
    ];
  });
}

export function selectMentionedGroup<T extends { id: string; name: string }>(
  text: string,
  groups: T[],
  activeGroupId: string,
): T | null {
  const normalizedText = normalizeGroupText(text);
  const mentioned = groups
    .filter((group) => normalizedText.includes(normalizeGroupText(group.name)))
    .sort((left, right) => right.name.length - left.name.length);
  return (
    mentioned[0] ??
    groups.find((group) => group.id === activeGroupId) ??
    groups[0] ??
    null
  );
}

export function parsePendingRetargetCommand(text: string) {
  const normalized = text.replace(/\s+/g, "");
  if (!/(都|全部|這批|剛剛|剛才|上面|那些)/.test(normalized)) return null;
  if (!/(改成|改到|轉成|轉到|移到|換成)/.test(normalized)) return null;
  if (!/私人帳|私人/.test(normalized)) return null;
  if (!/交通|車資|搭車|行程|uber|計程車/i.test(normalized)) return null;
  return {
    ledger: "private",
    tag: "交通",
  } as const;
}

export function parseSearchCommand(text: string): string | null {
  const match = text.trim().match(/^(?:\/?搜尋|搜)\s+(.+)$/);
  const query = match?.[1]?.trim();
  return query ? query.slice(0, 100) : null;
}
