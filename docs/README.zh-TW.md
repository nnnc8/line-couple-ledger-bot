# LINE Couple Ledger V2（中文說明）

> Self-hosted、聊天優先的雙人 TWD 帳本。英文版請見 [README.md](../README.md)。本檔描述目前 V2 產品；保留的 V1 程式只供 migration、audit 與 incident compatibility 使用。

這是一個用 **Next.js 16 + Supabase Postgres + Google Gemini** 打造的 Couple Ledger，整合 **LINE Messaging API** 與 **LINE Login (LIFF)**。每個 Couple 固定兩位成員，可建立多本彼此獨立的 Ledger；所有 canonical 金額都是非負 TWD 整數。

---

## 為什麼做這個

Couple Ledger V2 解決的是兩人共同帳務的範圍與一致性：
- 每本 Ledger 的 payment/share 與餘額獨立，不跨 Ledger 抵銷。
- 支援單一／多位付款人、平均／權重／百分比／指定金額分攤。
- immutable transaction、void-and-replace、idempotency、LINE inbox/outbox 與通知 retry 都由 canonical API／Postgres 保護。

這個專案的目標是**讓記帳回到對話裡**，並讓 payment、share、balance 與 persistence 保持 deterministic、zero-sum。

---

## 三層自動化驗證架構

```
                    ┌─────────────────────────┐
                    │  1. 靜態分析 (Compile)  │  pnpm typecheck, build
                    └────────────┬────────────┘
                                  │ Pass
                                  ▼
                    ┌─────────────────────────┐
                    │  2. 單元/虛擬測試 (Unit) │  pnpm test, test:e2e (不需連真實 DB)
                    └────────────┬────────────┘
                                  │ Pass
                                  ▼
                    ┌─────────────────────────┐
                    │ 3. 真實資料庫冒煙 (Smoke)│  pnpm smoke:* (需 DATABASE_URL)
                    └─────────────────────────┘
```

### Layer 1：靜態檢查
```bash
pnpm typecheck       # TypeScript 類型檢查
pnpm build           # Next.js 生產環境編譯
```
> `pnpm lint` 目前為「建議性」檢查，**未列入 CI 必要門檻**。待規則穩定後再升為 required gate。

### Layer 2：單元與虛擬測試（**不需 `DATABASE_URL`**）
- `pnpm test` ── V2 accounting、migration、workflow、outbox 與 compatibility tests。
- `pnpm test:e2e` ── Playwright 對 V2 LIFF 前端的端到端測試。
- `pnpm test:e2e:v2` ── 同一組 V2 流程的專用 config。

### Layer 3：真實資料庫冒煙（**需要 `DATABASE_URL`**）
```bash
pnpm smoke:local        # 建立費用 → 自動分帳 → 結清 → 一鍵清理
pnpm smoke:recurring    # 週期性自動記帳的 Cron 調度處理
pnpm smoke:cron         # 部署上的 /api/cron/daily 安全調度 API
```

> 冒煙測試會對真實 Postgres 進行交易、提交、回滾與清理。環境不齊全時會 Fail-Fast，**絕不假裝通過**。

---

## 系統架構

```
┌────────────────────────────────────────────────────────┐
│                      LINE Client                       │
└───────────┬────────────────────────────────┬───────────┘
            │ 對話訊息 / 語音（圖片會被拒收） │ 點擊選單 → LIFF WebView
            ▼                                ▼
┌───────────────────────┐        ┌───────────────────────┐
│ LINE Messaging API    │        │ LINE Login (LIFF)     │
└───────────┬───────────┘        └───────────┬───────────┘
            │ Webhook                        │ REST/hooks
            ▼                                ▼
┌────────────────────────────────────────────────────────┐
│               Next.js App Router (Vercel)              │
│  ┌──────────────────────────────┐  ┌────────────────────┐ │
│  │  V2 LINE parser / proposal   │  │  V2 Ledger LIFF    │ │
│  └──────────────┬───────────────┘  └─────────┬──────────┘ │
│                 └──────────────┬────────────┘            │
│                                ▼                         │
│             V2 canonical API → single Postgres writer   │
└──────────────────────────┬─────────────────────────────┘
                           │ DATABASE_URL
                           ▼
┌────────────────────────────────────────────────────────┐
│               Supabase Postgres (你的資料)            │
└────────────────────────────────────────────────────────┘
```

關鍵設計：
- **ACID 直連 Postgres** — V2 financial writes 走單一 `pg` transaction，**不走** Supabase PostgREST roundtrip。
- **Webhook 不重複** — 每個事件帶 `sourceEventId`；`pending_action` 用 idempotency key。
- **群組成員鎖定** — 只有前兩個輸入 `join <COUPLE_SETUP_CODE>` 的使用者會被綁定，其他人會被拒絕。
- **V2 Ledger 分離** — 各 Ledger 的歷史、餘額、結清、週期規則、分類與統計彼此獨立。

---

## 開發與部署

完整英文版請見 [docs/deploy-vercel.md](deploy-vercel.md)。本地／隔離測試步驟：

```bash
git clone https://github.com/nnnc8/line-couple-ledger-bot.git
cd line-couple-ledger-bot
pnpm install
cp .env.example .env.local
# 編輯 .env.local 填入所有必填變數
pnpm typecheck && pnpm test && pnpm test:e2e && pnpm test:e2e:v2 && pnpm build
pnpm dev   # 對外用 ngrok / localtunnel
```

Migration、cutover 與任何 production database 變更必須依
[V2 cutover runbook](v2-cutover-runbook.md) 由人員核准；本地驗證請使用
isolated PostgreSQL，不要把 production `DATABASE_URL` 傳給測試。

LINE 後台設定：
1. **Webhook URL** → `https://<your-domain>/api/line/webhook`
2. 開啟 **Use webhook** 與 **Webhook redelivery**
3. LIFF App → Size: `Full`、Endpoint: 你的部署首頁、Scopes: `openid` + `profile`

---

## 對話記帳指令

| 指令範例 | 說明 |
| :--- | :--- |
| `晚餐 860 我付` | V2 共同交易 860；明確單筆可直接入帳 |
| `晚餐 860 我付，五五分` | 以指定分攤方式建立 V2 交易 |
| `退款 300 她收` | 建立 V2 income／refund 交易 |
| `我轉給她 500` | 建立 V2 transfer；單一 Ledger 內維持零和 |
| `誰欠誰` | 回覆指定 Ledger 的 V2 balance |
| `結清` | 建立 V2 proposal，確認後以 transfer 結清 |
| `刪除剛剛那筆` | 透過 V2 LIFF 的 void／replace 流程處理 |
| `加入 <綁定碼>` | 前兩位使用者綁定群組 |
| `說明` / `help` | 顯示指令說明 |

---

## 環境變數

請見 [env-vars.md](env-vars.md)。重點：
- `COUPLE_SETUP_CODE` 必須 ≥ 20 字元
- `LIFF_SESSION_SECRET` 必須 ≥ 32 字元
- `CRON_SECRET` 必須 ≥ 16 字元

目前入口沒有 `NEXT_PUBLIC_V2_LEDGER_UI`；V2 LIFF 由根路徑直接渲染，
server-side 的 `V2_LEDGER_ENABLED` 才是 API／writer gate。

---

## 貢獻與授權

- 貢獻：[CONTRIBUTING.md](../CONTRIBUTING.md)
- 架構與 legacy boundary：[V2_ARCHITECTURE.md](V2_ARCHITECTURE.md)
- 資安：[SECURITY.md](../SECURITY.md)
- 授權：[MIT](../LICENSE)
