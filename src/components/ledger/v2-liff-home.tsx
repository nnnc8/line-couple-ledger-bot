"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { V2LedgerHome } from "@/components/ledger/v2-ledger-home";
import { useV2Ledgers } from "@/hooks/use-v2-ledgers";
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
  const [error, setError] = React.useState("");
  const [proposalMessage, setProposalMessage] = React.useState("");
  const proposalId = React.useMemo(() => urlParam("v2Proposal"), []);
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
    await v2.loadContext();
    await v2.loadLedgers();
  }, [v2]);

  React.useEffect(() => {
    if (v2.context) return;
    void startLiff().catch((reason) => setError(reason instanceof Error ? reason.message : "LIFF 初始化失敗"));
  }, [startLiff, v2.context]);

  React.useEffect(() => {
    if (proposalId) setProposalMessage("此 proposal 已建立；請在 Ledger 流水中確認或取消。");
  }, [proposalId]);

  if (!v2.context) {
    return <main className="mx-auto flex min-h-dvh max-w-[640px] flex-col items-center justify-center gap-3 px-6 text-center"><h1 className="text-xl font-bold">共同帳本</h1><p className="text-sm text-[var(--muted-foreground)]">{error || "正在連線至 LINE…"}</p>{error ? <Button variant="primary" size="md" onClick={() => { setError(""); void startLiff().catch((reason) => setError(reason instanceof Error ? reason.message : "LIFF 初始化失敗")); }}>重新登入</Button> : null}</main>;
  }

  return <main className="mx-auto min-h-dvh max-w-[640px] px-4 pb-6 pt-[max(16px,env(safe-area-inset-top))]">
    <header className="mb-3 flex items-center justify-between gap-3"><div><p className="text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-foreground)]">Couple Ledger</p><h1 className="text-lg font-bold tracking-tight">Ledger</h1></div><span className="rounded-full bg-accent-soft px-2 py-1 text-[11px] font-bold text-accent">TWD</span></header>
    {proposalMessage ? <div className="mb-3 rounded-xl border border-accent/30 bg-accent-soft p-3 text-sm">{proposalMessage} <Button variant="ghost" size="sm" onClick={() => setProposalMessage("")}>知道了</Button></div> : null}
    <V2LedgerHome user={v2.context.user} users={v2.context.users} today={v2.context.today} ledgers={v2.ledgers} activeLedgerId={v2.activeLedgerId} setActiveLedgerId={v2.setActiveLedgerId} bootstrap={v2.bootstrap} error={v2.error} busy={v2.busy} reload={async () => v2.activeLedgerId ? v2.loadBootstrap(v2.activeLedgerId) : v2.loadLedgers()} applyCommittedTransaction={v2.applyCommittedTransaction} createLedger={v2.createLedger} proposalIdFromUrl={proposalId} ledgerIdFromUrl={ledgerId} transactionIdFromUrl={transactionId} initialSecondaryTab={v2SecondaryTabFromUrlValue(urlParam("tab"))} />
  </main>;
}
