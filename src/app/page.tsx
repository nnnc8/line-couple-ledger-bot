"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Tab = "dashboard" | "history" | "add" | "budgets" | "settings";
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
  amount_twd: number;
  paid_by_user_id: string;
  expense_date: string;
  split_method: "equal" | "exact" | "percentage";
  version: number;
  deleted_at: string | null;
  receipts: Array<{ id: string; status: string }>;
  expense_splits: Array<{ user_id: string; amount_twd: number }>;
};
type Bootstrap = {
  today: string;
  month: string;
  user: User;
  users: User[];
  groups: Group[];
  activeGroupId: string;
  expenses: Expense[];
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
  dashboard: {
    monthlyTotalTwd: number;
    monthlyCount: number;
    categoryTotals: Record<string, number>;
    trend: Array<{ month: string; totalTwd: number }>;
    recent: Expense[];
  };
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

const tabs: Tab[] = ["dashboard", "history", "add", "budgets", "settings"];
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
const palette = [
  "#173b63",
  "#2c6e8f",
  "#4b8f8c",
  "#d2a84a",
  "#b65f55",
  "#7c6da7",
  "#59738b",
  "#8599a8",
  "#c7ced4",
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
  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">共同帳本</span>
          <h1>{titleFor(tab)}</h1>
        </div>
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
          icon="⌂"
          onClick={() => setTab("dashboard")}
        />
        <NavButton
          active={tab === "history"}
          label="流水"
          icon="≡"
          onClick={() => setTab("history")}
        />
        <NavButton
          active={tab === "add"}
          label="新增"
          icon="＋"
          primary
          onClick={() => {
            sessionStorage.removeItem("editExpense");
            setTab("add");
          }}
        />
        <NavButton
          active={tab === "budgets"}
          label="預算"
          icon="◎"
          onClick={() => setTab("budgets")}
        />
        <NavButton
          active={tab === "settings"}
          label="設定"
          icon={unread ? `●${unread}` : "⚙"}
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
            <span className="eyebrow">請再次確認</span>
            <h2 id="confirm-title">帳務變更</h2>
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
                確認
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
  const mine =
    data.balances.find((item) => item.user_id === data.user.id)?.balance_twd ??
    0;
  const owed = Math.abs(mine);
  const categories = Object.entries(data.dashboard.categoryTotals)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1]);
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
        <span>{activeGroup.name} · 目前餘額</span>
        <strong>
          {mine === 0
            ? "已結清"
            : mine > 0
              ? `另一半欠你 ${money(owed)}`
              : `你欠另一半 ${money(owed)}`}
        </strong>
        <div className="inline-actions">
          <button className="light" onClick={onAdd}>
            新增支出
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
          <span>本月共同支出</span>
          <strong>{money(data.dashboard.monthlyTotalTwd)}</strong>
          <small>{data.dashboard.monthlyCount} 筆交易</small>
        </article>
        <article>
          <span>月預算</span>
          <strong>{budget ? `${budgetPercent}%` : "未設定"}</strong>
          <div className="progress">
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
          <strong>{money(data.dashboard.monthlyTotalTwd)}</strong>
        </div>
        {categories.length ? (
          <div className="category-chart">
            <div
              className="donut"
              style={{
                background: donutGradient(
                  categories,
                  data.dashboard.monthlyTotalTwd,
                ),
              }}
            >
              <span>
                {categories.length}
                <small>分類</small>
              </span>
            </div>
            <div className="legend">
              {categories.slice(0, 5).map(([category, value], index) => (
                <div key={category}>
                  <i style={{ background: palette[index] }} />
                  <span>{categoryNames[category]}</span>
                  <strong>{money(value)}</strong>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <Empty text="本月還沒有共同支出" />
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
              <small>{Number(point.month.slice(5))}月</small>
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
          <Empty text="尚無流水" />
        )}
      </article>
    </div>
  );
}

function History({
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
  const [query, setQuery] = useState("");
  const [ledger, setLedger] = useState("all");
  const [category, setCategory] = useState("all");
  const [deleted, setDeleted] = useState(false);
  const filtered = data.expenses
    .filter(
      (expense) =>
        (deleted ? !!expense.deleted_at : !expense.deleted_at) &&
        (ledger === "all" || expense.ledger === ledger) &&
        (category === "all" || expense.category === category) &&
        `${expense.description} ${expense.merchant ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) => b.expense_date.localeCompare(a.expense_date));
  return (
    <div className="stack">
      <div className="filters">
        <input
          type="search"
          placeholder="搜尋說明或商家"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div>
          <select
            aria-label="帳本"
            value={ledger}
            onChange={(event) => setLedger(event.target.value)}
          >
            <option value="all">全部帳本</option>
            <option value="shared">共同</option>
            <option value="private">私人</option>
          </select>
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
        {filtered.length ? (
          filtered.map((expense) => (
            <div className="history-item" key={expense.id}>
              <ExpenseRow expense={expense} users={data.users} />
              <div className="row-actions">
                {!expense.deleted_at && (
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
                <button
                  className="text-button danger"
                  onClick={() => onDelete(expense)}
                >
                  {expense.deleted_at ? "復原" : "刪除"}
                </button>
              </div>
            </div>
          ))
        ) : (
          <Empty text="找不到符合條件的流水" />
        )}
      </article>
    </div>
  );
}

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
      <label className="upload">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          capture="environment"
          onChange={(event) => void scan(event.target.files?.[0])}
        />
        <strong>
          {ocr
            ? "辨識中…"
            : form.receiptId
              ? "收據已辨識，可重新選擇"
              : "拍攝或選擇收據"}
        </strong>
        <small>自動填入商家、日期與總額，確認前都能修改</small>
      </label>
      <div className="segmented">
        <button
          type="button"
          className={form.ledger === "shared" ? "active" : ""}
          onClick={() => update("ledger", "shared")}
        >
          共同帳
        </button>
        <button
          type="button"
          className={form.ledger === "private" ? "active" : ""}
          onClick={() => update("ledger", "private")}
        >
          私人帳
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
      <div className="two">
        <Field label="金額（TWD）">
          <input
            required
            inputMode="numeric"
            value={form.amountTwd}
            onChange={(event) => update("amountTwd", event.target.value)}
          />
        </Field>
        <Field label="日期">
          <input
            required
            type="date"
            value={form.expenseDate}
            onChange={(event) => update("expenseDate", event.target.value)}
          />
        </Field>
      </div>
      <div className="two">
        <Field label="商家">
          <input
            maxLength={100}
            value={form.merchant}
            onChange={(event) => update("merchant", event.target.value)}
          />
        </Field>
        <Field label="分類">
          <select
            value={form.category}
            onChange={(event) => update("category", event.target.value)}
          >
            {Object.entries(categoryNames).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
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
        />
      </Field>
      {localError && <p className="form-error">{localError}</p>}
      <button className="wide" disabled={busy || ocr}>
        {editing ? "預覽修改" : "預覽並確認"}
      </button>
    </form>
  );
}

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
            return (
              <div className="budget-row" key={budget.id}>
                <div>
                  <strong>
                    {budget.category
                      ? categoryNames[budget.category]
                      : "群組總預算"}
                  </strong>
                  <small>
                    {money(spent)} / {money(Number(budget.limit_twd))}
                  </small>
                </div>
                <strong className={percent >= 100 ? "negative" : ""}>
                  {percent}%
                </strong>
                <div className="progress">
                  <i style={{ width: `${Math.min(100, percent)}%` }} />
                </div>
              </div>
            );
          })
        ) : (
          <Empty text="尚未設定本月預算" />
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
        匯出目前流水 CSV
      </Link>
    </div>
  );
}

function NavButton({
  active,
  label,
  icon,
  primary,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: string;
  primary?: boolean;
  onClick(): void;
}) {
  return (
    <button
      className={`${active ? "active" : ""} ${primary ? "primary" : ""}`}
      onClick={onClick}
    >
      <span>{icon}</span>
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
function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <span>—</span>
      <p>{text}</p>
    </div>
  );
}
function ExpenseRow({ expense, users }: { expense: Expense; users: User[] }) {
  return (
    <div className={`expense-row ${expense.deleted_at ? "deleted" : ""}`}>
      <div className="category-icon">
        {categoryNames[expense.category]?.slice(0, 1)}
      </div>
      <div>
        <strong>{expense.description}</strong>
        <small>
          {expense.expense_date} ·{" "}
          {users.find((user) => user.id === expense.paid_by_user_id)?.label}付款
          ·{" "}
          {expense.ledger === "private"
            ? "私人"
            : categoryNames[expense.category]}
        </small>
      </div>
      <strong>{money(expense.amount_twd)}</strong>
    </div>
  );
}
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
