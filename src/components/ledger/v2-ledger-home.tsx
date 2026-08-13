"use client";

import * as React from "react";
import { ArrowLeftRight, CalendarClock, CheckCircle2, Download, Paperclip, Plus, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { V2LedgerSwitcher } from "./v2-ledger-switcher";
import { V2TransactionEditor, type TransactionEditorValue } from "./v2-transaction-editor";
import { api } from "@/lib/api";
import { money, moneyAbs } from "@/lib/format";
import type { User, V2Attachment, V2Category, V2LedgerBootstrap, V2LedgerSummary, V2RecurringRule } from "@/lib/types";

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
  ledgerIdFromUrl?: string | null;
  transactionIdFromUrl?: string | null;
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
  ledgerIdFromUrl = null,
  transactionIdFromUrl = null,
}: V2LedgerHomeProps) {
  const partner = users.find((candidate) => candidate.id !== user.id) ?? users[1];
  const [showCreate, setShowCreate] = React.useState(false);
  const [newLedgerName, setNewLedgerName] = React.useState("");
  const [formError, setFormError] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [recurring, setRecurring] = React.useState<V2RecurringRule[]>([]);
  const [categories, setCategories] = React.useState<V2Category[]>([]);
  const [categoryDrafts, setCategoryDrafts] = React.useState<Record<string, string>>({});
  const [newCategoryName, setNewCategoryName] = React.useState("");
  const [categoryMessage, setCategoryMessage] = React.useState("");
  const [showRecurring, setShowRecurring] = React.useState(false);
  const [recurringName, setRecurringName] = React.useState("");
  const [recurringAmount, setRecurringAmount] = React.useState("");
  const [recurringFrequency, setRecurringFrequency] = React.useState<"weekly" | "monthly" | "yearly">("monthly");
  const [recurringPaymentMode, setRecurringPaymentMode] = React.useState<"self" | "partner" | "both">("self");
  const [recurringSelfPayment, setRecurringSelfPayment] = React.useState("");
  const [recurringPartnerPayment, setRecurringPartnerPayment] = React.useState("");
  const [recurringSplitMethod, setRecurringSplitMethod] = React.useState<"equal" | "weights" | "percentage" | "exact">("weights");
  const [recurringSelfPercentage, setRecurringSelfPercentage] = React.useState("50");
  const [recurringPartnerPercentage, setRecurringPartnerPercentage] = React.useState("50");
  const [recurringSelfShare, setRecurringSelfShare] = React.useState("");
  const [recurringPartnerShare, setRecurringPartnerShare] = React.useState("");
  const [recurringCategoryId, setRecurringCategoryId] = React.useState("");
  const [statistics, setStatistics] = React.useState<{ byType: Record<string, string>; byCategory: Record<string, string>; paidBy: Record<string, string>; borneBy: Record<string, string> } | null>(null);
  const [historyType, setHistoryType] = React.useState<"all" | "expense" | "income" | "transfer">("all");
  const [historyPayer, setHistoryPayer] = React.useState("all");
  const [historyCategoryId, setHistoryCategoryId] = React.useState("all");
  const [historyQuery, setHistoryQuery] = React.useState("");
  const [historyFrom, setHistoryFrom] = React.useState("");
  const [historyTo, setHistoryTo] = React.useState("");
  const [historyRows, setHistoryRows] = React.useState<V2LedgerBootstrap["transactions"]>([]);
  const [historyCursor, setHistoryCursor] = React.useState<string | null>(null);
  const [historyLoadingMore, setHistoryLoadingMore] = React.useState(false);
  const proposalId = proposalIdFromUrl;
  const [proposalStatus, setProposalStatus] = React.useState<string | null>(null);
  const [defaultWeights, setDefaultWeights] = React.useState<[string, string]>(["1", "1"]);
  const [defaultShareMessage, setDefaultShareMessage] = React.useState("");
  const [savingDefaults, setSavingDefaults] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [secondaryTab, setSecondaryTab] = React.useState<"history" | "stats" | "recurring" | "settings">("history");

  React.useEffect(() => {
    if (ledgerIdFromUrl && ledgers.some((ledger) => ledger.id === ledgerIdFromUrl) && activeLedgerId !== ledgerIdFromUrl) {
      setActiveLedgerId(ledgerIdFromUrl);
    }
  }, [activeLedgerId, ledgerIdFromUrl, ledgers, setActiveLedgerId]);

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

  const loadCategories = React.useCallback(async () => {
    if (!activeLedgerId) return;
    const response = await fetch(`/api/app/v2/ledgers/${activeLedgerId}/categories`, { cache: "no-store", credentials: "same-origin" });
    const body = await response.json() as { categories?: V2Category[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "無法讀取分類");
    setCategories(body.categories ?? []);
    setCategoryDrafts(Object.fromEntries((body.categories ?? []).map((category) => [category.id, category.name])));
  }, [activeLedgerId]);

  React.useEffect(() => {
    if (!bootstrap) return;
    const timer = window.setTimeout(() => { void loadCategories().catch(() => undefined); }, 0);
    return () => window.clearTimeout(timer);
  }, [bootstrap, loadCategories]);

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

  const loadHistory = React.useCallback(async (cursor: string | null = null, append = false) => {
    if (!activeLedgerId) return;
    const params = new URLSearchParams();
    if (historyType !== "all") params.set("type", historyType);
    if (historyPayer !== "all") params.set("payerUserId", historyPayer);
    if (historyCategoryId !== "all") params.set("categoryId", historyCategoryId);
    if (historyQuery.trim()) params.set("q", historyQuery.trim());
    if (historyFrom) params.set("from", historyFrom);
    if (historyTo) params.set("to", historyTo);
    if (cursor) params.set("cursor", cursor);
    params.set("limit", "50");
    if (append) setHistoryLoadingMore(true);
    const response = await fetch(`/api/app/v2/ledgers/${activeLedgerId}/transactions?${params.toString()}`, { cache: "no-store", credentials: "same-origin" });
    try {
      const body = await response.json() as { transactions?: V2LedgerBootstrap["transactions"]; nextCursor?: string | null; error?: string };
      if (!response.ok) throw new Error(body.error ?? "無法讀取流水");
      setHistoryRows((current) => append ? [...current, ...(body.transactions ?? [])] : (body.transactions ?? []));
      setHistoryCursor(body.nextCursor ?? null);
    } finally {
      if (append) setHistoryLoadingMore(false);
    }
  }, [activeLedgerId, historyCategoryId, historyFrom, historyPayer, historyQuery, historyTo, historyType]);

  React.useEffect(() => {
    if (!bootstrap) return;
    const timer = window.setTimeout(() => { void loadHistory().catch(() => undefined); }, 0);
    return () => window.clearTimeout(timer);
  }, [bootstrap, loadHistory]);

  async function loadMoreHistory() {
    if (!historyCursor || historyLoadingMore) return;
    await loadHistory(historyCursor, true);
  }

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
  async function submitEditorTransaction(value: TransactionEditorValue) {
    if (!activeLedgerId) return;
    setSaving(true);
    setFormError("");
    try {
      await api(`/api/app/v2/ledgers/${activeLedgerId}/transactions`, value);
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
    const paymentTotal = recurringPaymentMode === "both"
      ? Number(recurringSelfPayment || 0) + Number(recurringPartnerPayment || 0)
      : amountValue;
    if (!Number.isSafeInteger(paymentTotal) || paymentTotal !== amountValue) {
      setFormError("週期付款合計必須等於總額");
      return;
    }
    const percentages = [Number(recurringSelfPercentage), Number(recurringPartnerPercentage)] as [number, number];
    const exactTotal = Number(recurringSelfShare || 0) + Number(recurringPartnerShare || 0);
    if (recurringSplitMethod === "percentage" && percentages[0] + percentages[1] !== 100) {
      setFormError("週期百分比分攤合計必須等於 100%");
      return;
    }
    if (recurringSplitMethod === "exact" && exactTotal !== amountValue) {
      setFormError("週期指定分攤合計必須等於總額");
      return;
    }
    const payerId = recurringPaymentMode === "partner" ? partner.id : user.id;
    const payments = recurringPaymentMode === "both"
      ? [{ userId: user.id, amountTwd: String(Number(recurringSelfPayment || 0)) }, { userId: partner.id, amountTwd: String(Number(recurringPartnerPayment || 0)) }].filter((payment) => Number(payment.amountTwd) > 0)
      : [{ userId: payerId, amountTwd: String(amountValue) }];
    setSaving(true);
    try {
      await api(`/api/app/v2/ledgers/${activeLedgerId}/recurring`, {
        name: recurringName.trim(),
        amountTwd: String(amountValue),
        frequency: recurringFrequency,
        nextRunDate: today,
        splitMethod: recurringSplitMethod,
        payments,
        ...(recurringSplitMethod === "exact" ? { shares: [{ userId: user.id, amountTwd: String(Number(recurringSelfShare || 0)) }, { userId: partner.id, amountTwd: String(Number(recurringPartnerShare || 0)) }] } : {}),
        ...(recurringSplitMethod === "percentage" ? { percentages } : {}),
        categoryId: recurringCategoryId || null,
      });
      setRecurringName("");
      setRecurringAmount("");
      setRecurringSelfPayment("");
      setRecurringPartnerPayment("");
      setRecurringSelfShare("");
      setRecurringPartnerShare("");
      setRecurringCategoryId("");
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

  async function createCategory(event: React.FormEvent) {
    event.preventDefault();
    if (!activeLedgerId || !newCategoryName.trim()) return;
    setSaving(true);
    setCategoryMessage("");
    try {
      await api(`/api/app/v2/ledgers/${activeLedgerId}/categories`, { name: newCategoryName.trim() });
      setNewCategoryName("");
      await loadCategories();
      setCategoryMessage("已新增分類");
    } catch (reason) {
      setCategoryMessage(reason instanceof Error ? reason.message : "分類新增失敗");
    } finally {
      setSaving(false);
    }
  }

  async function updateCategory(category: V2Category, status?: "active" | "archived") {
    const name = categoryDrafts[category.id]?.trim();
    if (!name || !activeLedgerId) return;
    setSaving(true);
    setCategoryMessage("");
    try {
      await api(`/api/app/v2/categories/${category.id}`, { name, ...(status ? { status } : {}) });
      await loadCategories();
      setCategoryMessage(status === "archived" ? "分類已封存" : "分類已更新");
    } catch (reason) {
      setCategoryMessage(reason instanceof Error ? reason.message : "分類更新失敗");
    } finally {
      setSaving(false);
    }
  }

  async function exportHistory() {
    if (!activeLedgerId) return;
    const params = new URLSearchParams();
    if (historyType !== "all") params.set("type", historyType);
    if (historyPayer !== "all") params.set("payerUserId", historyPayer);
    if (historyCategoryId !== "all") params.set("categoryId", historyCategoryId);
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

      <div className="grid grid-cols-4 gap-1 rounded-xl bg-[var(--muted)] p-1" role="tablist" aria-label="Ledger 次要功能"><button className={`rounded-lg px-2 py-2 text-xs font-semibold ${secondaryTab === "history" ? "bg-[var(--card)] shadow-sm" : ""}`} onClick={() => setSecondaryTab("history")} role="tab" aria-selected={secondaryTab === "history"}>流水</button><button className={`rounded-lg px-2 py-2 text-xs font-semibold ${secondaryTab === "stats" ? "bg-[var(--card)] shadow-sm" : ""}`} onClick={() => setSecondaryTab("stats")} role="tab" aria-selected={secondaryTab === "stats"}>統計</button><button className={`rounded-lg px-2 py-2 text-xs font-semibold ${secondaryTab === "recurring" ? "bg-[var(--card)] shadow-sm" : ""}`} onClick={() => setSecondaryTab("recurring")} role="tab" aria-selected={secondaryTab === "recurring"}>週期</button><button className={`rounded-lg px-2 py-2 text-xs font-semibold ${secondaryTab === "settings" ? "bg-[var(--card)] shadow-sm" : ""}`} onClick={() => setSecondaryTab("settings")} role="tab" aria-selected={secondaryTab === "settings"}>設定</button></div>

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2"><Plus className="size-4 text-accent" /><h2 className="font-bold">快速記一筆</h2></div>
        <V2TransactionEditor
          user={user}
          partner={partner}
          today={today}
          defaultShares={bootstrap.ledger.defaultShares}
          categoryOptions={categories.filter((category) => category.status === "active").map((category) => ({ id: category.id, name: category.name }))}
          busy={saving || busy}
          submitLabel="儲存交易"
          onSubmit={submitEditorTransaction}
        />
        {formError ? <p className="mt-2 text-sm font-medium text-destructive">{formError}</p> : null}
      </Card>

      {secondaryTab === "stats" ? <Card className="p-4">
        <h2 className="mb-2 font-bold">Ledger 統計</h2>
        {statistics ? <div className="space-y-4 text-sm"><div className="grid grid-cols-2 gap-2"><p>支出 <strong>{money(Number(statistics.byType.expense ?? "0"))}</strong></p><p>收入 <strong>{money(Number(statistics.byType.income ?? "0"))}</strong></p><p>你支付 <strong>{money(Number(statistics.paidBy[user.id] ?? "0"))}</strong></p><p>你分攤 <strong>{money(Number(statistics.borneBy[user.id] ?? "0"))}</strong></p></div><div><p className="mb-1 text-xs font-semibold text-[var(--muted-foreground)]">按分類</p><div className="space-y-1">{Object.entries(statistics.byCategory).length ? Object.entries(statistics.byCategory).map(([name, amount]) => <div key={name} className="flex justify-between gap-3"><span>{name}</span><strong>{money(Number(amount))}</strong></div>) : <p className="text-xs text-[var(--muted-foreground)]">尚無分類統計</p>}</div></div></div> : <p className="text-sm text-[var(--muted-foreground)]">統計載入中…</p>}
      </Card> : null}

      {secondaryTab === "settings" ? <Card className="p-4">
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
        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <h3 className="mb-1 font-bold">Ledger 分類</h3>
          <p className="mb-3 text-xs text-[var(--muted-foreground)]">分類只屬於這本 Ledger；封存不會改寫既有交易的文字快照。</p>
          <form className="mb-3 flex gap-2" onSubmit={(event) => void createCategory(event)}>
            <Input value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} placeholder="新增自訂分類" aria-label="新增自訂分類" maxLength={40} />
            <Button type="submit" variant="outline" size="sm" disabled={saving}>新增</Button>
          </form>
          <div className="space-y-2">
            {categories.map((category) => <div key={category.id} className={`flex items-center gap-2 ${category.status === "archived" ? "opacity-55" : ""}`}>
              <Input value={categoryDrafts[category.id] ?? category.name} onChange={(event) => setCategoryDrafts((current) => ({ ...current, [category.id]: event.target.value }))} aria-label={`${category.name} 分類名稱`} disabled={saving} />
              <Button variant="ghost" size="sm" onClick={() => void updateCategory(category)} disabled={saving}>改名</Button>
              {category.status === "active" ? <Button variant="ghost" size="sm" onClick={() => void updateCategory(category, "archived")} disabled={saving}>封存</Button> : null}
            </div>)}
          </div>
          {categoryMessage ? <p className="mt-2 text-xs text-[var(--muted-foreground)]">{categoryMessage}</p> : null}
        </div>
      </Card> : null}

      {secondaryTab === "recurring" ? <Card className="p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2"><CalendarClock className="size-4 text-accent" /><h2 className="font-bold">週期交易</h2></div>
          <Button variant="ghost" size="sm" onClick={() => setShowRecurring((current) => !current)}>{showRecurring ? "收起" : "新增"}</Button>
        </div>
        {showRecurring ? <form className="mb-3 space-y-2" onSubmit={(event) => void saveRecurring(event)}>
          <Input value={recurringName} onChange={(event) => setRecurringName(event.target.value)} placeholder="例如：房租" aria-label="週期交易名稱" />
          <div className="grid grid-cols-2 gap-2"><Input inputMode="numeric" value={recurringAmount} onChange={(event) => setRecurringAmount(event.target.value)} placeholder="金額 TWD" aria-label="週期交易金額" /><Select ariaLabel="週期" value={recurringFrequency} onValueChange={(value) => setRecurringFrequency(value as typeof recurringFrequency)} options={[{ value: "weekly", label: "每週" }, { value: "monthly", label: "每月" }, { value: "yearly", label: "每年" }]} /></div>
          <Select ariaLabel="週期付款人" value={recurringPaymentMode} onValueChange={(value) => setRecurringPaymentMode(value as typeof recurringPaymentMode)} options={[{ value: "self", label: `${user.label} 付款` }, { value: "partner", label: `${partner.label} 付款` }, { value: "both", label: "兩人共同付款" }]} />
          {recurringPaymentMode === "both" ? <div className="grid grid-cols-2 gap-2"><Input inputMode="numeric" value={recurringSelfPayment} onChange={(event) => setRecurringSelfPayment(event.target.value)} placeholder={`${user.label} 付款`} aria-label={`${user.label} 週期付款`} /><Input inputMode="numeric" value={recurringPartnerPayment} onChange={(event) => setRecurringPartnerPayment(event.target.value)} placeholder={`${partner.label} 付款`} aria-label={`${partner.label} 週期付款`} /></div> : null}
          <Select ariaLabel="週期分攤方式" value={recurringSplitMethod} onValueChange={(value) => setRecurringSplitMethod(value as typeof recurringSplitMethod)} options={[{ value: "equal", label: "平均分 50 / 50" }, { value: "weights", label: `套用 Ledger 預設（${bootstrap.ledger.defaultShares[user.id] ?? "1"} / ${bootstrap.ledger.defaultShares[partner.id] ?? "1"}）` }, { value: "percentage", label: "百分比" }, { value: "exact", label: "指定分攤金額" }]} />
          {recurringSplitMethod === "percentage" ? <div className="grid grid-cols-2 gap-2"><Input inputMode="decimal" value={recurringSelfPercentage} onChange={(event) => setRecurringSelfPercentage(event.target.value)} placeholder={`${user.label} %`} aria-label={`${user.label} 週期百分比`} /><Input inputMode="decimal" value={recurringPartnerPercentage} onChange={(event) => setRecurringPartnerPercentage(event.target.value)} placeholder={`${partner.label} %`} aria-label={`${partner.label} 週期百分比`} /></div> : null}
          {recurringSplitMethod === "exact" ? <div className="grid grid-cols-2 gap-2"><Input inputMode="numeric" value={recurringSelfShare} onChange={(event) => setRecurringSelfShare(event.target.value)} placeholder={`${user.label} 分攤`} aria-label={`${user.label} 週期分攤`} /><Input inputMode="numeric" value={recurringPartnerShare} onChange={(event) => setRecurringPartnerShare(event.target.value)} placeholder={`${partner.label} 分攤`} aria-label={`${partner.label} 週期分攤`} /></div> : null}
          <Select ariaLabel="週期分類" value={recurringCategoryId} onValueChange={setRecurringCategoryId} options={[{ value: "", label: "未分類" }, ...categories.filter((category) => category.status === "active").map((category) => ({ value: category.id, label: category.name }))]} />
          <Button type="submit" variant="primary" size="block" disabled={saving}>儲存週期規則</Button>
        </form> : null}
          {recurring.length ? <div className="divide-y divide-[var(--border)]">{recurring.map((rule) => <div key={rule.id} className="flex items-center gap-2 py-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{rule.name} · {money(Number(rule.amountTwd))}</p><p className="text-xs text-[var(--muted-foreground)]">{rule.frequency === "weekly" ? "每週" : rule.frequency === "monthly" ? "每月" : "每年"} · {rule.splitMethod} · 下次 {rule.nextRunDate}</p></div><Button variant="ghost" size="sm" onClick={() => void toggleRecurring(rule)} disabled={saving}>{rule.active ? "停用" : "啟用"}</Button></div>)}</div> : <p className="text-sm text-[var(--muted-foreground)]">尚未設定週期交易</p>}
      </Card> : null}

      {secondaryTab === "history" ? <Card className="p-4">
        <div className="mb-2 flex items-center justify-between gap-2"><h2 className="font-bold">Ledger 流水</h2><div className="flex items-center gap-2"><span className="text-xs text-[var(--muted-foreground)]">已載入 {historyRows.length} 筆</span><Button variant="ghost" size="sm" onClick={() => void exportHistory()} disabled={exporting}><Download className="size-3.5" />{exporting ? "匯出中" : "CSV"}</Button></div></div>
        <div className="mb-3 grid grid-cols-2 gap-2">
          <Input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="搜尋說明／分類／備註" aria-label="搜尋 Ledger 流水" />
          <Select ariaLabel="流水類型" value={historyType} onValueChange={(value) => setHistoryType(value as typeof historyType)} options={[{ value: "all", label: "全部類型" }, { value: "expense", label: "支出" }, { value: "income", label: "收入" }, { value: "transfer", label: "轉帳" }]} />
          <Select ariaLabel="付款人" value={historyPayer} onValueChange={setHistoryPayer} options={[{ value: "all", label: "全部付款人" }, ...users.map((candidate) => ({ value: candidate.id, label: `${candidate.label} 付款` }))]} />
          <Select ariaLabel="流水分類" value={historyCategoryId} onValueChange={setHistoryCategoryId} options={[{ value: "all", label: "全部分類" }, ...categories.filter((category) => category.status === "active").map((category) => ({ value: category.id, label: category.name }))]} />
          <Input type="date" value={historyFrom} onChange={(event) => setHistoryFrom(event.target.value)} aria-label="流水起始日期" />
          <Input type="date" value={historyTo} onChange={(event) => setHistoryTo(event.target.value)} aria-label="流水結束日期" />
        </div>
        <div className="divide-y divide-[var(--border)]">
          {historyRows.map((transaction) => <TransactionRow key={`${transaction.id}:${transaction.version ?? 1}`} transaction={transaction} users={users} currentUser={user} today={today} defaultShares={bootstrap.ledger.defaultShares} categoryOptions={categories.filter((category) => category.status === "active").map((category) => ({ id: category.id, name: category.name }))} initialOpen={transaction.id === transactionIdFromUrl} onChanged={async () => { await reload(); await loadHistory(); }} />)}
          {!historyRows.length ? <p className="py-8 text-center text-sm text-[var(--muted-foreground)]">尚無符合條件的流水</p> : null}
        </div>
        {historyCursor ? <Button variant="outline" size="block" className="mt-3" onClick={() => void loadMoreHistory()} disabled={historyLoadingMore}>{historyLoadingMore ? "載入中…" : "載入更早交易"}</Button> : null}
      </Card> : null}
    </div>
  );
}

function CreateLedgerCard({ name, onName, onCancel, onSave }: { name: string; onName: (value: string) => void; onCancel: () => void; onSave: () => Promise<void> }) {
  return <Card className="space-y-2 p-4"><p className="font-bold">建立新的 Ledger</p><Input value={name} onChange={(event) => onName(event.target.value)} placeholder="例如：上海旅行" maxLength={40} /><div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={onCancel}>取消</Button><Button variant="primary" size="sm" onClick={() => void onSave()}>建立</Button></div></Card>;
}

function TransactionRow({ transaction, users, currentUser, today, defaultShares, categoryOptions, initialOpen = false, onChanged }: { transaction: V2LedgerBootstrap["transactions"][number]; users: User[]; currentUser: User; today: string; defaultShares: Record<string, string>; categoryOptions: Array<{ id: string; name: string }>; initialOpen?: boolean; onChanged: () => Promise<unknown> }) {
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [uploading, setUploading] = React.useState(false);
  const [attachments, setAttachments] = React.useState<V2Attachment[]>([]);
  const [attachmentsLoaded, setAttachmentsLoaded] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const partner = users.find((user) => user.id !== currentUser.id) ?? users[1]!;
  const payments = transaction.payments.map((payment) => `${users.find((user) => user.id === payment.userId)?.label ?? "成員"} ${money(Number(payment.amountTwd))}`).join("、");
  const shares = transaction.shares.map((share) => `${users.find((user) => user.id === share.userId)?.label ?? "成員"} ${money(Number(share.amountTwd))}`).join("、");
  const categoryLabel = transaction.category ?? categoryOptions.find((category) => category.id === transaction.categoryId)?.name;
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
  async function replaceTransaction(value: TransactionEditorValue) {
    setBusy(true);
    setMessage("");
    try {
      await api(`/api/app/v2/transactions/${transaction.id}/mutate`, {
        action: "replace",
        expectedVersion: transaction.version ?? 1,
        idempotencyKey: `v2:transaction:${transaction.id}:replace:${transaction.version ?? 1}`,
        replacement: {
          ...value,
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
  return <details open={initialOpen || undefined} className={`group py-3 ${transaction.status !== "posted" ? "opacity-60" : ""}`} onToggle={(event) => { if (event.currentTarget.open && !attachmentsLoaded) void loadAttachments(); }}><summary className="flex cursor-pointer list-none items-start gap-3"><div className="grid size-9 shrink-0 items-center rounded-xl bg-accent-soft text-accent"><ArrowLeftRight className="size-4" /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{transaction.description ?? typeLabel}{transaction.status !== "posted" ? `（${transaction.status === "voided" ? "已作廢" : "已刪除"}）` : ""}</p><p className="mt-0.5 text-xs text-[var(--muted-foreground)]">{transaction.occurredOn} · {typeLabel} · {payments || "付款資訊"}</p></div><p className="text-sm font-bold tabular-nums">{money(Number(transaction.amountTwd))}</p></summary><div className="ml-12 mt-2 space-y-2 text-xs text-[var(--muted-foreground)]"><p>付款：{payments || "—"}</p><p>分攤：{shares || "—"}</p>{categoryLabel ? <p>分類：{categoryLabel}</p> : null}{transaction.type === "income" ? <p>收入／退款由收款人收到，分攤代表兩人的權益。</p> : null}{transaction.type === "transfer" ? <p>轉帳方向：{transaction.payments[0] ? users.find((user) => user.id === transaction.payments[0]!.userId)?.label ?? "成員" : "—"} → {transaction.shares[0] ? users.find((user) => user.id === transaction.shares[0]!.userId)?.label ?? "成員" : "—"}</p> : null}{transaction.replacesTransactionId ? <p>此交易由舊交易修改而來：{transaction.replacesTransactionId}</p> : null}{transaction.replacedByTransactionId ? <p>此交易已被更新，新版交易：{transaction.replacedByTransactionId}</p> : null}<div className="flex flex-wrap items-center gap-2"><Button variant="ghost" size="sm" disabled={busy || transaction.status === "voided"} onClick={() => setEditing((current) => !current)}>{editing ? "收起編輯" : "編輯"}</Button><Button variant="ghost" size="sm" disabled={busy || transaction.status === "voided"} onClick={() => void mutate("void")}>作廢</Button>{transaction.status === "voided" ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void mutate("restore")}>恢復</Button> : null}<label className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold hover:bg-accent-soft"><Paperclip className="size-3" />{uploading ? "上傳中…" : "加收據"}<input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadReceipt(file); event.currentTarget.value = ""; }} /></label></div>{editing ? <div className="rounded-xl border border-[var(--border)] p-3"><V2TransactionEditor user={currentUser} partner={partner} today={today} defaultShares={defaultShares} categoryOptions={categoryOptions} initial={transaction} submitLabel="儲存修改" busy={busy} onCancel={() => setEditing(false)} onSubmit={replaceTransaction} /><p className="mt-2 text-[11px] text-[var(--muted-foreground)]">編輯會保留原交易並建立一筆替代交易；付款人與分攤由你重新確認。</p></div> : null}{attachmentsLoaded && !attachments.length ? <p>尚無收據</p> : null}{attachments.length ? <div className="space-y-1"><p className="font-semibold">收據</p>{attachments.map((attachment) => <div key={attachment.id} className="flex items-center gap-2"><a href={attachment.url ?? undefined} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-accent underline">{attachment.mimeType === "application/pdf" ? "PDF 收據" : "圖片收據"} · {new Date(attachment.createdAt).toLocaleString("zh-TW")}</a><Button variant="ghost" size="sm" onClick={() => void (async () => { try { await api(`/api/app/v2/attachments/${attachment.id}`, undefined, { method: "DELETE" }); await loadAttachments(); } catch (reason) { setMessage(reason instanceof Error ? reason.message : "收據刪除失敗"); } })()}>刪除</Button></div>)}</div> : null}{message ? <p>{message}</p> : null}</div></details>;
}
