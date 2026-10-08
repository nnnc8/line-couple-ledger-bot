"use client";

import * as React from "react";
import { flushSync } from "react-dom";
import { ChevronDown, MoreHorizontal, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { V2LedgerSwitcher } from "@/components/ledger/v2-ledger-switcher";
import { Input } from "@/components/ui/input";
import { V2LedgerHome, type SettingsLeaveGuard } from "@/components/ledger/v2-ledger-home";
import { V2EntryControls } from "@/components/ledger/v2-entry-controls";
import type { EntryControlSurface } from "@/components/ledger/v2-transaction-editor";
import { QuickEntry } from "@/components/ledger/quick-entry";
import { entryCompletionTarget } from "@/lib/v2-entry-completion";
import { LedgerSurfaceHost } from "@/components/ledger/ledger-surface-host";
import { useV2Ledgers } from "@/hooks/use-v2-ledgers";
import { useV2EntrySession } from "@/hooks/use-v2-entry-session";
import { api } from "@/lib/api";
import { appOrigin, ledgerHome, navigationHistoryState, navigationParams, navigationUrl, parseNavigation, resolveLedgerTarget, searchKeys, type V2Navigation, type V2Surface } from "@/lib/v2-navigation";
import type { V2Category, V2LedgerTransaction } from "@/lib/types";
import { effectiveTimelineTransactions, TIMELINE_PAGE_SIZE } from "@/lib/v2-timeline";
import { resourceId } from "@/lib/v2-entry-operation";
import { currentEntryDate } from "@/lib/v2-transaction-draft";

declare global {
  interface Window {
    liff?: {
      init(input: { liffId: string; withLoginOnExternalBrowser?: boolean }): Promise<void>;
      isLoggedIn(): boolean;
      login(input?: { redirectUri?: string }): void;
      getIDToken(): string | null;
      isInClient(): boolean;
      closeWindow(): void;
    };
  }
}

function waitForLiffSdk(timeoutMs = 10_000): Promise<NonNullable<Window["liff"]>> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (window.liff) return resolve(window.liff);
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error("LIFF SDK 載入失敗"));
      window.setTimeout(check, 50);
    };
    check();
  });
}

type Intent = { kind: "navigate"; nav: V2Navigation; mode: "push" | "replace"; manual?: boolean; state?: unknown; rowId?: string }
  | { kind: "quick-entry" } | { kind: "close" } | { kind: "correction"; transaction: V2LedgerTransaction } | { kind: "create" };
type ScrollMemory = { rowId?: string; neighbors: string[]; offset: number; y: number };
const titles: Record<V2Surface, string> = { HOME: "", TRANSACTION_DETAIL: "紀錄詳情", STATS: "收支概況", SETTINGS: "帳本設定", RECURRING: "固定記帳", SEARCH: "搜尋紀錄", PROPOSAL_COMPAT_ENTRY: "LINE 待確認草稿" };

export function V2LiffHome() {
  const v2 = useV2Ledgers();
  const entry = useV2EntrySession({ context: v2.context, bootstrap: v2.bootstrap, read: v2.read, accessDenied: v2.accessDenied, acceptProof: v2.acceptCommitProof, refresh: v2.loadBootstrap });
  const [nav, setNav] = React.useState<V2Navigation | null>(null);
  const [error, setError] = React.useState("");
  const [targetError, setTargetError] = React.useState<"ledger" | "transaction-scope" | null>(null);
  const [timelineWindows, setTimelineWindows] = React.useState<Record<string, number>>({});
  const scopeError = targetError ?? (v2.accessDenied && !v2.authError ? "ledger" : null);
  const [settingsGuard, setSettingsGuard] = React.useState<SettingsLeaveGuard | null>(null);
  const [dialog, setDialog] = React.useState<"switcher" | "leave" | "create" | "quick-entry" | "home-more" | EntryControlSurface | null>(null);
  const [quickEntryActive, setQuickEntryActive] = React.useState(false);
  const [entryCategories, setEntryCategories] = React.useState<V2Category[]>([]);
  const quickTrigger = React.useRef<HTMLElement | null>(null);
  const quickOrigin = React.useRef<{ ledgerId: string; y: number; generation: number } | null>(null);
  const quickFocus = React.useRef({ selector: '[data-entry-field="amountTwd"]', scrollTop: 0 });
  const handledCreate = React.useRef<string | null>(null);
  const [completion, setCompletion] = React.useState<{ ledgerId: string; id: string; kind: "row" | "detail" } | null>(null);
  const completionFocus = React.useRef<{ ledgerId: string; id: string; kind: "row" | "detail" } | null>(null);
  const [pending, setPending] = React.useState<Intent | null>(null);
  const pendingRef = React.useRef<Intent | null>(null);
  const [newLedgerName, setNewLedgerName] = React.useState("");
  const [createError, setCreateError] = React.useState("");
  const createInFlight = React.useRef(false);
  const [leaveRevision, setLeaveRevision] = React.useState(0);
  const started = React.useRef(false);
  const [loginAttempt, setLoginAttempt] = React.useState(0);
  const [createdLedger, setCreatedLedger] = React.useState<{ id: string; generation: number } | null>(null);
  const navigationGeneration = React.useRef(0);
  const documentId = React.useRef("");
  const writingHistory = React.useRef(false);
  const accepted = React.useRef<{ url: string; state: unknown }>({ url: "/", state: null });
  const scroll = React.useRef(new Map<string, ScrollMemory>());
  const trigger = React.useRef<HTMLElement | null>(null);
  const editingField = React.useRef<HTMLElement | null>(null);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const focusRequest = React.useRef<{ ledgerId: string | null; list: boolean; rowId?: string; headingDone?: boolean } | null>(null);
  const correctionDetailOrigin = React.useRef<{ ledgerId: string; transactionId: string } | null>(null);

  function writeUrl(next: V2Navigation, mode: "push" | "replace", state: unknown) {
    const url = navigationUrl(next, window.location.href);
    writingHistory.current = true;
    try {
      const input = state && typeof state === "object" ? { ...state } as Record<string, unknown> : {};
      // Next 16 treats these flags as an INTERNAL write and skips query sync.
      // Its public history bridge copies both flags back from the current entry.
      delete input.__NA;
      delete input._N;
      window.history[mode === "push" ? "pushState" : "replaceState"](input, "", url);
    }
    finally { writingHistory.current = false; }
    accepted.current = { url, state: window.history.state };
  }

  function memoryKey(location: V2Navigation) {
    return JSON.stringify([location.ledgerId, location.surface, location.surface === "SEARCH" ? searchKeys.map(key => location.filters[key] ?? "") : []]);
  }
  function rememberOrigin(rowId?: string) {
    if (!nav || !["HOME", "SEARCH"].includes(nav.surface) || !nav.ledgerId) return;
    const rows = [...document.querySelectorAll<HTMLElement>("[data-transaction-id]")];
    const row = rows.find(node => node.dataset.transactionId === rowId) ?? rows.find(node => node.getBoundingClientRect().bottom > 0);
    const position = row ? rows.indexOf(row) : -1;
    const neighbors = position < 0 ? [] : [...rows.slice(position + 1), ...rows.slice(0, position).reverse()].map(node => node.dataset.transactionId!);
    scroll.current.set(memoryKey(nav), { rowId: row?.dataset.transactionId, neighbors, offset: row?.getBoundingClientRect().top ?? 0, y: window.scrollY });
  }

  function apply(intent: Intent) {
    if (intent.kind === "navigate" && intent.state === undefined && nav?.surface === "TRANSACTION_DETAIL" && ["HOME", "SEARCH"].includes(intent.nav.surface)
      && typeof document.startViewTransition === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // The browser snapshots the departing Detail; the destination is usable as
      // soon as it commits, while CSS fades only that snapshot for 140ms.
      const transition = document.startViewTransition(() => { flushSync(() => applyAccepted(intent)); });
      void transition.ready.catch(() => undefined);
      return;
    }
    applyAccepted(intent);
  }

  function applyAccepted(intent: Intent) {
    pendingRef.current = null;
    setPending(null);
    if (intent.kind === "create") { setQuickEntryActive(false); quickOrigin.current = null; setNewLedgerName(""); setCreateError(""); setDialog("create"); return; }
    if (intent.kind === "quick-entry") {
      if (!nav?.ledgerId || !entry.openCreateDraft()) return;
      quickOrigin.current = { ledgerId: nav.ledgerId, y: window.scrollY, generation: navigationGeneration.current };
      quickFocus.current = { selector: '[data-entry-field="amountTwd"]', scrollTop: 0 };
      returnFocus.current = quickTrigger.current;
      setCompletion(null); setQuickEntryActive(true); setDialog("quick-entry"); return;
    }
    if (intent.kind === "close" && quickEntryActive) {
      quickOrigin.current = null; returnFocus.current = quickTrigger.current;
      setQuickEntryActive(false); setDialog(null); return;
    }
    if (intent.kind === "close") { correctionDetailOrigin.current = null; setDialog(null); requestAnimationFrame(() => (document.querySelector<HTMLElement>('[data-testid="transaction-edit"]') ?? document.querySelector<HTMLElement>("[data-detail-heading]"))?.focus({ preventScroll: true })); return; }
    if (intent.kind === "correction") {
      setQuickEntryActive(false); quickOrigin.current = null;
      if (entry.openCorrection(intent.transaction, true)) correctionDetailOrigin.current = { ledgerId: intent.transaction.ledgerId, transactionId: intent.transaction.id };
      setDialog(null);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="金額，新臺幣"]')?.focus());
      return;
    }
    navigationGeneration.current += 1;
    setQuickEntryActive(false); quickOrigin.current = null;
    rememberOrigin(intent.rowId);
    const resolved = resolveLedgerTarget(intent.nav, v2.ledgers);
    const next = resolved.error ? intent.nav : { ...intent.nav, ledgerId: resolved.ledgerId, explicitLedger: resolved.ledgerId !== null };
    if (next.surface !== "TRANSACTION_DETAIL" || next.ledgerId !== correctionDetailOrigin.current?.ledgerId || next.transactionId !== correctionDetailOrigin.current?.transactionId) correctionDetailOrigin.current = null;
    const previousOrigin = appOrigin(accepted.current.state, documentId.current, nav?.ledgerId ?? null);
    const origin = intent.mode === "push" && nav && ["HOME", "SEARCH"].includes(nav.surface) && nav.ledgerId
      ? { version: 1 as const, documentId: documentId.current, ledgerId: nav.ledgerId, ...(intent.rowId ? { rowId: intent.rowId } : {}),
        ...(nav.surface === "SEARCH" ? { surface: "SEARCH" as const, filters: nav.filters } : {}) }
      : next.surface === "TRANSACTION_DETAIL" && previousOrigin?.ledgerId === next.ledgerId ? previousOrigin : null;
    const state = intent.state ?? navigationHistoryState(window.history.state, origin);
    const originRowId = intent.rowId ?? previousOrigin?.rowId;
    if (next.surface === "HOME" && next.ledgerId && v2.bootstrap?.ledger.id === next.ledgerId && originRowId) {
      const position = effectiveTimelineTransactions(v2.bootstrap.transactions).findIndex(row => row.id === originRowId);
      if (position >= 0) {
        const needed = Math.ceil((position + 1) / TIMELINE_PAGE_SIZE) * TIMELINE_PAGE_SIZE;
        const ledgerId = next.ledgerId;
        setTimelineWindows(current => ({ ...current, [ledgerId]: Math.max(current[ledgerId] ?? TIMELINE_PAGE_SIZE, needed) }));
      }
    }
    focusRequest.current = { ledgerId: next.ledgerId, list: ["HOME", "SEARCH"].includes(next.surface), rowId: intent.rowId ?? (["HOME", "SEARCH"].includes(next.surface) ? previousOrigin?.rowId : undefined) };
    // Clear old data and accept scope in the same update as URL/identity.
    v2.selectLedger(resolved.ledgerId);
    setTargetError(resolved.error);
    setNav(next);
    writeUrl(next, intent.mode, state);
    returnFocus.current = null;
    setDialog(null);
    if (intent.manual && resolved.ledgerId) void v2.activateLedger(resolved.ledgerId);
  }

  function leaveStatus() {
    const status = entry.leaveStatus();
    return status === "ready" && settingsGuard?.dirty ? "dirty" : status;
  }
  function discardInput() {
    if (!entry.discardDraft()) return false;
    settingsGuard?.discard();
    return true;
  }
  function rememberQuickFocus() {
    if (!quickEntryActive || dialog !== "quick-entry") return;
    const field = editingField.current;
    const selector = field?.dataset.entryField ? `[data-entry-field="${field.dataset.entryField}"]` : field?.getAttribute("aria-label") ? `[aria-label="${field.getAttribute("aria-label")}"]` : quickFocus.current.selector;
    quickFocus.current = { selector, scrollTop: document.getElementById("ledger-surface-dialog")?.scrollTop ?? 0 };
  }
  function request(intent: Intent) {
    if (intent.kind === "quick-entry" && entry.draft?.operationType === "create" && entry.draft.dirty && !entry.locked) { apply(intent); return; }
    const status = leaveStatus();
    if (status !== "ready") {
      rememberQuickFocus();
      pendingRef.current = intent;
      setPending(intent);
      setLeaveRevision(value => value + 1);
      if (!dialog) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDialog("leave");
      return;
    }
    discardInput();
    apply(intent);
  }

  const onHistory = React.useEffectEvent(() => {
    if (writingHistory.current || !nav) return;
    const url = `${location.pathname}${location.search}${location.hash}`;
    if (url === accepted.current.url) return;
    const intent: Intent = { kind: "navigate", nav: parseNavigation(location.search), mode: "replace", state: history.state };
    // A pop has already moved the URL. Restore the accepted truth while its leave
    // decision is pending. Acceptance replaces once; never push/forward traps.
    if (leaveStatus() !== "ready") {
      writingHistory.current = true;
      try {
        const state = { ...(accepted.current.state as Record<string, unknown>) };
        delete state.__NA; delete state._N;
        history.replaceState(state, "", accepted.current.url);
      }
      finally { writingHistory.current = false; }
    }
    request(intent);
  });
  const ready = nav !== null;
  React.useEffect(() => {
    if (!ready) return;
    const push = history.pushState, replace = history.replaceState;
    const observedPush: History["pushState"] = function (this: History, ...args) { push.apply(this, args); queueMicrotask(onHistory); };
    const observedReplace: History["replaceState"] = function (this: History, ...args) { replace.apply(this, args); queueMicrotask(onHistory); };
    history.pushState = observedPush;
    history.replaceState = observedReplace;
    window.addEventListener("popstate", onHistory);
    const restoration = history.scrollRestoration;
    history.scrollRestoration = "manual";
    return () => {
      if (history.pushState === observedPush) history.pushState = push;
      if (history.replaceState === observedReplace) history.replaceState = replace;
      history.scrollRestoration = restoration;
      window.removeEventListener("popstate", onHistory);
    };
  }, [ready]);

  React.useEffect(() => {
    if (!entry.draft?.dirty && !settingsGuard?.dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [entry.draft?.dirty, settingsGuard?.dirty]);

  React.useLayoutEffect(() => {
    const focus = focusRequest.current;
    if (!focus || nav?.ledgerId !== focus.ledgerId) return;
    if (!focus.list && nav.surface === "TRANSACTION_DETAIL" && v2.bootstrap?.ledger.id !== focus.ledgerId && !scopeError) {
      window.scrollTo(0, 0);
      if (v2.error) document.querySelector<HTMLElement>('[data-testid="surface-heading"]')?.focus({ preventScroll: true });
      // Retain the request through a failed first read. A successful retry must
      // focus the real Detail heading rather than the removed retry control.
      return;
    }
    const heading = document.querySelector<HTMLElement>(nav?.surface === "TRANSACTION_DETAIL" ? '[data-detail-heading], [data-testid="surface-heading"]' : '[data-testid="surface-heading"]');
    const detailHeading = nav?.surface === "TRANSACTION_DETAIL" ? document.querySelector<HTMLElement>("[data-detail-heading]") : null;
    if (!focus.headingDone) { (detailHeading ?? heading)?.focus({ preventScroll: true }); focus.headingDone = true; }
    if (focus.list && v2.bootstrap?.ledger.id !== focus.ledgerId && !scopeError) return;
    if (!focus.list) { window.scrollTo(0, 0); focusRequest.current = null; return; }
    const restoreList = (delayed = false) => {
      if (focusRequest.current !== focus) return true;
      if (nav.surface === "SEARCH" && document.querySelector('[data-search-ready="false"]')) return false;
      if (delayed && document.activeElement !== heading && document.activeElement !== document.body) { focusRequest.current = null; return true; }
      const memory = scroll.current.get(memoryKey(nav));
      const rows = [...document.querySelectorAll<HTMLElement>("[data-transaction-id]")];
      const nearest = memory?.neighbors.map(id => rows.find(node => node.dataset.transactionId === id)).find(Boolean);
      const anchor = rows.find(node => node.dataset.transactionId === memory?.rowId) ?? nearest;
      window.scrollTo(0, anchor && memory ? window.scrollY + anchor.getBoundingClientRect().top - memory.offset : memory?.y ?? 0);
      const row = rows.find(node => node.dataset.transactionId === focus.rowId);
      if (document.activeElement === heading && focus.rowId) (row ?? nearest ?? rows[0] ?? document.querySelector<HTMLElement>("[data-timeline-date]") ?? heading)?.focus({ preventScroll: true });
      focusRequest.current = null;
      return true;
    };
    if (restoreList()) return;
    const observer = new MutationObserver(() => { if (restoreList(true)) observer.disconnect(); });
    observer.observe(document.querySelector("main") ?? document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-search-ready"] });
    return () => observer.disconnect();
  }, [nav, v2.bootstrap, scopeError, v2.error]);

  const showCorrectedDetail = React.useEffectEvent(() => {
    const operation = entry.operation;
    if (entry.write === "submitting" && operation?.operationType === "replace" && nav?.surface === "TRANSACTION_DETAIL"
      && operation.ledgerId === nav.ledgerId && resourceId(operation) === nav.transactionId) {
      correctionDetailOrigin.current = { ledgerId: operation.ledgerId, transactionId: nav.transactionId! };
    }
    const proof = entry.write === "committed" && entry.operation?.operationType === "replace" ? entry.operation.proof : null;
    if (nav?.surface !== "TRANSACTION_DETAIL" || !proof || proof.transaction.ledgerId !== nav.ledgerId || proof.replacedTransactionId !== nav.transactionId
      || correctionDetailOrigin.current?.ledgerId !== nav.ledgerId || correctionDetailOrigin.current.transactionId !== nav.transactionId) return;
    correctionDetailOrigin.current = null;
    const next = { ...nav, transactionId: proof.transaction.id };
    focusRequest.current = { ledgerId: next.ledgerId, list: false };
    setNav(next);
    writeUrl(next, "replace", history.state);
  });
  React.useEffect(() => { showCorrectedDetail(); }, [entry.write, entry.operation, nav]);

  const showCreatedTransaction = React.useEffectEvent(() => {
    const operation = entry.operation;
    if (entry.write !== "committed" || operation?.operationType !== "create" || !operation.proof || handledCreate.current === operation.idempotencyKey) return;
    handledCreate.current = operation.idempotencyKey;
    const transaction = operation.proof.transaction;
    if (!nav || transaction.ledgerId !== nav.ledgerId || scopeError) return;
    const origin = quickOrigin.current;
    const moved = !origin || origin.ledgerId !== nav.ledgerId || origin.generation !== navigationGeneration.current || Math.abs(window.scrollY - origin.y) > 2 || document.hidden;
    const target = entryCompletionTarget({ transaction, transactions: v2.bootstrap?.transactions ?? [], today: currentEntryDate(), surface: nav.surface, moved,
      visibleCount: timelineWindows[nav.ledgerId ?? ""] ?? TIMELINE_PAGE_SIZE });
    if (target.kind === "row") {
      const ledgerId = transaction.ledgerId;
      setTimelineWindows(current => ({ ...current, [ledgerId]: target.visibleCount }));
    }
    const result = { ledgerId: transaction.ledgerId, id: transaction.id, kind: target.kind };
    setCompletion(result);
    if (origin && !document.hidden) completionFocus.current = result;
    if (quickEntryActive) {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      returnFocus.current = null;
      quickOrigin.current = null;
      if (pendingRef.current?.kind !== "navigate") { pendingRef.current = null; setPending(null); }
      setQuickEntryActive(false); setDialog(null);
    }
  });
  React.useLayoutEffect(() => { showCreatedTransaction(); }, [entry.write, entry.operation, v2.bootstrap, nav]);
  React.useLayoutEffect(() => {
    const target = completionFocus.current;
    if (!target || dialog || nav?.ledgerId !== target.ledgerId || document.hidden) return;
    completionFocus.current = null;
    const node = target.kind === "row" ? document.querySelector<HTMLElement>(`button[data-transaction-id="${target.id}"]`) : document.querySelector<HTMLElement>('[data-testid="entry-view-created"]');
    if (!node) return;
    node.focus({ preventScroll: true });
    if (target.kind === "row") {
      const rect = node.getBoundingClientRect();
      const top = document.querySelector('[data-testid="home-entry-status"]')?.getBoundingClientRect().bottom ?? 0;
      const bottom = document.querySelector('[data-testid="home-entry-action"]')?.getBoundingClientRect().top ?? innerHeight;
      const adjustment = rect.top < top ? rect.top - top - 8 : rect.bottom > bottom ? rect.bottom - bottom + 8 : 0;
      if (adjustment) window.scrollBy(0, adjustment);
    }
  }, [dialog, completion, nav, timelineWindows]);

  const startLiff = React.useEffectEvent(async () => {
    const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
    if (!liffId) throw new Error("尚未設定 LIFF ID");
    const liff = await waitForLiffSdk();
    try { await liff.init({ liffId }); } catch { throw new Error("LIFF 初始化失敗"); }
    if (!liff.isLoggedIn()) {
      if (liff.isInClient()) throw new Error("請在 LINE 內重新開啟此帳本。");
      liff.login({ redirectUri: window.location.href });
      return;
    }
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error("LINE 未提供登入憑證");
    const invite = navigationParams(location.search).get("invite");
    await api("/api/app/session", { idToken, ...(invite ? { invite } : {}) });
    const context = await v2.loadContext();
    const ledgers = await v2.loadLedgers(undefined, true);
    const incoming = parseNavigation(location.search);
    const resolved = resolveLedgerTarget(incoming, ledgers);
    const initialLedger = entry.initialize(context.user.id, ledgers, incoming.ledgerId);
    const recoveryLedger = entry.recoveryLedger();
    const ledgerId = recoveryLedger ?? resolved.ledgerId;
    const next = recoveryLedger && (recoveryLedger !== incoming.ledgerId || resolved.error)
      ? ledgerHome(recoveryLedger) : resolved.error ? incoming : { ...incoming, ledgerId: initialLedger, explicitLedger: initialLedger !== null };
    if (recoveryLedger && incoming.ledgerId !== recoveryLedger && !resolved.error) {
      const destination: Intent = { kind: "navigate", nav: { ...incoming, ledgerId: resolved.ledgerId, explicitLedger: true }, mode: "replace" };
      pendingRef.current = destination;
      setPending(destination);
    }
    documentId.current = crypto.randomUUID();
    v2.selectLedger(ledgerId);
    setTargetError(recoveryLedger ? null : resolved.error);
    setNav(next);
    focusRequest.current = { ledgerId: next.ledgerId, list: next.surface === "HOME" };
    // Initialization is the first permitted URL mutation, after liff.init resolves.
    writeUrl(next, "replace", navigationHistoryState(history.state, null));
  });
  React.useEffect(() => {
    if (started.current && loginAttempt === 0) return;
    started.current = true;
    void startLiff().catch(reason => setError(reason instanceof Error ? reason.message : "LIFF 初始化失敗"));
  }, [loginAttempt]);

  const completeCreation = React.useEffectEvent((created: { id: string; generation: number }) => {
    if (created.generation !== navigationGeneration.current) return;
    // Completion rechecks the current draft and latest accepted destination.
    request({ kind: "navigate", nav: ledgerHome(created.id), mode: "replace", manual: true });
  });
  React.useEffect(() => { if (createdLedger) completeCreation(createdLedger); }, [createdLedger]);

  function cancelDialog(keepDestination = false) {
    if (dialog === "quick-entry") { request({ kind: "close" }); return; }
    if (dialog === "create") {
      if (createInFlight.current) return;
      setNewLedgerName(""); setCreateError("");
      returnFocus.current = trigger.current;
      setDialog(nav?.ledgerId ? "switcher" : null);
      return;
    }
    if (dialog === "leave" && !keepDestination) {
      pendingRef.current = null;
      setPending(null);
      returnFocus.current = editingField.current?.isConnected ? editingField.current : returnFocus.current ?? trigger.current;
    } else if (dialog !== "payer" && dialog !== "split") returnFocus.current = trigger.current;
    setDialog(quickEntryActive ? "quick-entry" : null);
  }
  function openQuickEntry(origin: HTMLElement) {
    quickTrigger.current = origin;
    // Commit the host and its amount input during the opening user gesture.
    flushSync(() => request({ kind: "quick-entry" }));
  }
  function openEntryControls(surface: EntryControlSurface, target: HTMLElement) {
    if (entry.locked) return;
    returnFocus.current = target;
    if (quickEntryActive) quickFocus.current = { selector: `[data-testid="${surface}-summary"]`, scrollTop: document.getElementById("ledger-surface-dialog")?.scrollTop ?? 0 };
    setDialog(surface);
  }
  function openSurface(surface: V2Surface, transactionId: string | null = null) {
    if (!nav) return;
    request({ kind: "navigate", nav: { ...ledgerHome(nav.ledgerId), surface, transactionId }, mode: "push", rowId: transactionId ?? undefined });
  }
  function switchLedger(ledgerId: string) {
    request({ kind: "navigate", nav: ledgerHome(ledgerId), mode: "replace", manual: true });
  }
  function openCreate(origin?: HTMLElement) {
    if (!dialog) {
      trigger.current = origin ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      returnFocus.current = trigger.current;
    }
    request({ kind: "create" });
  }
  async function submitCreate(event: React.FormEvent) {
    event.preventDefault();
    const name = newLedgerName.trim();
    if (!name || name.length > 40 || createInFlight.current || v2.busy) return;
    createInFlight.current = true;
    const generation = navigationGeneration.current;
    setCreateError("");
    try {
      const result = await v2.createLedger(name);
      setNewLedgerName("");
      setCreatedLedger({ id: (result.ledger as { id: string }).id, generation });
    } catch (reason) {
      setCreateError(reason instanceof Error ? reason.message : "帳本暫時無法建立，請再試一次。");
    } finally { createInFlight.current = false; }
  }
  const ledgerName = (v2.bootstrap?.ledger.id === nav?.ledgerId ? v2.bootstrap?.ledger.name : null)
    ?? v2.ledgers.find(ledger => ledger.id === nav?.ledgerId)?.name ?? "";
  const identityTrigger = nav?.ledgerId && ledgerName && !scopeError ? <button type="button" tabIndex={0}
    aria-label={`${ledgerName}，目前查看，切換帳本`} aria-haspopup="dialog" aria-expanded={dialog !== null} aria-controls="ledger-surface-dialog"
    data-testid="ledger-name-trigger" onClick={event => { rememberQuickFocus(); trigger.current = event.currentTarget; returnFocus.current = event.currentTarget; setDialog("switcher"); }}
    className="inline-flex min-h-11 max-w-full min-w-0 items-center gap-2 rounded-lg py-2 text-left font-bold">
    <span className="min-w-0 [overflow-wrap:anywhere]">{ledgerName}</span><ChevronDown aria-hidden="true" className="size-4 shrink-0" />
  </button> : null;
  const createdTransaction = entry.write === "committed" && entry.operation?.operationType === "create" ? entry.operation.proof?.transaction : null;
  const leave = leaveStatus();
  const destinationName = pending?.kind === "navigate" && pending.manual ? v2.ledgers.find(ledger => ledger.id === pending.nav.ledgerId)?.name : null;
  const leaveTitle = leave === "submitting" ? `這筆正在加入『${ledgerName}』，完成後才能切換。`
    : leave === "unknown" ? "這筆的結果還沒確認，請先確認，再切換帳本。"
      : leave === "blocked" ? entry.blocked : settingsGuard?.dirty ? "放棄尚未儲存的設定？" : destinationName ? `放棄這筆輸入，切換到『${destinationName}』？` : "放棄這筆輸入？";

  if (!v2.context || !nav) return <main className="mx-auto flex min-h-dvh max-w-[640px] flex-col items-center justify-center gap-3 px-6 text-center"><h1 className="text-xl font-bold">共同帳本</h1><p>{error || "正在連線至 LINE…"}</p>{error ? <Button onClick={() => { setError(""); setLoginAttempt(value => value + 1); }}>重新登入</Button> : null}</main>;

  return <main className={`mx-auto min-h-dvh max-w-[640px] px-4 ${nav.surface === "HOME" ? "min-[380px]:px-5 pb-[calc(104px+env(safe-area-inset-bottom))]" : "pb-6"} pt-[max(16px,env(safe-area-inset-top))]`} onFocusCapture={event => {
    if (event.target instanceof HTMLElement && event.target.matches("[data-entry-field], input, select, textarea")) editingField.current = event.target;
  }}>
    <header className={nav.surface === "HOME" ? "mb-6 flex min-w-0 items-start gap-2" : "mb-3 space-y-2"}>
      {nav.surface !== "HOME" ? <Button data-testid="transaction-detail-back" aria-label="返回帳本" variant="ghost" size="sm" className="h-auto min-h-11 max-w-full whitespace-normal text-left [overflow-wrap:anywhere]" onClick={() => {
        const origin = nav.surface === "TRANSACTION_DETAIL" ? appOrigin(accepted.current.state, documentId.current, nav.ledgerId) : null;
        const destination = origin?.surface === "SEARCH" ? { ...ledgerHome(nav.ledgerId), surface: "SEARCH" as const, filters: origin.filters ?? {} } : ledgerHome(nav.ledgerId);
        request({ kind: "navigate", nav: destination, mode: "replace", rowId: origin?.rowId });
      }}>‹ {ledgerName}</Button> : null}
      <h1 tabIndex={-1} data-testid="surface-heading" className={`${nav.surface === "HOME" ? "min-w-0 flex-1 text-[1.375rem] leading-7 focus:outline-none" : "text-xl"} font-bold [overflow-wrap:anywhere]`}>{scopeError ? "連結無法開啟" : nav.surface === "HOME" ? identityTrigger ?? (nav.ledgerId ? "正在載入帳本…" : "共同帳本") : nav.surface === "PROPOSAL_COMPAT_ENTRY" ? titles[nav.surface] : `${ledgerName} · ${titles[nav.surface]}`}</h1>
      {nav.surface === "HOME" && identityTrigger && !v2.authError ? <div className="flex shrink-0 gap-1">
        <Button tabIndex={0} data-testid="home-search-trigger" variant="ghost" size="icon" className="text-foreground" aria-label="搜尋紀錄" onClick={() => openSurface("SEARCH")}><Search aria-hidden="true" className="size-5" /></Button>
        <Button tabIndex={0} data-testid="home-more-trigger" variant="ghost" size="icon" className="text-foreground" aria-label="更多" aria-haspopup="dialog" aria-expanded={dialog === "home-more"} aria-controls="ledger-surface-dialog" onClick={event => {
          trigger.current = event.currentTarget; returnFocus.current = event.currentTarget; setDialog("home-more");
        }}><MoreHorizontal aria-hidden="true" className="size-5" /></Button>
      </div> : null}
      {nav.surface !== "HOME" ? identityTrigger : null}
    </header>
    {scopeError ? <div role="alert" className="space-y-3"><p>{scopeError === "ledger" ? "這本帳本無法開啟，可能已失效或你沒有權限。" : "這筆紀錄的連結缺少帳本，無法開啟。"}</p><Button onClick={() => request({ kind: "navigate", nav: ledgerHome(null), mode: "replace" })}>回自己的帳本</Button></div> : <>
      {v2.preference?.ledgerId === nav.ledgerId && v2.preference.status === "syncing" ? <p role="status" className="mb-3 text-sm text-[var(--muted-foreground)]">正在更新 LINE 記帳預設…</p> : null}
      {v2.preference?.ledgerId === nav.ledgerId && v2.preference.status === "failed" ? <div role="status" className="mb-3"><p>這本可查看，LINE 的預設帳本尚未更新</p><Button variant="outline" size="sm" onClick={() => v2.preference?.authError ? location.reload() : void v2.activateLedger(nav.ledgerId!)}>{v2.preference.authError ? "重新登入" : "重試更新 LINE 預設"}</Button></div> : null}
      {pending?.kind === "navigate" && entry.operation && dialog !== "leave" ? <div className="mb-3 rounded-xl border p-3 text-sm"><p>先確認「{ledgerName}」這筆記帳的結果，再前往指定的帳本。</p>{entry.write === "committed" ? <Button variant="outline" size="sm" onClick={() => { if (pendingRef.current) request(pendingRef.current); }}>繼續前往指定帳本</Button> : null}</div> : null}
      {v2.authError ? <div role="alert"><p>登入已失效。</p><Button onClick={() => location.reload()}>重新登入</Button></div> : null}
      <V2LedgerHome key={v2.activeLedgerId ?? "no-ledger"} user={v2.context.user} users={v2.context.users} today={currentEntryDate()}
        ledgers={v2.ledgers} activeLedgerId={v2.activeLedgerId} bootstrap={v2.bootstrap} error={v2.error} read={v2.read} authError={v2.authError} busy={v2.busy}
        reload={async () => v2.activeLedgerId ? v2.loadBootstrap(v2.activeLedgerId) : v2.loadLedgers()}
        onOpenEntryControls={openEntryControls}
        entry={entry} navigation={nav} onOpenSurface={openSurface} onCloseEntry={() => request({ kind: "close" })}
        onEdit={transaction => request({ kind: "correction", transaction })} onCreateLedger={openCreate} onSettingsLeaveChange={setSettingsGuard}
        onQuickEntry={openQuickEntry} quickEntryActive={quickEntryActive} onCategoriesChange={setEntryCategories}
        highlightedId={completion?.ledgerId === nav.ledgerId && completion.kind === "row" ? completion.id : undefined}
        onViewCreated={createdTransaction?.ledgerId === nav.ledgerId && (nav.surface !== "HOME" || completion?.kind !== "row")
          && v2.bootstrap?.transactions.some(row => row.ledgerId === nav.ledgerId && row.id === createdTransaction?.id)
          ? () => openSurface("TRANSACTION_DETAIL", createdTransaction!.id) : undefined}
        onConfirmedMutation={v2.acceptTransactionStatusProof}
        timelineVisibleCount={timelineWindows[nav.ledgerId ?? ""] ?? TIMELINE_PAGE_SIZE}
        onLoadOlder={() => { const ledgerId = nav.ledgerId; if (ledgerId) setTimelineWindows(current => ({ ...current, [ledgerId]: (current[ledgerId] ?? TIMELINE_PAGE_SIZE) + TIMELINE_PAGE_SIZE })); }}
        onSearchChange={filters => { const next = { ...nav, filters }; setNav(next); writeUrl(next, "replace", history.state); }} />
    </>}
    <LedgerSurfaceHost surface={dialog === "leave" ? `leave-${leaveRevision}` : dialog} fullHeight={quickEntryActive} initialFocus={() => {
      if (dialog !== "quick-entry") return null;
      const host = document.getElementById("ledger-surface-dialog");
      if (host) host.scrollTop = quickFocus.current.scrollTop;
      return host?.querySelector<HTMLElement>(quickFocus.current.selector) ?? null;
    }} title={dialog === "home-more" ? "更多" : dialog === "quick-entry" ? "記一筆" : dialog === "switcher" ? "切換帳本" : dialog === "create" ? "建立帳本" : dialog === "payer" ? entry.draft?.type === "income" ? "選擇收款人" : entry.draft?.type === "transfer" ? "選擇發送人" : "選擇付款人" : dialog === "split" ? entry.draft?.type === "income" ? "款項分配" : "選擇分攤" : leaveTitle} onCancel={() => cancelDialog()} cancelDisabled={dialog === "create" && v2.busy} returnFocus={() => returnFocus.current}>
      {dialog === "home-more" ? <div data-home-more className="space-y-2">
        <Button tabIndex={0} variant="ghost" className="w-full justify-start text-foreground" onClick={() => openSurface("SETTINGS")}>帳本設定</Button>
        <Button tabIndex={0} variant="ghost" className="w-full justify-start text-foreground" onClick={() => {
          setDialog(quickEntryActive ? "quick-entry" : null);
          if (nav.ledgerId) void v2.loadBootstrap(nav.ledgerId).catch(() => undefined);
        }}>重新整理</Button>
      </div> : null}
      {quickEntryActive && !scopeError && v2.bootstrap && v2.bootstrap.ledger.id === nav.ledgerId && v2.context.users.find(user => user.id !== v2.context!.user.id) ? <div hidden={dialog !== "quick-entry"}>
        <QuickEntry entry={entry} bootstrap={v2.bootstrap} user={v2.context.user} partner={v2.context.users.find(user => user.id !== v2.context!.user.id)!} categories={entryCategories} onCancel={() => request({ kind: "close" })} onOpenControls={openEntryControls} />
      </div> : null}
      {(dialog === "payer" || dialog === "split") && entry.draft && v2.context.users.find(user => user.id !== v2.context!.user.id) ? <V2EntryControls key={`${entry.draft.id}-${dialog}`} surface={dialog} draft={entry.draft} user={v2.context.user} partner={v2.context.users.find(user => user.id !== v2.context!.user.id)!} locked={entry.locked} onCancel={() => cancelDialog()} onApply={patch => { entry.updateDraft(patch); cancelDialog(); }} /> : null}
      {dialog === "switcher" || dialog === "leave" && destinationName ? <div className="space-y-3">
        <V2LedgerSwitcher ledgers={v2.ledgers} activeLedgerId={nav.ledgerId}
          selectedLedgerId={pending?.kind === "navigate" && pending.manual ? pending.nav.ledgerId : nav.ledgerId}
          onChange={switchLedger} onCreate={() => openCreate()} choosingDestination={dialog === "leave"} />
      </div> : null}
      {dialog === "leave" ? <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" onClick={() => cancelDialog()}>繼續編輯</Button>
        {leave === "dirty" || leave === "ready" ? <Button variant="primary" size="sm" onClick={() => { if (discardInput() && pendingRef.current) apply(pendingRef.current); }}>{destinationName ? "放棄並切換" : "放棄這筆輸入"}</Button> : null}
        {leave === "submitting" || leave === "ready" && entry.write === "committed" ? <Button onClick={() => { cancelDialog(true); if (!quickEntryActive) requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-entry]")?.scrollIntoView()); }}>查看處理狀態</Button> : null}
        {leave === "unknown" ? <Button onClick={() => { cancelDialog(true); void entry.replay(); }}>確認並完成這筆</Button> : null}
      </div> : null}
      {dialog === "create" ? <form className="space-y-3" onSubmit={submitCreate}>
        <div className="space-y-2"><label htmlFor="new-ledger-name" className="block font-semibold">新帳本名稱</label>
          <Input id="new-ledger-name" value={newLedgerName} onChange={event => setNewLedgerName(event.target.value)} required maxLength={40} disabled={v2.busy} aria-describedby="new-ledger-name-help" />
          <p id="new-ledger-name-help" className="text-sm text-[var(--muted-foreground)]">最多 40 字。</p></div>
        <div className="flex flex-wrap gap-2"><Button type="submit" tabIndex={0} disabled={!newLedgerName.trim() || v2.busy}>{v2.busy ? "正在建立…" : "建立"}</Button>
          <Button variant="ghost" tabIndex={0} disabled={v2.busy} onClick={() => cancelDialog()}>取消</Button></div>
        {createError ? <p role="alert">{createError}</p> : null}
      </form> : null}
    </LedgerSurfaceHost>
  </main>;
}
