---
name: verify
description: 驗證電子禮券管理後台：啟動伺服器、用 Playwright 操作真實網頁介面並截圖
---

# 驗證方式

## 啟動

```bash
npm install
DATA_DIR=$(mktemp -d) PORT=3456 node src/server.js   # DATA_DIR 換成暫存目錄可避免污染 data/
```

首頁即後台介面：`http://localhost:3456`，API 掛在 `/api/*`。

## 用瀏覽器驅動（本環境已預裝 Chromium）

在 scratchpad 安裝 `playwright-core`，以
`executablePath: '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell'`
啟動（不要跑 `playwright install`）。

值得走的流程：
1. 上傳 CSV（`#tab-upload`）→ 檢查 `#upload-result` 文字與匯入數
2. 重複上傳同一份 → 應回報「重複略過」
3. 禮券管理（`#tab-codes`）→ 點「標記兌換」→ 填活動名稱 → 確認列變成「已兌換」徽章
4. 批次兌換（`#tab-bulk`）→ 貼多個碼含一個不存在的 → 檢查分類回報
5. 取消兌換（會跳 `confirm`，記得 `page.once('dialog', d => d.accept())`）
6. `/api/export.csv` 直接 curl 檢查（開頭有 BOM、狀態為中文）

## 陷阱

- 前端更新是非同步 fetch：`waitForFunction` 要等「新值」，不能只等元素非隱藏，
  否則會讀到上一步留下的舊 toast / result box（3.5 秒才消失）。
- 測試用 `npm test`（node:test，會自建暫存 DATA_DIR），但驗證請以真實 UI 為準。
