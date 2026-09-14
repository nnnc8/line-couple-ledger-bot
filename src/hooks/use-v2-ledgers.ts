"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, get } from "@/lib/api";
import type { V2AppContext, V2CreateTransactionResult, V2LedgerBootstrap, V2LedgerSummary } from "@/lib/types";

export function useV2Ledgers(enabled = true) {
  const [ledgers, setLedgers] = useState<V2LedgerSummary[]>([]);
  const [activeLedgerId, setActiveLedgerId] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<V2LedgerBootstrap | null>(null);
  const [context, setContext] = useState<V2AppContext | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const scope = useRef({ ledgerId: null as string | null, request: 0 });
  const activationQueue = useRef<Promise<unknown>>(Promise.resolve());

  const selectLedger = useCallback((ledgerId: string | null) => {
    if (scope.current.ledgerId === ledgerId) return;
    scope.current = { ledgerId, request: 0 };
    setBootstrap(null);
    setError("");
    setActiveLedgerId(ledgerId);
  }, []);

  const loadLedgers = useCallback(async (initialLedgerId?: string | null) => {
    const result = await get<{ ledgers: V2LedgerSummary[] }>("/api/app/v2/ledgers");
    setError("");
    setLedgers(result.ledgers);
    const current = scope.current.ledgerId ?? initialLedgerId;
    selectLedger(current && result.ledgers.some((ledger) => ledger.id === current)
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
    const current = () => scope.current === owner && owner.request === request;
    try {
      const result = await get<V2LedgerBootstrap>(`/api/app/v2/ledgers/${ledgerId}/bootstrap`);
      if (!current()) return;
      if (result.ledger.id !== ledgerId) throw new Error("Ledger 回應範圍不符");
      setError("");
      setBootstrap(result);
      return result;
    } catch (reason) {
      if (!current()) return;
      setError(reason instanceof Error ? reason.message : "無法讀取 Ledger");
      throw reason;
    }
  }, []);

  const applyCommittedTransaction = useCallback((result: V2CreateTransactionResult) => {
    if (scope.current.ledgerId !== result.transaction.ledgerId) return;
    // A read started before this commit must not replace the canonical result.
    scope.current.request += 1;
    setBootstrap((current) => {
      if (!current || current.ledger.id !== result.transaction.ledgerId) return current;
      const transactions = [
        result.transaction,
        ...current.transactions.filter((transaction) => transaction.id !== result.transaction.id),
      ].sort((left, right) => {
        const occurredOn = (right.occurredOn ?? "").localeCompare(left.occurredOn ?? "");
        if (occurredOn !== 0) return occurredOn;
        const createdAt = (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
        if (createdAt !== 0) return createdAt;
        return right.id.localeCompare(left.id);
      });
      return {
        ...current,
        ledger: { ...current.ledger, version: result.ledgerVersion },
        transactions,
        balance: result.balance,
        nextPayer: result.nextPayer,
      };
    });
  }, []);

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
    setActiveLedgerId: activateLedger,
    bootstrap,
    error,
    busy,
    context,
    loadContext,
    loadLedgers,
    loadBootstrap,
    applyCommittedTransaction,
    createLedger,
  };
}
