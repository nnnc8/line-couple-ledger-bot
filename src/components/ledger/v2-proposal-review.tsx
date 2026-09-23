"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Clock3, FilePenLine, LockKeyhole, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { money } from "@/lib/format";
import {
  confirmV2ProposalClient,
  cancelV2ProposalClient,
  getV2ProposalDetail,
  reviseV2ProposalClient,
} from "@/lib/v2-proposal-client";
import type { User, V2LedgerSummary } from "@/lib/types";
import { v2ProposalConfirmationSchema, type ReviseV2ProposalInput, type V2ProposalCommand, type V2ProposalDetail, type V2ProposalConfirmation } from "@/lib/v2-proposal-contract";

interface V2ProposalReviewProps {
  proposalId: string;
  users: User[];
  ledgers: V2LedgerSummary[];
  activeLedgerId: string | null;
  onProposalLedgerId?: (ledgerId: string) => void;
  onProposalId?: (proposalId: string) => void;
  refreshLedger: () => Promise<unknown>;
  onError: (message: string) => void;
}

type LocalIssue = { path: string; message: string };

const typeOptions = [
  { value: "expense", label: "支出" },
  { value: "income", label: "收入／退款" },
  { value: "transfer", label: "轉帳" },
];

const splitOptions = [
  { value: "none", label: "不分攤" },
  { value: "equal", label: "平均" },
  { value: "weights", label: "依 Ledger 權重" },
  { value: "exact", label: "指定金額" },
  { value: "percentage", label: "依百分比" },
];

function sumAmounts(values: Array<{ amountTwd: string }>): bigint | null {
  try {
    return values.reduce((sum, value) => sum + BigInt(value.amountTwd), 0n);
  } catch {
    return null;
  }
}

function commandIssues(command: V2ProposalCommand, index: number, userIds: Set<string>): LocalIssue[] {
  const issues: LocalIssue[] = [];
  let amount: bigint | null = null;
  try {
    amount = BigInt(command.amountTwd);
    if (amount <= 0n) issues.push({ path: `commands.${index}.amountTwd`, message: "金額必須大於 0" });
  } catch {
    issues.push({ path: `commands.${index}.amountTwd`, message: "金額必須是整數" });
  }
  if (!command.description.trim()) issues.push({ path: `commands.${index}.description`, message: "請填寫描述" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(command.occurredOn)) issues.push({ path: `commands.${index}.occurredOn`, message: "日期格式不正確" });
  const checkParticipants = (label: string, values: Array<{ userId: string; amountTwd: string }>) => {
    if (!values.length || values.length > 2) issues.push({ path: `commands.${index}.${label}`, message: `${label} 必須有一至兩位成員` });
    const seen = new Set<string>();
    for (const value of values) {
      if (!userIds.has(value.userId)) issues.push({ path: `commands.${index}.${label}`, message: `${label} 含有非本 Ledger 成員` });
      if (seen.has(value.userId)) issues.push({ path: `commands.${index}.${label}`, message: `${label} 不可重複成員` });
      seen.add(value.userId);
      try {
        if (BigInt(value.amountTwd) <= 0n) issues.push({ path: `commands.${index}.${label}`, message: `${label} 金額必須大於 0` });
      } catch {
        issues.push({ path: `commands.${index}.${label}`, message: `${label} 金額格式不正確` });
      }
    }
    if (amount !== null && sumAmounts(values) !== amount) issues.push({ path: `commands.${index}.${label}`, message: `${label} 合計必須等於交易金額` });
  };
  checkParticipants("payments", command.payments);
  checkParticipants("shares", command.shares);
  if (command.type === "transfer") {
    if (command.payments.length !== 1 || command.shares.length !== 1) issues.push({ path: `commands.${index}`, message: "轉帳必須只有付款人與收款人各一位" });
    if (command.payments[0]?.userId === command.shares[0]?.userId) issues.push({ path: `commands.${index}`, message: "轉帳付款人與收款人必須不同" });
  } else if (command.shares.length !== 2) {
    issues.push({ path: `commands.${index}.shares`, message: "支出／收入必須明確列出兩位成員分攤" });
  }
  return issues;
}

function statusLabel(detail: V2ProposalDetail): string {
  if (detail.status === "proposed") return detail.validation.state === "stale" ? "Ledger 已變更" : "待確認";
  if (detail.status === "confirmed") return "已入帳";
  if (detail.status === "cancelled") return detail.revision.supersededByProposalId ? "已由修正版取代" : "已取消";
  return "已過期";
}

function statusTone(detail: V2ProposalDetail): string {
  if (detail.status === "confirmed") return "border-emerald-200 bg-emerald-50";
  if (detail.status === "cancelled" || detail.status === "expired") return "border-[var(--border)] bg-[var(--muted)]";
  if (detail.validation.state !== "valid") return "border-amber-200 bg-amber-50";
  return "border-accent/30 bg-accent-soft";
}

export function V2ProposalReview({ proposalId, users, ledgers, activeLedgerId, onProposalLedgerId, onProposalId, refreshLedger, onError }: V2ProposalReviewProps) {
  const [currentProposalId, setCurrentProposalId] = React.useState(proposalId);
  const [detail, setDetail] = React.useState<V2ProposalDetail | null>(null);
  const [commands, setCommands] = React.useState<V2ProposalCommand[]>([]);
  const [selectedLedgerId, setSelectedLedgerId] = React.useState("");
  const [confirmation, setConfirmation] = React.useState<V2ProposalConfirmation | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Record<number, boolean>>({});
  const [notice, setNotice] = React.useState("");
  const [localIssues, setLocalIssues] = React.useState<LocalIssue[]>([]);
  const [dirty, setDirty] = React.useState(false);
  const requestRef = React.useRef(0);

  const load = React.useCallback(async (id: string) => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const next = await getV2ProposalDetail(id);
      if (request !== requestRef.current) return;
      setCurrentProposalId(id);
      setDetail(next);
      setCommands(next.commands);
      setSelectedLedgerId(next.ledgerId);
      const confirmed = v2ProposalConfirmationSchema.safeParse(next.result);
      setConfirmation(confirmed.success ? confirmed.data : null);
      setDirty(false);
      setLocalIssues([]);
      setNotice("");
      onProposalLedgerId?.(next.ledgerId);
    } catch (reason) {
      if (request === requestRef.current) onError(reason instanceof Error ? reason.message : "無法讀取 proposal");
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [onError, onProposalLedgerId]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => { void load(proposalId); }, 0);
    return () => window.clearTimeout(timer);
  }, [load, proposalId]);

  const userIds = React.useMemo(() => new Set(users.map((user) => user.id)), [users]);
  const validateLocal = React.useCallback((next: V2ProposalCommand[]) => {
    const issues = next.flatMap((command, index) => commandIssues(command, index, userIds));
    setLocalIssues(issues);
    return issues;
  }, [userIds]);

  function updateCommand(index: number, update: Partial<V2ProposalCommand>) {
    setCommands((current) => {
      const next = current.map((command, commandIndex) => commandIndex === index ? { ...command, ...update } : command);
      setDirty(true);
      validateLocal(next);
      return next;
    });
  }

  function updateParticipant(index: number, field: "payments" | "shares", participantIndex: number, update: Partial<{ userId: string; amountTwd: string }>) {
    const command = commands[index];
    if (!command) return;
    updateCommand(index, { [field]: command[field].map((participant, row) => row === participantIndex ? { ...participant, ...update } : participant) });
  }

  async function confirm() {
    if (!detail || detail.status !== "proposed" || selectedLedgerId !== detail.ledgerId || dirty || localIssues.length || detail.validation.state !== "valid") return;
    setSaving(true);
    setNotice("");
    try {
      const result = await confirmV2ProposalClient(currentProposalId);
      setConfirmation(result);
      setDetail((current) => current ? { ...current, status: "confirmed", validation: { ...current.validation, state: "valid" } } : current);
      setNotice("已完成唯一一次入帳寫入。");
      try {
        await refreshLedger();
        setNotice("已入帳，Ledger 流水已更新。");
      } catch {
        setNotice("已入帳；流水畫面暫時無法更新，請按重新整理。資料庫寫入已完成。");
      }
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "proposal 確認失敗");
    } finally {
      setSaving(false);
    }
  }

  async function cancel() {
    if (!detail || detail.status !== "proposed") return;
    setSaving(true);
    try {
      await cancelV2ProposalClient(currentProposalId);
      setDetail((current) => current ? { ...current, status: "cancelled" } : current);
      setNotice("proposal 已取消，不會產生帳務寫入。");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "proposal 取消失敗");
    } finally {
      setSaving(false);
    }
  }

  async function revise() {
    if (!detail || detail.status !== "proposed") return;
    const issues = validateLocal(commands);
    if (issues.length) return;
    setSaving(true);
    try {
      const revisionCommands: ReviseV2ProposalInput["commands"] = commands.map(({ commandIndex: _commandIndex, commandId: _commandId, ledgerId: _ledgerId, ledgerName: _ledgerName, validation: _validation, ...command }) => {
        void _commandIndex; void _commandId; void _ledgerId; void _ledgerName; void _validation;
        return command;
      });
      const result = await reviseV2ProposalClient(currentProposalId, { ledgerId: selectedLedgerId, commands: revisionCommands, reason: "使用者在 LIFF proposal review 修正" });
      const nextId = typeof result.proposalId === "string" ? result.proposalId : "";
      if (!nextId) throw new Error("修正版 proposal 回應格式不正確");
      setCurrentProposalId(nextId);
      onProposalId?.(nextId);
      await load(nextId);
      setNotice("修正版已建立，原草稿已標記為取代；請再次檢查後確認。");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "proposal 修正失敗");
    } finally {
      setSaving(false);
    }
  }

  if (loading && !detail) {
    return <Card className="border-accent/30 bg-accent-soft p-4 text-sm">正在載入可檢查的 proposal…</Card>;
  }
  if (!detail) return null;

  const canConfirm = detail.status === "proposed" && selectedLedgerId === detail.ledgerId && !dirty && !localIssues.length && detail.validation.state === "valid" && !saving;
  const detailIssues = [...detail.validation.issues.map((issue) => issue.message), ...localIssues.map((issue) => issue.message)];
  const proposalExpiredAt = new Date(detail.expiresAt).toLocaleString("zh-TW", { hour12: false });

  return (
    <Card className={`p-4 ${statusTone(detail)}`} aria-label="V3-1 proposal review">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-semibold"><FilePenLine className="size-4 text-accent" />可檢查的待確認草稿</p>
          <p className="mt-1 text-sm font-medium">Ledger：{detail.ledgerName}</p>
          <p className="text-xs text-[var(--muted-foreground)]">Proposal {detail.revision.revision} · {statusLabel(detail)} · 建立 {new Date(detail.createdAt).toLocaleString("zh-TW", { hour12: false })} · 到期 {proposalExpiredAt}</p>
        </div>
        <span className="rounded-full bg-[var(--card)] px-2 py-1 text-xs font-semibold">{detail.commandCount} 筆</span>
      </div>

      {detail.source ? <p className="mt-2 text-xs text-[var(--muted-foreground)]">來源：{detail.sourceSummary ?? detail.source.kind} · event {detail.source.eventId}</p> : null}
      {detail.revision.parentProposalId ? <p className="mt-1 text-xs text-[var(--muted-foreground)]">此版本承接前一版 proposal，修改不會直接改寫既有帳務。{detail.revision.changes.length ? ` 變更：${detail.revision.changes.join("、")}` : ""}</p> : null}

      {detail.status === "proposed" ? <label className="mt-3 block text-xs font-semibold">目標 Ledger
        <Select ariaLabel="Proposal Ledger" value={selectedLedgerId} onValueChange={(value) => { setSelectedLedgerId(value); setDirty(true); }} options={ledgers.filter((ledger) => ledger.status === "active" || ledger.id === detail.ledgerId).map((ledger) => ({ value: ledger.id, label: ledger.name }))} disabled={saving} />
      </label> : null}

      <div className="mt-3 space-y-3">
        {commands.map((command, index) => {
          const open = expanded[index] ?? true;
          return <div key={`${currentProposalId}-${index}`} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
            <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setExpanded((current) => ({ ...current, [index]: !open }))}>
              <span className="font-semibold">第 {index + 1} 筆：{command.description || "未命名交易"} · {money(Number(command.amountTwd))}</span>
              <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
            </button>
            {open ? <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs font-semibold">類型<Select value={command.type} onValueChange={(value) => updateCommand(index, { type: value as V2ProposalCommand["type"] })} options={typeOptions} disabled={detail.status !== "proposed" || saving} /></label>
                <label className="text-xs font-semibold">金額（TWD）<Input inputMode="numeric" value={command.amountTwd} onChange={(event) => updateCommand(index, { amountTwd: event.target.value.replace(/[^0-9]/g, "") })} disabled={detail.status !== "proposed" || saving} /></label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs font-semibold">日期<Input type="date" value={command.occurredOn} onChange={(event) => updateCommand(index, { occurredOn: event.target.value })} disabled={detail.status !== "proposed" || saving} /></label>
                <label className="text-xs font-semibold">分攤方式<Select value={command.splitMethod} onValueChange={(value) => updateCommand(index, { splitMethod: value as V2ProposalCommand["splitMethod"] })} options={splitOptions} disabled={detail.status !== "proposed" || saving} /></label>
              </div>
              <label className="block text-xs font-semibold">描述<Input value={command.description} onChange={(event) => updateCommand(index, { description: event.target.value })} disabled={detail.status !== "proposed" || saving} /></label>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs font-semibold">分類<Input value={command.category ?? ""} onChange={(event) => updateCommand(index, { category: event.target.value || null })} disabled={detail.status !== "proposed" || saving} /></label>
                <label className="text-xs font-semibold">備註<Input value={command.note ?? ""} onChange={(event) => updateCommand(index, { note: event.target.value || null })} disabled={detail.status !== "proposed" || saving} /></label>
              </div>
              <ParticipantEditor label="付款分配" values={command.payments} users={users} disabled={detail.status !== "proposed" || saving} onChange={(row, update) => updateParticipant(index, "payments", row, update)} />
              <ParticipantEditor label="分攤分配" values={command.shares} users={users} disabled={detail.status !== "proposed" || saving} onChange={(row, update) => updateParticipant(index, "shares", row, update)} />
            </div> : null}
          </div>;
        })}
      </div>

      {detail.validation.state === "stale" ? <div className="mt-3 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"><LockKeyhole className="mt-0.5 size-4 shrink-0" /><span>Ledger 版本已變更；確認按鈕保持關閉。送出修正版會重新以目前 Ledger 版本驗證，且不會直接寫入交易。</span></div> : null}
      {detail.validation.state === "expired" ? <div className="mt-3 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"><Clock3 className="mt-0.5 size-4 shrink-0" /><span>此 proposal 已過期，無法確認；請從 LINE 重新建立草稿。</span></div> : null}
      {detailIssues.length ? <div className="mt-3 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><div><p className="font-semibold">確認前仍有欄位需要處理</p><ul className="mt-1 list-disc pl-5">{[...new Set(detailIssues)].slice(0, 8).map((issue) => <li key={issue}>{issue}</li>)}</ul></div></div> : null}
      {notice ? <p className="mt-3 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950" role="status"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{notice}</p> : null}
      {confirmation ? <ConfirmationSummary confirmation={confirmation} ledgerName={detail.ledgerName} users={users} /> : null}

      {detail.status === "proposed" ? <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" size="sm" onClick={() => void confirm()} disabled={!canConfirm}>確認入帳</Button>
        <Button variant="secondary" size="sm" onClick={() => void revise()} disabled={saving || Boolean(localIssues.length) || detail.validation.state === "expired"}>送出修正版</Button>
        <Button variant="ghost" size="sm" onClick={() => void cancel()} disabled={saving}>取消草稿</Button>
      </div> : null}
      {detail.status === "confirmed" ? <p className="mt-3 flex items-center gap-2 text-sm font-semibold text-emerald-900"><CheckCircle2 className="size-4" />寫入已完成；畫面刷新失敗時仍以這個狀態為準。</p> : null}
      {detail.status === "cancelled" ? <p className="mt-3 flex items-center gap-2 text-sm text-[var(--muted-foreground)]"><XCircle className="size-4" />此 proposal 已終止，不會再次寫入。</p> : null}
      {activeLedgerId && activeLedgerId !== detail.ledgerId ? <p className="mt-2 text-xs text-amber-900">正在切換到 proposal 指定的 Ledger…</p> : null}
    </Card>
  );
}

function ConfirmationSummary({ confirmation, ledgerName, users }: { confirmation: V2ProposalConfirmation; ledgerName: string; users: User[] }) {
  const label = (userId: string) => users.find((user) => user.id === userId)?.label ?? userId;
  const total = confirmation.transactions.reduce((sum, transaction) => {
    const amount = typeof transaction.amountTwd === "string" ? transaction.amountTwd : "0";
    try { return sum + BigInt(amount); } catch { return sum; }
  }, 0n);
  return <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
    <p className="font-semibold">已記錄 {confirmation.transactions.length} 筆至 Ledger：{ledgerName}</p>
    <p className="mt-1">本次金額：NT${total.toString()} · Ledger 版本：{confirmation.ledgerVersion}</p>
    <p className="mt-1">目前餘額：{Object.entries(confirmation.balance).map(([userId, amount]) => `${label(userId)} ${money(Number(amount))}`).join("、")}</p>
    {confirmation.nextPayer ? <p className="mt-1">下一位付款：{label(confirmation.nextPayer.payerUserId)} → {label(confirmation.nextPayer.payeeUserId)} NT${confirmation.nextPayer.amountTwd}</p> : <p className="mt-1">目前沒有待結清金額。</p>}
  </div>;
}

function ParticipantEditor({ label, values, users, disabled, onChange }: { label: string; values: Array<{ userId: string; amountTwd: string }>; users: User[]; disabled: boolean; onChange: (row: number, update: Partial<{ userId: string; amountTwd: string }>) => void }) {
  return <div className="rounded-xl bg-[var(--muted)] p-3">
    <p className="mb-2 text-xs font-semibold">{label}</p>
    <div className="space-y-2">
      {values.map((value, index) => <div className="grid grid-cols-[1fr_7rem] gap-2" key={`${value.userId}-${index}`}>
        <Select value={value.userId} onValueChange={(userId) => onChange(index, { userId })} options={users.map((user) => ({ value: user.id, label: user.label }))} disabled={disabled} ariaLabel={`${label} 成員`} />
        <Input inputMode="numeric" value={value.amountTwd} onChange={(event) => onChange(index, { amountTwd: event.target.value.replace(/[^0-9]/g, "") })} disabled={disabled} aria-label={`${label} 金額`} />
      </div>)}
    </div>
    {!values.length ? <p className="text-xs text-[var(--muted-foreground)]">尚未提供分配；請送出修正版時補齊。</p> : null}
  </div>;
}
