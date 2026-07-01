import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  matchTransactions,
  parseBankCsvWithMeta,
  type BankTransaction,
  type CsvBank,
  type MatchResult,
} from "./bank-csv";
import { HttpError } from "./http-error";

const bankImportInputSchema = z.object({
  csv: z.string().min(1).max(512_000),
  bank: z.enum(["esun", "cathay", "taishin", "ctbc", "auto"]).default("auto"),
});

const bankExpenseSchema = z.object({
  id: z.string().uuid(),
  description: z.string(),
  merchant: z.string().nullable(),
  amount_twd: z.coerce.number().int(),
  expense_date: z.string(),
  deleted_at: z.string().nullable(),
});

type BankExpense = z.infer<typeof bankExpenseSchema>;

export class BankImportService {
  private readonly parseCsv: (csv: string, bank: CsvBank) => {
    bank: Exclude<CsvBank, "auto">;
    transactions: BankTransaction[];
  };
  private readonly matchTxs: (
    rows: BankTransaction[],
    expenses: BankExpense[],
  ) => MatchResult[];
  private readonly today: () => string;
  private readonly loadExpenses: (
    db: SupabaseClient,
    groupId: string,
    startDate: string,
  ) => Promise<BankExpense[]>;

  constructor(input?: {
    parseCsv?: (csv: string, bank: CsvBank) => {
      bank: Exclude<CsvBank, "auto">;
      transactions: BankTransaction[];
    };
    matchTransactions?: (
      rows: BankTransaction[],
      expenses: BankExpense[],
    ) => MatchResult[];
    today?: () => string;
    loadExpenses?: (
      db: SupabaseClient,
      groupId: string,
      startDate: string,
    ) => Promise<BankExpense[]>;
  }) {
    this.parseCsv = input?.parseCsv ?? parseBankCsvWithMeta;
    this.matchTxs = input?.matchTransactions ?? matchTransactions;
    this.today =
      input?.today ??
      (() =>
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Taipei",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date()));
    this.loadExpenses =
      input?.loadExpenses ??
      (async (db, groupId, startDate) => {
        const result = await db
          .from("expenses")
          .select(
            "id, description, merchant, amount_twd, expense_date, deleted_at",
          )
          .eq("group_id", groupId)
          .gte("expense_date", startDate)
          .order("expense_date", { ascending: false })
          .limit(500);
        if (result.error) throw new Error("expense lookup failed");
        return z.array(bankExpenseSchema).parse(result.data ?? []);
      });
  }

  async import(
    context: {
      db: SupabaseClient;
      getActiveGroupId: () => Promise<string>;
    },
    input: unknown,
  ) {
    const parsed = bankImportInputSchema.parse(input);
    const groupId = await context.getActiveGroupId();
    const { bank, transactions } = this.parseCsv(parsed.csv, parsed.bank);
    if (!transactions.length) {
      throw new HttpError(400, "無法解析 CSV，請確認銀行格式");
    }

    const startDate = `${shiftMonth(this.today().slice(0, 7), -2)}-01`;
    const expenses = await this.loadExpenses(context.db, groupId, startDate);
    const matches = this.matchTxs(transactions, expenses);

    return {
      bank,
      transactionCount: transactions.length,
      matchedCount: matches.filter((item) => item.matchedExpenseId).length,
      matches: matches.map((item) => ({
        bankTx: item.bankTx,
        matchedExpenseId: item.matchedExpenseId ?? null,
        matchedDescription: item.matchedDescription ?? null,
        confidence: item.confidence,
      })),
    };
  }
}

function shiftMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year!, monthNumber! - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
