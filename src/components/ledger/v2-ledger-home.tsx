"use client";

import * as React from "react";
import { ArrowLeftRight, CalendarClock, CheckCircle2, Download, Paperclip, Plus, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { V2LedgerSwitcher } from "./v2-ledger-switcher";
import { api } from "@/lib/api";
import { money, moneyAbs } from "@/lib/format";
import type { User, V2Attachment, V2LedgerBootstrap, V2LedgerSummary, V2RecurringRule } from "@/lib/types";

type PaymentMode = "self" | "partner" | "both";
type SplitMode = "weights" | "exact";
type TransactionType = "expense" | "income" | "transfer";

interface V2LedgerHomeProps {
  user: User;
  users: User[];
  today: string;
  ledgers: V2LedgerSummary[];
  activeLedgerId: string | null;
  setActiveLedgerId: (ledgerId: string) => void;
  bootstrap: V2LedgerBootstrap | null;
  error: string;
  busy: boolean;
  reload: () => Promise<unknown>;
  createLedger: (name: string, color?: string) => Promise<unknown>;
  proposalIdFromUrl?: string | null;
}

export function V2LedgerHome({
  user,
  users,
  today,
  ledgers,
  activeLedgerId,
  setActiveLedgerId,
  bootstrap,
  error,
  busy,
  reload,
  createLedger,
  proposalIdFromUrl = null,
}: V2LedgerHomeProps) {
  const partner = users.find((candidate) => candidate.id !== user.id) ?? users[1];
  const [showCreate, setShowCreate] = React.useState(false);
  const [newLedgerName, setNewLedgerName] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [occurredOn, setOccurredOn] = React.useState(today);
  const [category, setCategory] = React.useState("");
  const [note, setNote] = React.useState("");
  const [transactionType, setTransactionType] = React.useState<TransactionType>("expense");
  const [paymentMode, setPaymentMode] = React.useState<PaymentMode>("self");
  const [selfPayment, setSelfPayment] = React.useState("");
  const [partnerPayment, setPartnerPayment] = React.useState("");
  const [splitMode, setSplitMode] = React.useState<SplitMode>("weights");
  const [selfShare, setSelfShare] = React.useState("");
  const [partnerShare, setPartnerShare] = React.useState("");
  const [formError, setFormError] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [recurring, setRecurring] = React.useState<V2RecurringRule[]>([]);
  const [showRecurring, setShowRecurring] = React.useState(false);
  const [recurringName, setRecurringName] = React.useState("");
  const [recurringAmount, setRecurringAmount] = React.useState("");
  const [recurringFrequency, setRecurringFrequency] = React.useState<"weekly" | "monthly" | "yearly">("monthly");
  const [statistics, setStatistics] = React.useState<{ byType: Record<string, string>; byCategory: Record<string, string>; paidBy: Record<string, string>; borneBy: Record<string, string> } | null>(null);
  const [historyType, setHistoryType] = React.useState<"all" | TransactionType>("all");
  const [historyPayer, setHistoryPayer] = React.useState("all");
  const [historyQuery, setHistoryQuery] = React.useState("");
  const [historyFrom, setHistoryFrom] = React.useState("");
  const [historyTo, setHistoryTo] = React.useState("");
  const [historyRows, setHistoryRows] = React.useState<V2LedgerBootstrap["transactions"]>([]);
  const proposalId = proposalIdFromUrl;
  const [proposalStatus, setProposalStatus] = React.useState<string | null>(null);
  const [defaultWeights, setDefaultWeights] = React.useState<[string, string]>(["1", "1"]);
  const [defaultShareMessage, setDefaultShareMessage] = React.useState("");
  const [savingDefaults, setSavingDefaults] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);

  const loadRecurring = React.useCallback(async () => {
    if (!activeLedgerId) return;
    const result = await fetch(`/api/app/v2/ledgers/${activeLedgerId}/recurring`, { cache: "no-store", credentials: "same-origin" });
    const body = await result.json() as { recurring?: V2RecurringRule[]; error?: string };
    if (!result.ok) throw new Error(body.error ?? "無法讀取週期規則");
    setRecurring(body.recurring ?? []);
  }, [activeLedgerId]);

  React.useEffect(() => {
    if (!bootstrap) return;
    const timer = window.setTimeout(() => { void loadRecurring().catch(() => undefined); }, 0);
    return () => window.clearTimeout(timer);
  }, [bootstrap, loadRecurring]);

  const loadStatistics = React.useCallback(async () => {
    if (!activeLedgerId) return;
    const response = await fetch(`/api/app/v2/ledgers/${activeLedgerId}/statistics`, { cache: "no-store", credentials: "same-origin" });
    const body = await response.json() as typeof statistics & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "無法讀取統計");
    setStatistics(body);
  }, [activeLedgerId]);

  React.useEffect(() => {
    if (!bootstrap) return;
    const timer = window.setTimeout(() => { void loadStatistics().catch(() => undefined); }, 0);
    return () => window.clearTimeout(timer);
  }, [bootstrap, loadStatistics]);

  const loadHistory = React.useCallback(async () => {
    if (!activeLedgerId) return;
    const params = new URLSearchParams();
    if (historyType !== "all") params.set("type", historyType);
    if (historyPayer !== "all") params.set("payerUserId", historyPayer);
    if (historyQuery.trim()) params.set("q", historyQuery.trim());
    if (historyFrom) params.set("from", historyFrom);
    if (historyTo) params.set("to", historyTo);
    const response = await fetch(`/api/app/v2/ledgers/${activeLedgerId}/transactions?${params.toString()}`, { cache: "no-store", credentials: "same-origin" });
    const body = await response.json() as { transactions?: V2LedgerBootstrap["transactions"]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "無法讀取流水");
    setHistoryRows(body.transactions ?? []);
  }, [activeLedgerId, historyFrom, historyPayer, historyQuery, historyTo, historyType]);

  React.useEffect(() => {
    if (!bootstrap) return;
    const timer = window.setTimeout(() => { void loadHistory().catch(() => undefined); }, 0);
    return () => window.clearTimeout(timer);
  }, [bootstrap, loadHistory]);

  React.useEffect(() => {
    if (!bootstrap) return;
    const first = bootstrap.ledger.members[0]?.userId;
    const second = bootstrap.ledger.members[1]?.userId;
    if (!first || !second) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDefaultWeights([
      bootstrap.ledger.defaultShares[first] ?? "1",
      bootstrap.ledger.defaultShares[second] ?? "1",
    ]);
  }, [bootstrap]);

  const loadProposal = React.useCallback(async () => {
    if (!proposalId) return;
    const response = await fetch(`/api/app/v2/proposals/${proposalId}`, { cache: "no-store", credentials: "same-origin" });
    const body = await response.json() as { status?: string; error?: string };
    if (!response.ok) throw new Error(body.error ?? "無法讀取 proposal");
    setProposalStatus(body.status ?? null);
  }, [proposalId]);

  React.useEffect(() => {
    if (!proposalId) return;
    const timer = window.setTimeout(() => { void loadProposal().catch((reason) => setFormError(reason instanceof Error ? reason.message : "無法讀取 proposal")); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadProposal, proposalId]);

  async function confirmProposal() {
    if (!proposalId) return;
    setSaving(true);
    try {
      await api(`/api/app/v2/proposals/${proposalId}/confirm`, {});
      await reload();
      setProposalStatus("confirmed");
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "proposal 確認失敗");
    } finally {
      setSaving(false);
    }
  }

  async function cancelProposal() {
    if (!proposalId) return;
    setSaving(true);
    try {
      await api(`/api/app/v2/proposals/${proposalId}/cancel`, {});
      setProposalStatus("cancelled");
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "proposal 取消失敗");
    } finally {
      setSaving(false);
    }
  }

  if (!partner || !bootstrap) {
    return (
      <div className="space-y-3 pt-1">
      <V2LedgerSwitcher ledgers={ledgers} activeLedgerId={activeLedgerId} onChange={setActiveLedgerId} onCreate={() => setShowCreate(true)} />
        {showCreate ? <CreateLedgerCard name={newLedgerName} onName={setNewLedgerName} onCancel={() => setShowCreate(false)} onSave={async () => { if (!newLedgerName.trim()) return; await createLedger(newLedgerName.trim()); setNewLedgerName(""); setShowCreate(false); }} /> : null}
        <Card className="p-4 text-sm text-[var(--muted-foreground)]">{error || "正在載入 Ledger…"}</Card>
      </div>
    );
  }

  const selfBalance = Number(bootstrap.balance[user.id] ?? "0");
  const nextPayer = bootstrap.nextPayer;
  const nextPayerUser = nextPayer ? users.find((candidate) => candidate.id === nextPayer.payerUserId) : null;
  const nextPayerPayee = nextPayer ? users.find((candidate) => candidate.id === nextPayer.payeeUserId) : null;
  const amountNumber = Number(amount);
  const payments = paymentMode === "both"
    ? Number(selfPayment) + Number(partnerPayment)
    : amountNumber;
  const shares = splitMode === "exact" ? Number(selfShare) + Number(partnerShare) : amountNumber;

  async function submitTransaction(event: React.FormEvent) {
    event.preventDefault();
    setFormError("");
    if (!activeLedgerId || !Number.isSafeInteger(amountNumber) || amountNumber <= 0) {
      setFormError("請輸入正確的 TWD 整數金額");
      return;
    }
    if (!description.trim()) {
      setFormError("請輸入說明");
      return;
    }
    if (transactionType === "transfer" && paymentMode === "both") {
      setFormError("轉帳一次只能指定一位付款人");
      return;
    }
    if (paymentMode === "both" && payments !== amountNumber) {
      setFormError("兩位付款人的付款合計必須等於總額");
      return;
    }
    if (transactionType !== "transfer" && splitMode === "exact" && shares !== amountNumber) {
      setFormError("兩位成員的分攤合計必須等於總額");
      return;
    }
    setSaving(true);
    try {
      const payerId = paymentMode === "self" ? user.id : partner.id;
      const recipientId = payerId === user.id ? partner.id : user.id;
      await api(`/api/app/v2/ledgers/${activeLedgerId}/transactions`, {
        type: transactionType,
        amountTwd: String(amountNumber),
        occurredOn,
        description: description.trim(),
        category: category.trim() || null,
        note: note.trim() || null,
        splitMethod: transactionType === "transfer" ? "none" : splitMode,
        payments: paymentMode === "both"
          ? [
              { userId: user.id, amountTwd: String(Number(selfPayment)) },
              { userId: partner.id, amountTwd: String(Number(partnerPayment)) },
            ].filter((payment) => Number(payment.amountTwd) > 0)
          : [{ userId: payerId, amountTwd: String(amountNumber) }],
        ...(transactionType === "transfer"
          ? { shares: [{ userId: recipientId, amountTwd: String(amountNumber) }] }
          : {}),
        ...(transactionType !== "transfer" && splitMode === "exact"
          ? { exactShares: { [user.id]: String(Number(selfShare)), [partner.id]: String(Number(partnerShare)) } }
          : {}),
      });
      setAmount("");
      setDescription("");
      setOccurredOn(today);
      setCategory("");
      setNote("");
      setTransactionType("expense");
      setSelfPayment("");
      setPartnerPayment("");
      setSelfShare("");
      setPartnerShare("");
      await reload();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "儲存失敗");
    } finally {
      setSaving(false);
    }
  }

  async function settleAll() {
    if (!activeLedgerId || !nextPayer) return;
    setSaving(true);
    try {
      await api(`/api/app/v2/ledgers/${activeLedgerId}/settle-all`, {});
      await reload();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "結清失敗");
    } finally {
      setSaving(false);
    }
  }

  async function saveRecurring(event: React.FormEvent) {
    event.preventDefault();
    const amountValue = Number(recurringAmount);
    if (!activeLedgerId || !bootstrap || !recurringName.trim() || !Number.isSafeInteger(amountValue) || amountValue <= 0) return;
    setSaving(true);
    try {
      await api(`/api/app/v2/ledgers/${activeLedgerId}/recurring`, {
        name: recurringName.trim(),
        amountTwd: String(amountValue),
        frequency: recurringFrequency,
        nextRunDate: today,
        splitMethod: "weights",
        payments: [{ userId: user.id, amountTwd: String(amountValue) }],
      });
      setRecurringName("");
      setRecurringAmount("");
      setShowRecurring(false);
      await loadRecurring();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "週期規則儲存失敗");
    } finally {
      setSaving(false);
    }
  }

  async function toggleRecurring(rule: V2RecurringRule) {
    setSaving(true);
    try {
      await api(`/api/app/v2/recurring/${rule.id}/toggle`, { active: !rule.active });
      await loadRecurring();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "週期規則更新失敗");
    } finally {
      setSaving(false);
    }
  }

  async function saveDefaultShares(event: React.FormEvent) {
    event.preventDefault();
    if (!activeLedgerId || !bootstrap) return;
    const first = bootstrap.ledger.members[0]?.userId;
    const second = bootstrap.ledger.members[1]?.userId;
    if (!first || !second || !defaultWeights.every((value) => /^[1-9][0-9]*$/.test(value))) {
      setDefaultShareMessage("預設分攤權重必須是正整數");
      return;
    }
    setSavingDefaults(true);
    setDefaultShareMessage("");
    try {
      await api(`/api/app/v2/ledgers/${activeLedgerId}/default-shares`, {
        shares: [
          { userId: first, weight: defaultWeights[0] },
          { userId: second, weight: defaultWeights[1] },
        ],
      });
      setDefaultShareMessage("已更新；之後未指定分攤的交易會套用這個 Ledger 設定。");
      await reload();
    } catch (reason) {
      setDefaultShareMessage(reason instanceof Error ? reason.message : "預設分攤更新失敗");
    } finally {
      setSavingDefaults(false);
    }
  }

  async function exportHistory() {
    if (!activeLedgerId) return;
    const params = new URLSearchParams();
    if (historyType !== "all") params.set("type", historyType);
    if (historyPayer !== "all") params.set("payerUserId", historyPayer);
    if (historyQuery.trim()) params.set("q", historyQuery.trim());
    if (historyFrom) params.set("from", historyFrom);
    if (historyTo) params.set("to", historyTo);
    setExporting(true);
    try {
      const response = await fetch(`/api/app/v2/ledgers/${activeLedgerId}/export?${params.toString()}`, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error("匯出失敗");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${bootstrap?.ledger.name ?? "ledger"}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "匯出失敗");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-3 pt-1">
      <div className="flex items-center justify-between gap-2">
        <V2LedgerSwitcher ledgers={ledgers} activeLedgerId={activeLedgerId} onChange={setActiveLedgerId} onCreate={() => setShowCreate(true)} />
        <Button variant="ghost" size="icon-sm" aria-label="重新載入 Ledger" onClick={() => void reload()}><RefreshCw className="size-4" /></Button>
      </div>
      {proposalId && proposalStatus ? <Card className="border-accent/30 bg-accent-soft p-4"><p className="font-semibold">LINE 待確認草稿</p><p className="mt-1 text-sm text-[var(--muted-foreground)]">狀態：{proposalStatus === "proposed" ? "待確認" : proposalStatus === "confirmed" ? "已入帳" : proposalStatus === "cancelled" ? "已取消" : proposalStatus}</p>{proposalStatus === "proposed" ? <div className="mt-3 flex gap-2"><Button variant="primary" size="sm" onClick={() => void confirmProposal()} disabled={saving}>確認入帳</Button><Button variant="ghost" size="sm" onClick={() => void cancelProposal()} disabled={saving}>取消</Button></div> : null}</Card> : null}
      {showCreate ? <CreateLedgerCard name={newLedgerName} onName={setNewLedgerName} onCancel={() => setShowCreate(false)} onSave={async () => { if (!newLedgerName.trim()) return; await createLedger(newLedgerName.trim()); setNewLedgerName(""); setShowCreate(false); }} /> : null}

      <Card className="overflow-hidden p-5 text-white" style={{ background: `linear-gradient(140deg, ${bootstrap.ledger.color}, #0c2240)` }}>
        <p className="text-[13px] font-semibold text-white/75">{bootstrap.ledger.name}</p>
        <h2 className="mt-1 text-[28px] font-extrabold tracking-tight">
          {selfBalance === 0 ? "目前已結清" : selfBalance > 0 ? `另一半欠你 ${moneyAbs(selfBalance)}` : `你欠另一半 ${moneyAbs(selfBalance)}`}
        </h2>
        <p className="mt-1 text-[13px] text-white/70">餘額由 Ledger server 計算，未把其他 Ledger 抵銷。</p>
        {nextPayer ? <>
          <p className="mt-3 text-xs text-white/75">建議由 {nextPayerUser?.label ?? "欠款方"} 付款給 {nextPayerPayee?.label ?? "收款方"} {money(Number(nextPayer.amountTwd))}；這只會結清本 Ledger。</p>
          <Button variant="secondary" size="block" className="mt-3 h-11 bg-white text-primary" onClick={() => void settleAll()} disabled={saving}><CheckCircle2 className="size-4" /> 全部結清</Button>
        </> : null}
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2"><Plus className="size-4 text-accent" /><h2 className="font-bold">快速記一筆</h2></div>
        <form className="space-y-3" onSubmit={(event) => void submitTransaction(event)}>
          <div className="grid grid-cols-[1fr_1.7fr] gap-2">
            <Input inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="金額 TWD" aria-label="金額 TWD" />
            <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="說明" aria-label="說明" />
          </div>
          <details className="rounded-xl border border-[var(--border)] px-3 py-2">
            <summary className="cursor-pointer text-sm font-semibold">進階：日期、分類、備註</summary>
            <div className="mt-3 space-y-2">
              <Input type="date" value={occurredOn} onChange={(event) => setOccurredOn(event.target.value)} aria-label="交易日期" />
              <Input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="分類（可選）" aria-label="分類" maxLength={40} />
              <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="備註（可選）" aria-label="備註" maxLength={1000} className="min-h-20 w-full rounded-xl border-[1.5px] border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-[var(--accent-glow)]" />
            </div>
          </details>
          <Select ariaLabel="交易類型" value={transactionType} onValueChange={(value) => { const next = value as TransactionType; setTransactionType(next); if (next === "transfer" && paymentMode === "both") setPaymentMode("self"); }} options={[{ value: "expense", label: "支出" }, { value: "income", label: "收入／退款" }, { value: "transfer", label: "轉帳／結清" }]} />
          <Select ariaLabel={transactionType === "income" ? "收款人" : "付款人"} value={paymentMode} onValueChange={(value) => setPaymentMode(value as PaymentMode)} options={[{ value: "self", label: transactionType === "income" ? `${user.label} 收到` : `${user.label} ${transactionType === "transfer" ? "轉出" : "付款"}` }, { value: "partner", label: transactionType === "income" ? `${partner.label} 收到` : `${partner.label} ${transactionType === "transfer" ? "轉出" : "付款"}` }, ...(transactionType === "transfer" ? [] : [{ value: "both", label: transactionType === "income" ? "兩人共同收到" : "兩人共同付款" }])]} />
          {paymentMode === "both" ? <div className="grid grid-cols-2 gap-2"><Input inputMode="numeric" value={selfPayment} onChange={(event) => setSelfPayment(event.target.value)} placeholder={`${user.label} 付`} aria-label={`${user.label} 付款`} /><Input inputMode="numeric" value={partnerPayment} onChange={(event) => setPartnerPayment(event.target.value)} placeholder={`${partner.label} 付`} aria-label={`${partner.label} 付款`} /></div> : null}
          {transactionType === "transfer" ? <p className="text-xs text-[var(--muted-foreground)]">轉帳會直接抵銷這個 Ledger 的目前餘額，不會和其他 Ledger 互相抵銷。</p> : <><Select ariaLabel="分攤方式" value={splitMode} onValueChange={(value) => setSplitMode(value as SplitMode)} options={[{ value: "weights", label: "套用本 Ledger 預設" }, { value: "exact", label: "指定分攤金額" }]} />
          {splitMode === "exact" ? <div className="grid grid-cols-2 gap-2"><Input inputMode="numeric" value={selfShare} onChange={(event) => setSelfShare(event.target.value)} placeholder={`${user.label} 分攤`} aria-label={`${user.label} 分攤`} /><Input inputMode="numeric" value={partnerShare} onChange={(event) => setPartnerShare(event.target.value)} placeholder={`${partner.label} 分攤`} aria-label={`${partner.label} 分攤`} /></div> : <p className="text-xs text-[var(--muted-foreground)]">奇數 TWD 的餘數固定給第一位成員，server 會保存實際 shares。</p>}</>}
          {formError ? <p className="text-sm font-medium text-destructive">{formError}</p> : null}
          <Button type="submit" variant="primary" size="block" disabled={saving || busy}>儲存{transactionType === "expense" ? "支出" : transactionType === "income" ? "收入" : "轉帳"}</Button>
        </form>
      </Card>

      <Card className="p-4">
        <div className="mb-2 flex items-center gap-2"><Paperclip className="size-4 text-accent" /><h2 className="font-bold">收據附件</h2></div>
        <p className="text-sm text-[var(--muted-foreground)]">交易附件 API 已就緒；可在交易詳情綁定圖片或 PDF。V2 先保存檔案與權限，不自動把 OCR 當成入帳。</p>
      </Card>

      <Card className="p-4">
        <h2 className="mb-2 font-bold">Ledger 統計</h2>
        {statistics ? <div className="grid grid-cols-2 gap-2 text-sm"><p>支出 <strong>{money(Number(statistics.byType.expense ?? "0"))}</strong></p><p>收入 <strong>{money(Number(statistics.byType.income ?? "0"))}</strong></p><p>你支付 <strong>{money(Number(statistics.paidBy[user.id] ?? "0"))}</strong></p><p>你分攤 <strong>{money(Number(statistics.borneBy[user.id] ?? "0"))}</strong></p></div> : <p className="text-sm text-[var(--muted-foreground)]">統計載入中…</p>}
      </Card>

      <Card className="p-4">
        <h2 className="mb-1 font-bold">這本 Ledger 的預設分攤</h2>
        <p className="mb-3 text-xs text-[var(--muted-foreground)]">新 Ledger 預設 50/50；這裡只設定本 Ledger，不會影響其他 Ledger。</p>
        <form className="space-y-2" onSubmit={(event) => void saveDefaultShares(event)}>
          <div className="grid grid-cols-2 gap-2">
            <Input inputMode="numeric" value={defaultWeights[0]} onChange={(event) => setDefaultWeights((current) => [event.target.value, current[1]])} aria-label={`${users[0]?.label ?? "成員一"} 預設權重`} placeholder={`${users[0]?.label ?? "成員一"} 權重`} />
            <Input inputMode="numeric" value={defaultWeights[1]} onChange={(event) => setDefaultWeights((current) => [current[0], event.target.value])} aria-label={`${users[1]?.label ?? "成員二"} 預設權重`} placeholder={`${users[1]?.label ?? "成員二"} 權重`} />
          </div>
          <Button type="submit" variant="outline" size="block" disabled={savingDefaults}>{savingDefaults ? "儲存中…" : "儲存預設分攤"}</Button>
          {defaultShareMessage ? <p className="text-xs text-[var(--muted-foreground)]">{defaultShareMessage}</p> : null}
        </form>
      </Card>

      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2"><CalendarClock className="size-4 text-accent" /><h2 className="font-bold">週期交易</h2></div>
          <Button variant="ghost" size="sm" onClick={() => setShowRecurring((current) => !current)}>{showRecurring ? "收起" : "新增"}</Button>
        </div>
        {showRecurring ? <form className="mb-3 space-y-2" onSubmit={(event) => void saveRecurring(event)}>
          <Input value={recurringName} onChange={(event) => setRecurringName(event.target.value)} placeholder="例如：房租" aria-label="週期交易名稱" />
          <div className="grid grid-cols-2 gap-2"><Input inputMode="numeric" value={recurringAmount} onChange={(event) => setRecurringAmount(event.target.value)} placeholder="金額 TWD" aria-label="週期交易金額" /><Select ariaLabel="週期" value={recurringFrequency} onValueChange={(value) => setRecurringFrequency(value as typeof recurringFrequency)} options={[{ value: "weekly", label: "每週" }, { value: "monthly", label: "每月" }, { value: "yearly", label: "每年" }]} /></div>
          <Button type="submit" variant="primary" size="block" disabled={saving}>儲存週期規則</Button>
        </form> : null}
        {recurring.length ? <div className="divide-y divide-[var(--border)]">{recurring.map((rule) => <div key={rule.id} className="flex items-center gap-2 py-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{rule.name} · {money(Number(rule.amountTwd))}</p><p className="text-xs text-[var(--muted-foreground)]">{rule.frequency === "weekly" ? "每週" : rule.frequency === "monthly" ? "每月" : "每年"} · 下次 {rule.nextRunDate}</p></div><Button variant="ghost" size="sm" onClick={() => void toggleRecurring(rule)} disabled={saving}>{rule.active ? "停用" : "啟用"}</Button></div>)}</div> : <p className="text-sm text-[var(--muted-foreground)]">尚未設定週期交易</p>}
      </Card>

      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between gap-2"><h2 className="font-bold">Ledger 流水</h2><div className="flex items-center gap-2"><span className="text-xs text-[var(--muted-foreground)]">{historyRows.length} 筆</span><Button variant="ghost" size="sm" onClick={() => void exportHistory()} disabled={exporting}><Download className="size-3.5" />{exporting ? "匯出中" : "CSV"}</Button></div></div>
        <div className="mb-3 grid grid-cols-2 gap-2">
          <Input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="搜尋說明／分類／備註" aria-label="搜尋 Ledger 流水" />
          <Select ariaLabel="流水類型" value={historyType} onValueChange={(value) => setHistoryType(value as typeof historyType)} options={[{ value: "all", label: "全部類型" }, { value: "expense", label: "支出" }, { value: "income", label: "收入" }, { value: "transfer", label: "轉帳" }]} />
          <Select ariaLabel="付款人" value={historyPayer} onValueChange={setHistoryPayer} options={[{ value: "all", label: "全部付款人" }, ...users.map((candidate) => ({ value: candidate.id, label: `${candidate.label} 付款` }))]} />
          <Input type="date" value={historyFrom} onChange={(event) => setHistoryFrom(event.target.value)} aria-label="流水起始日期" />
          <Input type="date" value={historyTo} onChange={(event) => setHistoryTo(event.target.value)} aria-label="流水結束日期" />
        </div>
        <div className="divide-y divide-[var(--border)]">
          {historyRows.map((transaction) => <TransactionRow key={`${transaction.id}:${transaction.version ?? 1}`} transaction={transaction} users={users} onChanged={async () => { await reload(); await loadHistory(); }} />)}
          {!historyRows.length ? <p className="py-8 text-center text-sm text-[var(--muted-foreground)]">尚無符合條件的流水</p> : null}
        </div>
      </Card>
    </div>
  );
}

function CreateLedgerCard({ name, onName, onCancel, onSave }: { name: string; onName: (value: string) => void; onCancel: () => void; onSave: () => Promise<void> }) {
  return <Card className="space-y-2 p-4"><p className="font-bold">建立新的 Ledger</p><Input value={name} onChange={(event) => onName(event.target.value)} placeholder="例如：上海旅行" maxLength={40} /><div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={onCancel}>取消</Button><Button variant="primary" size="sm" onClick={() => void onSave()}>建立</Button></div></Card>;
}

function TransactionRow({ transaction, users, onChanged }: { transaction: V2LedgerBootstrap["transactions"][number]; users: User[]; onChanged: () => Promise<unknown> }) {
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [uploading, setUploading] = React.useState(false);
  const [attachments, setAttachments] = React.useState<V2Attachment[]>([]);
  const [attachmentsLoaded, setAttachmentsLoaded] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [editAmount, setEditAmount] = React.useState(transaction.amountTwd);
  const [editDescription, setEditDescription] = React.useState(transaction.description ?? "");
  const [editOccurredOn, setEditOccurredOn] = React.useState(transaction.occurredOn ?? "");
  const [editCategory, setEditCategory] = React.useState(transaction.category ?? "");
  const [editNote, setEditNote] = React.useState(transaction.note ?? "");
  const payments = transaction.payments.map((payment) => `${users.find((user) => user.id === payment.userId)?.label ?? "成員"} ${money(Number(payment.amountTwd))}`).join("、");
  const shares = transaction.shares.map((share) => `${users.find((user) => user.id === share.userId)?.label ?? "成員"} ${money(Number(share.amountTwd))}`).join("、");
  const typeLabel = transaction.type === "income" ? "收入" : transaction.type === "transfer" ? "轉帳" : "支出";
  const loadAttachments = React.useCallback(async () => {
    try {
      const result = await fetch(`/api/app/v2/transactions/${transaction.id}/attachments`, { cache: "no-store", credentials: "same-origin" });
      const body = await result.json() as { attachments?: V2Attachment[]; error?: string };
      if (!result.ok) throw new Error(body.error ?? "無法讀取收據");
      setAttachments(body.attachments ?? []);
      setAttachmentsLoaded(true);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "無法讀取收據");
    }
  }, [transaction.id]);
  async function mutate(action: "void" | "restore") {
    setBusy(true);
    setMessage("");
    try {
      await api(`/api/app/v2/transactions/${transaction.id}/mutate`, {
        action,
        expectedVersion: transaction.version ?? 1,
        idempotencyKey: `v2:transaction:${transaction.id}:${action}:${transaction.version ?? 1}`,
      });
      await onChanged();
      setMessage(action === "void" ? "已作廢" : "已恢復");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "更新失敗");
    } finally {
      setBusy(false);
    }
  }
  async function replaceTransaction(event: React.FormEvent) {
    event.preventDefault();
    const amount = Number(editAmount);
    if (!Number.isSafeInteger(amount) || amount <= 0 || !editDescription.trim() || !editOccurredOn) {
      setMessage("請輸入正確的 TWD 整數金額、日期與說明");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const replacementAmount = String(amount);
      const replacementPayments = rescaleParticipants(transaction.payments, replacementAmount, false);
      const replacementShares = rescaleParticipants(transaction.shares, replacementAmount, true);
      await api(`/api/app/v2/transactions/${transaction.id}/mutate`, {
        action: "replace",
        expectedVersion: transaction.version ?? 1,
        idempotencyKey: `v2:transaction:${transaction.id}:replace:${transaction.version ?? 1}`,
        replacement: {
          type: transaction.type,
          amountTwd: String(amount),
          occurredOn: editOccurredOn,
          description: editDescription.trim(),
          category: editCategory.trim() || null,
          note: editNote.trim() || null,
          splitMethod: transaction.splitMethod ?? "weights",
          payments: replacementPayments,
          shares: replacementShares,
        },
      });
      setEditing(false);
      await onChanged();
      setMessage("已更新；原交易保留作廢紀錄");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "更新失敗");
    } finally {
      setBusy(false);
    }
  }
  async function uploadReceipt(file: File) {
    if (!file || file.size > 10 * 1024 * 1024) {
      setMessage("收據必須小於 10 MB");
      return;
    }
    setUploading(true);
    setMessage("");
    try {
      const result = await api("/api/app/v2/attachments", {
        ledgerId: transaction.ledgerId,
        transactionId: transaction.id,
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      }) as unknown as { attachment: { id: string }; signedUpload: { signedUrl: string } };
      const response = await fetch(result.signedUpload.signedUrl, { method: "PUT", headers: { "content-type": file.type }, body: file });
      if (!response.ok) throw new Error("收據上傳失敗");
      await api(`/api/app/v2/attachments/${(result.attachment as { id: string }).id}/complete`, {});
      await loadAttachments();
      setMessage("收據已上傳");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "收據上傳失敗");
    } finally {
      setUploading(false);
    }
  }
  return <details className="group py-3" onToggle={(event) => { if (event.currentTarget.open && !attachmentsLoaded) void loadAttachments(); }}><summary className="flex cursor-pointer list-none items-start gap-3"><div className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent"><ArrowLeftRight className="size-4" /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{transaction.description ?? typeLabel}</p><p className="mt-0.5 text-xs text-[var(--muted-foreground)]">{transaction.occurredOn} · {typeLabel} · {payments || "付款資訊"}</p></div><p className="text-sm font-bold tabular-nums">{money(Number(transaction.amountTwd))}</p></summary><div className="ml-12 mt-2 space-y-2 text-xs text-[var(--muted-foreground)]"><p>付款：{payments || "—"}</p><p>分攤：{shares || "—"}</p><div className="flex flex-wrap items-center gap-2"><Button variant="ghost" size="sm" disabled={busy || transaction.status === "voided"} onClick={() => setEditing((current) => !current)}>{editing ? "收起編輯" : "編輯"}</Button><Button variant="ghost" size="sm" disabled={busy || transaction.status === "voided"} onClick={() => void mutate("void")}>作廢</Button>{transaction.status === "voided" ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void mutate("restore")}>恢復</Button> : null}<label className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold hover:bg-accent-soft"><Paperclip className="size-3" />{uploading ? "上傳中…" : "加收據"}<input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadReceipt(file); event.currentTarget.value = ""; }} /></label></div>{editing ? <form className="space-y-2 rounded-xl border border-[var(--border)] p-3" onSubmit={(event) => void replaceTransaction(event)}><div className="grid grid-cols-2 gap-2"><Input inputMode="numeric" value={editAmount} onChange={(event) => setEditAmount(event.target.value)} aria-label="編輯金額 TWD" /><Input type="date" value={editOccurredOn} onChange={(event) => setEditOccurredOn(event.target.value)} aria-label="編輯交易日期" /></div><Input value={editDescription} onChange={(event) => setEditDescription(event.target.value)} aria-label="編輯說明" /><Input value={editCategory} onChange={(event) => setEditCategory(event.target.value)} placeholder="分類（可選）" aria-label="編輯分類" /><textarea value={editNote} onChange={(event) => setEditNote(event.target.value)} placeholder="備註（可選）" aria-label="編輯備註" className="min-h-16 w-full rounded-xl border-[1.5px] border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm" /><p className="text-[11px] text-[var(--muted-foreground)]">編輯會保留原交易並建立一筆替代交易；付款人與分攤沿用原設定。</p><Button type="submit" variant="primary" size="sm" disabled={busy}>儲存修改</Button></form> : null}{attachmentsLoaded && !attachments.length ? <p>尚無收據</p> : null}{attachments.length ? <div className="space-y-1"><p className="font-semibold">收據</p>{attachments.map((attachment) => <a key={attachment.id} href={attachment.url ?? undefined} target="_blank" rel="noreferrer" className="block truncate text-accent underline">{attachment.mimeType === "application/pdf" ? "PDF 收據" : "圖片收據"} · {new Date(attachment.createdAt).toLocaleString("zh-TW")}</a>)}</div> : null}{message ? <p>{message}</p> : null}</div></details>;
}

function rescaleParticipants(
  participants: Array<{ userId: string; amountTwd: string }>,
  nextTotal: string,
  allowZero: boolean,
) {
  const total = BigInt(nextTotal);
  const previousTotal = participants.reduce((sum, participant) => sum + BigInt(participant.amountTwd), 0n);
  if (previousTotal <= 0n || total <= 0n) return participants;
  const rows = participants.map((participant, index) => {
    const numerator = total * BigInt(participant.amountTwd);
    return { ...participant, index, value: numerator / previousTotal, remainder: numerator % previousTotal };
  });
  let remainder = total - rows.reduce((sum, row) => sum + row.value, 0n);
  for (const row of [...rows].sort((left, right) => right.remainder > left.remainder ? 1 : right.remainder < left.remainder ? -1 : left.index - right.index)) {
    if (remainder <= 0n) break;
    row.value += 1n;
    remainder -= 1n;
  }
  return rows
    .filter((row) => allowZero || row.value > 0n)
    .map((row) => ({ userId: row.userId, amountTwd: row.value.toString() }));
}
