export type BankTransaction = {
  date: string;
  amount: number;
  description: string;
};

export type MatchResult = {
  bankTx: BankTransaction;
  matchedExpenseId?: string;
  matchedDescription?: string;
  confidence: number;
};

export type CsvBank = "esun" | "cathay" | "taishin" | "ctbc" | "auto";

type ExpenseForMatch = {
  id: string;
  description: string;
  merchant: string | null;
  amount_twd: number;
  expense_date: string;
  deleted_at: string | null;
};

const CSV_ADAPTERS: Record<Exclude<CsvBank, "auto">, (rows: string[][]) => BankTransaction[]> = {
  esun: parseEsunCsv,
  cathay: parseCathayCsv,
  taishin: parseTaishinCsv,
  ctbc: parseCtbcCsv,
};

export function parseBankCsv(csv: string, bank: CsvBank): BankTransaction[] {
  return parseBankCsvWithMeta(csv, bank).transactions;
}

export function parseBankCsvWithMeta(csv: string, bank: CsvBank) {
  const rows = parseCsvRows(csv);
  if (!rows.length) return { bank: "esun" as const, transactions: [] };
  const resolved = bank === "auto" ? detectBank(rows) : bank;
  return { bank: resolved, transactions: CSV_ADAPTERS[resolved](rows) };
}

export function detectBank(rows: string[][]): Exclude<CsvBank, "auto"> {
  const header = rows[0]?.join(",") ?? "";
  if (/玉山|ESUN|支出金額/.test(header)) return "esun";
  if (/國泰|Cathay|支存金額/.test(header)) return "cathay";
  if (/台新|Taishin|消費金額/.test(header)) return "taishin";
  if (/中信|CTBC|提現金額|消費地/.test(header)) return "ctbc";
  return "esun";
}

export function matchTransactions(
  bankTxs: BankTransaction[],
  expenses: ExpenseForMatch[],
): MatchResult[] {
  const active = expenses.filter((expense) => !expense.deleted_at);
  const used = new Set<string>();

  return bankTxs.map((bankTx) => {
    const candidates = active.filter(
      (expense) =>
        expense.amount_twd === bankTx.amount &&
        Math.abs(dayDiff(expense.expense_date, bankTx.date)) <= 2 &&
        !used.has(expense.id),
    );

    if (candidates.length === 1) {
      used.add(candidates[0]!.id);
      return {
        bankTx,
        matchedExpenseId: candidates[0]!.id,
        matchedDescription: candidates[0]!.description,
        confidence: 0.95,
      };
    }

    if (candidates.length > 1) {
      const best = candidates.reduce((winner, candidate) =>
        similarity(expenseText(candidate), bankTx.description) >
        similarity(expenseText(winner), bankTx.description)
          ? candidate
          : winner,
      );
      used.add(best.id);
      return {
        bankTx,
        matchedExpenseId: best.id,
        matchedDescription: best.description,
        confidence: 0.7,
      };
    }

    return { bankTx, confidence: 0 };
  });
}

function parseEsunCsv(rows: string[][]): BankTransaction[] {
  const header = normalizeRow(rows[0] ?? []);
  const dateIdx = findColumn(header, ["交易日期", "日期"]);
  const debitIdx = findColumn(header, ["支出金額", "支出", "借方金額"]);
  const creditIdx = findColumn(header, ["存入金額", "存入"]);
  const descIdx = findColumn(header, ["摘要", "交易說明", "備註"]);
  return rows.slice(1).flatMap((row) => {
    const normalized = normalizeRow(row);
    const amount = parseAmount(normalized[debitIdx]) || parseAmount(normalized[creditIdx]);
    const date = parseDate(normalized[dateIdx]);
    const description = normalized[descIdx]?.trim();
    if (!date || !amount || !description) return [];
    if (parseAmount(normalized[creditIdx]) && !parseAmount(normalized[debitIdx])) return [];
    return [{ date, amount, description }];
  });
}

function parseCathayCsv(rows: string[][]): BankTransaction[] {
  const header = normalizeRow(rows[0] ?? []);
  const dateIdx = findColumn(header, ["交易日", "交易日期", "日期"]);
  const debitIdx = findColumn(header, ["支存金額", "支出金額", "支出"]);
  const descIdx = findColumn(header, ["摘要", "交易說明", "備註"]);
  return rows.slice(1).flatMap((row) => {
    const normalized = normalizeRow(row);
    const amount = parseAmount(normalized[debitIdx]);
    const date = parseDate(normalized[dateIdx]);
    const description = normalized[descIdx]?.trim();
    if (!date || !amount || !description) return [];
    return [{ date, amount, description }];
  });
}

function parseTaishinCsv(rows: string[][]): BankTransaction[] {
  const header = normalizeRow(rows[0] ?? []);
  const dateIdx = findColumn(header, ["交易日期", "日期", "交易日"]);
  const debitIdx = findColumn(header, ["消費金額", "支出金額", "支出", "提現金額"]);
  const descIdx = findColumn(header, ["交易說明", "摘要", "備註", "商店名稱"]);
  return rows.slice(1).flatMap((row) => {
    const normalized = normalizeRow(row);
    const amount = parseAmount(normalized[debitIdx]);
    const date = parseDate(normalized[dateIdx]);
    const description = normalized[descIdx]?.trim();
    if (!date || !amount || !description) return [];
    return [{ date, amount, description }];
  });
}

function parseCtbcCsv(rows: string[][]): BankTransaction[] {
  const header = normalizeRow(rows[0] ?? []);
  const dateIdx = findColumn(header, ["交易日", "交易日期", "日期"]);
  const debitIdx = findColumn(header, ["台幣金額", "消費金額", "支出金額", "提現金額"]);
  const descIdx = findColumn(header, ["消費地", "摘要", "交易說明", "商店名稱"]);
  return rows.slice(1).flatMap((row) => {
    const normalized = normalizeRow(row);
    const amount = parseAmount(normalized[debitIdx]);
    const date = parseDate(normalized[dateIdx]);
    const description = normalized[descIdx]?.trim();
    if (!date || !amount || !description) return [];
    return [{ date, amount, description }];
  });
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let current = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index]!;
    const next = csv[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && char === ",") {
      row.push(current);
      current = "";
      continue;
    }
    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(current);
      current = "";
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      continue;
    }
    current += char;
  }
  row.push(current);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function normalizeRow(row: string[]): string[] {
  return row.map((cell) => cell.replace(/^\uFEFF/, "").trim());
}

function findColumn(header: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const index = header.findIndex((cell) => cell.includes(candidate));
    if (index >= 0) return index;
  }
  return 0;
}

function parseAmount(value?: string): number {
  if (!value) return 0;
  const digits = value.replace(/[^\d.-]/g, "");
  const amount = Math.round(Number(digits));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : 0;
}

function parseDate(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const slash = trimmed.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (slash) {
    return `${slash[1]}-${slash[2]!.padStart(2, "0")}-${slash[3]!.padStart(2, "0")}`;
  }
  const roc = trimmed.match(/^(\d{2,3})[/-](\d{1,2})[/-](\d{1,2})/);
  if (roc) {
    const year = Number(roc[1]) + 1911;
    return `${year}-${roc[2]!.padStart(2, "0")}-${roc[3]!.padStart(2, "0")}`;
  }
  return null;
}

function dayDiff(left: string, right: string): number {
  const a = Date.parse(`${left}T00:00:00Z`);
  const b = Date.parse(`${right}T00:00:00Z`);
  return Math.round(Math.abs(a - b) / 86_400_000);
}

function expenseText(expense: ExpenseForMatch): string {
  return `${expense.description} ${expense.merchant ?? ""}`;
}

function similarity(left: string, right: string): number {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  const tokensA = new Set(a.match(/[\p{Letter}\p{Number}]{2,}/gu) ?? []);
  const tokensB = new Set(b.match(/[\p{Letter}\p{Number}]{2,}/gu) ?? []);
  if (!tokensA.size || !tokensB.size) return 0;
  let overlap = 0;
  for (const token of tokensA) if (tokensB.has(token)) overlap += 1;
  return overlap / Math.max(tokensA.size, tokensB.size);
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}
