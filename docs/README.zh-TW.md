# LINE 智慧雙人共同帳本 (中文說明)

> Self-hosted、聊天優先的 LINE 記帳機器人，英文版請見 [README.md](../README.md)。本檔保留台灣使用者熟悉的中文說明。

這是一個用 **Next.js 16 + Supabase Postgres + Google Gemini** 打造的雙人共同帳本，深度整合 **LINE Messaging API** 與 **LINE Login (LIFF)**。在 LINE 對話框直接打字，背後的 AI 祕書就會幫你解析、生成待確認草稿；LIFF 儀表板提供隨開即看的視覺化圖表。

---

## 為什麼做這個

情侶、夫妻、死黨共同生活時，常見的痛點：
- 記帳 App 廣告多、登入麻煩。
- 同步麻煩、且固定分帳比例不彈性。
- 找不到精緻的行動儀表板與共同支出分析。

這個專案的目標是**讓記帳回到對話裡**，並把資料自主權還給你。

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
- `pnpm test` ── 170 筆單元測試，使用記憶體內的 `FakeTxClient`。
- `pnpm test:e2e` ── Playwright 對 LIFF 前端的端到端測試。

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
            │ 對話訊息 / 圖片 / 語音          │ 點擊選單 → LIFF WebView
            ▼                                ▼
┌───────────────────────┐        ┌───────────────────────┐
│ LINE Messaging API    │        │ LINE Login (LIFF)     │
└───────────┬───────────┘        └───────────┬───────────┘
            │ Webhook                        │ REST/hooks
            ▼                                ▼
┌────────────────────────────────────────────────────────┐
│               Next.js App Router (Vercel)              │
│  ┌─────────────────────┐  ┌─────────────────────┐      │
│  │  財務祕書 AI        │  │  會計師 AI          │      │
│  └──────────┬──────────┘  └──────────┬──────────┘      │
│             └────────────┬───────────┘                 │
│                          ▼                             │
│            pending_action → 單一交易提交                │
└──────────────────────────┬─────────────────────────────┘
                           │ DATABASE_URL
                           ▼
┌────────────────────────────────────────────────────────┐
│               Supabase Postgres (你的資料)            │
└────────────────────────────────────────────────────────┘
```

關鍵設計：
- **ACID 直連 Postgres** — 所有多列寫入走單一 `pg` 交易，**不走** Supabase PostgREST roundtrip。
- **Webhook 不重複** — 每個事件帶 `sourceEventId`；`pending_action` 用 idempotency key。
- **群組成員鎖定** — 只有前兩個輸入 `join <COUPLE_SETUP_CODE>` 的使用者會被綁定，其他人會被拒絕。
- **私人/共同分離** — 私人帳目絕不進入對方的債務計算，但仍會算入個人總額。

---

## 開發與部署

完整英文版請見 [docs/deploy-vercel.md](deploy-vercel.md)。簡述步驟：

```bash
git clone https://github.com/nnnc8/line-couple-ledger-bot.git
cd line-couple-ledger-bot
pnpm install
cp .env.example .env.local
# 編輯 .env.local 填入所有必填變數
pnpm dlx supabase login
pnpm dlx supabase link --project-ref <your-project-ref>
pnpm dlx supabase db push
pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build
pnpm dev   # 對外用 ngrok / localtunnel
```

LINE 後台設定：
1. **Webhook URL** → `https://<your-domain>/api/line/webhook`
2. 開啟 **Use webhook** 與 **Webhook redelivery**
3. LIFF App → Size: `Full`、Endpoint: 你的部署首頁、Scopes: `openid` + `profile`

---

## 對話記帳指令

| 指令範例 | 說明 |
| :--- | :--- |
| `晚餐 860 我付` | 共同支出 860，自動歸類 `food` |
| `私人 午餐 120` | 私人支出，不會納入對方帳目 |
| `誰欠誰` | 雙方債務結算 |
| `本月共同支出` | 本月共同支出加總與分類 |
| `本月私人支出` | 本月自己的私人支出 |
| `刪除剛剛那筆` | 5 分鐘內復原最後一筆 |
| `結清` | 發起清算，雙方需確認 |
| `加入 <綁定碼>` | 前兩位使用者綁定群組 |
| `說明` / `help` | 顯示指令說明 |

---

## 環境變數

請見 [env-vars.md](env-vars.md)。重點：
- `COUPLE_SETUP_CODE` 必須 ≥ 20 字元
- `LIFF_SESSION_SECRET` 必須 ≥ 32 字元
- `CRON_SECRET` 必須 ≥ 16 字元

---

## 貢獻與授權

- 貢獻：[CONTRIBUTING.md](../CONTRIBUTING.md)
- 資安：[SECURITY.md](../SECURITY.md)
- 授權：[MIT](../LICENSE)
