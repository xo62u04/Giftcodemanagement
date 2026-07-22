# 設計文件：CSV 範本下載與頁籤重組

日期：2026-07-22
分支：main

## 背景

行銷人員要自行準備禮券 CSV 上傳，但目前畫面上沒有任何範本可下載，只有一段文字說明可接受的欄位名稱（`public/index.html:81-85`）。人員只能自己猜欄位怎麼命名、日期怎麼寫。

同時，「上傳 CSV」這個頁籤現在混裝了三種性質不同的東西：上傳表單、NAS 同步、DB 路徑與備份設定。日常作業（上傳）跟系統管理（DB 路徑）擠在同一頁，而匯入（上傳頁）與匯出（禮券管理頁）卻分在兩頁。

本次處理兩件事：
1. 提供可下載的 CSV 範本
2. 依用途重組頁籤，讓匯入與匯出同頁、系統設定獨立

不動資料庫結構，不動上傳 API 的請求／回應格式。

---

## 1. 頁籤重組

改後的頁籤列：

```
總覽 | 禮券管理 | 批次兌換 | 上傳紀錄 | 同仁管理 | 系統設定
```

### `#tab-codes`（禮券管理）

把 `#upload-form` 與 `#upload-result`（`public/index.html:79-92`）整塊搬進來，置於篩選列上方。頁內順序：

1. 上傳禮券 CSV（含「下載 CSV 範本」連結）
2. 篩選列 ＋ 匯出 CSV
3. 禮券列表 ＋ 分頁

匯入與匯出自此在同一頁。

### `#tab-upload` → `#tab-settings`（系統設定）

保留 NAS 同步（`public/index.html:94-110`）與資料庫／備份設定表單（`public/index.html:112-133`）。

該區塊原本的 `<h2>系統設定</h2>` 改為 `<h2>資料庫與備份</h2>` —— 頁籤本身已叫「系統設定」，同頁不應再出現一層同名標題。

### id 保持不變

搬動的是 DOM 節點，所有 element id（`#upload-form`、`#upload-result`、`#sync-form`、`#db-config-form` 等）一律不變。頁籤切換邏輯是泛用的（`public/app.js:63-75`，以 `#tab-${btn.dataset.tab}` 對應 section），因此 `app.js` 只有一處需要改：

```js
// public/app.js:73
if (btn.dataset.tab === 'settings') { loadSyncStatus(); loadBackupStatus(); loadDbConfig(); }
```

### 上傳成功後刷新列表

上傳表單搬進禮券管理頁後，與禮券列表同頁；上傳成功時若不刷新，下方列表會停在舊資料，看起來像功能壞掉。在 `public/app.js:336` 的 `$('#upload-form').reset()` 之後補上：

```js
loadFilterOptions();
loadCodes();
```

---

## 2. CSV 範本

### 範本內容

四個欄位，加兩列範例資料：

```csv
禮券碼,禮品名稱,面額,到期日
ABC12345678,全家便利商店500元禮券,500,2026-12-31
ABC12345679,全家便利商店500元禮券,500,2026-12-31
```

欄位名稱全部取自 `src/csv.js:7-17` 既有的別名清單（`CODE_HEADERS` / `GIFT_NAME_HEADERS` / `VALUE_HEADERS` / `EXPIRY_HEADERS`），因此範本本身就是現有解析器吃得下的格式，不需要改動任何欄位辨識邏輯。

編碼為 **UTF-8 with BOM** —— 繁體中文 Windows 的 Excel 直接雙擊開啟才不會亂碼，而 `decodeCsvBuffer`（`src/csv.js:30`）本來就支援此格式。

### `src/csv.js`：單一來源

新增並 export 兩個常數：

- `TEMPLATE_SAMPLE_CODES = ['ABC12345678', 'ABC12345679']`
- `TEMPLATE_CSV`：上述完整範本字串（不含 BOM，BOM 由路由加上）

範本內容與「範例列略過」邏輯共用同一份常數，兩者不會各自漂移。

### 略過範例列

行銷人員若忘記刪掉範例列就上傳，`ABC12345678` 會被當成真實禮券碼匯入。`parseGiftcodeCsv` 在既有的空值與重複檢查之後加一道判斷：

```js
if (TEMPLATE_SAMPLE_CODES.includes(code)) {
  errors.push(`第 ${i + 1} 列：範本範例列，已略過`);
  continue;
}
```

走既有的 `errors` 陣列，前端結果框無需改動即可顯示。

### `src/server.js`：下載路由

新增 `GET /api/template.csv`，位置緊接 `/api/export.csv`（`src/server.js:350-379`）之後，並沿用其寫法：

```js
res.setHeader('Content-Type', 'text/csv; charset=utf-8');
res.setHeader(
  'Content-Disposition',
  `attachment; filename="giftcode-template.csv"; filename*=UTF-8''${encodeURIComponent('禮券上傳範本.csv')}`
);
res.send('\uFEFF' + TEMPLATE_CSV);   // 與 export.csv 一致
```

檔名為中文，故以 RFC 5987 的 `filename*` 提供 UTF-8 檔名，同時保留 ASCII 後備名供舊瀏覽器使用。

### `public/index.html`：UI

在上傳表單的 hint 區塊加入下載連結，純 `<a download>`，不需要 `app.js` 介入：

```html
<a href="/api/template.csv" class="btn btn-secondary" download>下載 CSV 範本</a>
```

hint 文字補上兩點說明：

- 範本內的範例列上傳時會自動略過
- 另存檔名建議使用實際禮品名稱（NAS 同步以 CSV 檔名作為禮品名稱，見 `src/sync.js`）

---

## 3. 測試

### `test/api.test.js`

- `GET /api/template.csv` 回應 200，內容以 BOM（`\uFEFF`）開頭，且包含四個中文欄位名稱
- **將該路由的回應內容直接餵入 `parseGiftcodeCsv`**，斷言 `rows` 為空陣列，且兩則「範本範例列，已略過」訊息都出現在 `errors` 中

  這一條同時驗證「範本格式解析得動」與「範例列會被擋掉」；範本一旦改壞，測試就會紅。
- 真實禮券碼（非範例碼）匯入不受影響，不會被誤殺

### `test/frontend-autofill.test.js`

新增一條結構檢查：`public/index.html` 中每個 `data-tab="X"` 都存在對應的 `<section id="tab-X">`。目前的頁籤切換靠字串對應，漏改不會有任何錯誤訊息，只會靜靜地切不過去；這條測試涵蓋本次的 `upload` → `settings` 改名，也保護日後的頁籤調整。

---

## 影響範圍

| 檔案 | 改動 |
|------|------|
| `public/index.html` | 搬動上傳表單至 `#tab-codes`；`#tab-upload` 改名 `#tab-settings`；內層 h2 改為「資料庫與備份」；新增範本下載連結與 hint 說明 |
| `public/app.js` | `'upload'` → `'settings'`（1 行）；上傳成功後刷新列表（2 行） |
| `src/csv.js` | 新增並 export `TEMPLATE_CSV`、`TEMPLATE_SAMPLE_CODES`；`parseGiftcodeCsv` 加入範例列略過 |
| `src/server.js` | 新增 `GET /api/template.csv` |
| `test/api.test.js` | 範本路由與範例列略過的測試 |
| `test/frontend-autofill.test.js` | 頁籤 id 對應完整性測試 |

不變動：資料庫結構、上傳 API（`POST /api/batches`）的請求與回應格式、NAS 同步邏輯、備份邏輯。
