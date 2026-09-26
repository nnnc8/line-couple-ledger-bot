import { splitEqual, splitExact, splitPercentage, splitWeights, validateV2Transaction } from "./v2-ledger";
import type { V2LedgerBootstrap, V2LedgerTransaction } from "./types";

export type EntryCommand = {
  type: "expense" | "income" | "transfer";
  amountTwd: string;
  occurredOn: string;
  description: string;
  category: string | null;
  categoryId: string | null;
  note: string | null;
  splitMethod: "none" | "weights" | "equal" | "percentage" | "exact";
  payments: Array<{ userId: string; amountTwd: string }>;
  shares: Array<{ userId: string; amountTwd: string }>;
};

export type DraftFields = {
  type: EntryCommand["type"];
  amountTwd: string;
  description: string;
  occurredOn: string;
  category: string;
  categoryId: string;
  note: string;
  paymentMode: "self" | "partner" | "both";
  selfPayment: string;
  partnerPayment: string;
  splitMode: Exclude<EntryCommand["splitMethod"], "none">;
  selfShare: string;
  partnerShare: string;
  selfPercentage: string;
  partnerPercentage: string;
};

export type TransactionDraft = DraftFields & {
  id: string;
  actorUserId: string;
  coupleId: number;
  ledgerId: string;
  memberIds: [string, string];
  defaultShares: Record<string, string>;
  operationType: "create" | "replace";
  transactionId?: string;
  expectedVersion?: number;
  dirty: boolean;
};

export class DraftValidationError extends Error {
  constructor(public field: keyof DraftFields, message: string) { super(message); }
}

// Match the API's Taipei calendar date without importing its server-only module.
// Called when opening a fresh draft; existing drafts and submitted dates stay fixed.
export function currentEntryDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function newTransactionDraft(bootstrap: V2LedgerBootstrap, actorUserId: string, today: string, id: string): TransactionDraft {
  const members = bootstrap.ledger.members.map(member => member.userId);
  if (members.length !== 2 || members[0] === members[1] || !members.includes(actorUserId)) throw new Error("帳本成員範圍不符");
  return {
    id, actorUserId, coupleId: bootstrap.ledger.coupleId, ledgerId: bootstrap.ledger.id,
    memberIds: [members[0]!, members[1]!], defaultShares: { ...bootstrap.ledger.defaultShares },
    operationType: "create", dirty: false, type: "expense", amountTwd: "", description: "", occurredOn: today,
    category: "", categoryId: "", note: "", paymentMode: "self", selfPayment: "", partnerPayment: "",
    splitMode: "weights", selfShare: "", partnerShare: "", selfPercentage: "50", partnerPercentage: "50",
  };
}

export function correctionDraft(bootstrap: V2LedgerBootstrap, actorUserId: string, today: string, id: string, transaction: V2LedgerTransaction): TransactionDraft {
  if (transaction.ledgerId !== bootstrap.ledger.id || transaction.status !== "posted" || !Number.isSafeInteger(transaction.version) || !transaction.version) throw new Error("這筆紀錄目前無法修改，請重新整理");
  const draft = newTransactionDraft(bootstrap, actorUserId, today, id);
  const partnerId = draft.memberIds.find(member => member !== actorUserId)!;
  return {
    ...draft, operationType: "replace", transactionId: transaction.id, expectedVersion: transaction.version, dirty: true,
    type: transaction.type, amountTwd: transaction.amountTwd, description: transaction.description ?? "",
    occurredOn: transaction.occurredOn ?? today, category: transaction.category ?? "", categoryId: transaction.categoryId ?? "", note: transaction.note ?? "",
    paymentMode: transaction.payments.length === 2 ? "both" : transaction.payments[0]?.userId === actorUserId ? "self" : "partner",
    selfPayment: transaction.payments.find(payment => payment.userId === actorUserId)?.amountTwd ?? "0",
    partnerPayment: transaction.payments.find(payment => payment.userId === partnerId)?.amountTwd ?? "0",
    // Historical rows contain exact allocations, not the original percentage/default choice.
    splitMode: "exact", selfShare: transaction.shares.find(share => share.userId === actorUserId)?.amountTwd ?? "0",
    partnerShare: transaction.shares.find(share => share.userId === partnerId)?.amountTwd ?? "0",
  };
}

function integer(value: string, field: keyof DraftFields): string {
  if (!/^\d+$/.test(value.trim())) throw new DraftValidationError(field, "請輸入新台幣整數金額");
  return BigInt(value.trim()).toString();
}

export function normalizeTransactionDraft(draft: TransactionDraft): EntryCommand {
  const amountTwd = integer(draft.amountTwd, "amountTwd");
  if (amountTwd === "0") throw new DraftValidationError("amountTwd", "金額必須大於 0");
  const description = draft.description.trim();
  if (!description || description.length > 120) throw new DraftValidationError("description", "請輸入 1 至 120 字的用途");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.occurredOn) || !Number.isFinite(Date.parse(draft.occurredOn)) || new Date(draft.occurredOn).toISOString().slice(0, 10) !== draft.occurredOn) throw new DraftValidationError("occurredOn", "請選擇有效日期");
  if (draft.category.trim().length > 40) throw new DraftValidationError("category", "分類最多 40 字");
  if (draft.note.trim().length > 1000) throw new DraftValidationError("note", "備註最多 1000 字");
  const partnerId = draft.memberIds.find(member => member !== draft.actorUserId)!;
  const payerId = draft.paymentMode === "partner" ? partnerId : draft.actorUserId;
  const receiverId = payerId === draft.actorUserId ? partnerId : draft.actorUserId;
  if (draft.type === "transfer" && draft.paymentMode === "both") throw new DraftValidationError("paymentMode", "轉帳一次只能指定一位發送人");
  const payments = draft.paymentMode === "both"
    ? draft.memberIds.map(userId => ({ userId, amountTwd: integer(userId === draft.actorUserId ? draft.selfPayment : draft.partnerPayment, userId === draft.actorUserId ? "selfPayment" : "partnerPayment") })).filter(payment => payment.amountTwd !== "0")
    : [{ userId: payerId, amountTwd }];
  let shares: EntryCommand["shares"];
  try {
    if (draft.type === "transfer") shares = [{ userId: receiverId, amountTwd }];
    else {
      const members = draft.memberIds;
      const allocations = draft.splitMode === "equal" ? splitEqual(amountTwd, members)
        : draft.splitMode === "weights" ? splitWeights(amountTwd, members, [draft.defaultShares[members[0]]!, draft.defaultShares[members[1]]!])
        : draft.splitMode === "exact" ? splitExact(amountTwd, members, { [draft.actorUserId]: integer(draft.selfShare, "selfShare"), [partnerId]: integer(draft.partnerShare, "partnerShare") })
        : splitPercentage(amountTwd, members, members.map(member => Number(member === draft.actorUserId ? draft.selfPercentage : draft.partnerPercentage)) as [number, number]);
      shares = members.map(userId => ({ userId, amountTwd: allocations[userId]!.toString() }));
    }
  } catch (error) {
    if (error instanceof DraftValidationError) throw error;
    throw new DraftValidationError("splitMode", "請檢查分攤金額、比例與總額");
  }
  const command: EntryCommand = {
    type: draft.type, amountTwd, occurredOn: draft.occurredOn, description,
    category: draft.category.trim() || null, categoryId: draft.categoryId || null, note: draft.note.trim() || null,
    splitMethod: draft.type === "transfer" ? "none" : draft.splitMode, payments, shares,
  };
  try { validateV2Transaction({ ...command, ledgerId: draft.ledgerId }, { ledgerId: draft.ledgerId, memberIds: draft.memberIds }); }
  catch { throw new DraftValidationError("paymentMode", "請檢查付款／收款金額，合計須等於總額，且金額在支援範圍內"); }
  return command;
}

export function draftPreview(draft: TransactionDraft): EntryCommand | null {
  try { return normalizeTransactionDraft({ ...draft, description: draft.description || "預覽" }); }
  catch { return null; }
}
