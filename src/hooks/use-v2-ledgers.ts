"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, get } from "@/lib/api";
import type { V2AppContext, V2CreateTransactionResult, V2LedgerBootstrap, V2LedgerSummary } from "@/lib/types";
import { applyCanonicalSnapshot, canApplySnapshot, isCurrentBootstrap, type CommitProof, type ReadFreshness } from "@/lib/v2-entry-operation";

export function useV2Ledgers(enabled = true) {
  const [ledgers, setLedgers] = useState<V2LedgerSummary[]>([]);
  const [activeLedgerId, setActiveLedgerId] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<V2LedgerBootstrap | null>(null);
  const [context, setContext] = useState<V2AppContext | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [read, setRead] = useState<ReadFreshness>("initialLoading");
  const [accessDenied, setAccessDenied] = useState(false);
  const scope = useRef({ ledgerId: null as string | null, request: 0, known: null as V2LedgerBootstrap | null });
  const minimumVersions = useRef(new Map<string, number>());
  const activationQueue = useRef<Promise<unknown>>(Promise.resolve());

  const selectLedger = useCallback((ledgerId: string | null) => {
    if (scope.current.ledgerId === ledgerId) return;
    scope.current = { ledgerId, request: 0, known: null };
    setBootstrap(null);
    setRead("initialLoading");
    setAccessDenied(false);
    setError("");
    setActiveLedgerId(ledgerId);
  }, []);

  const loadLedgers = useCallback(async (initialLedgerId?: string | null, deferSelection = false) => {
    const result = await get<{ ledgers: V2LedgerSummary[] }>("/api/app/v2/ledgers");
    setError("");
    setLedgers(result.ledgers);
    const current = scope.current.ledgerId ?? initialLedgerId;
    if (!deferSelection) selectLedger(current && result.ledgers.some((ledger) => ledger.id === current)
      ? current : result.ledgers.find((ledger) => ledger.status === "active")?.id ?? null);
    return result.ledgers;
  }, [selectLedger]);

  const loadContext = useCallback(async () => {
    const result = await get<V2AppContext>("/api/app/v2/context");
    setError("");
    setContext(result);
    return result;
  }, []);

  const loadBootstrap = useCallback(async (ledgerId: string) => {
    const owner = scope.current;
    if (owner.ledgerId !== ledgerId) return;
    const request = ++owner.request;
    setRead(owner.known ? "refreshing" : "initialLoading");
    const current = () => scope.current === owner && owner.request === request;
    try {
      const result = await get<V2LedgerBootstrap>(`/api/app/v2/ledgers/${ledgerId}/bootstrap`);
      if (!current()) return;
      if (result.ledger.id !== ledgerId) throw new Error("Ledger 回應範圍不符");
      if (!isCurrentBootstrap(owner.known, result, minimumVersions.current.get(ledgerId) ?? 0)) throw new Error("內容尚未更新，已保留目前已確認的紀錄");
      owner.known = result;
      minimumVersions.current.set(ledgerId, result.ledger.version);
      setError("");
      setBootstrap(result);
      setRead("ready");
      setAccessDenied(false);
      return result;
    } catch (reason) {
      if (!current()) return;
      setError(reason instanceof Error ? reason.message : "無法讀取 Ledger");
      setRead("failed");
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) {
        owner.known = null;
        setBootstrap(null);
        setAccessDenied(true);
      }
      throw reason;
    }
  }, []);

  const applyCommittedTransaction = useCallback((result: V2CreateTransactionResult) => {
    if (scope.current.ledgerId !== result.transaction.ledgerId || !canApplySnapshot(scope.current.known, result)
      || result.ledgerVersion < (minimumVersions.current.get(result.transaction.ledgerId) ?? 0)) return false;
    // A read started before this commit must not replace the canonical result.
    scope.current.request += 1;
    const next = applyCanonicalSnapshot(scope.current.known!, result);
    scope.current.known = next;
    minimumVersions.current.set(result.transaction.ledgerId, result.ledgerVersion);
    setBootstrap(next);
    setRead("ready");
    setError("");
    return true;
  }, []);

  const acceptCommitProof = useCallback((proof: CommitProof): boolean => {
    if (proof.snapshot && applyCommittedTransaction(proof.snapshot)) return true;
    const owner = scope.current;
    if (owner.ledgerId !== proof.transaction.ledgerId || !owner.known) return false;
    owner.request += 1;
    const minimum = minimumVersions.current.get(owner.ledgerId) ?? 0;
    if (proof.ledgerVersion) minimumVersions.current.set(owner.ledgerId, Math.max(minimum, proof.ledgerVersion));
    // Replacement proof identifies both rows. Show that fact while balance/next payer
    // remain explicitly stale until the read succeeds; never calculate either here.
    if (proof.replacedTransactionId && proof.originalVersion && (proof.ledgerVersion ?? 0) >= minimum) {
      const original = owner.known.transactions.find(row => row.id === proof.replacedTransactionId);
      if (original && (original.version ?? 1) < proof.originalVersion) {
        const next = { ...owner.known, transactions: [proof.transaction, ...owner.known.transactions
          .filter(row => row.id !== proof.transaction.id)
          .map(row => row.id === proof.replacedTransactionId ? { ...row, status: "voided" as const, version: proof.originalVersion, replacedByTransactionId: proof.transaction.id } : row)] };
        owner.known = next;
        setBootstrap(next);
      }
    }
    setRead("refreshing");
    return false;
  }, [applyCommittedTransaction]);

  useEffect(() => {
    if (!enabled) return;
    if (!activeLedgerId) {
      return;
    }
    const timer = window.setTimeout(() => {
      void loadBootstrap(activeLedgerId).catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeLedgerId, enabled, loadBootstrap]);

  const activateLedger = useCallback(async (ledgerId: string) => {
    selectLedger(ledgerId);
    const owner = scope.current;
    // Keep the server-side LINE preference in the same order as UI selections.
    const activation = activationQueue.current.catch(() => undefined).then(() => api(`/api/app/v2/ledgers/${ledgerId}/activate`, {}));
    activationQueue.current = activation;
    try {
      await activation;
    } catch (reason) {
      if (scope.current !== owner) return;
      setError(reason instanceof Error ? reason.message : "無法切換 Ledger");
    }
  }, [selectLedger]);

  const createLedger = useCallback(async (name: string, color = "#173B63") => {
    setBusy(true);
    try {
      const result = await api("/api/app/v2/ledgers", { name, color });
      await loadLedgers();
      const ledgerId = (result.ledger as { id: string }).id;
      await activateLedger(ledgerId);
      return result;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "建立 Ledger 失敗");
      throw reason;
    } finally {
      setBusy(false);
    }
  }, [activateLedger, loadLedgers]);

  return {
    ledgers,
    activeLedgerId,
    selectLedger,
    setActiveLedgerId: activateLedger,
    bootstrap,
    error,
    busy,
    read,
    accessDenied,
    context,
    loadContext,
    loadLedgers,
    loadBootstrap,
    applyCommittedTransaction,
    acceptCommitProof,
    createLedger,
  };
}
