"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  applyOptimistic,
  type PendingActionInput,
} from "@/lib/optimistic";
import { ExpenseEditor } from "@/components/expense/expense-form";
import { Dashboard } from "@/components/dashboard/dashboard-section";
import { SettingsSection } from "@/components/settings/settings-section";
import { HistorySection } from "@/components/settings/history-section";
import { BudgetSection } from "@/components/settings/budget-section";

type Tab =
  | "dashboard"
  | "history"
  | "private"
  | "add"
  | "budgets"
  | "settings";
import type {
  User,
  Group,
  Expense,
  DashboardData,
  Bootstrap,
  ProjectionData,
  CategoryAnalytics,
  BalanceSuggestion,
} from "@/lib/types";

const tabs: Tab[] = [
  "dashboard",
  "history",
  "private",
  "add",
  "budgets",
  "settings",
];
const categoryNames: Record<string, string> = {
  food: "餐飲",
  transport: "交通",
  groceries: "生鮮",
  household: "居家",
  entertainment: "娛樂",
  shopping: "購物",
  medical: "醫療",
  travel: "旅行",
  other: "其他",
};
const categoryEmojis: Record<string, string> = {
  food: "🍽",
  transport: "🚗",
  groceries: "🥬",
  household: "🏠",
  entertainment: "🎮",
  shopping: "🛍",
  medical: "💊",
  travel: "✈️",
  other: "📦",
};
const palette = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#84cc16",
  "#94a3b8",
];

function tabFromUrl(): Tab {
  const value = urlParam("tab");
  return tabs.includes(value as Tab) ? (value as Tab) : "dashboard";
}

function inviteFromUrl(): string | undefined {
  return urlParam("invite")?.slice(0, 200);
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

declare global {
  interface Window {
    liff?: {
      init(input: { liffId: string }): Promise<void>;
      isLoggedIn(): boolean;
      login(): void;
      getIDToken(): string | null;
      isInClient(): boolean;
      closeWindow(): void;
    };
  }
}

/* ─── SVG Icon Components ─── */
function IconHome() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z" />
      <path d="M9 21V12h6v9" />
    </svg>
  );
}
function IconList() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function IconUser() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21a8 8 0 10-16 0" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}
function IconBudget() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}
function IconSettings() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

export default function Home() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [tab, setTab] = useState<Tab>(() => tabFromUrl());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<{
    actionId: string;
    preview: string;
    action?: PendingActionInput;
  } | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/app/bootstrap", { cache: "no-store" });
    if (!response.ok) return false;
    setData(await response.json());
    return true;
  }, []);

  useEffect(() => {
    // This effect synchronizes the UI with the LIFF URL that opened the app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTab((current) => {
      const next = tabFromUrl();
      return current === next ? current : next;
    });
  }, []);

  useEffect(() => {
    // This effect synchronizes the UI with the authenticated server session.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    if (!data) return;
    const params = new URLSearchParams(window.location.search);
    const receiptId = params.get("receipt");
    if (receiptId) {
      void fetch(`/api/app/receipts/${receiptId}`)
        .then(parseResponse)
        .then((receipt) => {
          sessionStorage.setItem("receiptDraft", JSON.stringify(receipt));
          sessionStorage.removeItem("editExpense");
          history.replaceState(null, "", "/");
          setTab("add");
        })
        .catch((reason) =>
          setError(reason instanceof Error ? reason.message : "無法讀取收據"),
        );
      return;
    }
    const editId = params.get("edit");
    if (editId) {
      const expense =
        data.expenses.find((e) => e.id === editId) ||
        data.sharedExpenses.find((e) => e.id === editId) ||
        data.privateExpenses.find((e) => e.id === editId);
      if (expense) {
        sessionStorage.setItem("editExpense", JSON.stringify(expense));
        sessionStorage.removeItem("receiptDraft");
        history.replaceState(null, "", "/");
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setTab("add");
      }
    }
  }, [data]);

  const startLiff = useCallback(async () => {
    if (data) return;
    const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
    if (!liffId || !window.liff) return setError("尚未設定 LIFF ID");
    try {
      await window.liff.init({ liffId });
      if (!window.liff.isLoggedIn()) return window.liff.login();
      const idToken = window.liff.getIDToken();
      if (!idToken) throw new Error("LINE 沒有提供登入憑證");
      const invite = inviteFromUrl();
      await api("/api/app/session", { idToken, ...(invite ? { invite } : {}) });
      if (invite) {
        const url = new URL(window.location.href);
        url.searchParams.delete("invite");
        history.replaceState(null, "", `${url.pathname}${url.search}`);
      }
      if (!(await load())) throw new Error("無法讀取帳本");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "LINE 登入失敗");
    }
  }, [data, load]);

  useEffect(() => {
    if (data) return;
    const timer = window.setInterval(() => {
      if (!window.liff) return;
      window.clearInterval(timer);
      void startLiff();
    }, 100);
    return () => window.clearInterval(timer);
  }, [data, startLiff]);

  async function mutate(path: string, body: unknown, success?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api(path, body);
      if (success) setNotice(success);
      await load();
      return result;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失敗");
      throw reason;
    } finally {
      setBusy(false);
    }
  }

  async function propose(body: PendingActionInput) {
    setError("");
    try {
      const result = (await api("/api/app/actions", body)) as {
        actionId: string;
        preview: string;
      };
      setConfirm({ ...result, action: body });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失敗");
    }
  }

  async function decide(value: boolean) {
    if (!confirm) return;
    const current = confirm;
    setConfirm(null);
    if (!value) {
      try {
        await api("/api/app/actions/confirm", {
          actionId: current.actionId,
          confirm: false,
        });
        setNotice("已取消");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "操作失敗");
      }
      return;
    }
    const snapshot = data;
    if (snapshot && current.action) {
      setData(applyOptimistic(snapshot, current.action) as Bootstrap);
    }
    try {
      const result = (await api("/api/app/actions/confirm", {
        actionId: current.actionId,
        confirm: true,
      })) as { result: string };
      if (result.result === "confirmed") {
        sessionStorage.removeItem("editExpense");
        sessionStorage.removeItem("receiptDraft");
        setNotice("已完成");
        void load();
      } else {
        if (snapshot) setData(snapshot);
        setNotice(
          result.result === "cancelled"
            ? "已取消"
            : "帳目已變動，請重試",
        );
      }
    } catch (reason) {
      if (snapshot) setData(snapshot);
      setError(reason instanceof Error ? reason.message : "操作失敗");
    }
  }

  if (!data) {
    if (error) {
      return (
        <main className="center-state">
          <div className="brand-mark">共</div>
          <h1>共同帳本</h1>
          <p>{error}</p>
          <button onClick={() => void startLiff()}>重新登入</button>
        </main>
      );
    }
    return (
      <main className="app-shell loading-shell">
        <header className="topbar">
          <div>
            <span className="eyebrow">共同帳本</span>
            <h1>總覽</h1>
          </div>
        </header>
        <section className="content">
          <DashboardSkeleton />
        </section>
      </main>
    );
  }

  const activeGroup = data.groups.find(
    (group) => group.id === data.activeGroupId,
  )!;
  const unread = data.notifications.filter((item) => !item.read_at).length;
  const sharedExpenses =
    data.sharedExpenses ??
    data.expenses.filter(
      (expense) =>
        expense.ledger === "shared" && expense.group_id === data.activeGroupId,
    );

  function confirmTypeIcon(preview: string): string {
    if (preview.includes("刪除")) return "🗑";
    if (preview.includes("修改") || preview.includes("更新")) return "✏️";
    if (preview.includes("結清")) return "🤝";
    if (preview.includes("復原")) return "↩️";
    return "✅";
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">共同帳本</span>
          <h1>{titleFor(tab)}</h1>
        </div>
        {tab !== "private" && (
          <label className="group-picker">
            <span>目前群組</span>
            <select
              value={data.activeGroupId}
              onChange={(event) =>
                void mutate("/api/app/groups", {
                  operation: "activate",
                  groupId: event.target.value,
                })
              }
            >
              {data.groups
                .filter((group) => !group.archived_at)
                .map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
            </select>
          </label>
        )}
      </header>
      {error && (
        <div className="toast error" role="alert">
          {error}
          <button aria-label="關閉" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          {notice}
          <button aria-label="關閉" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      )}

      <section className="content">
        {tab === "dashboard" && (
          <Dashboard
            data={data}
            activeGroup={activeGroup}
            onSettle={(amountTwd) =>
              void propose({
                type: "settle",
                groupId: data.activeGroupId,
                amountTwd,
              })
            }
            onAdd={() => setTab("add")}
            onEdit={(expense) => {
              setTab("add");
              sessionStorage.setItem("editExpense", JSON.stringify(expense));
            }}
            onReceipt={(id) => void openReceipt(id)}
          />
        )}
        {tab === "history" && (
          <HistorySection
            expenses={sharedExpenses}
            users={data.users}
            onEdit={(expense) => {
              setTab("add");
              sessionStorage.setItem("editExpense", JSON.stringify(expense));
            }}
            onDelete={(expense) =>
              void propose({
                type: expense.deleted_at ? "restore_expense" : "delete_expense",
                expenseId: expense.id,
                expectedVersion: expense.version,
              })
            }
            onReceipt={(id) => void openReceipt(id)}
          />
        )}
        {tab === "private" && (
          <PrivateLedger
            data={data}
            onEdit={(expense) => {
              setTab("add");
              sessionStorage.setItem("editExpense", JSON.stringify(expense));
            }}
            onDelete={(expense) =>
              void propose({
                type: expense.deleted_at ? "restore_expense" : "delete_expense",
                expenseId: expense.id,
                expectedVersion: expense.version,
              })
            }
            onReceipt={(id) => void openReceipt(id)}
          />
        )}
        {tab === "add" && (
          <ExpenseEditor
            data={data}
            busy={busy}
            onSubmit={(body) => void propose(body as PendingActionInput)}
            onReceipt={async (file) => uploadReceipt(file, data.activeGroupId)}
          />
        )}
        {tab === "budgets" && (
          <BudgetSection
            data={data}
            onSave={(body) =>
              void mutate("/api/app/budgets", body, "預算已儲存")
            }
          />
        )}
        {tab === "settings" && (
          <SettingsSection
            data={data}
            unread={unread}
            onGroup={(body) =>
              void mutate("/api/app/groups", body, "群組已更新")
            }
            onRecurring={(body) =>
              void mutate("/api/app/recurring", body, "週期支出已儲存")
            }
            onRead={() =>
              void mutate("/api/app/notifications/read", {}, "已標示為已讀")
            }
            onPropose={(confirmData) =>
              setConfirm(confirmData as {
                actionId: string;
                preview: string;
                action?: PendingActionInput;
              })
            }
            onBatchCreate={(expenses) =>
              void propose({ type: "batch_create_expenses", expenses })
            }
          />
        )}
      </section>

      <nav className="bottom-nav" aria-label="主要導覽">
        <NavButton
          active={tab === "dashboard"}
          label="總覽"
          icon={<IconHome />}
          onClick={() => setTab("dashboard")}
        />
        <NavButton
          active={tab === "history"}
          label="流水"
          icon={<IconList />}
          onClick={() => setTab("history")}
        />
        <NavButton
          active={tab === "private"}
          label="私人"
          icon={<IconUser />}
          onClick={() => setTab("private")}
        />
        <NavButton
          active={tab === "add"}
          label="新增"
          icon={<IconPlus />}
          primary
          onClick={() => {
            sessionStorage.removeItem("editExpense");
            setTab("add");
          }}
        />
        <NavButton
          active={tab === "budgets"}
          label="預算"
          icon={<IconBudget />}
          onClick={() => setTab("budgets")}
        />
        <NavButton
          active={tab === "settings"}
          label="設定"
          icon={<IconSettings />}
          badge={unread || undefined}
          onClick={() => setTab("settings")}
        />
      </nav>
      {confirm && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
          >
            <div className="modal-handle" />
            <div className="modal-type">
              <span>{confirmTypeIcon(confirm.preview)}</span>
              <span className="eyebrow">請再次確認</span>
            </div>
            <h2 id="confirm-title">帳務變更</h2>
            <p className="modal-desc">以下操作將會更新帳本紀錄</p>
            <p className="preview">{confirm.preview}</p>
            <div className="modal-actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void decide(false)}
              >
                取消
              </button>
              <button disabled={busy} onClick={() => void decide(true)}>
                確認執行
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );

  async function uploadReceipt(file: File, groupId: string) {
    if (file.size > 10 * 1024 * 1024) throw new Error("收據不可超過 10 MB");
    const mimeType = receiptMime(file);
    if (!mimeType) throw new Error("只接受 JPEG、PNG、WebP 或 HEIC 收據");
    const created = (await api("/api/app/receipts/upload", {
      name: file.name,
      mimeType,
      sizeBytes: file.size,
      groupId,
    })) as { receiptId: string; signedUrl: string };
    const uploaded = await fetch(created.signedUrl, {
      method: "PUT",
      headers: { "content-type": mimeType, "x-upsert": "false" },
      body: file,
    });
    if (!uploaded.ok) throw new Error("收據上傳失敗");
    const result = (await api(
      `/api/app/receipts/${created.receiptId}/process`,
      {},
    )) as {
      extraction: {
        merchant: string | null;
        expenseDate: string | null;
        amountTwd: number | null;
        confidence: number;
      };
    };
    return { ...result, receiptId: created.receiptId };
  }

  async function openReceipt(id: string) {
    try {
      const result = (await fetch(`/api/app/receipts/${id}/url`).then(
        parseResponse,
      )) as { url: string };
      window.open(result.url, "_blank", "noopener,noreferrer");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "無法開啟收據");
    }
  }
}

function ProjectionWidget({
  projection,
  budgets,
}: {
  projection: ProjectionData;
  budgets: Bootstrap["budgets"];
}) {
  if (!projection) return null;
  const { daysElapsed, spentSoFar, projectedTotal, categoryProjections } = projection;
  if (daysElapsed < 4) return null;

  // Find total budget
  const totalBudgetRow = budgets.find((b) => b.category === null);
  const totalBudget = totalBudgetRow ? Number(totalBudgetRow.limit_twd) : 0;
  const totalOverrun = totalBudget > 0 ? projectedTotal - totalBudget : 0;

  // Find category overruns
  const overruns = categoryProjections.filter((cp) => cp.projectedOverrun > 0);

  return (
    <article className="panel projection-widget">
      <div className="panel-title">
        <div>
          <span className="eyebrow">本月花費線性外推預估</span>
          <h2>月底收支預估 📊</h2>
        </div>
      </div>
      
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <div>
          已花 <strong>{money(spentSoFar)}</strong> ／ 預估月底 <strong>{money(projectedTotal)}</strong>
          {totalBudget > 0 && (
            <div style={{ marginTop: "0.25rem", fontSize: "14px" }}>
              {totalOverrun > 0 ? (
                <span style={{ color: "var(--danger)", fontWeight: "bold" }}>
                  ⚠️ 預估超支 {money(totalOverrun)} (預算 {money(totalBudget)})
                </span>
              ) : (
                <span style={{ color: "#10b981", fontWeight: "bold" }}>
                  ✅ 預估在預算內 (剩餘空間約 {money(totalBudget - projectedTotal)})
                </span>
              )}
            </div>
          )}
        </div>

        {overruns.length > 0 && (
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: "0.5rem" }}>
            <span className="eyebrow" style={{ color: "var(--danger)" }}>⚠️ 類別超支預警</span>
            <ul style={{ margin: "0.25rem 0 0 0", paddingLeft: "1.25rem", fontSize: "13px" }}>
              {overruns.map((o) => (
                <li key={o.categoryLabel || o.category || "other"} style={{ margin: "0.2rem 0" }}>
                  {o.categoryLabel || (o.category ? (categoryNames[o.category] || o.category) : "其他")}{" "}
                  <strong>{money(o.spentSoFar)}</strong> → 預估月底 <strong>{money(o.projectedTotal)}</strong>{" "}
                  <span style={{ color: "var(--danger)" }}>(預計超出 {money(o.projectedOverrun)})</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </article>
  );
}

/* ─── Skeleton Loading ─── */
function DashboardSkeleton() {
  return (
    <div className="stack skeleton-stack">
      <article className="balance-card skeleton-card">
        <div className="skeleton-line w-40" />
        <div className="skeleton-line w-60 lg" />
        <div className="skeleton-line w-80" />
      </article>
      <div className="metric-grid">
        <article className="skeleton-card">
          <div className="skeleton-line w-50" />
          <div className="skeleton-line w-70 lg" />
        </article>
        <article className="skeleton-card">
          <div className="skeleton-line w-50" />
          <div className="skeleton-line w-40 lg" />
        </article>
      </div>
      <article className="panel skeleton-card">
        <div className="skeleton-line w-30" />
        <div className="category-chart skeleton-chart">
          <div className="skeleton-donut animate-pulse" />
          <div className="legend">
            {[1, 2, 3].map((item) => (
              <div key={item}>
                <div className="skeleton-dot" />
                <div className="skeleton-line w-80" />
              </div>
            ))}
          </div>
        </div>
      </article>
      <article className="panel skeleton-card">
        {[1, 2, 3, 4].map((item) => (
          <div className="skeleton-row" key={item}>
            <div className="skeleton-avatar" />
            <div className="skeleton-line w-90" />
          </div>
        ))}
      </article>
    </div>
  );
}

type DrillExpense = {
  id: string;
  description: string;
  merchant: string | null;
  amount_twd: number;
  expense_date: string;
  category: string;
  category_label: string;
  paid_by_user_id: string;
  version: number;
  receipts: Array<{ id: string; status: string }>;
};

function SearchPanel({
  users,
  onEdit,
  onReceipt,
}: {
  users: User[];
  onEdit(expense: Expense): void;
  onReceipt(id: string): void;
}) {
  const [query, setQuery] = useState(() => urlParam("search") ?? "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [category, setCategory] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [results, setResults] = useState<Expense[]>([]);
  const [error, setError] = useState("");
  const active = query.trim().length > 0;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        q: query.trim(),
        limit: "20",
      });
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (category) params.set("category", category);
      if (min) params.set("min", min);
      if (max) params.set("max", max);
      void fetch(`/api/app/expenses/search?${params}`, { cache: "no-store" })
        .then(parseResponse)
        .then((payload) => {
          if (!cancelled) {
            setResults((payload as { expenses: Expense[] }).expenses);
            setError("");
          }
        })
        .catch((reason) => {
          if (!cancelled) {
            setResults([]);
            setError(reason instanceof Error ? reason.message : "搜尋失敗");
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, query, from, to, category, min, max]);

  return (
    <article className="panel search-panel">
      <label className="search-box">
        <IconSearch />
        <input
          placeholder="搜尋支出..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {active && (
        <>
          <div className="search-filters">
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} aria-label="搜尋起日" />
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} aria-label="搜尋迄日" />
            <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="搜尋分類">
              <option value="">全部分類</option>
              {Object.entries(categoryNames).map(([key, label]) => (
                <option value={key} key={key}>{label}</option>
              ))}
            </select>
            <input inputMode="numeric" placeholder="最低金額" value={min} onChange={(event) => setMin(event.target.value)} />
            <input inputMode="numeric" placeholder="最高金額" value={max} onChange={(event) => setMax(event.target.value)} />
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="search-results">
            {results.map((expense) => (
              <ExpenseDrillItem
                key={expense.id}
                expense={expense}
                users={users}
                onEdit={onEdit}
                onReceipt={onReceipt}
              />
            ))}
            {!results.length && !error && <Empty text="沒有符合的支出" icon="🔎" />}
          </div>
        </>
      )}
    </article>
  );
}

function ExpenseDrillItem({
  expense,
  users,
  onEdit,
  onReceipt,
}: {
  expense: DrillExpense | Expense;
  users: User[];
  onEdit?(expense: Expense): void;
  onReceipt?(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [thumb, setThumb] = useState<string | null>(null);
  const receiptId = expense.receipts[0]?.id;

  useEffect(() => {
    if (!open || !receiptId || thumb) return;
    let cancelled = false;
    void fetch(`/api/app/receipts/${receiptId}/url`)
      .then(parseResponse)
      .then((result) => {
        if (!cancelled) setThumb((result as { url: string }).url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, receiptId, thumb]);

  return (
    <div className="drill-item">
      <button
        type="button"
        className="drill-item-head"
        onClick={() => setOpen((value) => !value)}
      >
        <div>
          <strong>{expense.description}</strong>
          <small>
            {expense.expense_date.slice(5).replace("-", "/")} ·{" "}
            {users.find((user) => user.id === expense.paid_by_user_id)?.label}付款
          </small>
        </div>
        <strong>{money(expense.amount_twd)}</strong>
      </button>
      {open && (
        <div className="drill-item-body">
          {receiptId && thumb && (
            <img
              className="receipt-thumb"
              src={thumb}
              alt="收據縮圖"
              loading="lazy"
            />
          )}
          <div className="row-actions">
            {onEdit && (
              <button
                className="text-button"
                type="button"
                onClick={() => onEdit(expense as Expense)}
              >
                編輯
              </button>
            )}
            {receiptId && onReceipt && (
              <button
                className="text-button"
                type="button"
                onClick={() => onReceipt(receiptId)}
              >
                查看收據
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CategoryDrillDown({
  label,
  range,
  scope,
  month,
  users,
  onEdit,
  onReceipt,
}: {
  label: string;
  range: CategoryAnalytics["range"];
  scope: CategoryAnalytics["scope"];
  month?: string;
  users: User[];
  onEdit?(expense: Expense): void;
  onReceipt?(id: string): void;
}) {
  const [items, setItems] = useState<DrillExpense[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      label,
      range,
      scope,
      offset: "0",
      limit: "20",
    });
    if (month) params.set("month", month);
    void fetch(`/api/app/analytics/expenses?${params}`, { cache: "no-store" })
      .then(parseResponse)
      .then((result) => {
        if (cancelled) return;
        const payload = result as {
          expenses: DrillExpense[];
          total: number;
        };
        setItems(payload.expenses);
        setTotal(payload.total);
      })
      .catch(() => {
        if (!cancelled) {
          setItems([]);
          setTotal(0);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [label, range, scope, month]);

  const loadMore = async () => {
    const params = new URLSearchParams({
      label,
      range,
      scope,
      offset: String(items.length),
      limit: "20",
    });
    if (month) params.set("month", month);
    const result = (await fetch(
      `/api/app/analytics/expenses?${params}`,
      { cache: "no-store" },
    ).then(parseResponse)) as { expenses: DrillExpense[] };
    setItems((current) => [...current, ...result.expenses]);
  };

  if (loading) return <div className="drill-panel loading">載入明細…</div>;

  return (
    <div className="drill-panel">
      {items.map((expense) => (
        <ExpenseDrillItem
          key={expense.id}
          expense={expense}
          users={users}
          onEdit={onEdit}
          onReceipt={onReceipt}
        />
      ))}
      {items.length < total && (
        <button type="button" className="text-button load-more" onClick={() => void loadMore()}>
          載入更多（{items.length}/{total}）
        </button>
      )}
      {!items.length && <Empty text="這個分類沒有明細" icon="📭" />}
    </div>
  );
}



/* ─── Private Ledger ─── */
function PrivateLedger({
  data,
  onEdit,
  onDelete,
  onReceipt,
}: {
  data: Bootstrap;
  onEdit(expense: Expense): void;
  onDelete(expense: Expense): void;
  onReceipt(id: string): void;
}) {
  const [categoryRange, setCategoryRange] =
    useState<CategoryAnalytics["range"]>("this_month");
  const [analytics, setAnalytics] = useState<CategoryAnalytics | null>(null);
  const privateExpenses =
    data.privateExpenses ??
    data.expenses.filter(
      (expense) =>
        expense.ledger === "private" && expense.created_by_user_id === data.user.id,
    );
  const privateDashboard =
    data.privateDashboard ?? buildClientDashboard(privateExpenses, data.month);

  useEffect(() => {
    let cancelled = false;
    void fetch(
      `/api/app/analytics/categories?range=${categoryRange}&scope=private`,
      { cache: "no-store" },
    )
      .then(parseResponse)
      .then((result) => {
        if (!cancelled) setAnalytics(result as CategoryAnalytics);
      })
      .catch(() => {
        if (!cancelled) setAnalytics(null);
      });
    return () => {
      cancelled = true;
    };
  }, [categoryRange]);

  const fallbackCategories = Object.entries(privateDashboard.categoryTotals)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([category, value]) => ({
      label: categoryNames[category] ?? category,
      totalTwd: value,
      count: 0,
      percent: 0,
    }));
  const categoryRows = analytics?.categories.length
    ? analytics.categories
    : fallbackCategories;
  const categoryTotal =
    analytics?.totalTwd ?? privateDashboard.monthlyTotalTwd;

  return (
    <div className="stack">
      <article className="balance-card private-card">
        <span>👤 私人帳</span>
        <strong>{money(privateDashboard.monthlyTotalTwd)}</strong>
        <small>
          本月 {privateDashboard.monthlyCount} 筆，含共同帳自動分攤
        </small>
      </article>
      <article className="panel">
        <div className="panel-title">
          <div>
            <span className="eyebrow">私人支出分析</span>
            <h2>分類占比</h2>
          </div>
          <strong>{money(categoryTotal)}</strong>
        </div>
        <div className="segmented three">
          {(["this_month", "six_months", "all"] as const).map((range) => (
            <button
              key={range}
              type="button"
              className={categoryRange === range ? "active" : ""}
              onClick={() => setCategoryRange(range)}
            >
              {range === "this_month" ? "本月" : range === "six_months" ? "近六月" : "全部"}
            </button>
          ))}
        </div>
        {categoryRows.length ? (
          <div className="category-chart">
            <div
              className="donut"
              style={{
                background: donutGradient(
                  categoryRows.map((item) => [item.label, item.totalTwd]),
                  categoryTotal,
                ),
              }}
            >
              <span>
                {categoryRows.length}
                <small>分類</small>
              </span>
            </div>
            <div className="legend">
              {categoryRows.slice(0, 6).map((category, index) => (
                <div key={category.label}>
                  <i style={{ background: palette[index] }} />
                  <span>{category.label}</span>
                  <strong>{money(category.totalTwd)}</strong>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <Empty text="私人帳還沒有支出" icon="👤" />
        )}
      </article>
      <HistorySection
        expenses={privateExpenses}
        users={data.users}
        onEdit={onEdit}
        onDelete={onDelete}
        onReceipt={onReceipt}
      />
    </div>
  );
}


/* ─── Budgets ─── */


/* ─── Bank CSV Import ─── */
type BankMatch = {
  bankTx: { date: string; amount: number; description: string };
  matchedExpenseId: string | null;
  matchedDescription: string | null;
  confidence: number;
};

function BankImport({
  data,
  onBack,
  onBatchCreate,
}: {
  data: Bootstrap;
  onBack(): void;
  onBatchCreate(
    expenses: Array<{
      ledger: "shared" | "private";
      groupId: string | null;
      description: string;
      merchant: string | null;
      notes: string | null;
      category: string;
      amountTwd: number;
      paidBy: "self" | "partner";
      expenseDate: string;
      splitMethod: "equal" | "exact" | "percentage";
      selfValue: number | null;
      partnerValue: number | null;
      receiptId: string | null;
    }>,
  ): void;
}) {
  const [bank, setBank] = useState<"auto" | "esun" | "cathay" | "taishin" | "ctbc">("auto");
  const [matches, setMatches] = useState<BankMatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [detectedBank, setDetectedBank] = useState("");

  async function handleFile(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const csv = await file.text();
      const result = (await api("/api/app/bank/import", { csv, bank })) as {
        bank: string;
        matches: BankMatch[];
      };
      setDetectedBank(result.bank);
      setMatches(result.matches);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "匯入失敗");
    } finally {
      setBusy(false);
    }
  }

  const unmatched = matches.filter((item) => !item.matchedExpenseId);

  function buildExpense(match: BankMatch) {
    return {
      ledger: "shared" as const,
      groupId: data.activeGroupId,
      description: match.bankTx.description.slice(0, 100),
      merchant: match.bankTx.description.slice(0, 100),
      notes: "信用卡帳單匯入",
      category: "other",
      amountTwd: match.bankTx.amount,
      paidBy: "self" as const,
      expenseDate: match.bankTx.date,
      splitMethod: "equal" as const,
      selfValue: null,
      partnerValue: null,
      receiptId: null,
    };
  }

  return (
    <div className="stack">
      <article className="panel">
        <div className="panel-title">
          <div>
            <button type="button" className="text-button" onClick={onBack}>
              ← 返回
            </button>
            <h2>匯入信用卡帳單</h2>
          </div>
        </div>
        <Field label="銀行">
          <select
            value={bank}
            onChange={(event) =>
              setBank(event.target.value as typeof bank)
            }
          >
            <option value="auto">自動偵測</option>
            <option value="esun">玉山銀行</option>
            <option value="cathay">國泰世華</option>
            <option value="taishin">台新銀行</option>
            <option value="ctbc">中國信託</option>
          </select>
        </Field>
        <label className="upload">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => void handleFile(event.target.files?.[0])}
          />
          <strong>{busy ? "解析中…" : "選擇 CSV 檔案"}</strong>
          <small>支援玉山、國泰、台新、中信常見格式</small>
        </label>
        {detectedBank && (
          <p className="import-meta">
            偵測銀行：{detectedBank} · 共 {matches.length} 筆 · 已配對{" "}
            {matches.length - unmatched.length} 筆
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
      </article>

      {matches.length > 0 && (
        <article className="panel match-game">
          <div className="panel-title">
            <div>
              <span className="eyebrow">配對結果</span>
              <h2>帳單 ↔ 系統支出</h2>
            </div>
          </div>
          {matches.map((match, index) => (
            <div className="match-row" key={`${match.bankTx.date}-${match.bankTx.amount}-${index}`}>
              <div className="match-bank">
                <strong>{match.bankTx.description}</strong>
                <small>
                  {match.bankTx.date} · {money(match.bankTx.amount)}
                </small>
              </div>
              <span className="match-arrow">
                {match.matchedExpenseId ? "✓" : "?"}
              </span>
              <div className={`match-expense ${match.matchedExpenseId ? "matched" : "unmatched"}`}>
                {match.matchedExpenseId ? (
                  <>
                    <strong>{match.matchedDescription}</strong>
                    <small>已配對</small>
                  </>
                ) : (
                  <>
                    <strong>未配對</strong>
                    <small>確認後批次新增</small>
                  </>
                )}
              </div>
            </div>
          ))}
          {unmatched.length > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                onBatchCreate(unmatched.map((match) => buildExpense(match)))
              }
            >
              一鍵新增 {unmatched.length} 筆未配對
            </button>
          )}
        </article>
      )}
    </div>
  );
}


type CanonicalLabel = {
  id: string;
  category: string;
  label: string;
  aliases: string[];
};

function CanonicalLabelsManager({
  onBack,
  onPropose,
}: {
  onBack(): void;
  onPropose(body: unknown): void;
}) {
  const [labels, setLabels] = useState<CanonicalLabel[]>([]);
  const [selectedLabels, setSelectedLabels] = useState<Record<string, string[]>>({});
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<{ category: string; oldLabel: string; newLabel: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const loadLabels = useCallback(async () => {
    try {
      const res = await fetch("/api/app/canonical-labels", { cache: "no-store" }).then(parseResponse);
      setLabels(res as CanonicalLabel[]);
    } catch {
      setError("無法載入分類標籤");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadLabels();
  }, [loadLabels]);

  const handleSelect = (category: string, label: string, checked: boolean) => {
    setSelectedLabels((prev) => {
      const list = prev[category] ?? [];
      const next = checked ? [...list, label] : list.filter((l) => l !== label);
      return { ...prev, [category]: next };
    });
  };

  const handleMerge = async (category: string) => {
    const selected = selectedLabels[category] ?? [];
    const target = mergeTargets[category]?.trim();
    if (selected.length < 2) {
      setError("請至少選擇兩個標籤進行合併");
      return;
    }
    if (!target) {
      setError("請選擇合併後的目標標籤");
      return;
    }
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      const sourceLabels = selected.filter((l) => l !== target);
      const res = (await api("/api/app/canonical-labels/merge", {
        targetLabel: target,
        sourceLabels,
        category,
      })) as { actionId: string | null; preview: string };

      if (res.actionId) {
        onPropose({
          actionId: res.actionId,
          preview: res.preview,
        });
        setSuccess("已提交合併提案，需另一半確認！");
      } else {
        setSuccess("標籤已直接合併！");
        void loadLabels();
      }
      setSelectedLabels((prev) => ({ ...prev, [category]: [] }));
      setMergeTargets((prev) => ({ ...prev, [category]: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "合併失敗");
    } finally {
      setLoading(false);
    }
  };

  const handleRename = async () => {
    if (!renaming) return;
    const target = renaming.newLabel.trim();
    if (!target) return;
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      const res = (await api("/api/app/canonical-labels/merge", {
        targetLabel: target,
        sourceLabels: [renaming.oldLabel],
        category: renaming.category,
      })) as { actionId: string | null; preview: string };

      if (res.actionId) {
        onPropose({
          actionId: res.actionId,
          preview: res.preview,
        });
        setSuccess("已提交重命名提案，需另一半確認！");
      } else {
        setSuccess("標籤已重命名！");
        void loadLabels();
      }
      setRenaming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重命名失敗");
    } finally {
      setLoading(false);
    }
  };

  const labelsByCategory: Record<string, CanonicalLabel[]> = {};
  for (const cat of Object.keys(categoryNames)) {
    labelsByCategory[cat] = [];
  }
  for (const label of labels) {
    if (!labelsByCategory[label.category]) {
      labelsByCategory[label.category] = [];
    }
    labelsByCategory[label.category].push(label);
  }

  return (
    <div className="stack">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <button type="button" className="text-button" onClick={onBack}>
          ← 返回設定
        </button>
        <h2>標籤管理</h2>
      </div>

      {error && <p className="form-error">{error}</p>}
      {success && <p className="form-notice" style={{ color: "#10b981", fontWeight: "bold" }}>{success}</p>}

      {Object.entries(labelsByCategory).map(([cat, catLabels]) => {
        const selected = selectedLabels[cat] ?? [];
        return (
          <article className="panel" key={cat}>
            <div className="panel-title">
              <div>
                <span className="eyebrow">
                  {categoryEmojis[cat]} {categoryNames[cat] ?? cat}
                </span>
                <h2>常用標籤 ({catLabels.length})</h2>
              </div>
            </div>

            {catLabels.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {catLabels.map((l) => (
                  <div
                    key={l.id}
                    className="setting-row"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "0.25rem 0",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <input
                        type="checkbox"
                        checked={selected.includes(l.label)}
                        onChange={(e) => handleSelect(cat, l.label, e.target.checked)}
                      />
                      <strong>{l.label}</strong>
                      {l.aliases && l.aliases.length > 0 && (
                        <small style={{ opacity: 0.6 }}>(別名: {l.aliases.join(", ")})</small>
                      )}
                    </div>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setRenaming({ category: cat, oldLabel: l.label, newLabel: l.label })}
                    >
                      ✏️ 改名
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <Empty text="目前沒有標籤" icon="🏷️" />
            )}

            {selected.length >= 2 && (
              <div className="inline-form" style={{ marginTop: "1rem" }}>
                <select
                  value={mergeTargets[cat] ?? ""}
                  onChange={(e) => setMergeTargets((prev) => ({ ...prev, [cat]: e.target.value }))}
                >
                  <option value="">選擇合併後的目標標籤</option>
                  {selected.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
                <button type="button" disabled={loading} onClick={() => handleMerge(cat)}>
                  合併
                </button>
              </div>
            )}
          </article>
        );
      })}

      {renaming && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true">
            <div className="modal-title">
              <h3>重新命名標籤</h3>
            </div>
            <div className="field" style={{ margin: "1rem 0" }}>
              <span>把「{renaming.oldLabel}」改名為：</span>
              <input
                type="text"
                value={renaming.newLabel}
                onChange={(e) => setRenaming({ ...renaming, newLabel: e.target.value })}
                maxLength={40}
              />
            </div>
            <div className="two" style={{ display: "flex", gap: "1rem" }}>
              <button type="button" className="wide secondary" onClick={() => setRenaming(null)}>
                取消
              </button>
              <button type="button" className="wide" disabled={loading} onClick={handleRename}>
                確定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Shared UI Components ─── */
function NavButton({
  active,
  label,
  icon,
  primary,
  badge,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  primary?: boolean;
  badge?: number;
  onClick(): void;
}) {
  return (
    <button
      className={`${active ? "active" : ""} ${primary ? "primary" : ""}`}
      onClick={onClick}
    >
      <span className={`nav-icon ${badge ? "nav-badge" : ""}`} {...(badge ? { "data-count": badge } : {})}>
        {icon}
      </span>
      <small>{label}</small>
    </button>
  );
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Empty({ text, icon }: { text: string; icon?: string }) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon ?? "—"}</span>
      <p>{text}</p>
    </div>
  );
}
function ExpenseRow({ expense, users }: { expense: Expense; users: User[] }) {
  const label = displayCategoryLabel(expense);
  const emoji = categoryEmojis[expense.category] ?? "📦";
  return (
    <div
      className={`expense-row ${expense.deleted_at ? "deleted" : ""} ${expense._optimistic ? "optimistic" : ""}`}
    >
      <div className={`category-icon ${expense.category}`}>{emoji}</div>
      <div>
        <strong>
          {expense.description}
          {expense._optimistic && <span className="pending-badge">同步中</span>}
        </strong>
        <small>
          {expense.expense_date} ·{" "}
          {users.find((user) => user.id === expense.paid_by_user_id)?.label}付款
          {expense.ledger === "private" ? (
            <>
              {" · "}
              <span className="ledger-badge private">
                {expense.mirror_kind ? "共同分攤" : "私人"}
              </span>{" "}
              {label}
            </>
          ) : (
            <> · {label}</>
          )}
        </small>
      </div>
      <strong>{money(expense.amount_twd)}</strong>
    </div>
  );
}

/* ─── Utility Functions ─── */
function buildClientDashboard(expenses: Expense[], month: string): DashboardData {
  const active = expenses.filter((expense) => !expense.deleted_at);
  const categoryTotals: Record<string, number> = {};
  const trend = Array.from({ length: 6 }, (_, index) => ({
    month: shiftMonth(month, index - 5),
    totalTwd: 0,
  }));
  for (const expense of active) {
    const expenseMonth = expense.expense_date.slice(0, 7);
    const point = trend.find((item) => item.month === expenseMonth);
    if (point) point.totalTwd += expense.amount_twd;
    if (expenseMonth === month) {
      const label = displayCategoryLabel(expense);
      categoryTotals[label] = (categoryTotals[label] ?? 0) + expense.amount_twd;
    }
  }
  const thisMonth = active.filter((expense) => expense.expense_date.startsWith(month));
  return {
    monthlyTotalTwd: thisMonth.reduce((sum, expense) => sum + expense.amount_twd, 0),
    monthlyCount: thisMonth.length,
    categoryTotals,
    trend,
    recent: active.slice(0, 8),
  };
}

function displayCategoryLabel(expense: Expense) {
  const label = expense.category_label?.trim();
  if (label && !Object.prototype.hasOwnProperty.call(categoryNames, label))
    return label;
  return categoryNames[expense.category] ?? label ?? expense.category;
}

function titleFor(tab: Tab) {
  return (
    {
      dashboard: "總覽",
      history: "帳務流水",
      private: "私人帳",
      add: "新增支出",
      budgets: "預算管理",
      settings: "帳本設定",
    } as const
  )[tab];
}
function frequencyName(value: string) {
  return value === "weekly" ? "每週" : value === "yearly" ? "每年" : "每月";
}
function money(value: number) {
  return `NT$${new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 }).format(value)}`;
}
function shortMoney(value: number) {
  if (value >= 10000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}
function formatDate(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  return `${month}/${day}（${weekdays[d.getDay()]}）`;
}
function shiftMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year!, monthNumber! - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
function donutGradient(items: Array<[string, number]>, total: number) {
  let position = 0;
  const parts = items.map(([, value], index) => {
    const start = position;
    position += (value / total) * 100;
    return `${palette[index % palette.length]} ${start}% ${position}%`;
  });
  return `conic-gradient(${parts.join(",")})`;
}
function receiptMime(file: File) {
  if (
    [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ].includes(file.type)
  )
    return file.type;
  const extension = file.name.toLowerCase().split(".").pop();
  return extension === "heic"
    ? "image/heic"
    : extension === "heif"
      ? "image/heif"
      : null;
}
async function api(path: string, body: unknown) {
  return fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  }).then(parseResponse);
}
async function parseResponse(response: Response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error((body as { error?: string }).error ?? "操作失敗");
  return body;
}
