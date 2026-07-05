<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.x-blue?style=for-the-badge&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Next.js-16-black?style=for-the-badge&logo=nextdotjs" alt="Next.js" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react" alt="React" />
  <img src="https://img.shields.io/badge/Tailwind--v4-38B2AC?style=for-the-badge&logo=tailwindcss" alt="Tailwind CSS v4" />
  <img src="https://img.shields.io/badge/Supabase-Database-3ECF8E?style=for-the-badge&logo=supabase" alt="Supabase" />
  <img src="https://img.shields.io/badge/Google--Gemini-AI--Agent-8E75C2?style=for-the-badge&logo=googlegemini" alt="Gemini" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="MIT License" />
</p>

<h1 align="center">💞 LINE 智慧雙人共同帳本 (LINE Couple Ledger Bot)</h1>

<p align="center">
  <strong>一款專為情侶、夫妻、死黨打造的智慧共同記帳神器 ── 完美結合 LINE Bot 的對話便利性、LIFF 網頁的視覺儀表板，以及 LLM 雙模驅動的 AI 財務大腦！</strong>
</p>

<p align="center">
  <a href="#-專案簡介">專案簡介</a> •
  <a href="#-核心亮點">核心亮點</a> •
  <a href="#-系統架構">系統架構</a> •
  <a href="#%EF%B8%8F-開發與部署指南">開發與部署指南</a> •
  <a href="#-環境變數配置">環境變數配置</a> •
  <a href="#-對話記帳指令手冊">對話記帳指令手冊</a> •
  <a href="#-三層自動化驗證架構">三層自動化驗證架構</a> •
  <a href="#-真實資料庫-smoke-驗證手冊">Smoke 驗證手冊</a>
</p>

---

## 📖 專案簡介

在雙人共同生活、管理財務的日常中，你是否也常遇到這些痛點？
- 記帳 App 廣告太多，或是需要繁瑣的打開、登入、選分類。
- 使用一般記帳 App 還要互相同步，或受限於固定的分帳比例。
- 想查看每月的共同支出佔比與剩餘預算，卻找不到一個好用又精美的行動儀表板。

**LINE 智慧雙人共同帳本** 是你最好的解答！本專案採用 **Next.js 16 (App Router)**、**Tailwind CSS v4** 與 **Supabase PostgreSQL**，並深度整合 **LINE Messaging API** 與 **LINE Login (LIFF)**。使用者只需在手機的 LINE 對話框內直接打字，甚至拍照、傳語意不清的話，背後的 **Google Gemini AI 智慧祕書** 就會自動為你解析，生成待確認記帳草稿！

此外，精美的 **LIFF 儀表板** 提供隨開即看的視覺化圖表與帳目歷史，免下載任何 App，所有資料安全、隱私，完全由你自行託管，終身免費且無廣告。

---

## 🌟 核心亮點

### 🧠 1. 雙模驅動 AI 財務大腦
本專案不只是普通的記帳機器人，我們設計了兩套各司其職的 LLM 智慧代理：
*   **👩‍💼 財務祕書 AI (Secretary Agent)**：*雙人共享對話快取*。她會隨時傾聽你們在 LINE 群組內的對談。不論是「昨晚晚餐 860 我付」、「幫我改成私人帳」或是「記一下剛剛那個，並提醒我partner買牛奶」，她都能理解脈絡、調用工具（Tool Calls）查詢歷史、新增代辦任務（Chore Tasks），並主動在適當時機推送貼心的日常簡報與提醒。
*   **👨‍💼 專業會計師 AI (Accountant Agent)**：*專屬財務分析專家*。她能在你查詢時，動態對大量交易數據進行財務多維度聚合、自動偵測重複記帳、分析不合理的分類，並提供精緻的分類重整建議（Category Cleanup），甚至一鍵幫你自動修復分類。

### 💬 2. 極簡對話記帳 & 語意解析
*   **單行秒記**：輸入 `晚餐 860 我付`，系統會秒自動分析付款人、群組共同帳、並推導分類（如 `food`）。
*   **私人帳支援**：開頭加 `私人` (如：`私人 午餐 120`) 即可自動記在你的私人帳，與伴侶的共同帳目完美隔開。
*   **五分鐘安全期**：所有新增、修改、刪除、復原與結清操作都具備 5 分鐘的安全暫存期，可以隨時一鍵取消或修正，完全不怕手抖記錯！

### 📊 3. 絢麗的 LIFF 行動儀表板 (Mobile-First UI)
*   **極致流暢**：使用 Next.js 16 + React 19 與 Tailwind CSS v4 打造，專為手機 LINE 內嵌瀏覽器最佳化。
*   **豐富圖表**：使用 Recharts 繪製精美的分類佔比圓餅圖、趨勢折線圖，一眼看清資金流向。
*   **多元分帳**：完美支援「均分」、「按比例」、「我全付」等三種常見情侶分帳模式。
*   **預算與週期帳**：設定每月總預算，並能自動按週期（房租、Netflix 訂閱等）生成記帳草稿，不再忘記固定支出。

### 🔒 4. 數據自主與完全自託管 (Self-Hosted & Privacy)
*   所有秘密金鑰與 API Key 僅儲存於你的 Vercel / Supabase 伺服器，安全無虞。
*   不需擔心第三方記帳平台倒閉或洩漏情侶間的隱私財務，資料庫掌握在自己手中。

---

## 📐 系統架構

本專案採用高内聚、低耦合的 Serverless 架構，保證極高的效能與極低的運行成本：

```
┌────────────────────────────────────────────────────────┐
│                      LINE Client                       │
└───────────┬────────────────────────────────┬───────────┘
            │ (對話訊息 / 語音 / 圖片)        │ (點擊選單開啟 LIFF WebView)
            ▼                                ▼
┌───────────────────────┐        ┌───────────────────────┐
│ LINE Messaging API    │        │ LINE Login (LIFF UI)  │
└───────────┬───────────┘        └───────────┬───────────┘
            │ Webhook 傳送                   │ REST API / hooks 請求
            ▼                                ▼
┌────────────────────────────────────────────────────────┐
│               Next.js App Router Server                │
│                                                        │
│  ┌───────────────────────┐   ┌──────────────────────┐  │
│  │   財務祕書 AI         │   │   專業會計師 AI       │  │
│  │ (Gemini 共享會話 loop)│   │  (財務聚合分析與清理) │  │
│  └───────────┬───────────┘   └──────────┬───────────┘  │
│              │                          │              │
│              └────────────┐ ┌───────────┘              │
│                           ▼ ▼                          │
│                    安全資料庫交易核心                  │
└───────────────────────────┬────────────────────────────┘
                            │ (直接交易連線 DATABASE_URL)
                            ▼
┌────────────────────────────────────────────────────────┐
│               Supabase PostgreSQL Database             │
└────────────────────────────────────────────────────────┘
```

---

## 🛠️ 開發與部署指南

### 📋 系統要求
- **Node.js**: `22.x` 以上版本
- **套件管理器**: `pnpm`
- **LINE 服務**: 一個 LINE Messaging API channel 與一個 LINE Login channel (需在同個 Provider 下)
- **AI 服務**: Google AI Studio API key (Gemini)
- **資料庫**: Supabase Project 與 PostgreSQL 資料庫連線字串 (`DATABASE_URL`)

### 1️⃣ 本地開發起步
```bash
# 1. 複製本專案
git clone https://github.com/your-username/line-couple-ledger-bot.git
cd line-couple-ledger-bot

# 2. 安裝相依套件
pnpm install

# 3. 建立並配置環境變數
cp .env.example .env.local
```
> 請打開 `.env.local` 填入您的環境變數（詳細說明請參閱[環境變數配置](#-環境變數配置)）。

### 2️⃣ 資料庫遷移 (Supabase)
本專案使用 Supabase 管理 Schema，請透過 Supabase CLI 將結構套用到您的 Postgres 資料庫：
```bash
# 登入 Supabase CLI
pnpm dlx supabase login

# 連結專案 (專案 ref 可在 Supabase 儀表板 URL 中找到)
pnpm dlx supabase link --project-ref <your-supabase-project-ref>

# 推送 Schema 與 Migrations 到雲端資料庫
pnpm dlx supabase db push
```

### 3️⃣ 啟動本機開發伺服器
```bash
pnpm dev
```
啟動後，本機網址為 `http://localhost:3000`。您可以使用 `ngrok` 或 `localtunnel` 將本機 3000 埠對外公開，以便 LINE Webhook 進行本機測試。

### 4️⃣ Vercel 部署與 LINE 後台設定
1. **部署到 Vercel**：將本專案匯入 Vercel，並將 `.env.example` 中所有的環境變數完整設定到 Vercel 專案的 Environment Variables 中。
2. **LINE Webhook 設定**：
   - 進入 [LINE Developers Console](https://developers.line.biz/)。
   - 在您的 Messaging API Channel 底下，將 **Webhook URL** 設為：
     ```text
     https://<your-vercel-deployment-url>/api/line/webhook
     ```
   - 點擊 **Verify** 驗證，並務必開啟 **Use webhook** 與 **Webhook redelivery**。
3. **LIFF App 設定**：
   - 在同一個 Provider 底下的 **LINE Login channel** 中建立一個 LIFF App。
   - **Size** 設為 `Full`。
   - **Endpoint URL** 設為您的 Vercel 部署首頁：`https://<your-vercel-deployment-url>/`。
   - **Scopes** 勾選 `openid` 與 `profile`。
   - 將產生的 LIFF ID 填入環境變數 `NEXT_PUBLIC_LIFF_ID` 中，LINE Login Channel ID 填入 `LINE_LOGIN_CHANNEL_ID`。

> 💡 **自動化每日任務**：Vercel 會在每日台北時間 01:15 自動執行 `/api/cron/daily`，來掃描並建立當天所需的週期帳與定時待辦草稿。

---

## 🔑 環境變數配置

在 `.env.local` 或是您的雲端託管平台中，請配置以下環境變數：

| 變數名稱 | 必填 | 說明 |
| :--- | :---: | :--- |
| `DATABASE_URL` | 是 | 直連 Postgres Database 的連線字串（注意：此變數強制要求，帳務交易會直連此資料庫以確保極致 ACID 完整性） |
| `SUPABASE_URL` | 是 | Supabase 專案網址 |
| `SUPABASE_SECRET_KEY` | 是 | Supabase Service-Role Secret 金鑰（可用於安全繞過 Row-Level Security 執行後台管理） |
| `LINE_CHANNEL_SECRET` | 是 | LINE Messaging API 的 Channel Secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | 是 | LINE Messaging API 的 Channel Access Token |
| `GEMINI_API_KEY` | 是 | Google AI Studio 的 API 密鑰，用於驅動雙 AI 代理（祕書與會計師） |
| `COUPLE_SETUP_CODE` | 是 | 情侶初始綁定配對碼，**必須大於 20 個字元**。用於防範未授權使用者加入您的記帳群組 |
| `LINE_LOGIN_CHANNEL_ID` | 是 | LINE Login 管道 ID，供 LIFF 的前端登入與安全性驗證使用 |
| `NEXT_PUBLIC_LIFF_ID` | 是 | LINE Login 底下建立的 LIFF 應用程式 ID（前端需要公開） |
| `NEXT_PUBLIC_LINE_BASIC_ID` | 否 | 機器人的 LINE ID (例如 `@123xxxxx`)，便於 LIFF UI 內引導使用者回到對話框 |
| `LIFF_SESSION_SECRET` | 是 | LIFF 工作階段加密金鑰，**必須大於 32 個字元**，保護前端 Session Cookie |
| `APP_URL` | 是 | 本專案部署後的完整網址 (例如 `https://my-ledger.vercel.app`) |
| `CRON_SECRET` | 是 | 每日定時任務的 Bearer 驗證金鑰，**必須大於 16 個字元**，防止 Cron Endpoint 被惡意調用 |

---

## 💬 對話記帳指令手冊

### 👥 1. 初始帳戶綁定 (情侶註冊)
前兩位加入 LINE Bot 的使用者，必須在對話框中輸入綁定碼來啟用共同帳務：
```text
加入 <您的COUPLE_SETUP_CODE綁定碼>
```
*綁定成功後，系統將鎖定兩人的 LINE User ID，其餘第三人皆無法查閱或操作此共同帳本，安全度極高。*

### 💰 2. 快捷記帳與查詢指令
您可以直接在對話框內輸入以下精準指令來完成操作：

| 指令範例 | 功能說明 | 備註 |
| :--- | :--- | :--- |
| `晚餐 860 我付` | 快速記錄一筆共同支出 860 元，由「我」代墊 | 自動歸類為 `food` 分類 |
| `私人 午餐 120` | 記錄一筆私人支出 120 元 | 不會納入伴侶的債務計算中 |
| `誰欠誰` | 查詢目前兩人間的債務分配狀況 | 計算誰需要給誰多少元 |
| `本月共同支出` | 列出本月共同支出的加總與分類摘要 | 呈現精美文字報表 |
| `本月私人支出` | 列出本月自己的私人支出總額 | 伴侶不會看到此明細 |
| `刪除剛剛那筆` | 撤銷在 5 分鐘安全期內記錄的最後一筆交易 | 支援秒速復原 |
| `結清` | 發起債務清算，將兩人的代墊帳目歸零 | 需雙方確認 |
| `說明` / `help` | 呼叫機器人回覆簡易說明指令表 | |

---

## 🧪 三層自動化驗證架構

本專案採用領先業界的 **三層自動化測試架構**，確保程式碼修改不影響既有帳務邏輯，且完全不混淆本地開發與線上正式資料庫。

```
                    ┌─────────────────────────┐
                    │  1. 靜態分析 (Compile)  │  pnpm typecheck, lint, build
                    └────────────┬────────────┘
                                 │ Pass
                                 ▼
                    ┌─────────────────────────┐
                    │  2. 單元/虛擬測試 (Unit) │  pnpm test:all (不需連接真實 DB)
                    └────────────┬────────────┘
                                 │ Pass
                                 ▼
                    ┌─────────────────────────┐
                    │ 3. 真實資料庫冒煙 (Smoke)│  pnpm smoke:* (需 DATABASE_URL)
                    └─────────────────────────┘
```

### 🟩 Layer 1: 靜態程式碼檢查 (`Static Checks`)
不需要任何環境變數，用來確保專案結構完整且無 TypeScript/Lint 錯誤：
```bash
pnpm typecheck       # TypeScript 類型檢查
pnpm lint            # ESLint 程式碼風格檢查
pnpm build           # Next.js 生產環境編譯測試
```

### 🟨 Layer 2: 獨立單元與模擬測試 (`Unit / Fake-DB Tests`)
**不需要 `DATABASE_URL`**。此階段會使用記憶體內的模擬交易客戶端 (`FakeTxClient`) 與純資料邏輯進行高強度覆蓋率測試，確保演算法、AI 模組狀態機與分帳規則完全正確：
*   `pnpm test` ── 執行 117+ 筆關於邊界環境、記帳規則、AI Agent 調度等極速單元測試。
*   `pnpm test:tx` ── 執行模擬客戶端核心測試 ＋ 條件防禦 PostgreSQL 測試（自動跳過無連線環境）。
*   `pnpm test:smoke` ── 測試冒煙引擎本身的環境哨兵與 cleanup 控制防禦合約。
*   `pnpm test:all` ── 一鍵在單個處理程序中跑完上述所有單元測試。
*   `pnpm test:e2e` ── 啟動 Playwright 自動化瀏覽器，對 LIFF 前端應用程式進行完整交互流程測試。

### 🟥 Layer 3: 真實冒煙測試證明 (`Live DB Smoke Activation`)
這是**唯一**會對真實 Postgres 資料庫進行真實交易寫入、提交、回滾與清理的驗證測試。它必須配置正確的 `DATABASE_URL`、Supabase 密鑰與 Smoke 認證，若環境不齊全會 Fail-Fast（迅速中斷）而絕不假裝通過。
```bash
pnpm smoke:local        # 測試建立費用 -> 自動分帳 -> 發起結清 -> 完整資料庫一鍵清理
pnpm smoke:recurring    # 測試週期性自動記帳的 Cron 調度處理路徑
pnpm smoke:cron         # 測試實體部署上的 /api/cron/daily 安全調度 API Endpoint
```

---

## 📕 真實資料庫 Smoke 驗證手冊

當您在本地端配置好真實 PostgreSQL 連線並想進行端到端功能驗證時，請依照本手冊步驟操作。

### 📋 冒煙測試所需之環境變數
請在本地 `.env.local` 內，配置以下 Smoke 專屬憑證：

| 變數名稱 | 範例與說明 |
| :--- | :--- |
| `DATABASE_URL` | 真實直連 Postgres 測試資料庫的連接字串 |
| `SUPABASE_URL` | 您的測試環境 Supabase 網址 |
| `SUPABASE_SECRET_KEY` | 能夠繞過 RLS 的 service-role 金鑰（冒煙測試清理資料庫必備） |
| `APP_URL` | 本機開發網址 (如 `http://localhost:3000`) |
| `CRON_SECRET` | 每日 API Cron 測試時所用的不重複長字串金鑰 |
| `SMOKE_LINE_USER_ID` | Owner 的 LINE User ID（**此 ID 必須已事先註冊於資料庫 `users` 表**） |
| `SMOKE_PARTNER_LINE_USER_ID` | Partner 的 LINE User ID（**此 ID 必須已事先註冊於資料庫 `users` 表**） |
| `SMOKE_GROUP_NAME` | 目標測試群組名稱（若資料庫中不存在，Smoke 腳本將會自動為您創立） |
| `SMOKE_CLEANUP_MODE` | 可設為 `always` (不論成功與否，跑完立刻清空測試明細) 或 `on-success` (成功時清空) |

### 🚀 執行驗證命令
```bash
# 1. 跑完本機 pending action e2e 核心鏈
pnpm smoke:local

# 2. 驗證週期性定時任務的解析與資料持久化
pnpm smoke:recurring

# 3. 模擬透過安全 API 發起 Cron 調度請求
pnpm smoke:cron
```

#### 🛡️ `pnpm smoke:local` 內部執行步驟拆解：
1. **定位 Smoke 租戶** ── 自適應搜尋或在 `users`/`couple_groups` 建立專屬 Smoke 測試租戶。
2. **測試私人支出** ── 模擬 `proposeAction(create_expense)` 提案並呼叫 `confirm()` 寫入，檢驗 `expenses` 資料表。
3. **測試共同支出** ── 模擬雙人均分 `split_method: equal`，檢驗 `expenses` 及其附屬 `expense_splits` 表。
4. **債務結清流** ── 模擬 `proposeAction(settle)`，並確認雙方帳務在 `settlements` 內是否正確對齊歸零。
5. **完美落幕清理** ── 根據 `SMOKE_CLEANUP_MODE` 配置，全自動清除因本次測試所產生的所有測試髒數據。

---

## 🤝 貢獻指南

我們非常歡迎社群開發者一同來優化這個專案！如果您有任何想法、發現 Bug 或想加入新功能：
1.  **Fork** 本專案。
2.  建立您的 Feature 分支：`git checkout -b feature/AmazingFeature`。
3.  確認程式碼風格與測試全部通過：`pnpm typecheck && pnpm lint && pnpm test:all`。
4.  提交您的修改：`git commit -m 'Add some AmazingFeature'`。
5.  推送到分支：`git push origin feature/AmazingFeature`。
6.  發起 **Pull Request**！

---

## 📄 開源授權

本專案採用 [MIT License](LICENSE) 授權，您可以自由地使用、修改及商業化部署。

---

<p align="center">
  <strong>如果這個專案幫到你與伴侶建立起幸福、流暢的記帳習慣，歡迎給我們一顆星星 ⭐！</strong>
</p>
