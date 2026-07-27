# v1 分類圖表與 LINE 操作體驗研究

日期：2026-07-27  
分支：`codex/v1-transfer-flow`  
研究基線：`8d0d981`

## 需求

1. 修正分類圓餅圖把不同分類全部顯示成「其他」且同色。
2. 重做 LINE Rich Menu。
3. 增加 Flex／Quick Reply，讓常用記帳、轉帳和結清能直接點選。
4. 移除 LIFF 中誤混入的泰文。
5. 保留 v1 的 pending action、transaction、冪等與通知路徑，不復活 v2。

## 現況與根因

### 分類圖表

- 正式資料不是全部為「其他」。唯讀彙總可見油資、停車費、餐飲、維修保養、交通、醫療等多種 `tag`。
- `rankCategoryLabels()` 回傳 `{ label, totalTwd, count }`。
- `categoryAnalytics()` 目前直接 spread 該物件，因此 API 回傳 `label`。
- 前端 `CategoryAnalytics` 契約與 Dashboard、私人帳都讀取 `tag`，讀不到時 fallback 為「其他」。
- `tagColor()` 依 tag 產生顏色；所有項目 fallback 成同一個 tag 後，自然全部同色。

結論：修正 API 邊界，把 `item.label` 明確映射成 `tag`；不需修改或回填資料庫。

### 泰文

`src/` 內有三處 `เงินจริง`：

- 記一筆 sheet 副標題。
- 轉帳反方向警告。
- 轉帳 sheet 副標題。

統一替換成「實際轉帳」或「實際金流」，並加入 Thai Unicode 靜態回歸測試。

### LINE Rich Menu

- 工作區有一張未納入 Git 的 `output/rich-menu.png`，尺寸 2500×1686，內容與目前截圖一致。
- Repo 沒有可重現的 Rich Menu 版型、熱區 manifest、部署或 rollback 腳本。
- 現有「收據／直接傳圖片」入口與實際 bot 行為矛盾：圖片目前只會被拒絕，不會 OCR 入帳。
- Vercel production 有 `LINE_CHANNEL_ACCESS_TOKEN` 變數名稱，但 CLI pull 取得空值；本機 token 已失效，因此目前無法驗證或切換線上 Rich Menu。

結論：建立可重現產圖、嚴格 manifest、validate/plan/apply/rollback 腳本；取得有效 token 前不得聲稱正式 Rich Menu 已切換。

### LINE 訊息與寫入路徑

- webhook 目前只把 postback 解讀為 pending action 的確認／取消。
- Flex 已有花費成功、查帳、群組選擇、錯誤與轉帳確認卡。
- LINE 寫入最終必須走既有 pending action executor；不得建立直接寫 expense/settlement 或額外 partner push。
- webhook 已有 `webhookEventId`，可用來建立穩定 idempotency key。

結論：新增嚴格白名單的 menu postback parser，使用 Flex／Quick Reply 收集選項；最後仍建立既有 pending action。

## 最佳實作

### 分類與文案

- `categoryAnalytics()` 回傳 `{ tag: item.label, totalTwd, count, percent }`。
- 修改錯誤的 `.label` 測試為 `.tag`，並確認 public response 不再暴露 `label`。
- 保留 `tagColor(tag)`，新增多分類不同色的元件測試。
- 清除所有 Thai Unicode。

### 按鈕式記帳

- 使用 stateless、版本化 postback，不新增資料表或半成品 session。
- 每一步把已選的白名單值帶入下一個 postback；group 永遠重新驗證 couple ownership。
- 快速花費只支援平均分帳與固定分類／說明／金額；自訂內容改開預填 LIFF。
- 常用金額為 NT$100、200、500、1,000。
- 最後建立 pending action 並顯示確認／取消，確認前不入帳。
- 轉帳保留兩個方向、無欠款、反向與超額；結清仍依最新餘額限制。

### 雙頁 Rich Menu

兩張 2500×1686 PNG：

- 記帳頁：大型「快速新增花費」、次要「記錄轉帳」、「全部結清」，底部切換記帳／管理。
- 管理頁：本月總覽、流水、私人帳、設定，底部切換記帳／管理。
- aliases：`ledger-record-v1`、`ledger-manage-v1`。
- 以 Playwright 從固定 HTML/CSS 產圖，不新增繪圖 dependency。
- 移除收據入口；圖片訊息改回說明 Flex，提供快速記帳與 LIFF 按鈕。

## 安全與資料邊界

- requester 只取自 LINE webhook source，不接受 postback 傳 user ID。
- postback 長度、keys、enum、UUID、金額與文字全部用 Zod／白名單驗證。
- group 必須屬於 requester 的 couple 且未封存。
- webhook retry 使用 event ID 與 canonical payload 衍生冪等 key。
- 不記錄 token、完整 postback、帳目描述或個資到 deployment log。
- 不新增 Supabase schema；現有 RLS、transaction 與 notification queue 不變。

## 驗收

- 分類圖顯示真實分類與不同顏色。
- `src/` 無 Thai Unicode。
- Rich Menu 與快速操作的所有 money write 都在確認後才發生且恰好一次。
- LIFF deep link 能預填，不能繞過現有驗證。
- `pnpm typecheck`、`pnpm test`、`pnpm test:tx`、`pnpm test:e2e`、`pnpm build` 全部通過。
- preview、真實手機 LIFF、真實 LINE、資料庫 row/activity/notification 都有證據。
- 沒有有效 LINE token 時停在 Rich Menu `plan`，不得冒充 live complete。

## 研究基線

- `pnpm typecheck`：通過。
- `pnpm test`：193/193 通過。
- Supabase 2026-07 breaking changes 與本次 server-side 既有 Data API 使用無直接衝突。
