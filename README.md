# LINE 共同帳本

固定兩人使用的 LINE Bot＋LIFF 帳務工具，支援多群組、共同／私人帳、三種分帳、預算、週期帳與 CSV。

## Setup

需要 Node.js 22+、pnpm、LINE Messaging API channel、同 Provider 的 LINE Login channel、Google AI Studio API key、Supabase project 以及一個 PostgreSQL 資料庫連線字串 (`DATABASE_URL`) 用於執行帳務交易。

```bash
rtk pnpm install
rtk cp .env.example .env.local
```

填入 `.env.local`，其中 `DATABASE_URL` 是直連 Postgres database 的連線字串（注意：需與 `SUPABASE_URL` 區分）。`COUPLE_SETUP_CODE` 至少 20 字元，所有 secret 都只放在伺服器端。

套用資料庫 migration：

```bash
rtk pnpm dlx supabase login
rtk pnpm dlx supabase link --project-ref <project-ref>
rtk pnpm dlx supabase db push
```

本機啟動：

```bash
rtk pnpm dev
```

部署到 Vercel 後，設定 `.env.example` 全部環境變數。`DATABASE_URL` 是強制要求（LINE 自動確認記帳、自動發送週期帳、執行/確認暫存記帳均會直連資料庫寫入）。`LIFF_SESSION_SECRET` 至少 32 字元，`CRON_SECRET` 至少 16 字元。把 LINE webhook 設成：

```text
https://<deployment>/api/line/webhook
```

在 LINE Developers Console 執行 Verify，並啟用 webhook redelivery。

在 LINE Login channel 建立 LIFF app：

- Endpoint URL：`https://<deployment>/`
- Scope：`openid`、`profile`
- 將 LIFF ID 設為 `NEXT_PUBLIC_LIFF_ID`
- 將 LINE Login channel ID 設為 `LINE_LOGIN_CHANNEL_ID`

Vercel 每日 01:15（Asia/Taipei）執行 `/api/cron/daily`，建立週期帳草稿。

## Usage

前兩位使用者先輸入 `加入 <設定碼>`，之後可使用：

```text
晚餐 860 我付
私人 午餐 120
誰欠誰
本月共同支出
本月私人支出
刪除剛剛那筆
結清
```

新增、修改、刪除、復原與結清都必須在五分鐘內確認。

```

## Checks

```bash
rtk pnpm typecheck       # tsc --noEmit
rtk pnpm lint
rtk pnpm build           # next build
```

## Verification: three distinct layers

The repo separates static checks, fake-DB unit tests, and live-DB smoke
proofs. They mean different things; do not mix them up.

### 1. Static checks — `typecheck`, `lint`, `build`

These do not need any env and prove the project still compiles and lints.

```bash
rtk pnpm typecheck
rtk pnpm lint
rtk pnpm build
```

### 2. Unit / fake-DB tests — `test`, `test:tx`, `test:smoke`, `test:all`

These do not need `DATABASE_URL`. They run in-process against an
inline `FakeTxClient` (executor) or against pure logic.

- `pnpm test` — 117 unit tests (env boundary, ledger, agents, etc.).
- `pnpm test:tx` — executor unit tests (fake client) + the **guarded**
  pg test (`pending-action.pg.test.ts`). The pg test auto-skips when
  `DATABASE_URL` is absent; it does not pretend to have passed.
- `pnpm test:smoke` — smoke harness **guards** (env fail-fast, module
  imports, cleanup-mode contract). Not live proof.
- `pnpm test:all` — runs all of the above in one process.
- `pnpm test:e2e` — Playwright LIFF spec (browser-driven; needs the
  dev server).

### 3. Live proof — `smoke:local`, `smoke:recurring`, `smoke:cron`

These are the **only** commands that prove live activation. They
require `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and the
`SMOKE_*` credentials listed below; without them, the scripts
fail-fast with a clear error and never pretend to succeed.

```bash
pnpm smoke:local        # create_expense + settle, end-to-end
pnpm smoke:recurring    # recurring.daily job path
pnpm smoke:cron         # /api/cron/daily HTTP path
```

> **Important for `smoke:cron`:** `APP_URL` must point at the *same*
> app instance this repo just started (e.g. a Vercel preview deployment
> or a local `pnpm dev` you are about to run). It must not point at a
> different local service, port 3000 by default, or any other
> environment the cron secret is not configured for — otherwise the
> request will hit the wrong server and either 401/404 or succeed
> against the wrong DB.

Only when all three of these pass against a real Postgres is the
system considered live-activated.

## Live Smoke Activation Handbook

本節說明如何在真實 Postgres 連線可用後驗證整個 pending action 流程。

### 前提條件

| 環境變數 | 說明 |
|---|---|
| `DATABASE_URL` | 直連 Postgres 的連線字串（帶 pooler 或 direct URL 均可） |
| `SUPABASE_URL` | Supabase 專案 URL |
| `SUPABASE_SECRET_KEY` | Supabase service-role secret（可繞過 RLS） |
| `APP_URL` | 部署網址（`smoke:cron` 需要） |
| `CRON_SECRET` | `/api/cron/daily` 用的 bearer secret（`smoke:cron` 需要） |
| `SMOKE_LINE_USER_ID` | owner 用戶的 LINE user ID（需已存在 `users` 表） |
| `SMOKE_PARTNER_LINE_USER_ID` | partner 用戶的 LINE user ID（需已存在 `users` 表） |
| `SMOKE_GROUP_NAME` | 目標群組名稱（若不存在會自動建立） |
| `SMOKE_CLEANUP_MODE` | `always`（預設）或 `on-success` |

全部填入 `.env.local` 後，執行以下指令：

```bash
pnpm smoke:local
pnpm smoke:recurring
pnpm smoke:cron
```

### Smoke 流程說明（`pnpm smoke:local`）

1. **Lookup smoke tenant** — 從 `users` / `couple_groups` 查詢或建立 smoke 用的 owner / partner / group。
2. **Private expense** — `proposeAction(create_expense)` 並立即 `confirm()`，確認 expenses 表有寫入。
3. **Shared expense** — 同上，但 `group_id` 與 `split_method: equal`，驗證 `expense_splits` 也有兩筆。
4. **Settlement** — `proposeAction(settle)` 並確認 `settlements` 表有寫入。
5. **Cleanup** — 依 `SMOKE_CLEANUP_MODE` 刪除所有測試資料。

### Blocker

若 `DATABASE_URL` 或 SMOKE 憑證無法取得，上列 `smoke:*` 指令會以明確的錯誤訊息中止（fail-fast），其餘 `test:*` 指令不受影響，可正常執行。唯一不變的 blocker 為「缺 live credentials」；其餘修補都已在這輪收完。

