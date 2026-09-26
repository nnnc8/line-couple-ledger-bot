"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, get } from "@/lib/api";
import { correctionDraft, currentEntryDate, DraftValidationError, newTransactionDraft, type DraftFields, type TransactionDraft } from "@/lib/v2-transaction-draft";
import { ENTRY_RECOVERY_KEY, classifyWriteFailure, freezeOperation, parseCommitProof, readRecovery, recoveryMatches, writeRecovery, type CommitProof, type EntryOperation, type ReadFreshness, type WriteOutcome } from "@/lib/v2-entry-operation";
import type { V2AppContext, V2LedgerBootstrap, V2LedgerSummary, V2LedgerTransaction } from "@/lib/types";

type Session = {
  draft: TransactionDraft | null;
  write: WriteOutcome;
  operation: EntryOperation | null;
  error: string;
  field?: keyof DraftFields;
  blocked: string;
  pendingDestination: string | null;
};
const initial: Session = { draft: null, write: "idle", operation: null, error: "", blocked: "", pendingDestination: null };
const storageError = "這次畫面無法保留送出結果，請重新開啟後再試。尚未送出，輸入內容仍保留。";

export function useV2EntrySession({ context, bootstrap, read, accessDenied, acceptProof, refresh }: {
  context: V2AppContext | null;
  bootstrap: V2LedgerBootstrap | null;
  read: ReadFreshness;
  accessDenied: boolean;
  acceptProof: (proof: CommitProof) => boolean;
  refresh: (ledgerId: string) => Promise<unknown>;
}) {
  const [session, setSession] = useState<Session>(initial);
  const operationRef = useRef<EntryOperation | null>(null);
  const pendingRecovery = useRef<EntryOperation | null>(null);
  const initialized = useRef(false);
  const inFlight = useRef(false);

  const initialize = useCallback((actorId: string, ledgers: V2LedgerSummary[], requestedId: string | null) => {
    initialized.current = true;
    const active = ledgers.filter(ledger => ledger.status === "active");
    const target = requestedId ?? active.find(ledger => ledger.activeForUser)?.id ?? active[0]?.id ?? null;
    const targetAllowed = !target || active.some(ledger => ledger.id === target);
    const selectTarget = () => {
      if (targetAllowed) return target;
      setSession(current => ({ ...current, blocked: "這本帳本無法開啟，可能已失效或你沒有權限。" }));
      return null;
    };
    try { window.sessionStorage.getItem(ENTRY_RECOVERY_KEY); }
    catch {
      setSession(current => ({ ...current, error: storageError }));
      return selectTarget();
    }
    let record: EntryOperation | null;
    try { record = readRecovery(window.sessionStorage); }
    catch {
      // Access failure and unreadable existing data must not silently become a new operation.
      setSession(current => ({ ...current, blocked: "這次畫面無法讀取已送出的操作紀錄。請保留此頁並重新開啟或登入原帳號。" }));
      return targetAllowed ? target : null;
    }
    if (!record) return selectTarget();
    if (record.actorUserId !== actorId || !active.some(ledger => ledger.id === record.ledgerId)) {
      setSession(current => ({ ...current, blocked: "有一筆操作屬於其他登入身分或無法存取的帳本。請以原帳號重新登入後確認；此頁不會重送。" }));
      return targetAllowed ? target : null;
    }
    pendingRecovery.current = record;
    setSession(current => ({ ...current, pendingDestination: targetAllowed && target !== record.ledgerId ? target : null,
      error: targetAllowed ? "" : "連結指定的帳本目前無法開啟，請先確認原帳本已送出的這筆操作。" }));
    return record.ledgerId;
  }, []);

  useEffect(() => {
    if (!initialized.current || !context || !bootstrap || session.blocked) return;
    const recovered = pendingRecovery.current;
    if (recovered) {
      pendingRecovery.current = null;
      if (!recoveryMatches(recovered, context.user.id, bootstrap)) {
        setSession(current => ({ ...current, blocked: "已送出的操作與目前身分／帳本不符。請重新登入原帳號；此頁不會重送。" }));
        return;
      }
      operationRef.current = recovered;
      setSession(current => ({ ...current, draft: null, operation: recovered, write: recovered.phase === "committed" ? "committed" : "unknown" }));
      if (recovered.proof) {
        acceptProof(recovered.proof);
        // A recovered historical receipt is never assumed to describe current state.
        void refresh(recovered.ledgerId).catch(() => undefined);
      }
      return;
    }
    // Creating a Ledger is asynchronous: an empty draft may reopen in the old
    // scope before activation finishes. Only carry an editable draft in its scope.
    const needsDraft = !session.draft || !session.draft.dirty && session.draft.ledgerId !== bootstrap.ledger.id;
    if (needsDraft && session.write !== "unknown" && session.write !== "submitting") {
      setSession(current => ({ ...current, draft: newTransactionDraft(bootstrap, context.user.id, currentEntryDate(), crypto.randomUUID()) }));
    }
  }, [context, bootstrap, session.blocked, session.draft, session.write, acceptProof, refresh]);

  useEffect(() => {
    const operation = session.operation;
    if (session.write !== "committed" || !operation?.proof || read !== "ready" || !bootstrap || bootstrap.ledger.id !== operation.ledgerId) return;
    const tx = bootstrap.transactions.find(row => row.id === operation.proof!.transaction.id);
    if (!tx || (tx.version ?? 1) < (operation.proof.transaction.version ?? 1) || bootstrap.ledger.version < (operation.proof.ledgerVersion ?? 0)) return;
    try {
      const stored = readRecovery(window.sessionStorage);
      if (stored?.idempotencyKey === operation.idempotencyKey) window.sessionStorage.removeItem(ENTRY_RECOVERY_KEY);
    } catch { /* Keep the receipt marker if clearing fails. A future reload can safely replay/read it. */ }
  }, [session.operation, session.write, bootstrap, read]);

  function updateDraft(patch: Partial<DraftFields>) {
    if (inFlight.current || accessDenied || session.blocked || session.write === "unknown") return;
    setSession(current => current.draft ? { ...current, draft: { ...current.draft, ...patch, dirty: true },
      write: current.write === "committed" ? "idle" : current.write, operation: current.write === "committed" ? null : current.operation, error: "", field: undefined } : current);
    if (session.write === "committed") operationRef.current = null;
  }

  function mayLeaveDraft() {
    if (inFlight.current || accessDenied || session.blocked || session.write === "unknown" || session.write === "submitting") return false;
    if (session.draft?.dirty && !window.confirm("目前有尚未送出的內容。確定放棄這筆輸入？取消可保留。")) return false;
    setSession(current => ({ ...current, draft: null, error: "", field: undefined }));
    if (session.write !== "committed") {
      operationRef.current = null;
      setSession(current => ({ ...current, write: "idle", operation: null }));
    }
    return true;
  }

  function openCorrection(transaction: V2LedgerTransaction) {
    if (!context || !bootstrap || !mayLeaveDraft()) return false;
    try {
      const draft = correctionDraft(bootstrap, context.user.id, context.today, crypto.randomUUID(), transaction);
      operationRef.current = null;
      setSession(current => ({ ...current, draft, write: "idle", operation: null }));
      return true;
    } catch (reason) {
      setSession(current => ({ ...current, error: reason instanceof Error ? reason.message : "目前無法修改" }));
      return false;
    }
  }

  async function dispatch(replay: boolean) {
    if (inFlight.current || accessDenied || session.blocked || !context || !bootstrap) return;
    if (replay ? session.write !== "unknown" : session.write === "unknown" || session.write === "committed" && !session.draft?.dirty) return;
    inFlight.current = true;
    let operation: EntryOperation;
    try {
      if (replay) {
        if (!operationRef.current) return;
        // Session cookies can change while this document remains open. Recheck
        // the authenticated actor before replaying an older submitted operation.
        const currentContext = await get<V2AppContext>("/api/app/v2/context");
        if (currentContext.user.id !== operationRef.current.actorUserId) {
          setSession(current => ({ ...current, blocked: "登入身分已變更。請重新登入原帳號後確認這筆操作；此頁不會重送。" }));
          return;
        }
        operation = { ...operationRef.current, phase: "submitting", hadUnknown: true };
      } else {
        if (!session.draft) return;
        const previous = operationRef.current;
        operation = freezeOperation(session.draft, previous?.idempotencyKey ?? crypto.randomUUID(), new Date().toISOString());
        if (previous && (previous.endpoint !== operation.endpoint || JSON.stringify(previous.body) !== JSON.stringify(operation.body))) operation = freezeOperation(session.draft, crypto.randomUUID(), operation.submittedAt);
      }
      if (!recoveryMatches(operation, context.user.id, bootstrap)) {
        setSession(current => ({ ...current, blocked: "操作與目前身分／帳本不符，無法送出。" }));
        return;
      }
      try { writeRecovery(window.sessionStorage, operation); }
      catch { setSession(current => ({ ...current, error: replay ? "目前無法保留確認結果，請重新開啟後再試。原操作仍待確認。" : storageError })); return; }
      operationRef.current = operation;
      setSession(current => ({ ...current, operation, write: "submitting", error: "", field: undefined }));
      let response: unknown;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 30_000);
      try { response = await api(operation.endpoint, operation.body, { signal: controller.signal }); }
      catch (reason) {
        const outcome = classifyWriteFailure(reason, operation);
        const pending: EntryOperation = { ...operation, phase: "unknown", hadUnknown: outcome === "unknown" };
        operationRef.current = outcome === "unknown" ? pending : operation;
        try {
          if (outcome === "rejected") window.sessionStorage.removeItem(ENTRY_RECOVERY_KEY);
          else writeRecovery(window.sessionStorage, pending);
        } catch { /* The pre-dispatch marker already preserves the exact operation. */ }
        setSession(current => ({ ...current, operation: operationRef.current, write: outcome, error: outcome === "rejected" && reason instanceof Error ? reason.message : "" }));
        return;
      }
      finally { window.clearTimeout(timeout); }
      const proof = parseCommitProof(response, operation);
      if (!proof) {
        const unknown: EntryOperation = { ...operation, phase: "unknown", hadUnknown: true };
        operationRef.current = unknown;
        try { writeRecovery(window.sessionStorage, unknown); } catch { /* Pre-dispatch marker remains safe. */ }
        setSession(current => ({ ...current, operation: unknown, write: "unknown", error: "" }));
        return;
      }
      const committed: EntryOperation = { ...operation, phase: "committed", proof };
      operationRef.current = committed;
      try { writeRecovery(window.sessionStorage, committed); } catch { /* Commit is known even if updating storage fails. */ }
      setSession(current => ({ ...current, operation: committed, write: "committed", draft: null, error: "", field: undefined }));
      const complete = acceptProof(proof);
      if (!complete) void refresh(operation.ledgerId).catch(() => undefined);
    } catch (reason) {
      setSession(current => ({ ...current, error: reason instanceof Error ? reason.message : "請檢查輸入內容", field: reason instanceof DraftValidationError ? reason.field : undefined }));
    } finally { inFlight.current = false; }
  }

  return {
    ...session, draftState: session.draft?.dirty ? "dirty" as const : "empty" as const, read,
    blocked: accessDenied ? "目前無法驗證這本帳本的存取權限。已保留操作結果；請重新登入後確認。" : session.blocked,
    locked: accessDenied || Boolean(session.blocked) || session.write === "submitting" || session.write === "unknown",
    initialize, updateDraft, mayLeaveDraft, openCorrection,
    submit: () => dispatch(false), replay: () => dispatch(true),
    retryRead: () => bootstrap ? refresh(bootstrap.ledger.id).catch(() => undefined) : Promise.resolve(),
    clearDestination: () => setSession(current => ({ ...current, pendingDestination: null })),
  };
}

export type V2EntrySession = ReturnType<typeof useV2EntrySession>;
