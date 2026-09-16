export type V2InputSource = "text" | "audio" | "ai";

export interface V2DirectCommand {
  kind: "expense" | "income" | "transfer";
  amountTwd: number;
  description: string;
  payer?: "self" | "partner";
  receiver?: "self" | "partner";
  ledgerName?: string;
}

// A deliberately bounded command language. Free descriptions, dates, custom
// shares and compound instructions belong in clarification/proposal review.
const expenseItems = "早餐|午餐|晚餐|宵夜|餐費|餐飲|飲料|咖啡|交通|車票|計程車|停車費|油錢|房租|水費|電費|瓦斯費|網路費|電話費|日用品|購物|醫療|娛樂|旅遊|其他";
const person = "我|本人|他|她|另一半|對方";
const amount = "(?:NT\\$\\s*|TWD\\s*)?([1-9][0-9]{0,8}|[1-9][0-9]{0,2}(?:,[0-9]{3}){1,2})(?:\\s*元)?";
const expense = new RegExp(`^(${expenseItems})\\s+${amount}\\s+(${person})\\s*(?:付|付款|出)$`, "i");
const income = new RegExp(`^((?:${expenseItems})?退款|收入)\\s+${amount}\\s+(${person})\\s*(?:收到|收款|拿到)$`, "i");
const transfer = new RegExp(`^(${person})\\s*(?:轉帳|轉|匯款|還款)\\s*${amount}\\s*給\\s*(${person})$`, "i");
const who = (value: string): "self" | "partner" => /^(我|本人)$/.test(value) ? "self" : "partner";

export function classifyV2DirectCommand(text: string): V2DirectCommand | null {
  const normalized = text.normalize("NFKC").trim();
  if (/[\r\n]/.test(normalized)) return null;
  const parts = normalized.split(/\s+記在\s+/);
  if (parts.length > 2) return null;
  const ledgerName = parts[1]?.trim();
  if (parts.length === 2 && (!ledgerName || ledgerName.length > 40)) return null;
  const command = parts[0]!;
  const matched = expense.exec(command) ?? income.exec(command) ?? transfer.exec(command);
  if (!matched) return null;
  const amountTwd = Number(matched[2]!.replaceAll(",", ""));
  if (!Number.isSafeInteger(amountTwd) || amountTwd <= 0 || amountTwd > 100_000_000) return null;
  const scope = ledgerName ? { ledgerName } : {};
  if (expense.test(command)) return { kind: "expense", amountTwd, description: matched[1]!, payer: who(matched[3]!), ...scope };
  if (income.test(command)) return { kind: "income", amountTwd, description: matched[1]!, receiver: who(matched[3]!), ...scope };
  const payer = who(matched[1]!);
  if (payer === who(matched[3]!)) return null;
  return { kind: "transfer", amountTwd, description: "LINE 轉帳", payer, ...scope };
}
