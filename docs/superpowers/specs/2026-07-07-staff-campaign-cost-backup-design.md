# 設計文件：同仁管理、活動成本統計、DB 備份

日期：2026-07-07  
分支：claude/egift-voucher-admin-r7st54

## 背景

電子禮券管理後台目前已支援 CSV 匯入、禮券兌換、NAS 同步。本次新增四個功能群：
1. 部門同仁管理（含工號）
2. Windows 登入帳號自動偵測，對應同仁資料
3. 活動預算 + 禮品成本統計
4. DB 每日自動備份

使用情境：部門不到 10 人，每人各自在自己 Windows 電腦執行 `node server.js`，`DATA_DIR` 指向 NAS 共用路徑，所有人共用同一個 SQLite DB 檔案（不會同時寫入）。

---

## 1. 資料庫結構

### 新增 `staff` 表

```sql
CREATE TABLE IF NOT EXISTS staff (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  department       TEXT NOT NULL DEFAULT '',
  employee_id      TEXT NOT NULL DEFAULT '',   -- 原編，例 A99393
  windows_username TEXT NOT NULL DEFAULT '',   -- Windows 登入帳號
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

### 擴充 `campaigns` 表

以 `ALTER TABLE` 新增欄位（相容現有資料）：

```sql
ALTER TABLE campaigns ADD COLUMN planned_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN budget        REAL    NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN start_date    TEXT    NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN end_date      TEXT    NOT NULL DEFAULT '';
```

- `planned_count`：預計發送禮券張數
- `budget`：本活動預算金額（元）
- `start_date`：活動開始日期（格式 YYYY-MM-DD，可留空）
- `end_date`：活動結束日期（格式 YYYY-MM-DD，可留空）

### 備份設定

沿用現有 `settings` 表（key/value），新增：
- `backup_dir`：備份目標資料夾路徑（可為 NAS 子目錄）

---

## 2. 成本計算

`codes.face_value` 為文字欄（如 `"200"`, `"$200"`, `"200元"`, `"NT$200"`）。  
新增 helper function `parseFaceValue(str) → number | null`，以 regex 抽出第一組數字（含小數），解析失敗回傳 `null`。

活動已發成本 = `SUM(parseFaceValue(face_value))` for all redeemed codes under the campaign.  
由於 SQLite 不執行 JS，改在 Node.js 層查詢後計算，或利用 `CAST(REPLACE(...) AS REAL)` 做初步轉換。

實際做法：在 `GET /api/campaigns` 的回應中，用 JS 對每個活動的 codes 做面額加總（批次 query + 分組），避免複雜 SQL。

---

## 3. 後端 API

### 同仁管理

| 方法   | 路徑              | 說明         |
|--------|-------------------|--------------|
| GET    | /api/staff        | 列出所有同仁 |
| POST   | /api/staff        | 新增同仁     |
| PUT    | /api/staff/:id    | 編輯同仁     |
| DELETE | /api/staff/:id    | 刪除同仁     |

POST/PUT body：`{ name, department, employee_id, windows_username }`

### 目前使用者偵測

| 方法 | 路徑              | 說明                                           |
|------|-------------------|------------------------------------------------|
| GET  | /api/current-user | 回傳 `os.userInfo().username`，並比對 staff 表 |

回應：
```json
{
  "windows_username": "A99393",
  "matched": true,
  "staff": { "id": 1, "name": "王小明", "department": "數位規劃處", "employee_id": "A99393" }
}
```

### 活動擴充

| 方法 | 路徑                | 說明                                          |
|------|---------------------|-----------------------------------------------|
| GET  | /api/campaigns      | 回傳加上 `cost`（已發成本）、`remaining`（剩餘預算）|
| POST | /api/campaigns      | 新增，body 加入 `planned_count`、`budget`、`start_date`、`end_date` |
| PUT  | /api/campaigns/:id  | 編輯活動（名稱、預計張數、預算、起迄時間）    |

### DB 備份

| 方法 | 路徑               | 說明                        |
|------|--------------------|-----------------------------|
| GET  | /api/backup/config | 取得備份路徑與最近備份清單  |
| PUT  | /api/backup/config | 設定備份資料夾路徑          |
| POST | /api/backup        | 手動立即備份                |

備份邏輯：
- Server 啟動時執行一次
- 每天 00:00 自動執行（`setInterval` 對齊下一個午夜）
- 備份檔名：`giftcodes-backup-YYYY-MM-DD.db`
- 保留最近 30 份，超過自動刪除

---

## 4. 前端介面

### Header 頂部列

右上角新增使用者顯示：
```
王小明（A99393）   或   未知帳號（win-username）
```
頁面載入時呼叫 `/api/current-user`，自動帶入。

### 新增「同仁管理」分頁

- 表格：姓名、部門、工號、Windows 帳號、操作（編輯／刪除）
- 「新增同仁」按鈕 → dialog 表單
- 編輯同樣開 dialog

### 總覽分頁 — 活動表格擴充

| 活動名稱 | 起迄時間 | 預計張數 | 已發張數 | 預算 | 已發成本 | 剩餘預算 |
|---------|---------|---------|---------|-----|---------|---------|
| 週年慶  | 2026-07-01 ~ 2026-07-31 | 100 | 67 | $20,000 | $13,400 | $6,600 |

- 起迄時間任一為空則顯示「–」
- 剩餘預算為負數時，整列顯示紅色警示樣式
- 活動名稱旁加「編輯」小按鈕（開 dialog 可修改名稱、預計張數、預算、起迄時間）

### 上傳 CSV — 成本摘要

上傳完成後的結果框新增：
```
本批禮券面額合計：$13,400 元（67 張有面額、3 張無面額）
```

### 上傳分頁 — 備份設定區塊

在 NAS 同步區塊下方新增「DB 備份」區塊：
- 備份資料夾路徑輸入欄
- 顯示最近備份清單（最多 5 筆，含日期、檔名）
- 「立即備份」按鈕

### 自動帶入使用者

所有「上傳人」「經手人」input 欄位，頁面載入後自動填入目前偵測到的使用者姓名。若找不到對應同仁則填 Windows 帳號。

---

## 5. 錯誤處理與邊界條件

- `face_value` 無法解析為數字 → 該張不計入成本，但標記「X 張無面額」
- 備份資料夾不存在 → API 回傳 400，UI 顯示警告
- Windows 帳號未在 staff 表中 → 帶入原始 windows_username，不阻斷操作
- 同仁刪除時，已上傳的 batch 的 `uploaded_by` 是文字欄，不受影響

---

## 6. 不在本次範圍

- 權限控制／登入驗證
- 同仁角色區分（管理員 vs 一般）
- DB 衝突解決（多人同時寫入）
- 活動刪除功能
