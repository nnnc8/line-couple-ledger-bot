import type { SupabaseClient } from "@supabase/supabase-js";
import type { GoogleGenAI } from "@google/genai";
import { createHash } from "node:crypto";
import { z } from "zod";

import { buildSettleAllTransfer, splitWeights, type V2LedgerMemberSet } from "./v2-ledger";
import {
  createV2Transaction,
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

const incomeDraftSchema = z.object({
  amountTwd: z.number().int().positive().max(100_000_000),
  description: z.string().trim().min(1).max(120),
  receiver: z.enum(["self", "partner"]),
  ledgerName: z.string().trim().min(1).max(40).optional(),
  category: z.string().trim().min(1).max(40).optional(),
  note: z.string().trim().max(1000).optional(),
});

const aiCandidateSchema = z.object({
  kind: z.enum(["expense", "income", "transfer", "settle_all", "unsupported"]),
  amountTwd: z.union([
    z.number().int().positive().max(100_000_000),
    z.string().regex(/^[1-9][0-9]*$/),
  ]).optional(),
  description: z.string().trim().min(1).max(120).optional(),
  payer: z.enum(["self", "partner"]).optional(),
  receiver: z.enum(["self", "partner"]).optional(),
  ledgerName: z.string().trim().min(1).max(40).optional(),
  category: z.string().trim().min(1).max(40).optional(),
  note: z.string().trim().max(1000).optional(),
}).strict();

const aiProposalEnvelopeSchema = z.object({
  version: z.literal(1),
  commands: z.array(aiCandidateSchema).min(1).max(20),
}).strict();

const aiProposalJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "integer", enum: [1] },
    commands: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["expense", "income", "transfer", "settle_all", "unsupported"] },
          amountTwd: { type: "integer", minimum: 1, maximum: 100_000_000 },
          description: { type: "string", minLength: 1, maxLength: 120 },
          payer: { type: "string", enum: ["self", "partner"] },
          receiver: { type: "string", enum: ["self", "partner"] },
          ledgerName: { type: "string", minLength: 1, maxLength: 40 },
          category: { type: "string", minLength: 1, maxLength: 40 },
          note: { type: "string", maxLength: 1000 },
        },
        required: ["kind"],
      },
    },
  },
  required: ["version", "commands"],
} as const;

export type V2AiProposalCandidate = Omit<z.infer<typeof aiCandidateSchema>, "amountTwd"> & { amountTwd?: number };

export type V2AiProposalCommands = { version: 1; commands: V2AiProposalCandidate[] };

function parseAiCandidate(value: z.infer<typeof aiCandidateSchema>): V2AiProposalCandidate | null {
  if (value.kind === "unsupported") return { kind: value.kind };
  if (value.kind === "settle_all") return { kind: value.kind };
  if (!value.amountTwd || !value.description || (value.kind === "income" ? !value.receiver : !value.payer)) return null;
  return { ...value, amountTwd: Number(value.amountTwd) };
}

export function parseV2AiProposalResponse(text: string): V2AiProposalCandidate | null {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const json = JSON.parse(normalized) as unknown;
    const legacy = aiCandidateSchema.safeParse(json);
    if (legacy.success) return parseAiCandidate(legacy.data);
    const envelope = aiProposalEnvelopeSchema.safeParse(json);
    return envelope.success ? parseAiCandidate(envelope.data.commands[0]!) : null;
  } catch {
    return null;
  }
}

export function parseV2AiProposalCommandsResponse(text: string): V2AiProposalCommands | null {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = aiProposalEnvelopeSchema.safeParse(JSON.parse(normalized));
    if (!parsed.success) return null;
    const commands: V2AiProposalCandidate[] = [];
    for (const value of parsed.data.commands) {
      if (value.kind === "unsupported" || value.kind === "settle_all") {
        commands.push({ kind: value.kind });
        continue;
      }
      if (!value.amountTwd || !value.description || (value.kind === "income" ? !value.receiver : !value.payer)) return null;
      commands.push({ ...value, amountTwd: Number(value.amountTwd) });
    }
    return { version: 1, commands };
  } catch {
    return null;
  }
}

function looksLikeV2AccountingText(text: string): boolean {
  return /\d|記|帳|花|買|付|支出|收入|收款|付款|退款|轉帳|轉給|匯給|還款|結清|還清|清帳/i.test(text);
}

async function parseV2AiProposal(gemini: GoogleGenAI, text: string): Promise<V2AiProposalCommands | null> {
  if (!looksLikeV2AccountingText(text)) return null;
  try {
    const response = await gemini.models.generateContent({
      model: getModelConfig().modelId,
      contents: [{
        role: "user",
        parts: [{ text: [
          "你是 Couple Ledger V2 的輸入解析器。只把使用者訊息解析成待確認草稿，絕對不要執行記帳。",
          "產品限制：只有 TWD 整數；Couple 永遠只有兩位成員；不能處理外幣、匯率、多人群組或模糊金額。",
          "只輸出 {version:1, commands:[...]}。kind 只能是 expense、income、transfer、settle_all、unsupported。expense/transfer 必須有 amountTwd、description、payer；income 必須有 receiver；結清使用 settle_all；無法安全判斷就 unsupported。",
          "payer/receiver 的 self 是訊息作者，partner 是另一半。不要猜測未出現的金額、付款人、收款人或 Ledger。多筆訊息拆成多個 commands，但沒有明確 Ledger 時不要跨 Ledger。",
          `使用者訊息：${text}`,
        ].join("\n") }],
      }],
      config: {
        temperature: 0,
        maxOutputTokens: 600,
        responseMimeType: "application/json",
        responseJsonSchema: aiProposalJsonSchema,
      },
    });
    return parseV2AiProposalCommandsResponse(response.text ?? "");
  } catch {
    return null;
  }
}

export type V2LineProposalResult =
  | { kind: "posted"; transactionId: string; ledgerId: string; ledgerName: string; amountTwd: number; description: string }
  | { kind: "created"; proposalId: string; ledgerName: string; amountTwd: number; description: string; count?: number }
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
    const count = result.count && result.count > 1 ? `（${result.count} 筆）` : "";
    return `已建立待確認草稿${count}：${result.ledgerName}｜${result.description}｜NT$${result.amountTwd.toLocaleString()}。請開啟 LIFF 確認後才會入帳${link}`;
  }
  if (result.kind === "posted") {
    let undo = "";
    try {
      undo = `\n撤銷：${buildLiffUrl(requireLiffId(), { v2Ledger: result.ledgerId, v2Transaction: result.transactionId })}`;
    } catch {
      undo = "\n如需撤銷，請在 LIFF 的該 Ledger 流水按「作廢」";
    }
    return `✓ 已記錄\n${result.description}\nNT$${result.amountTwd.toLocaleString()}\n${result.ledgerName}${undo}`;
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
  if (!/(?:轉帳|轉給|轉|匯給|還款)/.test(normalized)) return null;
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

function parseIncome(text: string): z.infer<typeof incomeDraftSchema> | null {
  const normalized = text.normalize("NFKC").trim();
  if (!/(?:退款|退費|退錢|收入|收款|拿到)/.test(normalized) || /(?:轉帳|轉給|匯給|還款)/.test(normalized)) return null;
  const amount = normalized.match(/(?:NT\$?|TWD\s*)?([0-9][0-9,]*)/i);
  if (!amount) return null;
  const amountTwd = Number(amount[1]!.replaceAll(",", ""));
  if (!Number.isSafeInteger(amountTwd) || amountTwd <= 0 || amountTwd > 100_000_000) return null;
  const receiver = /(?:我|本人)(?:(?:這邊|這裡)?(?:收到|拿到|收款))|(?:退到|退給|匯到|入帳到)(?:我|本人)/.test(normalized)
    ? "self"
    : /(?:他|她|另一半|對方)(?:(?:那邊|這邊)?(?:收到|拿到|收款))|(?:退到|退給|匯到|入帳到)(?:他|她|另一半|對方)/.test(normalized)
      ? "partner"
      : null;
  if (!receiver) return null;
  const ledgerMatch = normalized.match(/(?:記在|放到|加入|帳本|ledger)\s*[:：]?\s*([^\s,，。.!！?？]+)/i);
  const description = normalized
    .replace(amount[0]!, " ")
    .replace(/(?:退款|退費|退錢|收入|收款|拿到|我|本人|他|她|另一半|對方)(?:這邊|這裡|那邊)?(?:收到|拿到|收款)?/g, " ")
    .replace(/(?:記在|放到|加入|帳本|ledger)\s*[:：]?\s*[^\s,，。.!！?？]+/i, " ")
    .replace(/[，,。.!！?？]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "退款";
  return incomeDraftSchema.parse({ amountTwd, receiver, description, ...(ledgerMatch?.[1] ? { ledgerName: ledgerMatch[1] } : {}) });
}

export function parseV2LineIncome(text: string): z.infer<typeof incomeDraftSchema> | null {
  return parseIncome(text);
}

export function parseV2LineTransfer(text: string): { amountTwd: number; payer: "self" | "partner"; ledgerName?: string } | null {
  return parseTransfer(text);
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
  let income = parsed ? null : parseIncome(input.text);
  let transfer = parsed || income ? null : parseTransfer(input.text);
  let settleRequested = wantsSettleAll(input.text);
  const deterministicSingle = Boolean(parsed || income || transfer);
  let aiCommands: V2AiProposalCandidate[] | null = null;
  if (!parsed && !income && !transfer && !settleRequested && input.gemini) {
    const ai = await parseV2AiProposal(input.gemini, input.text);
    if (ai?.commands.length) {
      aiCommands = ai.commands;
      const first = ai.commands[0];
      if (ai.commands.length === 1 && first?.kind === "expense" && first.amountTwd && first.description && first.payer) {
        parsed = draftSchema.parse({ amountTwd: first.amountTwd, description: first.description, payer: first.payer, ...(first.ledgerName ? { ledgerName: first.ledgerName } : {}), ...(first.category ? { category: first.category } : {}), ...(first.note ? { note: first.note } : {}) });
      } else if (ai.commands.length === 1 && first?.kind === "income" && first.amountTwd && first.description && first.receiver) {
        income = incomeDraftSchema.parse({ amountTwd: first.amountTwd, description: first.description, receiver: first.receiver, ...(first.ledgerName ? { ledgerName: first.ledgerName } : {}), ...(first.category ? { category: first.category } : {}), ...(first.note ? { note: first.note } : {}) });
      } else if (ai.commands.length === 1 && first?.kind === "transfer" && first.amountTwd && first.payer) {
        transfer = { amountTwd: first.amountTwd, payer: first.payer, ...(first.ledgerName ? { ledgerName: first.ledgerName } : {}) };
      } else if (ai.commands.length === 1 && first?.kind === "settle_all") {
        settleRequested = true;
      }
    }
  }
  if (!parsed && !income && !transfer && !settleRequested && !aiCommands) return { kind: "not_supported" };
  const ledgers = await listV2UserLedgers(input.user.couple_id, input.user.id);
  if (!ledgers.length) return { kind: "needs_ledger", ledgers: [] };
  const requestedLedgerName = parsed?.ledgerName ?? income?.ledgerName ?? transfer?.ledgerName ?? aiCommands?.find((command) => command.ledgerName)?.ledgerName;
  const activeLedger = ledgers.filter((candidate) => candidate.activeForUser);
  if (!requestedLedgerName && ledgers.length > 1 && activeLedger.length !== 1) return { kind: "needs_ledger", ledgers };
  const ledgerMatches = requestedLedgerName
    ? ledgers.filter((candidate) => candidate.name === requestedLedgerName || candidate.name.includes(requestedLedgerName))
    : [];
  const ledger = requestedLedgerName
    ? ledgerMatches.length === 1 ? ledgerMatches[0] : undefined
    : activeLedger[0] ?? ledgers[0];
  if (!ledger) return { kind: "needs_ledger", ledgers };
  const selectedLedger = ledger;
  const requestedLedgerNames = [...new Set(aiCommands?.map((command) => command.ledgerName).filter((name): name is string => Boolean(name)) ?? [])];
  if (requestedLedgerNames.length > 1) return { kind: "needs_ledger", ledgers };
  if (requestedLedgerNames.length === 1 && requestedLedgerName && requestedLedgerNames[0] !== requestedLedgerName) return { kind: "needs_ledger", ledgers };
  const partner = await input.db
    .from("users")
    .select("id")
    .eq("couple_id", input.user.couple_id)
    .neq("id", input.user.id)
    .single();
  if (partner.error || !partner.data?.id) return { kind: "not_supported" };
  const partnerId = partner.data.id;
  const bootstrap = parsed || income || (aiCommands?.some((command) => command.kind === "expense" || command.kind === "income"))
    ? await getV2LedgerBootstrap(input.user.couple_id, selectedLedger.id)
    : null;
  const resolvedBootstrap = bootstrap ?? await getV2LedgerBootstrap(input.user.couple_id, selectedLedger.id);

  const memberIds: [string, string] = [
    resolvedBootstrap.ledger.members[0]!.userId,
    resolvedBootstrap.ledger.members[1]!.userId,
  ];
  const defaultWeights: [string, string] = [
    resolvedBootstrap.ledger.defaultShares[memberIds[0]!] ?? "1",
    resolvedBootstrap.ledger.defaultShares[memberIds[1]!] ?? "1",
  ];
  function buildCommand(candidate: { kind: "expense" | "income" | "transfer"; amountTwd: number; description: string; payer?: "self" | "partner"; receiver?: "self" | "partner"; category?: string; note?: string }): V2LineProposalDraft {
    const payer = candidate.payer === "partner" ? partnerId : input.user.id;
    const receiver = candidate.receiver === "partner" ? partnerId : input.user.id;
    const shares = splitWeights(String(candidate.amountTwd), memberIds, defaultWeights);
    return {
      ledgerId: selectedLedger.id,
      type: candidate.kind,
      amountTwd: String(candidate.amountTwd),
      occurredOn: taipeiDate(input.sourceEventTimestamp),
      description: candidate.description,
      splitMethod: candidate.kind === "transfer" ? "none" : "weights",
      payments: [{ userId: candidate.kind === "income" ? receiver : payer, amountTwd: String(candidate.amountTwd) }],
      shares: candidate.kind === "transfer"
        ? [{ userId: payer === input.user.id ? partnerId : input.user.id, amountTwd: String(candidate.amountTwd) }]
        : memberIds.map((userId) => ({ userId, amountTwd: shares[userId]!.toString() })),
      ...(candidate.category ? { category: candidate.category } : {}),
      ...(candidate.note ? { note: candidate.note } : {}),
    };
  }

  if (deterministicSingle && (parsed || income || transfer)) {
    const command = parsed
      ? buildCommand({ kind: "expense", amountTwd: parsed.amountTwd, description: parsed.description, payer: parsed.payer, category: parsed.category, note: parsed.note })
      : income
        ? buildCommand({ kind: "income", amountTwd: income.amountTwd, description: income.description, receiver: income.receiver, category: income.category, note: income.note })
        : buildCommand({ kind: "transfer", amountTwd: transfer!.amountTwd, description: "LINE 轉帳", payer: transfer!.payer });
    // Tier A: one deterministic, explicit transaction can use the canonical
    // V2 writer immediately. Idempotency still keys the webhook event.
    const written = await createV2Transaction(input.user.couple_id, input.user.id, selectedLedger.id, {
      type: command.type,
      amountTwd: command.amountTwd,
      occurredOn: command.occurredOn,
      description: command.description,
      category: command.category ?? null,
      note: command.note ?? null,
      splitMethod: command.splitMethod,
      payments: command.payments,
      shares: command.shares,
    }, `line:v2:direct:${createHash("sha256").update(input.sourceEventId).digest("hex").slice(0, 80)}`);
    return { kind: "posted", transactionId: ((written as unknown as { transaction: { id: string } }).transaction).id, ledgerId: selectedLedger.id, ledgerName: selectedLedger.name, amountTwd: Number(command.amountTwd), description: command.description };
  }

  if (aiCommands?.length) {
    const commands = aiCommands.filter((candidate): candidate is V2AiProposalCandidate & { kind: "expense" | "income" | "transfer" } => candidate.kind !== "unsupported" && candidate.kind !== "settle_all").map((candidate) => {
      if (!candidate.amountTwd || !candidate.description || (candidate.kind === "income" ? !candidate.receiver : !candidate.payer)) return null;
      return buildCommand({ kind: candidate.kind, amountTwd: candidate.amountTwd, description: candidate.description, payer: candidate.payer, receiver: candidate.receiver, category: candidate.category, note: candidate.note });
    });
    if (commands.some((command) => !command) || !commands.length || commands.length !== aiCommands.length) return { kind: "not_supported" };
    const validCommands = commands.filter((command): command is V2LineProposalDraft => command !== null);
    const proposal = await createV2ProposalFromLine(input.user.couple_id, input.user.id, {
      ledgerId: selectedLedger.id,
      commands: validCommands.map(({ ledgerId: _ledgerId, ...command }) => { void _ledgerId; return command; }),
    }, input.sourceEventId) as { proposalId: string };
    return { kind: "created", proposalId: proposal.proposalId, ledgerName: selectedLedger.name, amountTwd: commands.reduce((sum, command) => sum + Number(command!.amountTwd), 0), description: `${commands.length} 筆交易`, count: commands.length };
  }

  if (settleRequested) {
    const settleBootstrap = await getV2LedgerBootstrap(input.user.couple_id, selectedLedger.id);
    const memberSet: V2LedgerMemberSet = { ledgerId: selectedLedger.id, memberIds: [settleBootstrap.ledger.members[0]!.userId, settleBootstrap.ledger.members[1]!.userId] };
    const settle = buildSettleAllTransfer(memberSet, settleBootstrap.balance);
    if (!settle) return { kind: "not_supported" };
    const command: V2LineProposalDraft = { ledgerId: selectedLedger.id, type: "transfer", amountTwd: settle.amountTwd.toString(), occurredOn: taipeiDate(input.sourceEventTimestamp), description: "全部結清", splitMethod: "none", payments: settle.payments.map((payment) => ({ userId: payment.userId, amountTwd: payment.amountTwd.toString() })), shares: settle.shares.map((share) => ({ userId: share.userId, amountTwd: share.amountTwd.toString() })) };
    const result = await createV2ProposalFromLine(input.user.couple_id, input.user.id, command, input.sourceEventId) as { proposalId: string };
    return { kind: "created", proposalId: result.proposalId, ledgerName: selectedLedger.name, amountTwd: Number(settle.amountTwd), description: "全部結清" };
  }

  return { kind: "not_supported" };
}
