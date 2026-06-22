# LINE 情侶分帳 Bot

兩人使用的 LINE 分帳 MVP：Gemini 只解析文字，Supabase/PostgreSQL 負責權限、分帳與原子寫入。

## Setup

需要 Node.js 22+、pnpm、LINE Messaging API channel、Google AI Studio API key、Supabase project。

```bash
rtk pnpm install
rtk cp .env.example .env.local
```

填入 `.env.local`；`COUPLE_SETUP_CODE` 至少 20 字元，所有 secret 都只放在伺服器端。

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

部署到 Vercel 後，在 Vercel 設定 `.env.example` 列出的六個環境變數，並把 LINE webhook 設成：

```text
https://<deployment>/api/line/webhook
```

在 LINE Developers Console 執行 Verify，並啟用 webhook redelivery。

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

新增、刪除與結清都必須在五分鐘內按 quick reply 確認。

## Checks

```bash
rtk pnpm test
rtk pnpm typecheck
rtk pnpm lint
rtk pnpm build
```
