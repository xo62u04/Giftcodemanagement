# 電子禮券管理後台

給內部員工使用的電子禮券（gift code）管理系統：上傳禮券 CSV 之後，
可以在後台標記哪個禮券碼已經被兌換、用在哪個活動上。

## 功能

- **上傳 CSV**：每次上傳建立一個批次，與資料庫重複的禮券碼自動略過並回報
- **禮券管理**：搜尋禮券碼、依狀態／批次／活動篩選、分頁瀏覽
- **標記兌換**：記錄使用的活動、經手人、備註與兌換時間；也可以取消兌換
- **批次兌換**：貼上多個禮券碼，一次標記到同一個活動
- **總覽**：未兌換／已兌換張數、各活動使用狀況
- **匯出 CSV**：套用目前篩選條件匯出（含 BOM，Excel 可直接開啟）

## CSV 格式

支援含標頭的 CSV，禮券碼欄位可命名為 `code`／`禮券碼`／`序號`／`兌換碼` 等，
可選欄位：面額（`面額`／`amount`…）、到期日（`到期日`／`expires_at`…）。
若無可辨識的標頭，會以第一欄作為禮券碼。範例：

```csv
code,面額,到期日
VIP-2026-0001,500,2026-12-31
VIP-2026-0002,500,2026-12-31
```

## 啟動

```bash
npm install
npm start          # http://localhost:3000
```

環境變數：

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `3000` | 伺服器埠號 |
| `DATA_DIR` | `./data` | SQLite 資料庫存放目錄 |

## 開發

```bash
npm run dev        # 檔案變更自動重啟
npm test           # API 測試（node:test，自建暫存資料庫）
```

## 技術架構

- 後端：Node.js + Express，資料庫使用 SQLite（better-sqlite3，WAL 模式）
- 前端：純 HTML/CSS/JS 單頁介面（`public/`），無建置步驟
- CSV 解析：csv-parse（支援 BOM、彈性欄數）

## API 摘要

| Method | 路徑 | 說明 |
|---|---|---|
| `GET` | `/api/stats` | 總覽統計 |
| `POST` | `/api/batches` | 上傳 CSV（multipart：`file`、`uploaded_by`、`note`） |
| `GET` | `/api/batches` | 上傳紀錄 |
| `GET` | `/api/codes` | 禮券列表（`q`、`status`、`batch_id`、`campaign_id`、`page`、`page_size`） |
| `POST` | `/api/codes/:id/redeem` | 標記兌換（`campaign`、`redeemed_by`、`note`） |
| `POST` | `/api/codes/:id/unredeem` | 取消兌換 |
| `POST` | `/api/codes/redeem-bulk` | 批次兌換（`codes[]`、`campaign`、`redeemed_by`、`note`） |
| `GET` | `/api/campaigns` | 活動列表（含已兌換張數） |
| `POST` | `/api/campaigns` | 新增活動 |
| `GET` | `/api/export.csv` | 匯出（支援與列表相同的篩選參數） |
