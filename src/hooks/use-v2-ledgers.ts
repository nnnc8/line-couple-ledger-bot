"use client";

import { useCallback, useEffect, useState } from "react";
import { api, get } from "@/lib/api";
import type { V2AppContext, V2LedgerBootstrap, V2LedgerSummary } from "@/lib/types";

export function useV2Ledgers(enabled = true) {
  const [ledgers, setLedgers] = useState<V2LedgerSummary[]>([]);
  const [activeLedgerId, setActiveLedgerId] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<V2LedgerBootstrap | null>(null);
  const [context, setContext] = useState<V2AppContext | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadLedgers = useCallback(async () => {
    const result = await get<{ ledgers: V2LedgerSummary[] }>("/api/app/v2/ledgers");
    setError("");
    setLedgers(result.ledgers);
    setActiveLedgerId((current) => current && result.ledgers.some((ledger) => ledger.id === current)
      ? current
      : result.ledgers.find((ledger) => ledger.status === "active")?.id ?? null);
    return result.ledgers;
  }, []);

  const loadContext = useCallback(async () => {
    const result = await get<V2AppContext>("/api/app/v2/context");
    setError("");
    setContext(result);
    return result;
  }, []);

  const loadBootstrap = useCallback(async (ledgerId: string) => {
    const result = await get<V2LedgerBootstrap>(`/api/app/v2/ledgers/${ledgerId}/bootstrap`);
    setBootstrap(result);
    return result;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => {
      void loadLedgers().catch((reason) => setError(reason instanceof Error ? reason.message : "無法讀取帳本"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [enabled, loadLedgers]);

  useEffect(() => {
    if (!enabled) return;
    if (!activeLedgerId) {
      return;
    }
    const timer = window.setTimeout(() => {
      void loadBootstrap(activeLedgerId).catch((reason) => setError(reason instanceof Error ? reason.message : "無法讀取 Ledger"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeLedgerId, enabled, loadBootstrap]);

  const activateLedger = useCallback(async (ledgerId: string) => {
    setActiveLedgerId(ledgerId);
    try {
      await api(`/api/app/v2/ledgers/${ledgerId}/activate`, {});
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "無法切換 Ledger");
      throw reason;
    }
  }, []);

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
    createLedger,
  };
}
