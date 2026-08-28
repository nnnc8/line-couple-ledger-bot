# LINE Couple Ledger Bot

LINE-first 的 Couple Ledger V2。每個 Couple 固定兩位成員，可以建立一本或多本彼此獨立的 Ledger，快速記錄共同生活與旅程等帳務。

本專案只處理 TWD。所有 canonical 金額都是非負的 TWD 整數；不提供外幣、匯率或換算。

## 產品模型

```text
Couple（正好兩位成員）
└── Ledgers（一本或多本，彼此獨立）
    └── Transactions
        ├── Payments（誰付了多少）
        └── Shares（誰承擔了多少）
```

Ledger 例如「共同生活」、「韓國旅行」與「上海旅行」。每一本 Ledger 都有自己的交易歷史、餘額、結清狀態、下次付款建議、週期規則、分類、統計與預設分攤。不同 Ledger 的餘額永遠不互相抵銷，也不會建立虛假的平衡交易。

## V2 功能

- LIFF 中以 Ledger 為單位瀏覽歷史、餘額、統計、設定與 CSV 匯出。
- 交易類型包含支出、收入／退款、轉帳；轉帳可用於單一本 Ledger 的結清。
- 支援單一付款人、多位付款人，以及平均、Ledger 權重、百分比、指定金額與 100/0 分攤。
- 交易採 immutable financial record；編輯使用 void-and-replace，保留 replacement lineage 與稽核事件。
- Ledger 可管理自己的分類、週期交易與收據附件 metadata。
- LINE 可直接輸入自然語句，例如 `晚餐 500 我付`。明確且安全的輸入可直接入帳；不明確或多命令輸入會先建立 proposal，確認後才原子入帳。
- LINE webhook 先寫入 durable inbox；交易與通知分別以 idempotency、outbox 與 retry/dead-letter 保護。
- 前端只有在 canonical API 回傳資料庫已提交的交易後才顯示成功，並立即更新流水、餘額與下次付款建議。

V1 表格與程式目前只作為 migration、audit 與 incident fallback 保留，不是目前的產品模型，也不是第二個 financial writer。

## 重要不變量

- Couple 必須正好有兩位成員；每本 Ledger 必須包含同一對成員。
- 每筆 active transaction 的 payments 合計等於 amount，shares 合計也等於 amount。
- 每本 Ledger 的兩位成員 signed balance 合計為零。
- 金額欄位使用 TWD integer；不接受外幣欄位或浮點換算。
- 相同 webhook／idempotency key 只產生一個 accounting effect。
- financial write 走同一個 PostgreSQL transaction；通知失敗不能重播交易。

## 技術架構

- Next.js App Router、React、TypeScript、Tailwind CSS
- LINE Messaging API、LINE Login／LIFF
- Supabase Postgres；直接 PostgreSQL connection 用於 ACID financial writes
- Vercel Functions；LINE inbox 使用 webhook 後的 opportunistic drain，並保留 worker endpoint 作安全掃描
- Google Gemini 用於 secretary／proposal 與 accountant 輔助流程

## 本機開始

需求：Node.js 22.x、pnpm 9+、Supabase／PostgreSQL 測試資料庫、LINE Messaging API channel、同一 provider 的 LINE Login／LIFF channel，以及 Gemini API key。

```bash
git clone https://github.com/nnnc8/line-couple-ledger-bot.git
cd line-couple-ledger-bot
pnpm install
cp .env.example .env.local
```

在 `.env.local` 填入必要設定。完整欄位說明見 [docs/env-vars.md](docs/env-vars.md)。至少需要：

- `DATABASE_URL`：直接 PostgreSQL connection string（不要用 Supabase REST URL）。
- `SUPABASE_URL`、`SUPABASE_SECRET_KEY`
- `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_LOGIN_CHANNEL_ID`、`NEXT_PUBLIC_LIFF_ID`
- `GEMINI_API_KEY`、`COUPLE_SETUP_CODE`
- `LIFF_SESSION_SECRET`、`APP_URL`、`CRON_SECRET`

本機開發：

```bash
pnpm dev
```

若要讓 LINE webhook 連到本機，使用 ngrok 或其他安全的 HTTPS tunnel，並將 URL 指向 `/api/line/webhook`。資料庫 migration 請先在 local／test project 執行；production migration 必須遵循既有 cutover runbook。

## 常用指令

```bash
# 開發與正式建置
pnpm dev
pnpm build

# 靜態檢查與測試
pnpm typecheck
pnpm test
pnpm test:tx
pnpm test:e2e
pnpm test:e2e:v2

# V2 migration（依 runbook 在隔離或核准環境執行）
pnpm migration:v2:plan
pnpm migration:v2:apply
pnpm migration:v2:cutover

# V2 worker 與 incident 工具
pnpm incident:v2:status
pnpm smoke:local
pnpm smoke:transfer
pnpm smoke:recurring
pnpm smoke:cron
```

`pnpm test:tx` 的 PostgreSQL 測試只能使用隔離測試資料庫；需要時設定 `V2_TEST_DATABASE_URL`，測試會拒絕非 localhost 連線。`pnpm smoke:*` 會寫入測試資料，請只在明確的測試環境執行並設定 cleanup 變數。

## 測試層級

| 層級 | 指令 | 資料庫 | 內容 |
| --- | --- | --- | --- |
| 型別／建置 | `pnpm typecheck`、`pnpm build` | 否 | TypeScript 與 Next.js production build |
| 單元／服務 | `pnpm test` | 否 | accounting、migration、workflow、outbox 與 UI service tests |
| PostgreSQL | `pnpm test:tx` | 隔離測試 DB | 真實 transaction、rollback、idempotency 與 invariant |
| LIFF E2E | `pnpm test:e2e`、`pnpm test:e2e:v2` | 否 | 現有流程與 V2 新增交易回饋；含手機與寬螢幕 project |

## 部署

Vercel、Supabase、LINE webhook 與 LIFF 的設定步驟見 [docs/deploy-vercel.md](docs/deploy-vercel.md)。production 環境變數不可提交至 Git；`RELEASE_SHA` 與 `BUILD_TIMESTAMP` 可用來讓 `/api/version` 回報不可變的 release 身分。

Vercel Hobby 不支援每分鐘 Cron。V2 worker 的支援策略是：

1. webhook durable inbox commit 後，以 `after()` opportunistically drain；
2. 每日 safety sweep 呼叫 `/api/cron/v2-workers`，每次最多處理 50 筆 inbox 與 50 筆 notification outbox；
3. 重試採持久化 exponential backoff，最多八次，超過後進 dead-letter；
4. 需要更短 retry latency 時，由受控的外部 scheduler 定期呼叫同一 endpoint，不在 Hobby `vercel.json` 登記每分鐘 Cron。

不要用 `vercel --prod` 取代 repository 的 release 流程，也不要在沒有 migration／writer gate 證據時開啟 V2 flags。正式 cutover、rollback 與 Rich Menu 變更都應依維運 runbook 由人員核准。

## Repository 文件

- [環境變數](docs/env-vars.md)
- [Vercel／LINE／Supabase 部署](docs/deploy-vercel.md)
- [LINE 指令](docs/commands.md)
- [貢獻指南](CONTRIBUTING.md)
- [安全回報](SECURITY.md)

## License

[MIT](LICENSE) © 2026 nnnc8 and contributors.
