"use client";

import { useCallback, useEffect, useState } from "react";
import type { Bootstrap } from "@/lib/types";
import { applyOptimistic } from "@/lib/optimistic";
import type { ActionInput } from "@/lib/pending-action-types";
import { api, get } from "@/lib/api";

let mutationQueue = Promise.resolve();

interface ActionResult {
  result: string;
  actionType?: string;
  createdCount?: number;
}

export function useBootstrap() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
      const run = async () => {
        setBusy(true);
        try {
          if (opts.optimistic) setData((current) => current ? opts.optimistic!(current) : current);
          await api(path, body);
          if (opts.success) setError("");
          await load();
          return { success: true, message: opts.success };
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "操作失敗");
          // Never restore an old bootstrap snapshot: another mutation may
          // have committed while this request was in flight. Reconcile from
          // the server instead; if that also fails, keep the pending row and
          // let the next reload resolve it.
          try {
            await load();
          } catch {
            // The visible optimistic row is intentionally retained.
          }
          return { success: false, message: reason instanceof Error ? reason.message : "操作失敗" };
        } finally {
          setBusy(false);
        }
      };
      const result = mutationQueue.then(run, run);
      mutationQueue = result.then(() => undefined, () => undefined);
      return result;
    },
    [load],
  );

  const propose = useCallback(async (body: ActionInput) => {
    const run = async () => {
      setBusy(true);
      try {
        setData((current) => current ? applyOptimistic(current, body) as Bootstrap : current);
        const result = (await api("/api/app/actions", body)) as unknown as ActionResult;
        setError("");
        await load();
        return { success: true, result };
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "操作失敗");
        try {
          await load();
        } catch {
          // Keep the pending marker until a later server reconciliation.
        }
        return { success: false };
      } finally {
        setBusy(false);
      }
    };
    const result = mutationQueue.then(run, run);
    mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }, [load]);

  const reset = useCallback(() => {
    setData(null);
    setError("");
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
    setError,
    load,
    reload,
    mutate,
    propose,
    reset,
  };
}
