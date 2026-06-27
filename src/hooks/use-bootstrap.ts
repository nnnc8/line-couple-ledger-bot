"use client";

import { useCallback, useEffect, useState } from "react";
import type { Bootstrap } from "@/lib/types";
import { applyOptimistic, type PendingActionInput } from "@/lib/optimistic";
import { api, get } from "@/lib/api";

interface Proposal {
  actionId: string;
  preview: string;
  action?: PendingActionInput;
}

interface DecideResult {
  result: string;
  actionType?: string;
  createdCount?: number;
}

export function useBootstrap() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);

  const load = useCallback(async () => {
    const result = await get<Bootstrap>("/api/app/bootstrap");
    setData(result);
    return true;
  }, []);

  const reload = useCallback(async () => {
    try {
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "無法重新載入");
    }
  }, [load]);

  const mutate = useCallback(
    async (
      path: string,
      body: unknown,
      opts: { success?: string; optimistic?: (d: Bootstrap) => Bootstrap } = {},
    ) => {
      setBusy(true);
      try {
        if (opts.optimistic && data) setData(opts.optimistic(data));
        await api(path, body);
        if (opts.success) setError("");
        await load();
        return { success: true, message: opts.success };
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "操作失敗");
        if (data) setData(data);
        return { success: false, message: reason instanceof Error ? reason.message : "操作失敗" };
      } finally {
        setBusy(false);
      }
    },
    [data, load],
  );

  const propose = useCallback(async (body: PendingActionInput) => {
    setBusy(true);
    try {
      const result = (await api("/api/app/actions", body)) as unknown as Proposal;
      setProposal({ ...result, action: body });
      return { success: true };
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失敗");
      return { success: false };
    } finally {
      setBusy(false);
    }
  }, []);

  const proposeExternal = useCallback(
    (preview: Proposal) => {
      setProposal(preview);
    },
    [],
  );

  const decide = useCallback(
    async (confirm: boolean): Promise<DecideResult | null> => {
      if (!proposal) return null;
      const current = proposal;
      setProposal(null);
      setBusy(true);
      if (!confirm) {
        try {
          await api("/api/app/actions/confirm", {
            actionId: current.actionId,
            confirm: false,
          });
          setError("");
          return { result: "cancelled" };
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "操作失敗");
          return null;
        } finally {
          setBusy(false);
        }
      }
      const snapshot = data;
      if (snapshot && current.action) {
        setData(applyOptimistic(snapshot, current.action) as Bootstrap);
      }
      try {
        const result = (await api("/api/app/actions/confirm", {
          actionId: current.actionId,
          confirm: true,
        })) as unknown as DecideResult;
        if (result.result === "confirmed") {
          await load();
          return result;
        }
        if (snapshot) setData(snapshot);
        return result;
      } catch (reason) {
        if (snapshot) setData(snapshot);
        setError(reason instanceof Error ? reason.message : "操作失敗");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [proposal, data, load],
  );

  const reset = useCallback(() => {
    setData(null);
    setError("");
    setProposal(null);
  }, []);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(""), 4000);
    return () => window.clearTimeout(timer);
  }, [error]);

  return {
    data,
    error,
    busy,
    proposal,
    setProposal: proposeExternal,
    setError,
    load,
    reload,
    mutate,
    propose,
    decide,
    reset,
  };
}