"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Tab =
  | "dashboard"
  | "history"
  | "private"
  | "add"
  | "accountant"
  | "budgets"
  | "settings";
type User = { id: string; role: "owner" | "partner"; label: string };
type Group = {
  id: string;
  name: string;
  color: string;
  archived_at: string | null;
};
type Expense = {
  id: string;
  group_id: string | null;
  ledger: "shared" | "private";
  description: string;
  merchant: string | null;
  notes: string | null;
  category: string;
  category_label: string;
  mirror_kind: "shared_share" | null;
  mirror_source_expense_id: string | null;
  amount_twd: number;
  paid_by_user_id: string;
  created_by_user_id: string;
  expense_date: string;
  split_method: "equal" | "exact" | "percentage";
  version: number;
  deleted_at: string | null;
  receipts: Array<{ id: string; status: string }>;
  expense_splits: Array<{ user_id: string; amount_twd: number }>;
};
type DashboardData = {
  monthlyTotalTwd: number;
  monthlyCount: number;
  categoryTotals: Record<string, number>;
  trend: Array<{ month: string; totalTwd: number }>;
  recent: Expense[];
};
type Bootstrap = {
  today: string;
  month: string;
  user: User;
  users: User[];
  groups: Group[];
  activeGroupId: string;
  expenses: Expense[];
  sharedExpenses: Expense[];
  privateExpenses: Expense[];
  balances: Array<{ user_id: string; balance_twd: number }>;
  budgets: Array<{ id: string; category: string | null; limit_twd: number }>;
  recurring: Array<{
    id: string;
    description: string;
    amount_twd: number;
    frequency: string;
    next_run_date: string;
    active: boolean;
  }>;
  notifications: Array<{
    id: number;
    title: string;
    body: string;
    read_at: string | null;
    created_at: string;
    line_status: string;
  }>;
  dashboard: DashboardData;
  privateDashboard: DashboardData;
};
type AccountantReport = {
  id: string;
  report_type: string;
  scope: "shared" | "private" | "combined";
  month: string;
  question: string | null;
  title: string;
  summary: string;
  facts: {
    totalTwd: number;
    sharedTotalTwd: number;
    privateTotalTwd: number;
    transactionCount: number;
    balanceTwd: number;
    otherTotalTwd: number;
  };
  findings: Array<{
    severity: "info" | "warning" | "danger";
    title: string;
    body: string;
    amountTwd: number | null;
  }>;
  suggestions: Array<{
    title: string;
    body: string;
    actionInput: unknown | null;
  }>;
  source: "llm" | "fallback";
  created_at: string;
};
type CategoryAnalytics = {
  range: "this_month" | "six_months" | "all";
  scope: "shared" | "private" | "combined";
  totalTwd: number;
  count: number;
  categories: Array<{
    label: string;
    totalTwd: number;
    count: number;
    percent: number;
  }>;
};
type AgentRun = {
  answer: string;
  reportId: string;
  toolCalls: Array<{ tool: string; count?: number; result?: unknown }>;
  suggestions: AccountantReport["suggestions"];
  report: AccountantReport;
};
type ExpenseForm = {
  ledger: "shared" | "private";
  description: string;
  merchant: string;
  notes: string;
  category: string;
  amountTwd: string;
  paidBy: "self" | "partner";
  expenseDate: string;
  splitMethod: "equal" | "exact" | "percentage";
  selfValue: string;
  partnerValue: string;
  receiptId: string | null;
};

const tabs: Tab[] = [
  "dashboard",
  "history",
  "private",
  "add",
  "accountant",
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
function IconAI() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z" />
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
function IconCamera() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
      <circle cx="12" cy="13" r="4" />
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
    const receiptId = new URLSearchParams(window.location.search).get(
      "receipt",
    );
    if (!receiptId) return;
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

  async function propose(body: unknown) {
    try {
      const result = (await mutate("/api/app/actions", body)) as {
        actionId: string;
        preview: string;
      };
      setConfirm(result);
    } catch {
      /* error shown */
    }
  }

  async function decide(value: boolean) {
    if (!confirm) return;
    const current = confirm;
    setConfirm(null);
    try {
      const result = (await mutate("/api/app/actions/confirm", {
        actionId: current.actionId,
        confirm: value,
      })) as { result: string };
      if (result.result === "confirmed") {
        sessionStorage.removeItem("editExpense");
        sessionStorage.removeItem("receiptDraft");
      }
      setNotice(
        result.result === "confirmed"
          ? "已完成"
          : result.result === "cancelled"
            ? "已取消"
            : "帳目已變動，請重試",
      );
    } catch {
      /* error shown */
    }
  }

  if (!data)
    return (
      <main className="center-state">
        <div className="brand-mark">共</div>
        <h1>共同帳本</h1>
        <p>{error || "正在連接 LINE…"}</p>
        {error && <button onClick={() => void startLiff()}>重新登入</button>}
      </main>
    );

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
          />
        )}
        {tab === "history" && (
          <History
            data={data}
            expenses={sharedExpenses}
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
            onSubmit={(body) => void propose(body)}
            onReceipt={async (file) => uploadReceipt(file, data.activeGroupId)}
          />
        )}
        {tab === "accountant" && (
          <Accountant onPropose={(body) => void propose(body)} />
        )}
        {tab === "budgets" && (
          <Budgets
            data={data}
            onSave={(body) =>
              void mutate("/api/app/budgets", body, "預算已儲存")
            }
          />
        )}
        {tab === "settings" && (
          <Settings
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
          active={tab === "accountant"}
          label="AI"
          icon={<IconAI />}
          onClick={() => setTab("accountant")}
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

/* ─── Dashboard ─── */
function Dashboard({
  data,
  activeGroup,
  onSettle,
  onAdd,
}: {
  data: Bootstrap;
  activeGroup: Group;
  onSettle(amount: number): void;
  onAdd(): void;
}) {
  const [settleAmount, setSettleAmount] = useState("");
  const [categoryRange, setCategoryRange] =
    useState<CategoryAnalytics["range"]>("this_month");
  const [analytics, setAnalytics] = useState<CategoryAnalytics | null>(null);
  const mine =
    data.balances.find((item) => item.user_id === data.user.id)?.balance_twd ??
    0;
  const owed = Math.abs(mine);
  useEffect(() => {
    let cancelled = false;
    void fetch(
      `/api/app/analytics/categories?range=${categoryRange}&scope=shared`,
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
  }, [categoryRange, data.activeGroupId]);
  const fallbackCategories = Object.entries(data.dashboard.categoryTotals)
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
  const categoryTotal = analytics?.totalTwd ?? data.dashboard.monthlyTotalTwd;
  const budget = data.budgets.find((item) => item.category === null);
  const budgetPercent = budget
    ? Math.min(
        100,
        Math.round(
          (data.dashboard.monthlyTotalTwd / Number(budget.limit_twd)) * 100,
        ),
      )
    : 0;
  const maxTrend = Math.max(
    1,
    ...data.dashboard.trend.map((item) => item.totalTwd),
  );
  return (
    <div className="stack">
      <article
        className="balance-card"
        style={{ "--group-color": activeGroup.color } as React.CSSProperties}
      >
        <span>💰 {activeGroup.name} · 目前餘額</span>
        <strong>
          {mine === 0
            ? "已結清 ✨"
            : mine > 0
              ? `另一半欠你 ${money(owed)}`
              : `你欠另一半 ${money(owed)}`}
        </strong>
        <div className="inline-actions">
          <button className="light" onClick={onAdd}>
            ＋ 新增支出
          </button>
          {owed > 0 && (
            <>
              <input
                aria-label="結清金額"
                inputMode="numeric"
                placeholder={String(owed)}
                value={settleAmount}
                onChange={(event) => setSettleAmount(event.target.value)}
              />
              <button
                className="light"
                onClick={() => onSettle(Number(settleAmount || owed))}
              >
                結清
              </button>
            </>
          )}
        </div>
      </article>
      <div className="metric-grid">
        <article>
          <span>📊 本月共同支出</span>
          <strong>{money(data.dashboard.monthlyTotalTwd)}</strong>
          <small>{data.dashboard.monthlyCount} 筆交易</small>
        </article>
        <article>
          <span>🎯 月預算</span>
          <strong>{budget ? `${budgetPercent}%` : "未設定"}</strong>
          <div className={`progress ${budgetPercent >= 80 ? "progress-warn" : ""}`}>
            <i style={{ width: `${budgetPercent}%` }} />
          </div>
        </article>
      </div>
      <article className="panel">
        <div className="panel-title">
          <div>
            <span className="eyebrow">支出分析</span>
            <h2>分類占比</h2>
          </div>
          <strong>{money(categoryTotal)}</strong>
        </div>
        <div className="segmented three">
          <button
            type="button"
            className={categoryRange === "this_month" ? "active" : ""}
            onClick={() => setCategoryRange("this_month")}
          >
            本月
          </button>
          <button
            type="button"
            className={categoryRange === "six_months" ? "active" : ""}
            onClick={() => setCategoryRange("six_months")}
          >
            近六月
          </button>
          <button
            type="button"
            className={categoryRange === "all" ? "active" : ""}
            onClick={() => setCategoryRange("all")}
          >
            全部
          </button>
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
              {categoryRows.slice(0, 6).map((category, index) => {
                const pct = categoryTotal > 0
                  ? Math.round((category.totalTwd / categoryTotal) * 100)
                  : 0;
                return (
                  <div key={category.label}>
                    <i style={{ background: palette[index] }} />
                    <span>{category.label}</span>
                    <strong>
                      {money(category.totalTwd)}
                      <span className="pct">{pct}%</span>
                    </strong>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <Empty text="這個範圍還沒有共同支出" icon="📭" />
        )}
      </article>
      <article className="panel">
        <div className="panel-title">
          <div>
            <span className="eyebrow">趨勢</span>
            <h2>近六個月</h2>
          </div>
        </div>
        <div className="bars">
          {data.dashboard.trend.map((point) => (
            <div key={point.month}>
              <div className="bar-track">
                <i
                  style={{
                    height: `${Math.max(3, (point.totalTwd / maxTrend) * 100)}%`,
                  }}
                  title={money(point.totalTwd)}
                />
              </div>
              <div>
                {point.totalTwd > 0 && (
                  <span className="bar-label">{shortMoney(point.totalTwd)}</span>
                )}
                <small>{Number(point.month.slice(5))}月</small>
              </div>
            </div>
          ))}
        </div>
      </article>
      <article className="panel">
        <div className="panel-title">
          <div>
            <span className="eyebrow">最新動態</span>
            <h2>最近流水</h2>
          </div>
        </div>
        {data.dashboard.recent.length ? (
          data.dashboard.recent.map((expense) => (
            <ExpenseRow key={expense.id} expense={expense} users={data.users} />
          ))
        ) : (
          <Empty text="尚無流水" icon="📝" />
        )}
      </article>
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
      <History
        data={data}
        expenses={privateExpenses}
        onEdit={onEdit}
        onDelete={onDelete}
        onReceipt={onReceipt}
      />
    </div>
  );
}

/* ─── History ─── */
function History({
  data,
  expenses,
  onEdit,
  onDelete,
  onReceipt,
}: {
  data: Bootstrap;
  expenses: Expense[];
  onEdit(expense: Expense): void;
  onDelete(expense: Expense): void;
  onReceipt(id: string): void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [deleted, setDeleted] = useState(false);
  const filtered = expenses
    .filter(
      (expense) =>
        (deleted ? !!expense.deleted_at : !expense.deleted_at) &&
        (category === "all" || expense.category === category) &&
        `${expense.description} ${expense.merchant ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) => b.expense_date.localeCompare(a.expense_date));

  // Group by date
  const dateGroups: Array<{ date: string; items: Expense[] }> = [];
  for (const expense of filtered) {
    const last = dateGroups[dateGroups.length - 1];
    if (last && last.date === expense.expense_date) {
      last.items.push(expense);
    } else {
      dateGroups.push({ date: expense.expense_date, items: [expense] });
    }
  }

  return (
    <div className="stack">
      <div className="filters">
        <div className="search-wrap">
          <IconSearch />
          <input
            type="search"
            placeholder="搜尋說明或商家"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div>
          <select
            aria-label="分類"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="all">全部分類</option>
            {Object.entries(categoryNames).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={deleted}
            onChange={(event) => setDeleted(event.target.checked)}
          />
          垃圾桶
        </label>
      </div>
      <article className="panel history-list">
        {dateGroups.length ? (
          dateGroups.map((group) => (
            <div key={group.date}>
              <div className="date-header">{formatDate(group.date)}</div>
              {group.items.map((expense) => (
                <div className="history-item" key={expense.id}>
                  <ExpenseRow expense={expense} users={data.users} />
                  <div className="row-actions">
                    {!expense.deleted_at && !expense.mirror_kind && (
                      <button
                        className="text-button"
                        onClick={() => onEdit(expense)}
                      >
                        編輯
                      </button>
                    )}
                    {expense.receipts[0] && (
                      <button
                        className="text-button"
                        onClick={() => onReceipt(expense.receipts[0]!.id)}
                      >
                        收據
                      </button>
                    )}
                    {!expense.mirror_kind && (
                      <button
                        className="text-button danger"
                        onClick={() => onDelete(expense)}
                      >
                        {expense.deleted_at ? "復原" : "刪除"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))
        ) : (
          <Empty text="找不到符合條件的流水" icon="🔍" />
        )}
      </article>
    </div>
  );
}

/* ─── Expense Editor ─── */
function ExpenseEditor({
  data,
  busy,
  onSubmit,
  onReceipt,
}: {
  data: Bootstrap;
  busy: boolean;
  onSubmit(body: unknown): void;
  onReceipt(
    file: File,
  ): Promise<{
    extraction: {
      merchant: string | null;
      expenseDate: string | null;
      amountTwd: number | null;
    };
    receiptId: string;
  }>;
}) {
  const stored =
    typeof window !== "undefined"
      ? sessionStorage.getItem("editExpense")
      : null;
  const editing = stored ? (JSON.parse(stored) as Expense) : null;
  const receiptStored =
    typeof window !== "undefined"
      ? sessionStorage.getItem("receiptDraft")
      : null;
  const receiptDraft = receiptStored
    ? (JSON.parse(receiptStored) as {
        id: string;
        extraction: {
          merchant: string | null;
          expenseDate: string | null;
          amountTwd: number | null;
        } | null;
      })
    : null;
  const [form, setForm] = useState<ExpenseForm>(() =>
    editing
      ? formFromExpense(editing, data)
      : receiptDraft?.extraction
        ? {
            ...emptyForm(data.today),
            receiptId: receiptDraft.id,
            merchant: receiptDraft.extraction.merchant ?? "",
            description: receiptDraft.extraction.merchant ?? "收據支出",
            expenseDate: receiptDraft.extraction.expenseDate ?? data.today,
            amountTwd: receiptDraft.extraction.amountTwd
              ? String(receiptDraft.extraction.amountTwd)
              : "",
          }
        : emptyForm(data.today),
  );
  const [ocr, setOcr] = useState(false);
  const [localError, setLocalError] = useState("");
  const update = (key: keyof ExpenseForm, value: string | null) =>
    setForm((current) => ({ ...current, [key]: value }));
  function submit(event: React.FormEvent) {
    event.preventDefault();
    setLocalError("");
    const amount = Number(form.amountTwd);
    if (!Number.isSafeInteger(amount) || amount <= 0)
      return setLocalError("請輸入正確整數金額");
    const expense = {
      ...form,
      groupId: form.ledger === "shared" ? data.activeGroupId : null,
      amountTwd: amount,
      merchant: form.merchant || null,
      notes: form.notes || null,
      selfValue: form.selfValue ? Number(form.selfValue) : null,
      partnerValue: form.partnerValue ? Number(form.partnerValue) : null,
    };
    onSubmit(
      editing
        ? {
            type: "update_expense",
            expenseId: editing.id,
            expectedVersion: editing.version,
            expense,
          }
        : { type: "create_expense", expense },
    );
  }
  async function scan(file?: File) {
    if (!file) return;
    setOcr(true);
    setLocalError("");
    try {
      const result = await onReceipt(file);
      setForm((current) => ({
        ...current,
        receiptId: result.receiptId,
        merchant: result.extraction.merchant ?? current.merchant,
        description: result.extraction.merchant ?? current.description,
        expenseDate: result.extraction.expenseDate ?? current.expenseDate,
        amountTwd: result.extraction.amountTwd
          ? String(result.extraction.amountTwd)
          : current.amountTwd,
      }));
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : "收據辨識失敗");
    } finally {
      setOcr(false);
    }
  }
  return (
    <form className="panel form" onSubmit={submit}>
      <div className="panel-title">
        <div>
          <span className="eyebrow">{editing ? "修改流水" : "建立草稿"}</span>
          <h2>{editing ? editing.description : "新增支出"}</h2>
        </div>
      </div>

      {/* Hero amount input */}
      <div className="hero-amount">
        <span className="currency">金額（TWD）</span>
        <input
          required
          inputMode="numeric"
          placeholder="0"
          aria-label="金額（TWD）"
          value={form.amountTwd}
          onChange={(event) => update("amountTwd", event.target.value)}
        />
      </div>

      {/* Receipt upload */}
      <label className="upload">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          capture="environment"
          onChange={(event) => void scan(event.target.files?.[0])}
        />
        <span className="upload-icon">
          {ocr ? "⏳" : form.receiptId ? "✅" : <IconCamera />}
        </span>
        <strong>
          {ocr
            ? "辨識中…"
            : form.receiptId
              ? "收據已辨識，可重新選擇"
              : "拍攝或選擇收據"}
        </strong>
        <small>自動填入商家、日期與總額，確認前都能修改</small>
      </label>

      {/* Ledger toggle */}
      <div className="segmented">
        <button
          type="button"
          className={form.ledger === "shared" ? "active" : ""}
          onClick={() => update("ledger", "shared")}
        >
          💑 共同帳
        </button>
        <button
          type="button"
          className={form.ledger === "private" ? "active" : ""}
          onClick={() => update("ledger", "private")}
        >
          👤 私人帳
        </button>
      </div>

      <Field label="說明">
        <input
          required
          maxLength={100}
          value={form.description}
          onChange={(event) => update("description", event.target.value)}
          placeholder="例如：晚餐"
        />
      </Field>

      {/* Category chips */}
      <div className="field">
        <span>分類</span>
        <div className="category-chips">
          {Object.entries(categoryNames).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`category-chip ${form.category === key ? "active" : ""}`}
              onClick={() => update("category", key)}
            >
              {categoryEmojis[key]} {label}
            </button>
          ))}
        </div>
      </div>

      <div className="two">
        <Field label="日期">
          <input
            required
            type="date"
            value={form.expenseDate}
            onChange={(event) => update("expenseDate", event.target.value)}
          />
        </Field>
        <Field label="商家">
          <input
            maxLength={100}
            value={form.merchant}
            onChange={(event) => update("merchant", event.target.value)}
            placeholder="選填"
          />
        </Field>
      </div>
      <div className="two">
        <Field label="付款人">
          <select
            value={form.paidBy}
            disabled={form.ledger === "private"}
            onChange={(event) => update("paidBy", event.target.value)}
          >
            <option value="self">你</option>
            <option value="partner">另一半</option>
          </select>
        </Field>
        <Field label="分帳方式">
          <select
            value={form.splitMethod}
            disabled={form.ledger === "private"}
            onChange={(event) => update("splitMethod", event.target.value)}
          >
            <option value="equal">平均</option>
            <option value="exact">指定金額</option>
            <option value="percentage">百分比</option>
          </select>
        </Field>
      </div>
      {form.ledger === "shared" && form.splitMethod !== "equal" && (
        <div className="two">
          <Field
            label={`你的${form.splitMethod === "exact" ? "金額" : "比例 %"}`}
          >
            <input
              required
              inputMode="decimal"
              value={form.selfValue}
              onChange={(event) => update("selfValue", event.target.value)}
            />
          </Field>
          <Field
            label={`另一半${form.splitMethod === "exact" ? "金額" : "比例 %"}`}
          >
            <input
              required
              inputMode="decimal"
              value={form.partnerValue}
              onChange={(event) => update("partnerValue", event.target.value)}
            />
          </Field>
        </div>
      )}
      <Field label="備註">
        <textarea
          maxLength={500}
          value={form.notes}
          onChange={(event) => update("notes", event.target.value)}
          placeholder="選填備註"
        />
      </Field>
      {localError && <p className="form-error">{localError}</p>}
      <button className="wide" disabled={busy || ocr}>
        {editing ? "預覽修改" : "預覽並確認"}
      </button>
    </form>
  );
}

/* ─── Accountant ─── */
function Accountant({
  onPropose,
}: {
  onPropose(body: unknown): void;
}) {
  const [reports, setReports] = useState<AccountantReport[]>([]);
  const [question, setQuestion] = useState("歷史以來哪裡花最多？");
  const [scope, setScope] = useState<AccountantReport["scope"]>("combined");
  const [latestRun, setLatestRun] = useState<AgentRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState("");

  const promptSuggestions = [
    "本月哪裡花太多？",
    "這個月餐飲花了多少？",
    "可以幫我結清嗎？",
    "哪個分類增加最快？",
  ];

  const loadReports = useCallback(async () => {
    const result = (await fetch("/api/app/accountant/reports", {
      cache: "no-store",
    }).then(parseResponse)) as AccountantReport[];
    setReports(result);
  }, []);

  useEffect(() => {
    // This effect synchronizes the accountant tab with saved server reports.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadReports().catch((reason) =>
      setLocalError(reason instanceof Error ? reason.message : "無法讀取報告"),
    );
  }, [loadReports]);

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setLocalError("");
    try {
      const run = (await api("/api/app/agent/runs", {
        message: question,
        scope,
      })) as AgentRun;
      setLatestRun(run);
      setReports((current) => [run.report, ...current]);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : "會計師暫時無法回覆");
    } finally {
      setLoading(false);
    }
  }

  const latest = reports[0];
  return (
    <div className="stack">
      <form className="panel form" onSubmit={ask}>
        <div className="panel-title">
          <div>
            <span className="eyebrow">LINE 問快答 · LIFF 做整理</span>
            <h2>AI 會計師</h2>
          </div>
        </div>
        <div className="prompt-chips">
          {promptSuggestions.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="prompt-chip"
              onClick={() => setQuestion(prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>
        <Field label="你想問什麼">
          <textarea
            maxLength={500}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </Field>
        <div className="segmented three">
          <button
            type="button"
            className={scope === "combined" ? "active" : ""}
            onClick={() => setScope("combined")}
          >
            合併
          </button>
          <button
            type="button"
            className={scope === "shared" ? "active" : ""}
            onClick={() => setScope("shared")}
          >
            共同
          </button>
          <button
            type="button"
            className={scope === "private" ? "active" : ""}
            onClick={() => setScope("private")}
          >
            私人
          </button>
        </div>
        {localError && <p className="form-error">{localError}</p>}
        <button className="wide" disabled={loading || !question.trim()}>
          {loading ? "分析中…" : "詢問會計師"}
        </button>
      </form>

      {latestRun && (
        <article className="panel">
          <div className="panel-title">
            <div>
              <span className="eyebrow">本次回覆</span>
              <h2>Agent 工具執行</h2>
            </div>
          </div>
          <p className="preline">{latestRun.answer}</p>
          <div className="tool-list">
            {latestRun.toolCalls.map((call, index) => (
              <small key={`${call.tool}-${index}`}>
                🔧 {call.tool}
                {typeof call.count === "number" ? ` · ${call.count}` : ""}
              </small>
            ))}
          </div>
        </article>
      )}

      {latest ? (
        <AccountantReportCard report={latest} onPropose={onPropose} />
      ) : (
        <article className="panel">
          <Empty text="還沒有 AI 會計師報告" icon="🤖" />
        </article>
      )}

      {reports.length > 1 && (
        <article className="panel">
          <div className="panel-title">
            <div>
              <span className="eyebrow">歷史</span>
              <h2>近期報告</h2>
            </div>
          </div>
          {reports.slice(1, 8).map((report) => (
            <div className="notification read" key={report.id}>
              <strong>{report.title}</strong>
              <p>{report.summary}</p>
              <small>{new Date(report.created_at).toLocaleString("zh-TW")}</small>
            </div>
          ))}
        </article>
      )}
    </div>
  );
}

/* ─── Accountant Report Card ─── */
function AccountantReportCard({
  report,
  onPropose,
}: {
  report: AccountantReport;
  onPropose(body: unknown): void;
}) {
  return (
    <article className="panel accountant-report">
      <div className="panel-title">
        <div>
          <span className="eyebrow">
            {scopeLabel(report.scope)} · {report.source === "fallback" ? "本地摘要" : "Gemini"}
          </span>
          <h2>{report.title}</h2>
        </div>
        <strong>{money(report.facts.totalTwd)}</strong>
      </div>
      <p>{report.summary}</p>
      <div className="metric-grid compact-metrics">
        <article>
          <span>筆數</span>
          <strong>{report.facts.transactionCount}</strong>
        </article>
        <article>
          <span>其他分類</span>
          <strong>{money(report.facts.otherTotalTwd)}</strong>
        </article>
      </div>
      {report.findings.map((finding) => (
        <div className={`finding ${finding.severity}`} key={`${finding.title}-${finding.body}`}>
          <strong>{finding.title}</strong>
          <p>{finding.body}</p>
          {finding.amountTwd !== null && <small>{money(finding.amountTwd)}</small>}
        </div>
      ))}
      {report.suggestions.map((suggestion) => (
        <div className="suggestion" key={`${suggestion.title}-${suggestion.body}`}>
          <div>
            <strong>{suggestion.title}</strong>
            <p>{suggestion.body}</p>
          </div>
          {suggestion.actionInput !== null && (
            <button
              className="text-button"
              onClick={() => onPropose(suggestion.actionInput)}
            >
              建立確認
            </button>
          )}
        </div>
      ))}
    </article>
  );
}

/* ─── Budgets ─── */
function Budgets({
  data,
  onSave,
}: {
  data: Bootstrap;
  onSave(body: unknown): void;
}) {
  const [category, setCategory] = useState("total");
  const [limit, setLimit] = useState("");
  return (
    <div className="stack">
      <article className="panel">
        <div className="panel-title">
          <div>
            <span className="eyebrow">{data.month}</span>
            <h2>本月預算</h2>
          </div>
        </div>
        {data.budgets.length ? (
          data.budgets.map((budget) => {
            const spent = budget.category
              ? (data.dashboard.categoryTotals[budget.category] ?? 0)
              : data.dashboard.monthlyTotalTwd;
            const percent = Math.round(
              (spent / Number(budget.limit_twd)) * 100,
            );
            const pctClass = percent >= 100 ? "over" : percent >= 80 ? "warn" : "";
            return (
              <div className="budget-row" key={budget.id}>
                <div>
                  <strong>
                    {budget.category
                      ? `${categoryEmojis[budget.category] ?? "📦"} ${categoryNames[budget.category]}`
                      : "📋 群組總預算"}
                  </strong>
                  <small>
                    {money(spent)} / {money(Number(budget.limit_twd))}
                  </small>
                </div>
                <strong className={`budget-pct ${pctClass}`}>
                  {percent}%
                </strong>
                <div className={`progress ${percent >= 80 ? "progress-warn" : ""}`}>
                  <i style={{ width: `${Math.min(100, percent)}%` }} />
                </div>
              </div>
            );
          })
        ) : (
          <Empty text="尚未設定本月預算" icon="🎯" />
        )}
      </article>
      <article className="panel form">
        <h2>新增或調整預算</h2>
        <div className="two">
          <Field label="範圍">
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="total">群組總額</option>
              {Object.entries(categoryNames).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="上限（TWD）">
            <input
              inputMode="numeric"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              placeholder="例如：30000"
            />
          </Field>
        </div>
        <button
          onClick={() =>
            onSave({
              groupId: data.activeGroupId,
              month: data.month,
              category: category === "total" ? null : category,
              limitTwd: Number(limit),
            })
          }
        >
          儲存預算
        </button>
      </article>
    </div>
  );
}

/* ─── Settings ─── */
function Settings({
  data,
  unread,
  onGroup,
  onRecurring,
  onRead,
}: {
  data: Bootstrap;
  unread: number;
  onGroup(body: unknown): void;
  onRecurring(body: unknown): void;
  onRead(): void;
}) {
  const [name, setName] = useState("");
  const [recurring, setRecurring] = useState({
    description: "",
    amountTwd: "",
    frequency: "monthly",
    nextRunDate: data.today,
  });
  return (
    <div className="stack">
      <article className="panel">
        <div className="panel-title">
          <div>
            <span className="eyebrow">共同空間</span>
            <h2>群組</h2>
          </div>
        </div>
        {data.groups.map((group) => (
          <div className="setting-row" key={group.id}>
            <i style={{ background: group.color }} />
            <div>
              <strong>{group.name}</strong>
              <small>
                {group.archived_at
                  ? "已封存"
                  : group.id === data.activeGroupId
                    ? "目前使用"
                    : "雙方共享"}
              </small>
            </div>
            {!group.archived_at && (
              <button
                className="text-button danger"
                onClick={() =>
                  onGroup({ operation: "archive", groupId: group.id })
                }
              >
                封存
              </button>
            )}
          </div>
        ))}
        <div className="inline-form">
          <input
            placeholder="新群組名稱"
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            onClick={() => {
              onGroup({ operation: "create", name, color: "#173B63" });
              setName("");
            }}
          >
            新增
          </button>
        </div>
      </article>
      <article className="panel">
        <div className="panel-title">
          <div>
            <span className="eyebrow">提醒</span>
            <h2>週期支出</h2>
          </div>
        </div>
        {data.recurring.map((item) => (
          <div className="setting-row" key={item.id}>
            <div>
              <strong>
                {item.description} · {money(item.amount_twd)}
              </strong>
              <small>
                下次 {item.next_run_date} · {frequencyName(item.frequency)}
              </small>
            </div>
            <button
              className="text-button"
              onClick={() =>
                onRecurring({
                  operation: "toggle",
                  id: item.id,
                  active: !item.active,
                })
              }
            >
              {item.active ? "停用" : "啟用"}
            </button>
          </div>
        ))}
        <div className="form compact">
          <Field label="說明">
            <input
              value={recurring.description}
              onChange={(event) =>
                setRecurring({ ...recurring, description: event.target.value })
              }
            />
          </Field>
          <div className="two">
            <Field label="金額">
              <input
                inputMode="numeric"
                value={recurring.amountTwd}
                onChange={(event) =>
                  setRecurring({ ...recurring, amountTwd: event.target.value })
                }
              />
            </Field>
            <Field label="頻率">
              <select
                value={recurring.frequency}
                onChange={(event) =>
                  setRecurring({ ...recurring, frequency: event.target.value })
                }
              >
                <option value="weekly">每週</option>
                <option value="monthly">每月</option>
                <option value="yearly">每年</option>
              </select>
            </Field>
          </div>
          <Field label="下次日期">
            <input
              type="date"
              value={recurring.nextRunDate}
              onChange={(event) =>
                setRecurring({ ...recurring, nextRunDate: event.target.value })
              }
            />
          </Field>
          <button
            onClick={() =>
              onRecurring({
                id: null,
                ledger: "shared",
                groupId: data.activeGroupId,
                description: recurring.description,
                merchant: null,
                notes: null,
                category: "other",
                amountTwd: Number(recurring.amountTwd),
                paidBy: "self",
                expenseDate: recurring.nextRunDate,
                splitMethod: "equal",
                selfValue: null,
                partnerValue: null,
                receiptId: null,
                frequency: recurring.frequency,
                nextRunDate: recurring.nextRunDate,
                endDate: null,
                active: true,
              })
            }
          >
            新增週期支出
          </button>
        </div>
      </article>
      <article className="panel">
        <div className="panel-title">
          <div>
            <span className="eyebrow">通知中心</span>
            <h2>{unread ? `${unread} 則未讀` : "全部已讀"}</h2>
          </div>
          {unread > 0 && (
            <button className="text-button" onClick={onRead}>
              全部已讀
            </button>
          )}
        </div>
        {data.notifications.slice(0, 10).map((item) => (
          <div
            className={`notification ${item.read_at ? "read" : ""}`}
            key={item.id}
          >
            <strong>{item.title}</strong>
            <p>{item.body}</p>
            <small>
              {new Date(item.created_at).toLocaleString("zh-TW")}
              {item.line_status === "skipped" ? " · 已留在站內" : ""}
            </small>
          </div>
        ))}
      </article>
      <Link className="button-link" href="/api/app/export">
        📥 匯出目前流水 CSV
      </Link>
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
  const label = expense.category_label || categoryNames[expense.category] || expense.category;
  const emoji = categoryEmojis[expense.category] ?? "📦";
  return (
    <div className={`expense-row ${expense.deleted_at ? "deleted" : ""}`}>
      <div className={`category-icon ${expense.category}`}>
        {emoji}
      </div>
      <div>
        <strong>{expense.description}</strong>
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
function emptyForm(today: string): ExpenseForm {
  return {
    ledger: "shared",
    description: "",
    merchant: "",
    notes: "",
    category: "other",
    amountTwd: "",
    paidBy: "self",
    expenseDate: today,
    splitMethod: "equal",
    selfValue: "",
    partnerValue: "",
    receiptId: null,
  };
}
function buildClientDashboard(expenses: Expense[], month: string): DashboardData {
  const active = expenses.filter((expense) => !expense.deleted_at);
  const categoryTotals = Object.fromEntries(
    Object.keys(categoryNames).map((category) => [category, 0]),
  ) as Record<string, number>;
  const trend = Array.from({ length: 6 }, (_, index) => ({
    month: shiftMonth(month, index - 5),
    totalTwd: 0,
  }));
  for (const expense of active) {
    const expenseMonth = expense.expense_date.slice(0, 7);
    const point = trend.find((item) => item.month === expenseMonth);
    if (point) point.totalTwd += expense.amount_twd;
    if (expenseMonth === month)
      categoryTotals[expense.category] = (categoryTotals[expense.category] ?? 0) + expense.amount_twd;
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
function formFromExpense(expense: Expense, data: Bootstrap): ExpenseForm {
  const mine =
    expense.expense_splits.find((split) => split.user_id === data.user.id)
      ?.amount_twd ?? 0;
  const theirs =
    expense.expense_splits.find((split) => split.user_id !== data.user.id)
      ?.amount_twd ?? 0;
  const percentage = (value: number) =>
    String(Math.round((value / expense.amount_twd) * 10_000) / 100);
  return {
    ledger: expense.ledger,
    description: expense.description,
    merchant: expense.merchant ?? "",
    notes: expense.notes ?? "",
    category: expense.category,
    amountTwd: String(expense.amount_twd),
    paidBy: expense.paid_by_user_id === data.user.id ? "self" : "partner",
    expenseDate: expense.expense_date,
    splitMethod: expense.split_method,
    selfValue:
      expense.split_method === "percentage" ? percentage(mine) : String(mine),
    partnerValue:
      expense.split_method === "percentage"
        ? percentage(theirs)
        : String(theirs),
    receiptId: expense.receipts[0]?.id ?? null,
  };
}
function titleFor(tab: Tab) {
  return (
    {
      dashboard: "總覽",
      history: "帳務流水",
      private: "私人帳",
      add: "新增支出",
      accountant: "AI 會計師",
      budgets: "預算管理",
      settings: "帳本設定",
    } as const
  )[tab];
}
function scopeLabel(scope: AccountantReport["scope"]) {
  return scope === "shared" ? "共同帳" : scope === "private" ? "私人帳" : "合併帳";
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
