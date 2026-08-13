import type { SupabaseClient } from "@supabase/supabase-js";
import type { GoogleGenAI } from "@google/genai";
import { z } from "zod";

import { buildSettleAllTransfer, splitWeights, type V2LedgerMemberSet } from "./v2-ledger";
import {
  createV2ProposalFromLine,
  getV2LedgerBootstrap,
  listV2UserLedgers,
  type V2LineProposalDraft,
} from "./v2-ledger-service";
import { buildLiffUrl, requireLiffId } from "./liff-url";
import type { LineUser } from "./line-bot-shared";
import { getModelConfig } from "./server-env";

const draftSchema = z.object({
  amountTwd: z.number().int().positive().max(100_000_000),
  description: z.string().trim().min(1).max(120),
  payer: z.enum(["self", "partner"]),
  ledgerName: z.string().trim().min(1).max(40).optional(),
  category: z.string().trim().min(1).max(40).optional(),
  note: z.string().trim().max(1000).optional(),
});

const aiCandidateSchema = z.object({
  kind: z.enum(["expense", "transfer", "settle_all", "unsupported"]),
  amountTwd: z.union([
    z.number().int().positive().max(100_000_000),
    z.string().regex(/^(0|[1-9][0-9]*)$/),
  ]).optional(),
  description: z.string().trim().min(1).max(120).optional(),
  payer: z.enum(["self", "partner"]).optional(),
  ledgerName: z.string().trim().min(1).max(40).optional(),
  category: z.string().trim().min(1).max(40).optional(),
  note: z.string().trim().max(1000).optional(),
}).strict();

const aiProposalJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["expense", "transfer", "settle_all", "unsupported"] },
    amountTwd: { type: "integer", minimum: 1, maximum: 100_000_000 },
    description: { type: "string", minLength: 1, maxLength: 120 },
    payer: { type: "string", enum: ["self", "partner"] },
    ledgerName: { type: "string", minLength: 1, maxLength: 40 },
    category: { type: "string", minLength: 1, maxLength: 40 },
    note: { type: "string", maxLength: 1000 },
  },
  required: ["kind"],
} as const;

export type V2AiProposalCandidate = Omit<z.infer<typeof aiCandidateSchema>, "amountTwd"> & { amountTwd?: number };

export function parseV2AiProposalResponse(text: string): V2AiProposalCandidate | null {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = aiCandidateSchema.safeParse(JSON.parse(normalized));
    if (!parsed.success) return null;
    const value = parsed.data;
    if (value.kind === "unsupported") return { kind: value.kind };
    if (value.kind === "settle_all") return { kind: value.kind };
    if (!value.amountTwd || !value.description || !value.payer) return null;
    return { ...value, amountTwd: Number(value.amountTwd) };
  } catch {
    return null;
  }
}

function looksLikeV2AccountingText(text: string): boolean {
  return /\d|記|帳|花|買|付|支出|收入|收款|付款|退款|轉帳|轉給|匯給|還款|結清|還清|清帳/i.test(text);
}

async function parseV2AiProposal(gemini: GoogleGenAI, text: string): Promise<V2AiProposalCandidate | null> {
  if (!looksLikeV2AccountingText(text)) return null;
  try {
    const response = await gemini.models.generateContent({
      model: getModelConfig().modelId,
      contents: [{
        role: "user",
        parts: [{ text: [
          "你是 Couple Ledger V2 的輸入解析器。只把使用者訊息解析成待確認草稿，絕對不要執行記帳。",
          "產品限制：只有 TWD 整數；Couple 永遠只有兩位成員；不能處理外幣、匯率、多人群組或模糊金額。",
          "kind 只能是 expense、transfer、settle_all、unsupported。expense/transfer 必須有 amountTwd、description、payer；結清使用 settle_all；無法安全判斷就 unsupported。",
          "payer 的 self 是訊息作者，partner 是另一半。不要猜測未出現的金額或付款人。只輸出 JSON。",
          `使用者訊息：${text}`,
        ].join("\n") }],
      }],
      config: {
        temperature: 0,
        maxOutputTokens: 300,
        responseMimeType: "application/json",
        responseJsonSchema: aiProposalJsonSchema,
      },
    });
    return parseV2AiProposalResponse(response.text ?? "");
  } catch {
    return null;
  }
}

export type V2LineProposalResult =
  | { kind: "created"; proposalId: string; ledgerName: string; amountTwd: number; description: string }
  | { kind: "needs_ledger"; ledgers: Array<{ id: string; name: string }> }
  | { kind: "not_supported" };

export function v2LineProposalText(result: V2LineProposalResult): string {
  if (result.kind === "not_supported") return "V2 快速記帳格式：晚餐 500 我付（可加「記在 韓國旅行」）。";
  if (result.kind === "needs_ledger") {
    return result.ledgers.length
      ? `請指定 Ledger：${result.ledgers.map((ledger) => ledger.name).join("、")}`
      : "目前還沒有可用的 Ledger，請先在 LIFF 建立一本 Ledger。";
  }
  if (result.kind === "created") {
    let link = "";
    try {
      link = `：${buildLiffUrl(requireLiffId(), { v2Proposal: result.proposalId })}`;
    } catch {
      // Keep the durable proposal usable in local/test environments without a LIFF id.
    }
    return `已建立待確認草稿：${result.ledgerName}｜${result.description}｜NT$${result.amountTwd.toLocaleString()}。請開啟 LIFF 確認後才會入帳${link}`;
  }
  return "";
}

export async function v2LineBalanceText(input: {
  coupleId: number;
  userId: string;
}): Promise<string> {
  const ledgers = await listV2UserLedgers(input.coupleId, input.userId);
  if (!ledgers.length) return "目前還沒有可用的 Ledger，請先在 LIFF 建立一本 Ledger。";
  const rows = await Promise.all(ledgers.map(async (ledger) => {
    const bootstrap = await getV2LedgerBootstrap(input.coupleId, ledger.id);
    const signed = BigInt(bootstrap.balance[input.userId] ?? "0");
    const amount = (signed < 0n ? -signed : signed).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const status = signed === 0n
      ? "已結清"
      : signed > 0n
        ? `另一半欠你 NT$${amount}`
        : `你欠另一半 NT$${amount}`;
    return `${ledger.name}：${status}`;
  }));
  return ["各 Ledger 餘額（彼此不抵銷）", ...rows].join("\n");
}

function taipeiDate(timestamp?: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp ?? Date.now()));
}

function parseDraft(text: string): z.infer<typeof draftSchema> | null {
  const normalized = text.normalize("NFKC").trim();
  const amount = normalized.match(/(?:NT\$?|TWD\s*)?([0-9][0-9,]*)/i);
  if (!amount) return null;
  const amountTwd = Number(amount[1]!.replaceAll(",", ""));
  if (!Number.isSafeInteger(amountTwd) || amountTwd <= 0) return null;
  const payer = /(?:他|她|另一半|對方)\s*(?:付|出|付款)/.test(normalized)
    ? "partner"
    : /(?:我|本人)\s*(?:付|出|付款)|我請/.test(normalized)
      ? "self"
      : null;
  if (!payer) return null;
  const ledgerMatch = normalized.match(/(?:記在|放到|加入|帳本|ledger)\s*[:：]?\s*([^\s,，。.!！?？]+)/i);
  const description = normalized
    .replace(amount[0]!, " ")
    .replace(/(?:我|本人|他|她|另一半|對方)\s*(?:付|出|付款)|我請/g, " ")
    .replace(/(?:記在|放到|加入|帳本|ledger)\s*[:：]?\s*[^\s,，。.!！?？]+/i, " ")
    .replace(/[，,。.!！?？]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!description) return null;
  return draftSchema.parse({ amountTwd, description, payer, ...(ledgerMatch?.[1] ? { ledgerName: ledgerMatch[1] } : {}) });
}

function parseTransfer(text: string): { amountTwd: number; payer: "self" | "partner"; ledgerName?: string } | null {
  const normalized = text.normalize("NFKC").trim();
  if (!/(?:轉帳|轉給|匯給|還款)/.test(normalized)) return null;
  const amount = normalized.match(/(?:NT\$?|TWD\s*)?([0-9][0-9,]*)/i);
  if (!amount) return null;
  const amountTwd = Number(amount[1]!.replaceAll(",", ""));
  if (!Number.isSafeInteger(amountTwd) || amountTwd <= 0 || amountTwd > 100_000_000) return null;
  const payer = /(?:我|本人)\s*(?:轉|匯|還)|我給/.test(normalized)
    ? "self"
    : /(?:他|她|另一半|對方)\s*(?:轉|匯|還)|對方給/.test(normalized)
      ? "partner"
      : null;
  if (!payer) return null;
  const ledgerMatch = normalized.match(/(?:記在|放到|加入|帳本|ledger)\s*[:：]?\s*([^\s,，。.!！?？]+)/i);
  return { amountTwd, payer, ...(ledgerMatch?.[1] ? { ledgerName: ledgerMatch[1] } : {}) };
}

function wantsSettleAll(text: string): boolean {
  return /(?:全部)?(?:結清|還清|清帳|settle\s*all)/i.test(text.normalize("NFKC"));
}

export async function proposeV2LineText(input: {
  db: SupabaseClient;
  user: LineUser;
  text: string;
  sourceEventId: string;
  sourceEventTimestamp?: number;
  gemini?: GoogleGenAI;
}): Promise<V2LineProposalResult> {
  let parsed = parseDraft(input.text);
  let transfer = parsed ? null : parseTransfer(input.text);
  let settleRequested = wantsSettleAll(input.text);
  if (!parsed && !transfer && !settleRequested && input.gemini) {
    const ai = await parseV2AiProposal(input.gemini, input.text);
    if (ai?.kind === "expense" && ai.amountTwd && ai.description && ai.payer) {
      parsed = draftSchema.parse({
        amountTwd: ai.amountTwd,
        description: ai.description,
        payer: ai.payer,
        ...(ai.ledgerName ? { ledgerName: ai.ledgerName } : {}),
        ...(ai.category ? { category: ai.category } : {}),
        ...(ai.note ? { note: ai.note } : {}),
      });
    } else if (ai?.kind === "transfer" && ai.amountTwd && ai.payer) {
      transfer = {
        amountTwd: ai.amountTwd,
        payer: ai.payer,
        ...(ai.ledgerName ? { ledgerName: ai.ledgerName } : {}),
      };
    } else if (ai?.kind === "settle_all") {
      settleRequested = true;
    }
  }
  if (!parsed && !transfer && !settleRequested) return { kind: "not_supported" };
  const ledgers = await listV2UserLedgers(input.user.couple_id, input.user.id);
  if (!ledgers.length) return { kind: "needs_ledger", ledgers: [] };
  const requestedLedgerName = parsed?.ledgerName ?? transfer?.ledgerName;
  const ledger = requestedLedgerName
    ? ledgers.find((candidate) => candidate.name === requestedLedgerName || candidate.name.includes(requestedLedgerName))
    : ledgers[0];
  if (!ledger) return { kind: "needs_ledger", ledgers };
  const partner = await input.db
    .from("users")
    .select("id")
    .eq("couple_id", input.user.couple_id)
    .neq("id", input.user.id)
    .single();
  if (partner.error || !partner.data?.id) return { kind: "not_supported" };
  let command: V2LineProposalDraft;
  let amountTwd: number;
  let description: string;
  const bootstrap = parsed
    ? await getV2LedgerBootstrap(input.user.couple_id, ledger.id)
    : null;
  if (parsed) {
    const payerId = parsed.payer === "self" ? input.user.id : partner.data.id;
    const memberIds: [string, string] = [
      bootstrap!.ledger.members[0]!.userId,
      bootstrap!.ledger.members[1]!.userId,
    ];
    const defaultWeights: [string, string] = [
      bootstrap!.ledger.defaultShares[memberIds[0]!] ?? "1",
      bootstrap!.ledger.defaultShares[memberIds[1]!] ?? "1",
    ];
    const shares = splitWeights(String(parsed.amountTwd), memberIds, defaultWeights);
    command = {
      ledgerId: ledger.id,
      type: "expense",
      amountTwd: String(parsed.amountTwd),
      occurredOn: taipeiDate(input.sourceEventTimestamp),
      description: parsed.description,
      splitMethod: "weights",
      payments: [{ userId: payerId, amountTwd: String(parsed.amountTwd) }],
      shares: memberIds.map((userId) => ({ userId, amountTwd: shares[userId]!.toString() })),
      ...(parsed.category ? { category: parsed.category } : {}),
      ...(parsed.note ? { note: parsed.note } : {}),
    };
    amountTwd = parsed.amountTwd;
    description = parsed.description;
  } else {
    let paymentAmount: number;
    let payerId: string;
    if (transfer) {
      paymentAmount = transfer.amountTwd;
      payerId = transfer.payer === "self" ? input.user.id : partner.data.id;
      const receiverId = payerId === input.user.id ? partner.data.id : input.user.id;
      command = {
        ledgerId: ledger.id,
        type: "transfer",
        amountTwd: String(paymentAmount),
        occurredOn: taipeiDate(input.sourceEventTimestamp),
        description: "LINE 轉帳",
        splitMethod: "none",
        payments: [{ userId: payerId, amountTwd: String(paymentAmount) }],
        shares: [{ userId: receiverId, amountTwd: String(paymentAmount) }],
      };
      description = "LINE 轉帳";
    } else {
      const settleBootstrap = await getV2LedgerBootstrap(input.user.couple_id, ledger.id);
      const memberSet: V2LedgerMemberSet = {
        ledgerId: ledger.id,
        memberIds: [settleBootstrap.ledger.members[0]!.userId, settleBootstrap.ledger.members[1]!.userId],
      };
      const settle = buildSettleAllTransfer(memberSet, settleBootstrap.balance);
      if (!settle) return { kind: "not_supported" };
      paymentAmount = Number(settle.amountTwd);
      payerId = settle.payments[0]!.userId;
      command = {
        ledgerId: ledger.id,
        type: "transfer",
        amountTwd: settle.amountTwd.toString(),
        occurredOn: taipeiDate(input.sourceEventTimestamp),
        description: "全部結清",
        splitMethod: "none",
        payments: settle.payments.map((payment) => ({ userId: payment.userId, amountTwd: payment.amountTwd.toString() })),
        shares: settle.shares.map((share) => ({ userId: share.userId, amountTwd: share.amountTwd.toString() })),
      };
      description = "全部結清";
    }
    amountTwd = paymentAmount;
    void payerId;
  }
  const result = await createV2ProposalFromLine(
    input.user.couple_id,
    input.user.id,
    command,
    input.sourceEventId,
  ) as { proposalId: string };
  return { kind: "created", proposalId: result.proposalId, ledgerName: ledger.name, amountTwd, description };
}
