"use client";

import * as React from "react";
import { useBootstrap } from "@/hooks/use-bootstrap";
import { NavBar, type TabKey } from "@/components/layout/nav-bar";
import { Dashboard } from "@/components/dashboard/dashboard";
import { AnalysisSection } from "@/components/analysis/analysis-section";
import { HistorySection } from "@/components/history/history-section";
import { SettingsSection } from "@/components/settings/settings-section";
import {
  ExpenseForm,
  type ExpenseFormPrefill,
} from "@/components/expense/expense-form";
import {
  TransferSheet,
  type TransferSheetPrefill,
} from "@/components/transfer/transfer-sheet";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import type {
  Bootstrap,
  CategoryAnalytics,
  Expense,
  SettlementView,
} from "@/lib/types";
import type { ActionInput } from "@/lib/pending-action-types";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { ArrowLeftRight, CircleCheckBig, ReceiptText } from "lucide-react";
import { useV2Ledgers } from "@/hooks/use-v2-ledgers";
import { V2LedgerHome } from "@/components/ledger/v2-ledger-home";

const TAB_KEYS: TabKey[] = ["dashboard", "history", "analysis", "settings"];

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
  const query = state.includes("?") ? state.slice(state.indexOf("?")) : state;
  return new URLSearchParams(query).get(name);
}

function tabFromUrl(): TabKey {
  const v = urlParam("tab");
  if (urlParam("search")) return "history";
  if (v === "private") return "analysis";
  return TAB_KEYS.includes(v as TabKey) ? (v as TabKey) : "dashboard";
}

function analysisScopeFromUrl(): CategoryAnalytics["scope"] {
  return urlParam("tab") === "private" ? "private" : "combined";
}

let liffStartPromise: Promise<void> | null = null;

function waitForLiffSdk(timeoutMs = 10_000): Promise<NonNullable<Window["liff"]>> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (window.liff) {
        resolve(window.liff);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("LIFF SDK 載入失敗"));
        return;
      }
      window.setTimeout(check, 50);
    };
    check();
  });
}

function liffRedirectUri(): string {
  const redirect = new URL(window.location.origin + window.location.pathname);
  for (const name of [
    "invite",
    "tab",
    "edit",
    "search",
    "action",
    "groupId",
    "ledger",
    "paidBy",
    "direction",
    "tag",
    "amount",
    "description",
  ]) {
    const value = urlParam(name);
    if (value) redirect.searchParams.set(name, value);
  }
  return redirect.toString();
}

function liffErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : "";
  const status = typeof reason === "object" && reason !== null && "status" in reason
    ? Number((reason as { status?: unknown }).status)
    : 0;
  if (message === "LIFF SDK 載入失敗" || message === "尚未設定 LIFF ID") return message;
  if (message.includes("LINE login expired") || message.includes("Session expired") || status === 401) {
    return "LINE 登入已過期，請重新登入。";
  }
  if (message.includes("請先在 LINE Bot")) return "此 LINE 帳號尚未綁定，請先在 LINE Bot 輸入加入設定碼。";
  if (message.includes("LINE login failed")) return "LINE 登入驗證失敗，請重新登入。";
  if (message === "LINE 未提供登入憑證") return message;
  if (message.includes("請在 LINE 內")) return message;
  if (message.includes("LIFF 初始化")) return message;
  return "LIFF 初始化失敗，請確認 LINE 登入後再試。";
}

export default function Home() {
  const v2Enabled = process.env.NEXT_PUBLIC_V2_LEDGER_UI === "1";
  const {
    data,
    error,
    busy,
    load,
    reload,
    mutate,
    propose,
  } = useBootstrap();
  const v2 = useV2Ledgers(v2Enabled);
  const { context: v2Context, loadContext: loadV2Context, loadLedgers: loadV2Ledgers } = v2;
  const [v2ProposalId] = React.useState<string | null>(() => urlParam("v2Proposal"));
  const [v2ProposalMessage, setV2ProposalMessage] = React.useState("");

  const [tab, setTab] = React.useState<TabKey>(() => tabFromUrl());
  const [analysisScope, setAnalysisScope] =
    React.useState<CategoryAnalytics["scope"]>(() => analysisScopeFromUrl());
  const [loginError, setLoginError] = React.useState("");
  const [recordOpen, setRecordOpen] = React.useState(false);
  const [expenseOpen, setExpenseOpen] = React.useState(false);
  const [transferOpen, setTransferOpen] = React.useState(false);
  const [expensePrefill, setExpensePrefill] =
    React.useState<ExpenseFormPrefill | null>(null);
  const [transferPrefill, setTransferPrefill] =
    React.useState<TransferSheetPrefill | null>(null);
  const [editExpense, setEditExpense] = React.useState<Expense | null>(null);
  const deepLinkHandledRef = React.useRef(false);
  const settleRequestRef = React.useRef<{ fingerprint: string; key: string } | null>(null);
  const voidRequestKeysRef = React.useRef(new Map<string, string>());

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTab((current) => {
      const next = tabFromUrl();
      return current === next ? current : next;
    });
    setAnalysisScope(analysisScopeFromUrl());
  }, []);

  React.useEffect(() => {
    if (!v2ProposalId || !v2Enabled) return;
    const timer = window.setTimeout(() => setV2ProposalMessage("此 proposal 已建立；請在 Ledger 流水中確認或取消。"), 0);
    return () => window.clearTimeout(timer);
  }, [v2Enabled, v2ProposalId]);

  const startLiff = React.useCallback(() => {
    if (data || (v2Enabled && v2Context)) return Promise.resolve();
    if (liffStartPromise) return liffStartPromise;
    liffStartPromise = (async () => {
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
        liff.login({ redirectUri: liffRedirectUri() });
        return;
      }
      const idToken = liff.getIDToken();
      if (!idToken) throw new Error("LINE 未提供登入憑證");
      const invite = urlParam("invite") ?? undefined;
      await api("/api/app/session", { idToken, ...(invite ? { invite } : {}) });
      if (v2Enabled) {
        await loadV2Context();
        await loadV2Ledgers();
        // V2 can be used by a couple that has no V1 group. Loading the legacy
        // bootstrap is best-effort only in that mode.
        await load().catch(() => undefined);
      } else {
        const ok = await load();
        if (!ok) throw new Error("無法讀取帳本");
      }
    })()
      .catch((reason) => {
        setLoginError(liffErrorMessage(reason));
        throw reason;
      })
      .finally(() => {
        liffStartPromise = null;
      });
    return liffStartPromise;
  }, [data, load, loadV2Context, loadV2Ledgers, v2Context, v2Enabled]);

  React.useEffect(() => {
    if (data || (v2Enabled && v2Context)) return;
    void startLiff().catch(() => undefined);
  }, [data, startLiff, v2Context, v2Enabled]);

  React.useEffect(() => {
    if (!data) return;
    const params = new URLSearchParams(window.location.search);
    const editId = params.get("edit");
    if (editId) {
      const expense =
        data.expenses.find((e) => e.id === editId) ??
        data.sharedExpenses.find((e) => e.id === editId) ??
        data.privateExpenses.find((e) => e.id === editId);
      if (expense) {
        history.replaceState(null, "", "/");
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setEditExpense(expense);
        setExpenseOpen(true);
      }
    }
  }, [data]);

  React.useEffect(() => {
    if (!data || deepLinkHandledRef.current) return;
    const action = urlParam("action");
    if (action !== "expense" && action !== "transfer") return;
    deepLinkHandledRef.current = true;
    const groupId = validGroupId(data, urlParam("groupId"));
    const amount = validAmountParam(urlParam("amount"));
    if (action === "expense") {
      const ledger = urlParam("ledger");
      const paidBy = urlParam("paidBy");
      const prefill: ExpenseFormPrefill = {
        ledger: ledger === "private" ? "private" : "shared",
        groupId,
        paidBy: paidBy === "partner" ? "partner" : "self",
        tag: boundedParam("tag", 40),
        description: boundedParam("description", 100),
        amount,
      };
      queueMicrotask(() => {
        setExpensePrefill(prefill);
        setEditExpense(null);
        setExpenseOpen(true);
      });
    } else {
      const prefill: TransferSheetPrefill = {
        groupId,
        direction:
          urlParam("direction") === "partner_to_me"
            ? "partner_to_me"
            : "me_to_partner",
        amount,
      };
      queueMicrotask(() => {
        setTransferPrefill(prefill);
        setTransferOpen(true);
      });
    }
    clearActionParams();
  }, [data]);

  function openAdd() {
    setEditExpense(null);
    setExpensePrefill(null);
    sessionStorage.removeItem("editExpense");
    setExpenseOpen(true);
  }

  function openTransfer() {
    setRecordOpen(false);
    setTransferPrefill(null);
    setTransferOpen(true);
  }

  function openExpenseFromRecord() {
    setRecordOpen(false);
    openAdd();
  }

  const openEdit = React.useCallback((expense: Expense) => {
    setEditExpense(expense);
    setExpenseOpen(true);
  }, []);

  function closeExpense() {
    setExpenseOpen(false);
    setEditExpense(null);
    setExpensePrefill(null);
    sessionStorage.removeItem("editExpense");
  }

  function runAction(
    body: ActionInput,
    options: { success?: string; onSuccess?: () => void } = {},
  ) {
    void propose(body).then(({ success }) => {
      if (!success) return;
      toast.success(options.success ?? "已完成");
      options.onSuccess?.();
    });
  }

  function settleAll(onSuccess?: () => void) {
    if (!data) return;
    const mine =
      data.balances.find((balance) => balance.user_id === data.user.id)
        ?.balance_twd ?? 0;
    if (mine === 0) return;
    const direction = mine < 0 ? "me_to_partner" : "partner_to_me";
    const fingerprint = `${data.activeGroupId}:${direction}:${mine}`;
    const idempotencyKey =
      settleRequestRef.current?.fingerprint === fingerprint
        ? settleRequestRef.current.key
        : crypto.randomUUID();
    settleRequestRef.current = { fingerprint, key: idempotencyKey };
    runAction(
      {
        type: "settle",
        groupId: data.activeGroupId,
        direction,
        idempotencyKey,
      },
      {
        success: mine < 0 ? "已全部結清" : "已記錄收到全部欠款",
        onSuccess: () => {
          settleRequestRef.current = null;
          onSuccess?.();
        },
      },
    );
  }

  function voidSettlement(settlement: SettlementView) {
    const requestId = `${settlement.id}:${settlement.version}`;
    const idempotencyKey =
      voidRequestKeysRef.current.get(requestId) ?? crypto.randomUUID();
    voidRequestKeysRef.current.set(requestId, idempotencyKey);
    runAction(
      {
        type: "void_settlement",
        settlementId: settlement.id,
        expectedVersion: settlement.version,
        idempotencyKey,
      },
      {
        success: "已撤銷轉帳",
        onSuccess: () => voidRequestKeysRef.current.delete(requestId),
      },
    );
  }

  React.useEffect(() => {
    if (!error) return;
    toast.error(error, { duration: 4000 });
  }, [error]);

  // ─── Login / Loading ───
  if (!data && !(v2Enabled && v2Context)) {
    if (loginError) {
      return (
        <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center animate-fade-in">
          <div className="flex size-20 items-center justify-center rounded-3xl bg-primary text-2xl font-extrabold text-primary-foreground shadow-[var(--shadow-fab)]">
            共
          </div>
          <h1 className="text-xl font-bold tracking-tight">共同帳本</h1>
          <p className="text-[14px] text-[var(--muted-foreground)]">{loginError}</p>
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              setLoginError("");
              void startLiff().catch(() => undefined);
            }}
          >
            重新登入
          </Button>
        </main>
      );
    }
    return <LoadingShell />;
  }

  if (!data && v2Enabled && v2Context) {
    return (
      <main className="mx-auto min-h-dvh max-w-[640px] px-4 pb-6 pt-[max(16px,env(safe-area-inset-top))]">
        <header className="mb-3 flex items-center justify-between gap-3">
          <div><p className="text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-foreground)]">Couple Ledger</p><h1 className="text-lg font-bold tracking-tight">Ledger</h1></div>
          <span className="rounded-full bg-accent-soft px-2 py-1 text-[11px] font-bold text-accent">TWD</span>
        </header>
        {v2ProposalMessage ? <div className="mb-3 rounded-xl border border-accent/30 bg-accent-soft p-3 text-sm">{v2ProposalMessage} <Button variant="ghost" size="sm" onClick={() => setV2ProposalMessage("")}>知道了</Button></div> : null}
        <V2LedgerHome user={v2Context.user} users={v2Context.users} today={v2Context.today} ledgers={v2.ledgers} activeLedgerId={v2.activeLedgerId} setActiveLedgerId={v2.setActiveLedgerId} bootstrap={v2.bootstrap} error={v2.error} busy={v2.busy} reload={async () => { if (v2.activeLedgerId) return v2.loadBootstrap(v2.activeLedgerId); return v2.loadLedgers(); }} createLedger={v2.createLedger} proposalIdFromUrl={v2ProposalId} />
      </main>
    );
  }

  if (!data) {
    return <LoadingShell />;
  }

  if (!data.user) {
    return <OnboardingFlow onDone={() => void reload()} />;
  }

  if (v2Enabled) {
    return (
      <main className="mx-auto min-h-dvh max-w-[640px] px-4 pb-6 pt-[max(16px,env(safe-area-inset-top))]">
        <header className="mb-3 flex items-center justify-between gap-3">
          <div><p className="text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-foreground)]">Couple Ledger</p><h1 className="text-lg font-bold tracking-tight">Ledger</h1></div>
          <span className="rounded-full bg-accent-soft px-2 py-1 text-[11px] font-bold text-accent">TWD</span>
        </header>
        {v2ProposalMessage ? <div className="mb-3 rounded-xl border border-accent/30 bg-accent-soft p-3 text-sm">{v2ProposalMessage} <Button variant="ghost" size="sm" onClick={() => setV2ProposalMessage("")}>知道了</Button></div> : null}
        <V2LedgerHome user={data.user} users={data.users} today={data.today} ledgers={v2.ledgers} activeLedgerId={v2.activeLedgerId} setActiveLedgerId={v2.setActiveLedgerId} bootstrap={v2.bootstrap} error={v2.error} busy={v2.busy} reload={async () => { if (v2.activeLedgerId) return v2.loadBootstrap(v2.activeLedgerId); return v2.loadLedgers(); }} createLedger={v2.createLedger} proposalIdFromUrl={v2ProposalId} />
      </main>
    );
  }

  if (data.groups.filter((g) => !g.archived_at).length === 0) {
    return <OnboardingFlow onDone={() => void reload()} />;
  }

  const currentBalance =
    data.balances.find((balance) => balance.user_id === data.user.id)
      ?.balance_twd ?? 0;

  return (
    <main className="mx-auto flex min-h-dvh max-w-[640px] flex-col pb-nav">
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 bg-background/85 px-4 pb-3 pt-[max(16px,env(safe-area-inset-top))] backdrop-blur-xl">
        <div>
          <p className="text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-foreground)]">
            共同帳本
          </p>
          <h1 className="text-lg font-bold tracking-tight">{titleFor(tab)}</h1>
        </div>
        <label className="flex min-w-0 items-center gap-2">
          <span className="text-[13px] font-medium text-[var(--muted-foreground)]">
            群組
          </span>
          <select
            aria-label="切換群組"
            value={data.activeGroupId}
            onChange={(e) =>
              void mutate("/api/app/groups", {
                operation: "activate",
                groupId: e.target.value,
              })
            }
            className="h-11 max-w-[164px] truncate rounded-xl border-[1.5px] border-[var(--border)] bg-[var(--card)] px-3 py-1 text-[14px] font-semibold text-foreground focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)]"
          >
            {data.groups
              .filter((g) => !g.archived_at)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
          </select>
        </label>
      </header>

      <div className="flex-1 px-4 pb-4">
        <div key={tab} className="animate-slide-up">
          {tab === "dashboard" && (
            <Dashboard
              data={data}
              onTransfer={openTransfer}
              onSettle={() => settleAll()}
              onAdd={openAdd}
              onEdit={openEdit}
              onViewHistory={() => setTab("history")}
              onRefresh={reload}
            />
          )}
          {tab === "history" && (
            <HistorySection
              key={data.activeGroupId}
              expenses={data.expenses}
              users={data.users}
              settlements={data.settlements}
              initialQuery={boundedParam("search", 100)}
              onEdit={openEdit}
              onDelete={(expense) =>
                runAction(
                  {
                    type: expense.deleted_at ? "restore_expense" : "delete_expense",
                    expenseId: expense.id,
                    expectedVersion: expense.version,
                  },
                  { success: expense.deleted_at ? "已復原" : "已刪除" },
                )
              }
              onVoid={voidSettlement}
              currentUserId={data.user.id}
              currentBalance={currentBalance}
              busy={busy}
            />
          )}
          {tab === "analysis" && (
            <AnalysisSection
              data={data}
              scope={analysisScope}
              onScopeChange={setAnalysisScope}
            />
          )}
          {tab === "settings" && (
            <SettingsSection
              data={data}
              onGroup={(body, success) => void mutate("/api/app/groups", body, { success })}
              onRecurring={(body, success) =>
                void mutate("/api/app/recurring", body, { success })
              }
            />
          )}
        </div>
      </div>

      <NavBar tab={tab} onChange={setTab} onAdd={() => setRecordOpen(true)} />

      <Sheet
        open={recordOpen}
        onClose={() => setRecordOpen(false)}
        title="記一筆"
        subtitle="花費與實際轉帳分開記錄"
        labelledBy="record-sheet-title"
      >
        <div className="space-y-2">
          <Button
            variant="outline"
            size="block"
            className="h-14 justify-start px-4 text-[15px] font-bold"
            onClick={openExpenseFromRecord}
          >
            <ReceiptText className="size-5" /> 新增花費
          </Button>
          <Button
            variant="outline"
            size="block"
            className="h-14 justify-start px-4 text-[15px] font-bold"
            onClick={openTransfer}
          >
            <ArrowLeftRight className="size-5" /> 記錄轉帳
          </Button>
          {currentBalance !== 0 ? (
            <Button
              variant="outline"
              size="block"
              disabled={busy}
              className="h-14 justify-start px-4 text-[15px] font-bold"
              onClick={() => settleAll(() => setRecordOpen(false))}
            >
              <CircleCheckBig className="size-5" />
              {currentBalance < 0 ? "全部結清" : "已收到全部欠款"}
              <span className="ml-auto text-[13px] font-semibold text-[var(--muted-foreground)]">
                NT${Math.abs(currentBalance).toLocaleString()}
              </span>
            </Button>
          ) : null}
        </div>
      </Sheet>

      {/* Add/Edit expense sheet */}
      <Sheet
        open={expenseOpen}
        onClose={closeExpense}
        title={editExpense ? "編輯流水" : "新增支出"}
        subtitle={editExpense ? editExpense.description : undefined}
        labelledBy="expense-sheet-title"
        variant="full"
      >
        <ExpenseForm
          data={data}
          busy={busy}
          editExpense={editExpense}
          prefill={expensePrefill}
          onExit={closeExpense}
          onTransfer={() => {
            closeExpense();
            openTransfer();
          }}
          onSubmit={(body) => {
            runAction(body, {
              success: editExpense ? "已更新" : "已記帳",
              onSuccess: closeExpense,
            });
          }}
          onDelete={
            editExpense
              ? () =>
                  runAction(
                    {
                      type: "delete_expense",
                      expenseId: editExpense.id,
                      expectedVersion: editExpense.version,
                    },
                    { success: "已刪除", onSuccess: closeExpense },
                  )
              : undefined
          }
        />
      </Sheet>

      {transferOpen ? (
        <TransferSheet
          open
          groups={data.groups}
          initialGroupId={data.activeGroupId}
          currentUserId={data.user.id}
          groupBalances={data.groupBalances}
          today={data.today}
          busy={busy}
          prefill={transferPrefill}
          onClose={() => {
            setTransferOpen(false);
            setTransferPrefill(null);
          }}
          onSubmit={(body) =>
            runAction(body, {
              success: "已記錄轉帳",
              onSuccess: () => {
                setTransferOpen(false);
                setTransferPrefill(null);
              },
            })
          }
        />
      ) : null}
    </main>
  );
}

function boundedParam(name: string, maxLength: number): string | undefined {
  const value = urlParam(name)?.trim();
  return value && value.length <= maxLength ? value : undefined;
}

function validAmountParam(value: string | null): string | undefined {
  if (!value || !/^\d{1,9}$/.test(value)) return undefined;
  const amount = Number(value);
  return amount >= 1 && amount <= 100_000_000 ? String(amount) : undefined;
}

function validGroupId(
  data: Bootstrap,
  value: string | null,
): string | undefined {
  return data.groups.some((group) => group.id === value && !group.archived_at)
    ? value!
    : undefined;
}

function clearActionParams() {
  const url = new URL(window.location.href);
  for (const name of [
    "action",
    "groupId",
    "ledger",
    "paidBy",
    "direction",
    "tag",
    "amount",
    "description",
  ]) {
    url.searchParams.delete(name);
  }
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function titleFor(tab: TabKey): string {
  switch (tab) {
    case "dashboard":
      return "首頁";
    case "history":
      return "帳務流水";
    case "analysis":
      return "分析";
    case "settings":
      return "設定";
  }
}



function LoadingShell() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[640px] flex-col pb-nav">
      <header className="sticky top-0 z-30 bg-background/85 px-4 pb-3 pt-[max(16px,env(safe-area-inset-top))] backdrop-blur-xl">
        <div className="space-y-2">
          <div className="h-3 w-16 rounded-full bg-muted" />
          <div className="h-5 w-24 rounded-full bg-muted" />
        </div>
      </header>
      <div className="space-y-3 px-4 pt-2">
        <div className="h-32 rounded-2xl bg-muted" />
        <div className="grid grid-cols-2 gap-3">
          <div className="h-24 rounded-2xl bg-muted" />
          <div className="h-24 rounded-2xl bg-muted" />
        </div>
        <div className="h-56 rounded-2xl bg-muted" />
        <div className="h-40 rounded-2xl bg-muted" />
      </div>
    </main>
  );
}
