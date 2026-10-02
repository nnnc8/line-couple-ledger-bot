import { splitEqual } from "./v2-ledger";
import { currentEntryDate, DraftValidationError, normalizeTransactionDraft, type DraftFields, type EntryCommand, type TransactionDraft } from "./v2-transaction-draft";

// Presentation only. Allocation and validity come from P1-B's adapter/kernel.
function check(draft: TransactionDraft): { command: EntryCommand | null; field?: keyof DraftFields; error: string } {
  try {
    try {
      if (!/^\d+$/.test(draft.amountTwd.trim())) throw new Error("integer");
      splitEqual(BigInt(draft.amountTwd.trim()), draft.memberIds);
    } catch { throw new DraftValidationError("amountTwd", "請輸入大於 0 的新臺幣整數金額，並確認金額在支援範圍內"); }
    if (draft.type !== "transfer" && draft.splitMode === "percentage") {
      for (const field of ["selfPercentage", "partnerPercentage"] as const) {
        if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(draft[field].trim())) throw new DraftValidationError(field, "請輸入百分比，最多兩位小數");
      }
    }
    return { command: normalizeTransactionDraft(draft), error: "" };
  }
  catch (error) { return { command: null, field: error instanceof DraftValidationError ? error.field : undefined, error: error instanceof Error ? error.message : "請檢查輸入內容" }; }
}

export function entryPresentation(draft: TransactionDraft) {
  const validation = check(draft);
  // Temporary preview probes isolate allocation feedback from unfinished fields.
  // They are never stored or submitted.
  const probe = { ...draft, description: "預覽", occurredOn: currentEntryDate(), category: "", categoryId: "", note: "" };
  const payer = check({ ...probe, splitMode: "equal" });
  const split = check({ ...probe, paymentMode: draft.type === "transfer" ? draft.paymentMode : "self" });
  return { validation, payer, split };
}

export function entryMoney(value: string): string {
  return /^\d+$/.test(value.trim()) ? `NT$${BigInt(value.trim()).toLocaleString("en-US")}` : "NT$—";
}

// Difference feedback only. Never allocate or repair explicit amounts.
export function allocationDifference(total: string, first: string, second: string): string {
  if (![total, first, second].every(value => /^\d+$/.test(value.trim()))) return "請填寫兩人的金額";
  const difference = BigInt(total.trim()) - BigInt(first.trim()) - BigInt(second.trim());
  return difference === 0n ? "" : difference > 0n ? `還差 ${entryMoney(String(difference))}` : `超出 ${entryMoney(String(-difference))}`;
}

export function entrySummaries(draft: TransactionDraft, labels: Record<string, string>) {
  const { payer, split } = entryPresentation(draft);
  const partnerId = draft.memberIds.find(id => id !== draft.actorUserId)!;
  const label = (id: string) => labels[id] ?? "成員";
  const amounts = (kind: "payment" | "share") => draft.memberIds.map(id => `${label(id)} ${entryMoney(kind === "payment" ? id === draft.actorUserId ? draft.selfPayment : draft.partnerPayment : id === draft.actorUserId ? draft.selfShare : draft.partnerShare)}`).join("／");
  const payerId = draft.paymentMode === "partner" ? partnerId : draft.actorUserId;
  const payerSummary = draft.type === "transfer" ? draft.paymentMode === "both" ? "發送人尚未選擇" : `${label(payerId)} → ${label(payerId === draft.actorUserId ? partnerId : draft.actorUserId)}`
    : draft.paymentMode === "both" ? `兩人${draft.type === "income" ? "收款" : "付款"} · ${amounts("payment")}${payer.command ? "" : " · 金額尚未完成"}`
      : `${label(payerId)}${draft.type === "income" ? "收款" : "付款"}`;
  const allocationWord = draft.type === "income" ? "分配" : "分攤";
  const equalSummary = draft.type === "income" ? "平均分配" : "平均分";
  const historicalExact = draft.operationType === "replace" && draft.seed.splitMode === "exact" && draft.selfShare === draft.seed.selfShare && draft.partnerShare === draft.seed.partnerShare;
  let splitSummary = `${allocationWord}尚未完成`;
  if (split.command) {
    if (draft.splitMode === "equal") splitSummary = equalSummary;
    else if (draft.splitMode === "weights") {
      const [first, second] = draft.memberIds.map(id => draft.defaultShares[id]!);
      splitSummary = BigInt(first) === BigInt(second) && BigInt(first) > 0n ? equalSummary : draft.memberIds.map(id => `${label(id)} ${draft.defaultShares[id]}`).join("：") + ` ${allocationWord}`;
    } else if (draft.splitMode === "percentage") splitSummary = draft.memberIds.map(id => `${label(id)} ${id === draft.actorUserId ? draft.selfPercentage : draft.partnerPercentage}%`).join("／");
    else splitSummary = `${historicalExact ? `沿用這筆${allocationWord} · ` : ""}${amounts("share")}`;
  }
  return { payerSummary, splitSummary, shares: split.command?.shares ?? null };
}
