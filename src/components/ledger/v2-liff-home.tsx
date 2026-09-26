"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { V2LedgerHome } from "@/components/ledger/v2-ledger-home";
import { useV2Ledgers } from "@/hooks/use-v2-ledgers";
import { useV2EntrySession } from "@/hooks/use-v2-entry-session";
import { api } from "@/lib/api";
import { v2SecondaryTabFromUrlValue } from "@/lib/v2-navigation";

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

function urlParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const direct = params.get(name);
  if (direct) return direct;
  const state = params.get("liff.state");
  if (!state) return null;
  return new URLSearchParams(state.includes("?") ? state.slice(state.indexOf("?")) : state).get(name);
}

function redirectUri() {
  const url = new URL(window.location.href);
  return url.toString();
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

export function V2LiffHome() {
  const v2 = useV2Ledgers();
  const entry = useV2EntrySession({ context: v2.context, bootstrap: v2.bootstrap, read: v2.read, accessDenied: v2.accessDenied, acceptProof: v2.acceptCommitProof, refresh: v2.loadBootstrap });
  const initializeEntry = entry.initialize;
  const started = React.useRef(false);
  const [error, setError] = React.useState("");
  const [proposalDismissed, setProposalDismissed] = React.useState(false);
  const proposalId = React.useMemo(() => urlParam("v2Proposal"), []);
  const proposalMessage = proposalId && !proposalDismissed ? "此 proposal 已建立；請在 Ledger 流水中確認或取消。" : "";
  const ledgerId = React.useMemo(() => urlParam("v2Ledger"), []);
  const transactionId = React.useMemo(() => urlParam("v2Transaction"), []);

  const startLiff = React.useCallback(async () => {
    const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
    if (!liffId) throw new Error("尚未設定 LIFF ID");
    const liff = await waitForLiffSdk();
    try {
      await liff.init({ liffId });
    } catch {
      throw new Error("LIFF 初始化失敗");
    }
    if (!liff.isLoggedIn()) {
      if (liff.isInClient()) throw new Error("請在 LINE 內重新開啟此帳本。");
      liff.login({ redirectUri: redirectUri() });
      return;
    }
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error("LINE 未提供登入憑證");
    const invite = urlParam("invite") ?? undefined;
    await api("/api/app/session", { idToken, ...(invite ? { invite } : {}) });
    const context = await v2.loadContext();
    const ledgers = await v2.loadLedgers(undefined, true);
    const target = initializeEntry(context.user.id, ledgers, ledgerId);
    v2.selectLedger(target);
  }, [v2, ledgerId, initializeEntry]);

  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void startLiff().catch((reason) => setError(reason instanceof Error ? reason.message : "LIFF 初始化失敗"));
  }, [startLiff, v2.context]);

  if (!v2.context) {
    return <main className="mx-auto flex min-h-dvh max-w-[640px] flex-col items-center justify-center gap-3 px-6 text-center"><h1 className="text-xl font-bold">共同帳本</h1><p className="text-sm text-[var(--muted-foreground)]">{error || "正在連線至 LINE…"}</p>{error ? <Button variant="primary" size="md" onClick={() => { setError(""); void startLiff().catch((reason) => setError(reason instanceof Error ? reason.message : "LIFF 初始化失敗")); }}>重新登入</Button> : null}</main>;
  }

  return <main className="mx-auto min-h-dvh max-w-[640px] px-4 pb-6 pt-[max(16px,env(safe-area-inset-top))]">
    <header className="mb-3 flex items-center justify-between gap-3"><div><p className="text-sm font-semibold tracking-[0.06em] text-[var(--muted-foreground)]">共同記帳</p><h1 className="text-lg font-bold tracking-tight">帳本</h1></div><span className="rounded-full bg-accent-soft px-2 py-1 text-xs font-bold text-accent">NT$</span></header>
    {proposalMessage ? <div className="mb-3 rounded-xl border border-accent/30 bg-accent-soft p-3 text-sm">{proposalMessage} <Button variant="ghost" size="sm" onClick={() => setProposalDismissed(true)}>知道了</Button></div> : null}
    {error ? <p role="alert">{error}</p> : null}
    {entry.pendingDestination && entry.operation ? <div className="mb-3 rounded-xl border p-3 text-sm">
      <p>先確認「{v2.bootstrap?.ledger.name}」這筆記帳的結果，再前往連結指定的帳本。</p>
      {entry.write === "committed" ? <Button variant="outline" size="sm" onClick={() => { if (entry.mayLeaveDraft()) { void v2.setActiveLedgerId(entry.pendingDestination!); entry.clearDestination(); } }}>繼續前往指定帳本</Button> : null}
    </div> : null}
    <V2LedgerHome key={v2.activeLedgerId ?? "no-ledger"} user={v2.context.user} users={v2.context.users} today={v2.context.today} ledgers={v2.ledgers} activeLedgerId={v2.activeLedgerId} setActiveLedgerId={id => { if (id !== v2.activeLedgerId && entry.mayLeaveDraft()) void v2.setActiveLedgerId(id); }} bootstrap={v2.bootstrap} error={v2.error} busy={v2.busy} reload={async () => v2.activeLedgerId ? v2.loadBootstrap(v2.activeLedgerId) : v2.loadLedgers()} entry={entry} createLedger={async (name, color) => { if (entry.mayLeaveDraft()) return v2.createLedger(name, color); }} proposalIdFromUrl={proposalId} transactionIdFromUrl={transactionId} initialSecondaryTab={v2SecondaryTabFromUrlValue(urlParam("tab"))} />
  </main>;
}
