# v1 LINE／LIFF 穩定性與 UI 重構研究

日期：2026-07-28

分支：`codex/v1-transfer-flow`

研究基線：`66d758b8b77ebd2896343c113bfbd70dc852120b`

## 需求

1. 修正分類分析把不同分類顯示成「其他」且使用同色。
2. 重做 LINE Rich Menu 與按鈕式記帳流程。
3. 修正 Rich Menu 操作後重複出現「這個操作無效或已更新」。
4. Rich Menu 與聊天中的 LIFF 入口留在 LINE，不跳 Safari。
5. 重構整套 LIFF，保留 v1 帳務、pending action、transaction、冪等與通知契約。
6. 移除誤混入介面的泰文，不復活 finance v2。

## 根因

### Rich Menu 重複錯誤

Rich Menu 底部分頁使用 `richmenuswitch`，data 為 `tab=record`／
`tab=manage`。LINE 切換分頁時仍會把 data 送成 webhook postback；
舊 webhook 只接受 pending decision 或 `m=1` 選單協定，因此每次切換
都被當成無效操作並回覆錯誤。

修復原則：

- 只接受完整且唯一的 `tab=record` 或 `tab=manage`。
- 在使用者與資料庫查詢前靜默結束，不產生聊天泡泡。
- 其他 `tab`、重複 key 或額外 key 仍拒絕。

### 跳到 Safari

Rich Menu 與部分聊天訊息使用一般 Vercel endpoint URL。這是一般網頁
連結，不是 LIFF 入口。所有 LINE → Web App 連結必須統一為：

```text
https://liff.line.me/{LIFF_ID}/?...
```

前端需同時讀取直接 query 與 LINE 包裝後的 `liff.state`，並保留舊
`tab=private` 深連結。

### 分類全部是「其他」

歷史資料中有不少 generic tag；舊圖表直接讀取原始 tag，因此不同花費
會合併成同一個「其他」，顏色雜湊也自然相同。

現有 server-side 分類器已能依說明、商家與規則產生 fallback label。
分類彙總和明細下鑽必須共用同一個 label 函式，避免排行榜顯示「餐飲」，
展開後卻找不到資料。

### LIFF 資訊架構

舊首頁同時放餘額、三個操作、任務、決策、分類圓餅、趨勢、排行與最近
流水，首屏沒有單一任務；分類圓餅、清單與長條圖也在重複同一份資訊。
私人帳則被做成另一套頁面，不像同一個財務系統的範圍。

## 選定方案

### LINE

- 保留 stateless postback，不新增選單 session table。
- emitter 與 parser 共用 discriminated stage schema。
- 新協定發出 `menu=quick`，繼續接受既有 `m=1`。
- 快速花費依序選帳本、群組、付款人、分類、說明與常用金額。
- 自訂內容開啟預填 LIFF。
- 轉帳保留兩個方向；結清仍依最新餘額。
- 最後只建立 pending action，確認前不得入帳。
- 過期或 stale 只回一張可重新開始的 Quick Reply。
- postback 不帶 `displayText`，避免每次點擊產生聊天雜訊。

### LIFF

導覽改為：

1. 首頁：餘額、主要動作、本月共同／私人／合計、一則洞察、高優先待辦、
   最近五筆。
2. 流水：全部／花費／轉帳，加上全部帳本／共同／私人。
3. 記一筆：中央入口，分開新增花費、記錄轉帳與全部結清。
4. 分析：共同／私人／合併，近六個月趨勢、分類排行與明細下鑽。
5. 設定：可用功能優先；未開放功能移到「即將推出」。

表單採 action-first：

- 花費先填金額與說明，日期、商家、付款人、分帳與備註放進進階區。
- 轉帳先填金額，再選群組、方向、日期與備註。
- 送出按鈕固定在 safe area 上方。
- 100/0 仍合法，但明確提醒轉帳應使用「記錄轉帳」。

### 視覺

- 深海軍藍作財務主色，單一鈷藍作互動色。
- 減少陰影與重複卡片，主要文字至少 15px、次要文字至少 13px。
- 點擊區至少 44px。
- 分類色以實際分類 label 穩定雜湊，非 generic fallback。

## 安全與資料邊界

- requester 只取自 LINE webhook source，不接受 postback 傳 user ID。
- postback 長度、keys、enum、UUID、金額與 stage 全部白名單驗證。
- group 每一步重新驗證 couple ownership 與未封存狀態。
- webhook retry 使用 event ID 與 canonical command 衍生穩定冪等 key。
- log 只留安全 reason code，不記完整 postback、金額、group ID 或文字。
- 所有 money write 仍走 pending action executor 與既有 notification queue。
- 不新增 Supabase schema、不建立新的轉帳 table、不引入狀態管理套件。

## 驗收門檻

- `tab=record|manage` 切換不查 DB、不回訊息。
- 所有 Rich Menu、Quick Reply、搜尋與月報連結使用 LIFF URL。
- `liff.state`、舊 `tab=private`、搜尋與預填表單深連結皆可用。
- generic 歷史分類能在分析頁分開顯示、使用不同顏色並正確下鑽。
- 390×844 與 430×932 無水平溢位，核心按鈕與 sticky submit 可用。
- `src/` 不含誤植的泰文字母。
- `pnpm typecheck`、`pnpm test`、真實 DB transaction tests、
  `pnpm test:e2e`、Rich Menu validate 與 `pnpm build` 全部通過。
- preview 與同一 artifact promotion 後，真實 LINE／LIFF、Rich Menu aliases、
  production alias、runtime logs 與 rollback 證據一致。
