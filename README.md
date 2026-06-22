# LINE 共同帳本

固定兩人使用的 LINE Bot＋LIFF 帳務工具，支援多群組、共同／私人帳、三種分帳、收據辨識、預算、週期帳與 CSV。

## Setup

需要 Node.js 22+、pnpm、LINE Messaging API channel、同 Provider 的 LINE Login channel、Google AI Studio API key、Supabase project。

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

部署到 Vercel 後，設定 `.env.example` 全部環境變數。`LIFF_SESSION_SECRET` 至少 32 字元，`CRON_SECRET` 至少 16 字元。把 LINE webhook 設成：

```text
https://<deployment>/api/line/webhook
```

在 LINE Developers Console 執行 Verify，並啟用 webhook redelivery。

在 LINE Login channel 建立 LIFF app：

- Endpoint URL：`https://<deployment>/`
- Scope：`openid`、`profile`
- 將 LIFF ID 設為 `NEXT_PUBLIC_LIFF_ID`
- 將 LINE Login channel ID 設為 `LINE_LOGIN_CHANNEL_ID`

Vercel 每日 01:15（Asia/Taipei）執行 `/api/cron/daily`，建立週期帳草稿並清除超過 30 天的已刪除收據。

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

新增、修改、刪除、復原與結清都必須在五分鐘內確認。LINE 傳送收據圖片後，辨識結果會以通知連回 LIFF 編輯確認。

## Checks

```bash
rtk pnpm test
rtk pnpm typecheck
rtk pnpm lint
rtk pnpm build
```
