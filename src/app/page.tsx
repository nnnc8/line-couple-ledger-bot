"use client";

import * as React from "react";
import { useBootstrap } from "@/hooks/use-bootstrap";
import { NavBar, type TabKey } from "@/components/layout/nav-bar";
import { Dashboard } from "@/components/dashboard/dashboard";
import { HistorySection } from "@/components/history/history-section";
import { PrivateLedger } from "@/components/private/private-ledger";
import { SettingsSection } from "@/components/settings/settings-section";
import { ExpenseForm } from "@/components/expense/expense-form";
import { ConfirmDialog } from "@/components/layout/confirm-dialog";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import type { Expense } from "@/lib/types";
import type { ExpenseInput } from "@/lib/optimistic";
import { api } from "@/lib/api";
import { toast } from "sonner";

const TAB_KEYS: TabKey[] = ["dashboard", "history", "private", "settings"];

declare global {
  interface Window {
    liff?: {
      init(input: { liffId: string }): Promise<void>;
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
  return TAB_KEYS.includes(v as TabKey) ? (v as TabKey) : "dashboard";
}

export default function Home() {
  const {
    data,
    error,
    busy,
    proposal,
    setError,
    load,
    mutate,
    propose,
    decide,
  } = useBootstrap();

  const [tab, setTab] = React.useState<TabKey>(() => tabFromUrl());
  const [loginError, setLoginError] = React.useState("");
  const [expenseOpen, setExpenseOpen] = React.useState(false);
  const [editExpense, setEditExpense] = React.useState<Expense | null>(null);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTab((current) => {
      const next = tabFromUrl();
      return current === next ? current : next;
    });
  }, []);

  const startLiff = React.useCallback(async () => {
    if (data) return;
    const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
    if (!liffId || !window.liff) {
      setLoginError("尚未設定 LIFF ID");
      return;
    }
    try {
      await window.liff.init({ liffId });
      if (!window.liff.isLoggedIn()) {
        return window.liff.login({
          redirectUri: window.location.origin + window.location.pathname,
        });
      }
      const idToken = window.liff.getIDToken();
      if (!idToken) throw new Error("LINE 未提供登入憑證");
      await api("/api/app/session", { idToken });
      const ok = await load();
      if (!ok) throw new Error("無法讀取帳本");
    } catch (reason) {
      setLoginError(reason instanceof Error ? reason.message : "LINE 登入失敗");
    }
  }, [data, load]);

  React.useEffect(() => {
    if (data) return;
    if (!window.liff) {
      const t = window.setTimeout(() => {
        if (window.liff) void startLiff();
      }, 150);
      return () => window.clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void startLiff();
  }, [data, startLiff]);

  React.useEffect(() => {
    if (!data) return;
    const params = new URLSearchParams(window.location.search);
    const receiptId = params.get("receipt");
    if (receiptId) {
      void fetch(`/api/app/receipts/${receiptId}`)
        .then((res) => res.json())
        .then((receipt) => {
          sessionStorage.setItem("receiptDraft", JSON.stringify(receipt));
          sessionStorage.removeItem("editExpense");
          history.replaceState(null, "", "/");
          setEditExpense(null);
          setExpenseOpen(true);
        })
        .catch(() => setError("無法讀取收據"));
      return;
    }
    const editId = params.get("edit");
    if (editId) {
      const expense =
        data.expenses.find((e) => e.id === editId) ??
        data.sharedExpenses.find((e) => e.id === editId) ??
        data.privateExpenses.find((e) => e.id === editId);
      if (expense) {
        sessionStorage.removeItem("receiptDraft");
        history.replaceState(null, "", "/");
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setEditExpense(expense);
        setExpenseOpen(true);
      }
    }
  }, [data, setError]);

  async function uploadReceipt(
    file: File,
    groupId: string,
  ): Promise<{ receiptId: string; extraction: { merchant: string | null; expenseDate: string | null; amountTwd: number | null } }> {
    if (file.size > 10 * 1024 * 1024) throw new Error("收據不可超過 10 MB");
    const mimeType = receiptMime(file);
    if (!mimeType) throw new Error("只接受 JPEG、PNG、WebP 或 HEIC 收據");
    const created = (await api("/api/app/receipts/upload", {
      name: file.name,
      mimeType,
      sizeBytes: file.size,
      groupId,
    })) as unknown as { receiptId: string; signedUrl: string };
    const uploaded = await fetch(created.signedUrl, {
      method: "PUT",
      headers: { "content-type": mimeType, "x-upsert": "false" },
      body: file,
    });
    if (!uploaded.ok) throw new Error("收據上傳失敗");
    const result = (await api(`/api/app/receipts/${created.receiptId}/process`, {})) as unknown as {
      extraction: { merchant: string | null; expenseDate: string | null; amountTwd: number | null };
    };
    return { receiptId: created.receiptId, extraction: result.extraction };
  }

  async function openReceiptUrl(id: string) {
    try {
      const r = (await api(`/api/app/receipts/${id}/url`, {})) as unknown as { url: string };
      window.open(r.url, "_blank", "noopener,noreferrer");
    } catch {
      toast.error("無法開啟收據");
    }
  }

  function openAdd() {
    setEditExpense(null);
    sessionStorage.removeItem("editExpense");
    sessionStorage.removeItem("receiptDraft");
    setExpenseOpen(true);
  }

  function openEdit(expense: Expense) {
    setEditExpense(expense);
    setExpenseOpen(true);
  }

  function closeExpense() {
    setExpenseOpen(false);
    setEditExpense(null);
    sessionStorage.removeItem("editExpense");
    sessionStorage.removeItem("receiptDraft");
  }

  React.useEffect(() => {
    if (!error) return;
    toast.error(error, { duration: 4000 });
  }, [error]);

  // ─── Login / Loading ───
  if (!data) {
    if (loginError) {
      return (
        <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center animate-fade-in">
          <div className="flex size-20 items-center justify-center rounded-3xl bg-primary text-2xl font-extrabold text-primary-foreground shadow-[var(--shadow-fab)]">
            共
          </div>
          <h1 className="text-xl font-bold tracking-tight">共同帳本</h1>
          <p className="text-[14px] text-[var(--muted-foreground)]">{loginError}</p>
          <Button variant="primary" size="md" onClick={() => void startLiff()}>
            重新登入
          </Button>
        </main>
      );
    }
    return <LoadingShell />;
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-[640px] flex-col pb-nav">
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 bg-background/85 px-4 pb-3 pt-[max(16px,env(safe-area-inset-top))] backdrop-blur-xl">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-foreground)]">
            共同帳本
          </p>
          <h1 className="text-lg font-bold tracking-tight">{titleFor(tab)}</h1>
        </div>
        {tab !== "private" && (
          <label className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-[var(--muted-foreground)]">
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
              className="h-9 rounded-lg border-[1.5px] border-[var(--border)] bg-[var(--card)] px-2 py-1 text-[13px] font-semibold text-foreground focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)]"
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
        )}
      </header>

      <div className="flex-1 px-4 pb-4">
        <div key={tab} className="animate-slide-up">
          {tab === "dashboard" && (
            <Dashboard
              data={data}
              onSettle={(amount) =>
                void propose({
                  type: "settle",
                  groupId: data.activeGroupId,
                  amountTwd: amount,
                })
              }
              onAdd={openAdd}
              onEdit={openEdit}
              onReceipt={openReceiptUrl}
            />
          )}
          {tab === "history" && (
            <HistorySection
              expenses={data.sharedExpenses}
              users={data.users}
              onEdit={openEdit}
              onDelete={(expense) =>
                void propose({
                  type: expense.deleted_at ? "restore_expense" : "delete_expense",
                  expenseId: expense.id,
                  expectedVersion: expense.version,
                })
              }
              onReceipt={openReceiptUrl}
            />
          )}
          {tab === "private" && (
            <PrivateLedger
              data={data}
              onEdit={openEdit}
              onDelete={(expense) =>
                void propose({
                  type: expense.deleted_at ? "restore_expense" : "delete_expense",
                  expenseId: expense.id,
                  expectedVersion: expense.version,
                })
              }
              onReceipt={openReceiptUrl}
            />
          )}
          {tab === "settings" && (
            <SettingsSection
              data={data}
              onGroup={(body, success) => void mutate("/api/app/groups", body, { success })}
              onRecurring={(body, success) =>
                void mutate("/api/app/recurring", body, { success })
              }
              onPropose={() => {}}
              onBatchCreate={(expenses: ExpenseInput[]) => void propose({ type: "batch_create_expenses", expenses })}
            />
          )}
        </div>
      </div>

      <NavBar tab={tab} onChange={setTab} onAdd={openAdd} />

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
          onExit={closeExpense}
          onSubmit={(body) => {
            void propose(body).then(({ success }) => {
              if (success) closeExpense();
            });
          }}
          onDelete={
            editExpense
              ? () => {
                  if (!confirm("確定要刪除這筆支出嗎？")) return;
                  void propose({
                    type: "delete_expense",
                    expenseId: editExpense.id,
                    expectedVersion: editExpense.version,
                  }).then(({ success }) => {
                    if (success) closeExpense();
                  });
                }
              : undefined
          }
          onReceipt={async (file) =>
            uploadReceipt(file, data.activeGroupId)
          }
        />
      </Sheet>

      <ConfirmDialog
        preview={proposal ? proposal.preview : null}
        busy={busy}
        onConfirm={() => {
          void decide(true).then((res) => {
            if (res?.result === "confirmed") {
              toast.success("已完成");
            }
          });
        }}
        onCancel={() => {
          void decide(false);
        }}
      />
    </main>
  );
}

function titleFor(tab: TabKey): string {
  switch (tab) {
    case "dashboard":
      return "總覽";
    case "history":
      return "帳務流水";
    case "private":
      return "私人帳";
    case "settings":
      return "設定";
  }
}

function receiptMime(file: File): string | null {
  if (["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(file.type))
    return file.type;
  const ext = file.name.toLowerCase().split(".").pop();
  return ext === "heic" ? "image/heic" : ext === "heif" ? "image/heif" : null;
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