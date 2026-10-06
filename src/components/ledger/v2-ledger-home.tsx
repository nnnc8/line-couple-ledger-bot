"use client";

import * as React from "react";
import { CalendarClock, Download, Plus, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { V2TransactionEditor, type EntryControlSurface } from "./v2-transaction-editor";
import { LedgerTimeline, TimelineTransactionRow } from "./ledger-timeline";
import { TransactionDetail, TransactionDetailSkeleton } from "./transaction-detail";
import { effectiveTimelineTransactions, lookupTimelineTransaction } from "@/lib/v2-timeline";
import type { TransactionStatusProof } from "@/lib/v2-transaction-status";
import { api, ApiError } from "@/lib/api";
import { money } from "@/lib/format";
import type { V2EntrySession } from "@/hooks/use-v2-entry-session";
import { EntryStatus } from "./entry-status";
import { currentEntryDate } from "@/lib/v2-transaction-draft";
import type { User, V2Category, V2LedgerBootstrap, V2LedgerSummary, V2RecurringRule } from "@/lib/types";
import type { SearchFilters, V2Navigation, V2Surface } from "@/lib/v2-navigation";

export type SettingsLeaveGuard = { dirty: boolean; discard: () => void };

interface V2LedgerHomeProps {
  user: User;
  users: User[];
  today: string;
  ledgers: V2LedgerSummary[];
  activeLedgerId: string | null;
  bootstrap: V2LedgerBootstrap | null;
  error: string;
  busy: boolean;
  reload: () => Promise<unknown>;
  entry: V2EntrySession;
  navigation: V2Navigation;
  onOpenSurface: (surface: V2Surface, transactionId?: string | null) => void;
  onSearchChange: (filters: SearchFilters) => void;
  onCloseEntry: () => void;
  onOpenEntryControls: (surface: EntryControlSurface, trigger: HTMLElement) => void;
  onEdit: (transaction: V2LedgerBootstrap["transactions"][number]) => void;
  onCreateLedger: (trigger: HTMLElement) => void;
  onSettingsLeaveChange: (guard: SettingsLeaveGuard | null) => void;
  onConfirmedMutation: (ledgerId: string, proof: TransactionStatusProof) => void;
  timelineVisibleCount: number;
  onLoadOlder: () => void;
  onQuickEntry: (trigger: HTMLElement) => void;
  quickEntryActive: boolean;
  onCategoriesChange: (categories: V2Category[]) => void;
  highlightedId?: string;
  onViewCreated?: () => void;
}

export function V2LedgerHome({
  user,
  users,
  today,
  ledgers,
  activeLedgerId,
  bootstrap,
  error,
  busy,
  reload,
  entry,
  navigation, onOpenSurface, onSearchChange, onCloseEntry, onOpenEntryControls, onEdit, onCreateLedger, onSettingsLeaveChange, onConfirmedMutation, timelineVisibleCount: visibleCount, onLoadOlder, onQuickEntry, quickEntryActive, onCategoriesChange, highlightedId, onViewCreated,
}: V2LedgerHomeProps) {
  const partner = users.find((candidate) => candidate.id !== user.id) ?? users[1];
  const errorScope = JSON.stringify([navigation.surface, navigation.proposalId, navigation.transactionId, navigation.filters]);
  const [surfaceError, setSurfaceError] = React.useState<{ scope: string; message: string; auth?: boolean; retry?: () => Promise<void> } | null>(null);
  const formError = surfaceError?.scope === errorScope ? surfaceError.message : "";
  const setFormError = React.useCallback((message: string) => setSurfaceError({ scope: errorScope, message }), [errorScope]);
  const setReadError = React.useCallback((reason: unknown, retry: () => Promise<void>) => setSurfaceError({
    scope: errorScope, message: reason instanceof Error ? reason.message : "無法讀取內容",
    auth: reason instanceof ApiError && reason.status === 401, retry,
  }), [errorScope]);
  const [saving, setSaving] = React.useState(false);
  const [recurring, setRecurring] = React.useState<V2RecurringRule[]>([]);
  const recurringLoaded = React.useRef(false);
  const [categories, setCategories] = React.useState<V2Category[]>([]);
  React.useEffect(() => { onCategoriesChange(categories); }, [categories, onCategoriesChange]);
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
  const [statisticsCommit, setStatisticsCommit] = React.useState<string | null>(null);
  const committedKey = entry.write === "committed" ? entry.operation?.idempotencyKey : null;
  if (committedKey && statisticsCommit !== committedKey) {
    setStatisticsCommit(committedKey);
    setStatistics(null);
  }
  const { filters } = navigation;
  const historyType = filters.type ?? "all", historyPayer = filters.payerUserId ?? "all", historyCategoryId = filters.categoryId ?? "all";
  const historyQuery = filters.q ?? "", historyFrom = filters.from ?? "", historyTo = filters.to ?? "";
  const changeFilter = (key: keyof SearchFilters, value: string) => onSearchChange({ ...filters, [key]: value === "all" ? "" : value });
  const setHistoryType = (value: string) => changeFilter("type", value);
  const setHistoryPayer = (value: string) => changeFilter("payerUserId", value);
  const setHistoryCategoryId = (value: string) => changeFilter("categoryId", value);
  const setHistoryQuery = (value: string) => changeFilter("q", value);
  const setHistoryFrom = (value: string) => changeFilter("from", value);
  const setHistoryTo = (value: string) => changeFilter("to", value);
  const historyScope = JSON.stringify([historyType, historyPayer, historyCategoryId, historyQuery, historyFrom, historyTo]);
  const hasHistoryFilters = historyType !== "all" || historyPayer !== "all" || historyCategoryId !== "all" || Boolean(historyQuery.trim()) || Boolean(historyFrom) || Boolean(historyTo);
  const [historyResult, setHistoryResult] = React.useState<{ bootstrap: V2LedgerBootstrap | null; scope: string; rows: V2LedgerBootstrap["transactions"]; cursor: string | null } | null>(null);
  const [historySettled, setHistorySettled] = React.useState<{ bootstrap: V2LedgerBootstrap; scope: string } | null>(null);
  const cachedHistory = historyResult?.scope === historyScope ? historyResult : null;
  const canonicalById = new Map(bootstrap?.transactions.map(transaction => [transaction.id, transaction]));
  const historyRawRows = hasHistoryFilters ? cachedHistory?.rows.map(transaction => {
    const canonical = canonicalById.get(transaction.id);
    return canonical && (canonical.version ?? 1) > (transaction.version ?? 1) ? canonical : transaction;
  }) ?? [] : bootstrap?.transactions ?? [];
  const historyRows = filters.includeVoided === "1" ? historyRawRows : effectiveTimelineTransactions(historyRawRows);
  const historyReady = !hasHistoryFilters || cachedHistory?.bootstrap === bootstrap || historySettled?.bootstrap === bootstrap && historySettled.scope === historyScope;
  const [mutationFact, setMutationFact] = React.useState("");
  const historyCursor = historyResult?.bootstrap === bootstrap && historyResult?.scope === historyScope ? historyResult.cursor : null;
  const [historyLoadingMore, setHistoryLoadingMore] = React.useState(false);
  const historyAbortRef = React.useRef<AbortController | null>(null);
  // These secondary reads belong to this Ledger; entry state lives in the root owner.
  const mounted = React.useRef(false);
  const reads = React.useRef({ categories: 0, recurring: 0, statistics: 0 });
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; historyAbortRef.current?.abort(); };
  }, []);
  const proposalId = navigation.surface === "PROPOSAL_COMPAT_ENTRY" ? navigation.proposalId : null;
  const [proposalResult, setProposalResult] = React.useState<{ id: string; status: string | null } | null>(null);
  const proposalStatus = proposalResult?.id === proposalId ? proposalResult.status : null;
  const proposalRead = React.useRef(0);
  const [defaultWeights, setDefaultWeights] = React.useState<[string, string]>(["1", "1"]);
  const [defaultShareMessage, setDefaultShareMessage] = React.useState("");
  const [savingDefaults, setSavingDefaults] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const secondaryTab = navigation.surface === "STATS" ? "stats" : ["SETTINGS", "RECURRING"].includes(navigation.surface) ? "settings" : "history";
  const settingsDirty = secondaryTab === "settings" && Boolean(newCategoryName ||
    categories.some(category => categoryDrafts[category.id] !== undefined && categoryDrafts[category.id] !== category.name) ||
    bootstrap && defaultWeights.some((value, index) => value !== (bootstrap.ledger.defaultShares[bootstrap.ledger.members[index]?.userId ?? ""] ?? "1")) ||
    recurringName || recurringAmount || recurringSelfPayment || recurringPartnerPayment || recurringSelfShare || recurringPartnerShare || recurringCategoryId ||
    recurringFrequency !== "monthly" || recurringPaymentMode !== "self" || recurringSplitMethod !== "weights" || recurringSelfPercentage !== "50" || recurringPartnerPercentage !== "50");
  const discardSettings = React.useCallback(() => {
    setNewCategoryName(""); setCategoryDrafts(Object.fromEntries(categories.map(category => [category.id, category.name])));
    setDefaultWeights([0, 1].map(index => bootstrap?.ledger.defaultShares[bootstrap.ledger.members[index]?.userId ?? ""] ?? "1") as [string, string]);
    setRecurringName(""); setRecurringAmount(""); setRecurringSelfPayment(""); setRecurringPartnerPayment("");
    setRecurringSelfShare(""); setRecurringPartnerShare(""); setRecurringCategoryId("");
    setRecurringFrequency("monthly"); setRecurringPaymentMode("self"); setRecurringSplitMethod("weights");
    setRecurringSelfPercentage("50"); setRecurringPartnerPercentage("50");
  }, [bootstrap, categories]);
  React.useLayoutEffect(() => {
    onSettingsLeaveChange({ dirty: settingsDirty, discard: discardSettings });
    return () => onSettingsLeaveChange(null);
  }, [settingsDirty, discardSettings, onSettingsLeaveChange]);
  const isHome = navigation.surface === "HOME";
  const isSearch = navigation.surface === "SEARCH";
  const isDetail = navigation.surface === "TRANSACTION_DETAIL";
  const isCorrection = entry.draft?.operationType === "replace" || entry.operation?.operationType === "replace" && (entry.write === "submitting" || entry.write === "unknown");
  const detail = bootstrap && activeLedgerId && navigation.transactionId ? lookupTimelineTransaction(bootstrap.transactions, activeLedgerId, navigation.transactionId) : undefined;

  const refreshLedger = React.useCallback(async () => {
    if (!mounted.current) return;
    reads.current.statistics += 1;
    setStatistics(null);
    return reload();
  }, [reload]);

  const loadRecurring = React.useCallback(async () => {
    if (!activeLedgerId || !mounted.current) return;
    const request = ++reads.current.recurring;
    try {
      const result = await fetch(`/api/app/v2/ledgers/${activeLedgerId}/recurring`, { cache: "no-store", credentials: "same-origin" });
      const body = await result.json() as { recurring?: V2RecurringRule[]; error?: string };
      if (!mounted.current || reads.current.recurring !== request) return;
      if (!result.ok) throw new ApiError(body.error ?? "無法讀取週期規則", result.status, Boolean(body.error));
      recurringLoaded.current = true;
      setRecurring(body.recurring ?? []);
    } catch (reason) {
      if (mounted.current && reads.current.recurring === request) throw reason;
    }
  }, [activeLedgerId]);

  const loadCategories = React.useCallback(async () => {
    if (!activeLedgerId || !mounted.current) return;
    const request = ++reads.current.categories;
    try {
      const response = await fetch(`/api/app/v2/ledgers/${activeLedgerId}/categories`, { cache: "no-store", credentials: "same-origin" });
      const body = await response.json() as { categories?: V2Category[]; error?: string };
      if (!mounted.current || reads.current.categories !== request) return;
      if (!response.ok) throw new Error(body.error ?? "無法讀取分類");
      setCategories(body.categories ?? []);
      setCategoryDrafts(Object.fromEntries((body.categories ?? []).map((category) => [category.id, category.name])));
    } catch (reason) {
      if (mounted.current && reads.current.categories === request) throw reason;
    }
  }, [activeLedgerId]);

  React.useEffect(() => {
    if (!bootstrap) return;
    const timer = window.setTimeout(() => { void loadCategories().catch(() => undefined); }, 0);
    return () => window.clearTimeout(timer);
  }, [bootstrap, loadCategories]);

  const loadStatistics = React.useCallback(async () => {
    if (!activeLedgerId || !mounted.current) return;
    const request = ++reads.current.statistics;
    try {
      const response = await fetch(`/api/app/v2/ledgers/${activeLedgerId}/statistics`, { cache: "no-store", credentials: "same-origin" });
      const body = await response.json() as typeof statistics & { error?: string };
      if (!mounted.current || reads.current.statistics !== request) return;
      if (!response.ok) throw new ApiError(body.error ?? "無法讀取統計", response.status, Boolean(body.error));
      setStatistics(body);
    } catch (reason) {
      if (mounted.current && reads.current.statistics === request) throw reason;
    }
  }, [activeLedgerId]);

  const loadHistory = React.useCallback(async (cursor: string | null = null, append = false, minimumRows = 0) => {
    if (!activeLedgerId || !bootstrap) return;
    const params = new URLSearchParams();
    if (historyType !== "all") params.set("type", historyType);
    if (historyPayer !== "all") params.set("payerUserId", historyPayer);
    if (historyCategoryId !== "all") params.set("categoryId", historyCategoryId);
    if (historyQuery.trim()) params.set("q", historyQuery.trim());
    if (historyFrom) params.set("from", historyFrom);
    if (historyTo) params.set("to", historyTo);
    params.set("limit", "50");
    if (append) setHistoryLoadingMore(true);
    else { setHistoryLoadingMore(false); setHistorySettled(null); }
    historyAbortRef.current?.abort();
    const controller = new AbortController();
    historyAbortRef.current = controller;
    try {
      const rows = new Map<string, V2LedgerBootstrap["transactions"][number]>();
      let nextCursor = cursor;
      do {
        if (nextCursor) params.set("cursor", nextCursor); else params.delete("cursor");
        const response = await fetch(`/api/app/v2/ledgers/${activeLedgerId}/transactions?${params.toString()}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
        const body = await response.json() as { transactions?: V2LedgerBootstrap["transactions"]; nextCursor?: string | null; error?: string };
        if (!mounted.current || controller.signal.aborted || historyAbortRef.current !== controller) return;
        if (!response.ok) throw new ApiError(body.error ?? "無法讀取紀錄", response.status, Boolean(body.error));
        for (const transaction of body.transactions ?? []) rows.set(transaction.id, transaction);
        nextCursor = body.nextCursor ?? null;
      } while (!append && nextCursor && rows.size < minimumRows);
      setHistoryResult((current) => ({ bootstrap, scope: historyScope,
        rows: append && current?.scope === historyScope ? [...new Map([...current.rows, ...rows.values()].map(row => [row.id, row])).values()] : [...rows.values()],
        cursor: nextCursor }));
      setSurfaceError(current => current?.scope === errorScope ? null : current);
    } finally {
      if (mounted.current && historyAbortRef.current === controller) {
        if (append) setHistoryLoadingMore(false);
        else if (!controller.signal.aborted) setHistorySettled({ bootstrap, scope: historyScope });
      }
    }
  }, [activeLedgerId, historyCategoryId, historyFrom, historyPayer, historyQuery, historyTo, historyType, historyScope, bootstrap, errorScope]);

  const refreshHistory = React.useCallback(() => loadHistory(null, false, cachedHistory?.rows.length ?? 0), [loadHistory, cachedHistory?.rows.length]);

  React.useEffect(() => { if (!isSearch) historyAbortRef.current?.abort(); }, [isSearch]);

  React.useEffect(() => {
    if (!bootstrap || !isSearch) return;
    const hasFilters = historyType !== "all" || historyPayer !== "all" || historyCategoryId !== "all" || Boolean(historyQuery.trim()) || Boolean(historyFrom) || Boolean(historyTo);
    if (!hasFilters) {
      historyAbortRef.current?.abort();
      return;
    }
    if (historyResult?.scope === historyScope && historyResult.bootstrap === bootstrap) return;
    const timer = window.setTimeout(() => {
      void refreshHistory().catch((reason) => {
        if ((reason as { name?: string }).name !== "AbortError") setReadError(reason, refreshHistory);
      });
    }, historyQuery.trim() ? 300 : 0);
    return () => { window.clearTimeout(timer); historyAbortRef.current?.abort(); };
  }, [bootstrap, isSearch, historyCategoryId, historyFrom, historyPayer, historyQuery, historyTo, historyType, historyResult?.scope, historyResult?.bootstrap, historyScope, refreshHistory, setReadError]);

  React.useEffect(() => {
    if (!bootstrap || secondaryTab !== "stats" || statistics) return;
    const timer = window.setTimeout(() => {
      void loadStatistics().catch((reason) => setReadError(reason, loadStatistics));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [bootstrap, loadStatistics, secondaryTab, statistics, setReadError]);

  React.useEffect(() => {
    if (!bootstrap || secondaryTab !== "settings" || recurringLoaded.current) return;
    void loadRecurring().catch((reason) => setReadError(reason, loadRecurring));
  }, [bootstrap, loadRecurring, recurring.length, secondaryTab, setReadError]);

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

  React.useEffect(() => {
    if (!proposalId) return;
    const controller = new AbortController();
    const generation = ++proposalRead.current;
    const timer = window.setTimeout(() => {
      void fetch(`/api/app/v2/proposals/${proposalId}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal })
        .then(async response => {
          const body = await response.json() as { status?: string; error?: string };
          if (controller.signal.aborted || generation !== proposalRead.current || !mounted.current) return;
          if (!response.ok) throw new Error(body.error ?? "無法讀取 proposal");
          setProposalResult({ id: proposalId, status: body.status ?? null });
        }).catch(reason => {
          if (!controller.signal.aborted && generation === proposalRead.current && mounted.current) setFormError(reason instanceof Error ? reason.message : "無法讀取 proposal");
        });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [proposalId, setFormError]);

  async function confirmProposal() {
    if (!proposalId) return;
    proposalRead.current += 1;
    setSaving(true);
    try {
      await api(`/api/app/v2/proposals/${proposalId}/confirm`, {});
      await refreshLedger();
      if (mounted.current) setProposalResult({ id: proposalId, status: "confirmed" });
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "proposal 確認失敗");
    } finally {
      setSaving(false);
    }
  }

  async function cancelProposal() {
    if (!proposalId) return;
    proposalRead.current += 1;
    setSaving(true);
    try {
      await api(`/api/app/v2/proposals/${proposalId}/cancel`, {});
      if (mounted.current) setProposalResult({ id: proposalId, status: "cancelled" });
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "proposal 取消失敗");
    } finally {
      setSaving(false);
    }
  }

  if (!partner || !bootstrap) {
    return (
      <div className="space-y-3 pt-1">
        {!activeLedgerId && !ledgers.some(ledger => ledger.status === "active") ? <Card className="space-y-3 p-4"><h2 className="font-bold">還沒有帳本</h2><p>建立一本帳本，開始一起記錄生活。</p><Button tabIndex={0} onClick={event => onCreateLedger(event.currentTarget)}>建立帳本</Button></Card>
          : error ? <Card role="alert" className="p-4 text-sm text-[var(--muted-foreground)]">暫時讀不到這本帳本。{error}<Button className="mt-2" variant="outline" size="sm" onClick={() => void reload().catch(() => undefined)}>重新讀取</Button></Card>
          : isDetail ? <TransactionDetailSkeleton /> : isHome ? <Card className="p-4"><LedgerTimeline transactions={[]} userId={user.id} categories={categories} today={today} visibleCount={visibleCount} onLoadOlder={() => undefined} onOpenTransaction={() => undefined} loading /></Card> : <Card className="p-4">正在載入帳本…</Card>}
        {!quickEntryActive ? <EntryStatus entry={entry} ledgerId={activeLedgerId} today={currentEntryDate()} onView={onViewCreated} /> : null}
      </div>
    );
  }

  const selfBalance = Number(bootstrap.balance[user.id] ?? "0");
  const nextPayer = bootstrap.nextPayer;
  const nextPayerUser = nextPayer ? users.find((candidate) => candidate.id === nextPayer.payerUserId) : null;
  const balanceHeadline = selfBalance === 0
    ? "目前很平衡"
    : selfBalance > 0
      ? "你目前多付"
      : "另一半目前多付";
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
      setRecurringFrequency("monthly"); setRecurringPaymentMode("self"); setRecurringSplitMethod("weights");
      setRecurringSelfPercentage("50"); setRecurringPartnerPercentage("50");
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
      setDefaultShareMessage("已更新；之後未指定分攤的交易會套用這本帳本的設定。");
      await refreshLedger();
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
      if (!mounted.current) return;
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
      {isHome ? <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="icon-sm" aria-label="重新整理帳本" onClick={() => void refreshLedger().catch(() => undefined)}><RefreshCw className="size-4" /></Button>
      </div> : null}
      {formError ? <div className="text-sm font-medium text-destructive" role="alert"><p>{formError}</p>
        {surfaceError?.retry ? <Button variant="outline" size="sm" onClick={() => {
          if (surfaceError.auth) { location.reload(); return; }
          const retry = surfaceError.retry!;
          setSurfaceError(null);
          void retry().catch(reason => setReadError(reason, retry));
        }}>{surfaceError.auth ? "重新登入" : "重新讀取"}</Button> : null}
      </div> : null}
      <div data-testid={isHome ? "home-entry-status" : undefined} className={isHome ? "sticky top-0 z-20 bg-[var(--background)] py-1" : undefined}>
        {!quickEntryActive && !(isDetail && isCorrection) ? <EntryStatus entry={entry} ledgerId={activeLedgerId} today={currentEntryDate()} onView={onViewCreated} /> : null}
      </div>
      {error && entry.write !== "committed" ? <div role="alert" className="text-sm"><p>內容暫時無法更新。{error}</p><Button variant="outline" size="sm" onClick={() => void refreshLedger().catch(() => undefined)}>重新讀取</Button></div> : null}
      {isHome && mutationFact ? <p role="status">{mutationFact}{entry.read !== "ready" ? "。內容與近況待更新。" : ""}</p> : null}
      {proposalId && proposalStatus ? <Card className="border-accent/30 bg-accent-soft p-4"><p className="font-semibold">LINE 待確認草稿</p><p className="mt-1 text-sm text-[var(--muted-foreground)]">狀態：{proposalStatus === "proposed" ? "待確認" : proposalStatus === "confirmed" ? "已入帳" : proposalStatus === "cancelled" ? "已取消" : proposalStatus}</p>{proposalStatus === "proposed" ? <div className="mt-3 flex gap-2"><Button variant="primary" size="sm" onClick={() => void confirmProposal()} disabled={saving}>確認入帳</Button><Button variant="ghost" size="sm" onClick={() => void cancelProposal()} disabled={saving}>取消</Button></div> : null}</Card> : null}


      {isHome ? <><Card data-testid="ledger-balance" data-ledger-version={bootstrap.ledger.version} className="overflow-hidden p-5 text-white" style={{ background: `linear-gradient(140deg, ${bootstrap.ledger.color}, #0c2240)` }}>
        <p className="text-sm font-semibold text-white/75">{bootstrap.ledger.name}</p>
        <h2 className="mt-1 text-xl font-extrabold tracking-tight">{balanceHeadline}</h2>
        {selfBalance !== 0 ? <p className="mt-0.5 text-[clamp(1rem,7vw,1.75rem)] font-extrabold tracking-tight">{money(Math.abs(selfBalance))}</p> : null}
        {nextPayer ? <>
          <p className="mt-3 text-sm text-white/75">下次建議由 {nextPayerUser?.label ?? "另一半"} 付款</p>
        </> : null}
      </Card>

      <nav className="flex flex-wrap gap-2" aria-label="帳本功能">
        <Button variant="outline" size="sm" onClick={() => onOpenSurface("STATS")}>收支概況</Button>
        <Button variant="outline" size="sm" onClick={() => onOpenSurface("SETTINGS")}>帳本設定</Button>
        <Button variant="outline" size="sm" onClick={() => onOpenSurface("SEARCH")}>搜尋</Button>
      </nav></> : null}

      {isDetail && isCorrection ? <Card className="p-4" data-entry>
        <h2 className="mb-3 font-bold">修改這筆紀錄</h2>
        {entry.draft && entry.draft.ledgerId === activeLedgerId ? <V2TransactionEditor
          key={entry.draft.id}
          user={user}
          partner={partner}
          draft={entry.draft}
          categoryOptions={categories.filter(category => category.status === "active").map(category => ({ id: category.id, name: category.name }))}
          busy={entry.write === "submitting" || saving || busy}
          locked={entry.locked}
          errorField={entry.field}
          serverError={entry.error}
          scopeValid={Boolean(bootstrap && bootstrap.ledger.id === entry.draft.ledgerId && bootstrap.ledger.members.length === entry.draft.memberIds.length && bootstrap.ledger.status === "active" && entry.draft.actorUserId === user.id && entry.draft.coupleId === bootstrap.ledger.coupleId && entry.draft.memberIds.every((id, index) => id === bootstrap.ledger.members[index]?.userId))}
          onOpenControls={onOpenEntryControls}
          onChange={entry.updateDraft}
          onCancel={onCloseEntry}
          onSubmit={async () => { await entry.submit(); if (mounted.current) setStatistics(null); }}
        /> : null}
        <EntryStatus entry={entry} ledgerId={activeLedgerId} today={currentEntryDate()} onView={onViewCreated} />
      </Card> : null}

      {secondaryTab === "stats" ? <Card className="p-4">
        <h2 className="mb-2 font-bold">收支概況</h2><p className="mb-2 text-sm">全部有效紀錄</p>
        {statistics ? <div className="space-y-4 text-sm"><div className="grid grid-cols-2 gap-2"><p>支出 <strong>{money(Number(statistics.byType.expense ?? "0"))}</strong></p><p>收入／退款 <strong>{money(Number(statistics.byType.income ?? "0"))}</strong></p><p>{user.label} 支付 <strong>{money(Number(statistics.paidBy[user.id] ?? "0"))}</strong></p><p>{partner.label} 支付 <strong>{money(Number(statistics.paidBy[partner.id] ?? "0"))}</strong></p><p>{user.label} 負擔 <strong>{money(Number(statistics.borneBy[user.id] ?? "0"))}</strong></p><p>{partner.label} 負擔 <strong>{money(Number(statistics.borneBy[partner.id] ?? "0"))}</strong></p></div><div><p className="mb-1 text-xs font-semibold text-[var(--muted-foreground)]">分類排行</p><div className="space-y-1">{Object.entries(statistics.byCategory).length ? Object.entries(statistics.byCategory).map(([name, amount]) => <div key={name} className="flex justify-between gap-3"><span>{name}</span><strong>{money(Number(amount))}</strong></div>) : <p className="text-xs text-[var(--muted-foreground)]">尚無分類統計</p>}</div></div></div> : <p className="text-sm text-[var(--muted-foreground)]">統計載入中…</p>}
      </Card> : null}

      {navigation.surface === "SETTINGS" ? <Card className="p-4">
        <h2 className="mb-4 font-bold">帳本設定</h2><Button variant="outline" size="sm" onClick={() => onOpenSurface("RECURRING")}>固定記帳</Button>
        <h3 className="mb-1 font-semibold">預設分攤</h3>
        <p className="mb-3 text-xs text-[var(--muted-foreground)]">新帳本預設 50 / 50；這裡只設定目前帳本，不會影響其他帳本。</p>
        <form className="space-y-2" onSubmit={(event) => void saveDefaultShares(event)}>
          <div className="grid grid-cols-2 gap-2">
            <Input inputMode="numeric" value={defaultWeights[0]} onChange={(event) => setDefaultWeights((current) => [event.target.value, current[1]])} aria-label={`${users[0]?.label ?? "成員一"} 預設權重`} placeholder={`${users[0]?.label ?? "成員一"} 權重`} />
            <Input inputMode="numeric" value={defaultWeights[1]} onChange={(event) => setDefaultWeights((current) => [current[0], event.target.value])} aria-label={`${users[1]?.label ?? "成員二"} 預設權重`} placeholder={`${users[1]?.label ?? "成員二"} 權重`} />
          </div>
          <Button type="submit" variant="outline" size="block" disabled={savingDefaults}>{savingDefaults ? "儲存中…" : "儲存預設分攤"}</Button>
          {defaultShareMessage ? <p className="text-xs text-[var(--muted-foreground)]">{defaultShareMessage}</p> : null}
        </form>
        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <h3 className="mb-1 font-bold">帳本分類</h3>
          <p className="mb-3 text-xs text-[var(--muted-foreground)]">分類只屬於這本帳本；封存不會改寫既有交易的文字快照。</p>
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
        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <h3 className="mb-2 font-bold">匯出</h3>
          <Button variant="outline" size="sm" onClick={() => void exportHistory()} disabled={exporting}><Download className="size-3.5" />{exporting ? "匯出中…" : "匯出 CSV"}</Button>
        </div>
      </Card> : null}

      {secondaryTab === "settings" ? <Card className="p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2"><CalendarClock className="size-4 text-accent" /><h2 className="font-bold">週期交易</h2></div>
          <Button variant="ghost" size="sm" onClick={() => setShowRecurring((current) => !current)}>{showRecurring ? "收起" : "新增"}</Button>
        </div>
        {showRecurring ? <form className="mb-3 space-y-2" onSubmit={(event) => void saveRecurring(event)}>
          <Input value={recurringName} onChange={(event) => setRecurringName(event.target.value)} placeholder="例如：房租" aria-label="週期交易名稱" />
          <div className="grid grid-cols-2 gap-2"><Input inputMode="numeric" value={recurringAmount} onChange={(event) => setRecurringAmount(event.target.value)} placeholder="金額" aria-label="週期交易金額（新台幣）" /><Select ariaLabel="週期" value={recurringFrequency} onValueChange={(value) => setRecurringFrequency(value as typeof recurringFrequency)} options={[{ value: "weekly", label: "每週" }, { value: "monthly", label: "每月" }, { value: "yearly", label: "每年" }]} /></div>
          <Select ariaLabel="週期付款人" value={recurringPaymentMode} onValueChange={(value) => setRecurringPaymentMode(value as typeof recurringPaymentMode)} options={[{ value: "self", label: `${user.label} 付款` }, { value: "partner", label: `${partner.label} 付款` }, { value: "both", label: "兩人共同付款" }]} />
          {recurringPaymentMode === "both" ? <div className="grid grid-cols-2 gap-2"><Input inputMode="numeric" value={recurringSelfPayment} onChange={(event) => setRecurringSelfPayment(event.target.value)} placeholder={`${user.label} 付款`} aria-label={`${user.label} 週期付款`} /><Input inputMode="numeric" value={recurringPartnerPayment} onChange={(event) => setRecurringPartnerPayment(event.target.value)} placeholder={`${partner.label} 付款`} aria-label={`${partner.label} 週期付款`} /></div> : null}
          <Select ariaLabel="週期分攤方式" value={recurringSplitMethod} onValueChange={(value) => setRecurringSplitMethod(value as typeof recurringSplitMethod)} options={[{ value: "equal", label: "平均分 50 / 50" }, { value: "weights", label: `套用帳本預設（${bootstrap.ledger.defaultShares[user.id] ?? "1"} / ${bootstrap.ledger.defaultShares[partner.id] ?? "1"}）` }, { value: "percentage", label: "百分比" }, { value: "exact", label: "指定分攤金額" }]} />
          {recurringSplitMethod === "percentage" ? <div className="grid grid-cols-2 gap-2"><Input inputMode="decimal" value={recurringSelfPercentage} onChange={(event) => setRecurringSelfPercentage(event.target.value)} placeholder={`${user.label} %`} aria-label={`${user.label} 週期百分比`} /><Input inputMode="decimal" value={recurringPartnerPercentage} onChange={(event) => setRecurringPartnerPercentage(event.target.value)} placeholder={`${partner.label} %`} aria-label={`${partner.label} 週期百分比`} /></div> : null}
          {recurringSplitMethod === "exact" ? <div className="grid grid-cols-2 gap-2"><Input inputMode="numeric" value={recurringSelfShare} onChange={(event) => setRecurringSelfShare(event.target.value)} placeholder={`${user.label} 分攤`} aria-label={`${user.label} 週期分攤`} /><Input inputMode="numeric" value={recurringPartnerShare} onChange={(event) => setRecurringPartnerShare(event.target.value)} placeholder={`${partner.label} 分攤`} aria-label={`${partner.label} 週期分攤`} /></div> : null}
          <Select ariaLabel="週期分類" value={recurringCategoryId} onValueChange={setRecurringCategoryId} options={[{ value: "", label: "未分類" }, ...categories.filter((category) => category.status === "active").map((category) => ({ value: category.id, label: category.name }))]} />
          <Button type="submit" variant="primary" size="block" disabled={saving}>儲存週期規則</Button>
        </form> : null}
          {recurring.length ? <div className="divide-y divide-[var(--border)]">{recurring.map((rule) => <div key={rule.id} className="flex items-center gap-2 py-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{rule.name} · {money(Number(rule.amountTwd))}</p><p className="text-xs text-[var(--muted-foreground)]">{rule.frequency === "weekly" ? "每週" : rule.frequency === "monthly" ? "每月" : "每年"} · {rule.splitMethod} · 下次 {rule.nextRunDate}</p></div><Button variant="ghost" size="sm" onClick={() => void toggleRecurring(rule)} disabled={saving}>{rule.active ? "停用" : "啟用"}</Button></div>)}</div> : <p className="text-sm text-[var(--muted-foreground)]">尚未設定週期交易</p>}
      </Card> : null}

      {isHome ? <Card data-testid="home-timeline-card" data-ledger-version={bootstrap.ledger.version} className="p-4"><h2 className="mb-2 font-bold">生活紀錄</h2>
        <LedgerTimeline transactions={bootstrap.transactions} userId={user.id} categories={categories} today={today}
          visibleCount={visibleCount} onLoadOlder={onLoadOlder} highlightedId={highlightedId}
          onOpenTransaction={id => onOpenSurface("TRANSACTION_DETAIL", id)} />
      </Card> : null}
      {isHome ? <div data-testid="home-entry-action" className="pointer-events-none fixed inset-x-0 bottom-0 z-10 mx-auto max-w-[640px] px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3">
        <Button data-testid="quick-entry-trigger" aria-haspopup="dialog" aria-controls="ledger-surface-dialog" className="pointer-events-auto min-h-[52px] w-full text-base shadow-md" onClick={event => onQuickEntry(event.currentTarget)}><Plus aria-hidden="true" className="size-5" />記一筆</Button>
      </div> : null}
      {isSearch ? <Card className="p-4" data-search-ready={historyReady ? "true" : "false"}>
        <div className="mb-2 flex items-center justify-between gap-2"><h2 className="font-bold">搜尋紀錄</h2><span className="text-xs text-[var(--muted-foreground)]">已載入 {historyRows.length} 筆</span></div>
        <div className="mb-3 grid grid-cols-2 gap-2">
          <Input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="搜尋用途／分類／備註" aria-label="搜尋紀錄" />
          <Select ariaLabel="紀錄類型" value={historyType} onValueChange={(value) => setHistoryType(value as typeof historyType)} options={[{ value: "all", label: "全部類型" }, { value: "expense", label: "支出" }, { value: "income", label: "收入" }, { value: "transfer", label: "轉帳" }]} />
          <Select ariaLabel="付款人" value={historyPayer} onValueChange={setHistoryPayer} options={[{ value: "all", label: "全部付款人" }, ...users.map((candidate) => ({ value: candidate.id, label: `${candidate.label} 付款` }))]} />
          <Select ariaLabel="紀錄分類" value={historyCategoryId} onValueChange={setHistoryCategoryId} options={[{ value: "all", label: "全部分類" }, ...categories.filter((category) => category.status === "active").map((category) => ({ value: category.id, label: category.name }))]} />
          <Input type="date" value={historyFrom} onChange={(event) => setHistoryFrom(event.target.value)} aria-label="紀錄開始日期" />
          <Input type="date" value={historyTo} onChange={(event) => setHistoryTo(event.target.value)} aria-label="紀錄結束日期" />
        </div>
        <label className="mb-3 flex min-h-11 items-center gap-2"><input type="checkbox" checked={filters.includeVoided === "1"} onChange={event => changeFilter("includeVoided", event.target.checked ? "1" : "")} />包含已作廢</label>
        <ul className="divide-y divide-[var(--border)]">
          {historyRows.map(transaction => <li key={transaction.id}><TimelineTransactionRow transaction={transaction} userId={user.id} categories={categories} today={today} onOpenTransaction={id => onOpenSurface("TRANSACTION_DETAIL", id)} /></li>)}
        </ul>
        {!historyReady ? <p role="status" className="text-sm text-[var(--muted-foreground)]">搜尋內容更新中…</p> : !historyRows.length ? <p className="py-8 text-center text-sm text-[var(--muted-foreground)]">沒有符合條件的紀錄</p> : null}
        {historyCursor ? <Button variant="outline" size="block" className="mt-3" onClick={() => void loadMoreHistory().catch(reason => setReadError(reason, loadMoreHistory))} disabled={historyLoadingMore}>{historyLoadingMore ? "載入中…" : "載入更早交易"}</Button> : null}
      </Card> : null}
      {isDetail ? detail ? <div hidden={isCorrection}><TransactionDetail key={detail.id} transaction={detail} transactions={bootstrap.transactions}
        userId={user.id} users={users} categories={categories} entryLocked={entry.locked}
        onEdit={() => onEdit(detail)} onOpenTransaction={id => onOpenSurface("TRANSACTION_DETAIL", id)}
        onConfirmedMutation={(proof, action) => { onConfirmedMutation(detail.ledgerId, proof); setMutationFact(`${action === "void" ? "已作廢" : "已恢復"}「${detail.description ?? "這筆紀錄"}」`); }} onChanged={refreshLedger} /></div>
        : <p role="alert">這筆紀錄不屬於這本帳本，或已無法開啟。</p> : null}
    </div>
  );
}
