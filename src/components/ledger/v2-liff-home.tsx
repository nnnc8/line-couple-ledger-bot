"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { V2LedgerSwitcher } from "@/components/ledger/v2-ledger-switcher";
import { Input } from "@/components/ui/input";
import { V2LedgerHome, type SettingsLeaveGuard } from "@/components/ledger/v2-ledger-home";
import { V2EntryControls } from "@/components/ledger/v2-entry-controls";
import type { EntryControlSurface } from "@/components/ledger/v2-transaction-editor";
import { LedgerSurfaceHost } from "@/components/ledger/ledger-surface-host";
import { useV2Ledgers } from "@/hooks/use-v2-ledgers";
import { useV2EntrySession } from "@/hooks/use-v2-entry-session";
import { api } from "@/lib/api";
import { appOrigin, ledgerHome, navigationHistoryState, navigationParams, navigationUrl, parseNavigation, resolveLedgerTarget, type V2Navigation, type V2Surface } from "@/lib/v2-navigation";
import type { V2LedgerTransaction } from "@/lib/types";

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
  | { kind: "close" } | { kind: "correction"; transaction: V2LedgerTransaction } | { kind: "create" };
type ScrollMemory = { rowId?: string; offset: number; y: number };
const titles: Record<V2Surface, string> = { HOME: "", TRANSACTION_DETAIL: "紀錄詳情", STATS: "收支概況", SETTINGS: "帳本設定", RECURRING: "固定記帳", SEARCH: "搜尋紀錄", PROPOSAL_COMPAT_ENTRY: "LINE 待確認草稿" };

export function V2LiffHome() {
  const v2 = useV2Ledgers();
  const entry = useV2EntrySession({ context: v2.context, bootstrap: v2.bootstrap, read: v2.read, accessDenied: v2.accessDenied, acceptProof: v2.acceptCommitProof, refresh: v2.loadBootstrap });
  const [nav, setNav] = React.useState<V2Navigation | null>(null);
  const [error, setError] = React.useState("");
  const [targetError, setTargetError] = React.useState<"ledger" | "transaction-scope" | null>(null);
  const scopeError = targetError ?? (v2.accessDenied && !v2.authError ? "ledger" : null);
  const [settingsGuard, setSettingsGuard] = React.useState<SettingsLeaveGuard | null>(null);
  const [dialog, setDialog] = React.useState<"switcher" | "leave" | "create" | EntryControlSurface | null>(null);
  const [pending, setPending] = React.useState<Intent | null>(null);
  const pendingRef = React.useRef<Intent | null>(null);
  const [newLedgerName, setNewLedgerName] = React.useState("");
  const [createError, setCreateError] = React.useState("");
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
  const focusRequest = React.useRef<{ ledgerId: string | null; home: boolean; rowId?: string; headingDone?: boolean } | null>(null);

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

  function rememberHome() {
    if (nav?.surface !== "HOME" || !nav.ledgerId) return;
    const row = [...document.querySelectorAll<HTMLElement>("[data-transaction-id]")].find(node => node.getBoundingClientRect().bottom > 0);
    scroll.current.set(nav.ledgerId, { rowId: row?.dataset.transactionId, offset: row?.getBoundingClientRect().top ?? 0, y: window.scrollY });
  }

  function apply(intent: Intent) {
    pendingRef.current = null;
    setPending(null);
    if (intent.kind === "create") { setDialog("create"); return; }
    if (intent.kind === "close") { setDialog(null); return; }
    if (intent.kind === "correction") {
      entry.openCorrection(intent.transaction, true);
      setDialog(null);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="金額，新臺幣"]')?.focus());
      return;
    }
    navigationGeneration.current += 1;
    rememberHome();
    const resolved = resolveLedgerTarget(intent.nav, v2.ledgers);
    const next = resolved.error ? intent.nav : { ...intent.nav, ledgerId: resolved.ledgerId, explicitLedger: resolved.ledgerId !== null };
    const origin = intent.mode === "push" && nav?.surface === "HOME" && nav.ledgerId
      ? { version: 1 as const, documentId: documentId.current, ledgerId: nav.ledgerId, ...(intent.rowId ? { rowId: intent.rowId } : {}) } : null;
    const previousOrigin = appOrigin(accepted.current.state, documentId.current, nav?.ledgerId ?? null);
    const state = intent.state ?? navigationHistoryState(window.history.state, origin);
    focusRequest.current = { ledgerId: next.ledgerId, home: next.surface === "HOME", rowId: intent.rowId ?? (next.surface === "HOME" ? previousOrigin?.rowId : undefined) };
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
  function request(intent: Intent) {
    const status = leaveStatus();
    if (status !== "ready") {
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
    const heading = document.querySelector<HTMLElement>('[data-testid="surface-heading"]');
    if (!focus.headingDone) { heading?.focus({ preventScroll: true }); focus.headingDone = true; }
    if (focus.home && v2.bootstrap?.ledger.id !== focus.ledgerId && !targetError) return;
    const memory = focus.ledgerId ? scroll.current.get(focus.ledgerId) : undefined;
    const rows = [...document.querySelectorAll<HTMLElement>("[data-transaction-id]")];
    const anchor = rows.find(node => node.dataset.transactionId === memory?.rowId);
    if (focus.home) {
      window.scrollTo(0, anchor && memory ? window.scrollY + anchor.getBoundingClientRect().top - memory.offset : memory?.y ?? 0);
      const row = rows.find(node => node.dataset.transactionId === focus.rowId);
      if (document.activeElement === heading && focus.rowId) (row ?? rows[0] ?? heading)?.focus({ preventScroll: true });
    } else window.scrollTo(0, 0);
    focusRequest.current = null;
  }, [nav, v2.bootstrap, targetError]);

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
    focusRequest.current = { ledgerId: next.ledgerId, home: next.surface === "HOME" };
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
    if (dialog === "leave" && !keepDestination) {
      pendingRef.current = null;
      setPending(null);
      returnFocus.current = editingField.current?.isConnected ? editingField.current : returnFocus.current ?? trigger.current;
    } else if (dialog !== "payer" && dialog !== "split") returnFocus.current = trigger.current;
    setDialog(null);
  }
  function openSurface(surface: V2Surface, transactionId: string | null = null) {
    if (!nav) return;
    request({ kind: "navigate", nav: { ...ledgerHome(nav.ledgerId), surface, transactionId }, mode: "push", rowId: transactionId ?? undefined });
  }
  function switchLedger(ledgerId: string) {
    request({ kind: "navigate", nav: ledgerHome(ledgerId), mode: "replace", manual: true });
  }
  const ledgerName = v2.ledgers.find(ledger => ledger.id === nav?.ledgerId)?.name ?? "帳本";
  const leave = leaveStatus();
  const destinationName = pending?.kind === "navigate" && pending.manual ? v2.ledgers.find(ledger => ledger.id === pending.nav.ledgerId)?.name : null;
  const leaveTitle = leave === "submitting" ? `這筆正在加入『${ledgerName}』，完成後才能切換。`
    : leave === "unknown" ? "這筆的結果還沒確認，請先確認，再切換帳本。"
      : leave === "blocked" ? entry.blocked : settingsGuard?.dirty ? "放棄尚未儲存的設定？" : destinationName ? `放棄這筆輸入，切換到『${destinationName}』？` : "放棄這筆輸入？";

  if (!v2.context || !nav) return <main className="mx-auto flex min-h-dvh max-w-[640px] flex-col items-center justify-center gap-3 px-6 text-center"><h1 className="text-xl font-bold">共同帳本</h1><p>{error || "正在連線至 LINE…"}</p>{error ? <Button onClick={() => { setError(""); setLoginAttempt(value => value + 1); }}>重新登入</Button> : null}</main>;

  return <main className="mx-auto min-h-dvh max-w-[640px] px-4 pb-6 pt-[max(16px,env(safe-area-inset-top))]" onFocusCapture={event => {
    if (event.target instanceof HTMLElement && event.target.closest("[data-entry]") || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) editingField.current = event.target;
  }}>
    <header className="mb-3 space-y-2">
      {nav.surface !== "HOME" ? <Button variant="ghost" size="sm" onClick={() => request({ kind: "navigate", nav: ledgerHome(nav.ledgerId), mode: "replace" })}>返回帳本</Button> : null}
      <h1 tabIndex={-1} data-testid="surface-heading" className="text-lg font-bold break-words">{scopeError ? "連結無法開啟" : nav.surface === "PROPOSAL_COMPAT_ENTRY" ? titles[nav.surface] : `${ledgerName}${titles[nav.surface] ? ` · ${titles[nav.surface]}` : ""}`}</h1>
      {!scopeError ? <Button variant="outline" size="sm" aria-label="切換帳本" onClick={event => { trigger.current = event.currentTarget; returnFocus.current = event.currentTarget; setDialog("switcher"); }}>{ledgerName} ▾</Button> : null}
    </header>
    {scopeError ? <div role="alert" className="space-y-3"><p>{scopeError === "ledger" ? "這本帳本無法開啟，可能已失效或你沒有權限。" : "這筆紀錄的連結缺少帳本，無法開啟。"}</p><Button onClick={() => request({ kind: "navigate", nav: ledgerHome(null), mode: "replace" })}>回自己的帳本</Button></div> : <>
      {v2.preference?.ledgerId === nav.ledgerId && v2.preference.status === "failed" ? <div role="status" className="mb-3"><p>這本可查看，LINE 的預設帳本尚未更新</p><Button variant="outline" size="sm" onClick={() => v2.preference?.authError ? location.reload() : void v2.activateLedger(nav.ledgerId!)}>{v2.preference.authError ? "重新登入" : "重試更新 LINE 預設"}</Button></div> : null}
      {pending?.kind === "navigate" && entry.operation && dialog !== "leave" ? <div className="mb-3 rounded-xl border p-3 text-sm"><p>先確認「{ledgerName}」這筆記帳的結果，再前往指定的帳本。</p>{entry.write === "committed" ? <Button variant="outline" size="sm" onClick={() => { if (pendingRef.current) request(pendingRef.current); }}>繼續前往指定帳本</Button> : null}</div> : null}
      {v2.authError ? <div role="alert"><p>登入已失效。</p><Button onClick={() => location.reload()}>重新登入</Button></div> : null}
      <V2LedgerHome key={v2.activeLedgerId ?? "no-ledger"} user={v2.context.user} users={v2.context.users} today={v2.context.today}
        ledgers={v2.ledgers} activeLedgerId={v2.activeLedgerId} bootstrap={v2.bootstrap} error={v2.error} busy={v2.busy}
        reload={async () => v2.activeLedgerId ? v2.loadBootstrap(v2.activeLedgerId) : v2.loadLedgers()}
        onOpenEntryControls={(surface, target) => { if (entry.locked) return; returnFocus.current = target; setDialog(surface); }}
        entry={entry} navigation={nav} onOpenSurface={openSurface} onCloseEntry={() => request({ kind: "close" })}
        onEdit={transaction => request({ kind: "correction", transaction })} onCreateLedger={() => request({ kind: "create" })} onSettingsLeaveChange={setSettingsGuard}
        onSearchChange={filters => { const next = { ...nav, filters }; setNav(next); writeUrl(next, "replace", history.state); }} />
    </>}
    <LedgerSurfaceHost surface={dialog === "leave" ? `leave-${leaveRevision}` : dialog} title={dialog === "switcher" ? "切換帳本" : dialog === "create" ? "建立帳本" : dialog === "payer" ? entry.draft?.type === "income" ? "選擇收款人" : entry.draft?.type === "transfer" ? "選擇發送人" : "選擇付款人" : dialog === "split" ? entry.draft?.type === "income" ? "款項分配" : "選擇分攤" : leaveTitle} onCancel={() => cancelDialog()} returnFocus={() => returnFocus.current}>
      {(dialog === "payer" || dialog === "split") && entry.draft && v2.context.users.find(user => user.id !== v2.context!.user.id) ? <V2EntryControls key={`${entry.draft.id}-${dialog}`} surface={dialog} draft={entry.draft} user={v2.context.user} partner={v2.context.users.find(user => user.id !== v2.context!.user.id)!} locked={entry.locked} onCancel={() => cancelDialog()} onApply={patch => { entry.updateDraft(patch); setDialog(null); }} /> : null}
      {dialog === "switcher" || dialog === "leave" && destinationName ? <div className="space-y-3">
        <V2LedgerSwitcher ledgers={v2.ledgers} activeLedgerId={nav.ledgerId}
          selectedLedgerId={pending?.kind === "navigate" && pending.manual ? pending.nav.ledgerId : nav.ledgerId}
          onChange={switchLedger} onCreate={() => request({ kind: "create" })} choosingDestination={dialog === "leave"} />
      </div> : null}
      {dialog === "leave" ? <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" onClick={() => cancelDialog()}>繼續編輯</Button>
        {leave === "dirty" || leave === "ready" ? <Button variant="primary" size="sm" onClick={() => { if (discardInput() && pendingRef.current) apply(pendingRef.current); }}>{destinationName ? "放棄並切換" : "放棄這筆輸入"}</Button> : null}
        {leave === "submitting" || leave === "ready" && entry.write === "committed" ? <Button onClick={() => { cancelDialog(true); requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-entry]")?.scrollIntoView()); }}>查看處理狀態</Button> : null}
        {leave === "unknown" ? <Button onClick={() => { cancelDialog(true); void entry.replay(); }}>確認並完成這筆</Button> : null}
      </div> : null}
      {dialog === "create" ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (!newLedgerName.trim() || v2.busy) return; const generation = navigationGeneration.current; setCreateError(""); void v2.createLedger(newLedgerName.trim()).then(result => { setNewLedgerName(""); setCreatedLedger({ id: (result.ledger as { id: string }).id, generation }); }).catch(reason => setCreateError(String(reason))); }}><Input value={newLedgerName} onChange={event => setNewLedgerName(event.target.value)} aria-label="新帳本名稱" /><Button type="submit" disabled={v2.busy}>建立</Button>{createError ? <p role="alert">{createError}</p> : null}</form> : null}
    </LedgerSurfaceHost>
  </main>;
}
