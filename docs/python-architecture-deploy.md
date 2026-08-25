# 電子禮券後台 — Python 正式版架構與部署

正式版採 **Client-Server**：前端（`public/`）與 API 由 **IIS** 承載，後端改寫為 **Python/FastAPI**，
資料庫改用 **MSSQL @ 172.22.112.2**。**Python 與所有套件都打包在專案內**，目標機不需安裝 Python、
也不需 pip install。

## 架構
```
瀏覽器（同仁，內網）
        │ HTTP
        ▼
IIS（測試機）  ── HttpPlatformHandler ──►  打包在專案內的 Python 執行 api\app.py（FastAPI + uvicorn）
        │                                         │ pymssql（自帶原生元件，免裝 ODBC）
        └── 前端 public\ 由 FastAPI 服務          ▼
                                            MSSQL  172.22.112.2  資料庫 EGift
```

## 專案結構（Python 部分）
```
api/
  app.py            FastAPI 進入點（IIS 用此啟動）＋核心 API；自動 API 文件在 /api/docs
  config.py         連線設定（讀 config.local.json / 環境變數）
  config.local.json MSSQL 帳密（各機自建、不進版控；範例見 .example）
  db.py             pymssql 連線與結構初始化
  schema_sql.py     MSSQL 建表 DDL（從空資料庫建立）
  csv_parse.py      CSV 解析（與 Node 版行為一致，已本機驗證）
  importer.py       逐列匯入
  dates.py / status.py  日期正規化、三態/圈存判定
  requirements.txt  相依套件版本
runtime/            打包產物（不進版控）：可攜式 Python 3.11 + site-packages
web.config          IIS HttpPlatformHandler 設定
build/setup_runtime.ps1  在有網路的建置機產生 runtime\
```

## 建置（在「有對外網路」的機器上做一次）
```powershell
.\build\setup_runtime.ps1   # 下載可攜式 Python 3.11、安裝套件到 runtime\
```
完成後，`runtime\` 內含可攜式 Python 與全部套件；整個專案資料夾即為可部署包。

## 部署到 IIS 測試機
1. 目標機安裝 **HttpPlatformHandler**（IIS 官方模組，一個小 MSI；非 Python 套件）。
2. 複製整個專案資料夾（含 `runtime\`）到測試機，設為 IIS 站台的實體路徑。
3. 建立 `api\config.local.json`（照 `.example` 填 MSSQL 帳密）。
4. 首次啟動會自動在 MSSQL 建表（`db.ensure_schema`）。
5. 瀏覽器開站台首頁即可；健康檢查：`/api/health`（會回報 DB 連線狀態）。

> 目標機**不需**安裝 Python 或任何 Python 套件——全部在 `runtime\` 內。唯一需要的是 IIS 的 HttpPlatformHandler。

## 進度
- ✅ 純邏輯（CSV 解析、日期、三態/圈存）已於本機以 Python 驗證，與 Node 版一致。
- ✅ 核心 API：健康檢查、目前使用者/權限、範本下載、總覽統計、上傳批次、禮券列表、活動、匯出 CSV、匯出簽收表。
- ✅ 打包：pymssql 等套件已可打包（自帶原生元件、免裝 ODBC）；IIS `web.config`、建置腳本就緒。
- ⏳ 待補（後續階段，需連上 MSSQL 驗證）：標記/取消/批次兌換、單張編輯、刪除單張/整批、
  同仁 CRUD、NAS 同步、每日備份、圈存警告。
- ⏳ 待你提供：MSSQL 連線帳密、確認測試機能連 172.22.112.2、IIS 已裝 HttpPlatformHandler。

## 安全提醒
簽收表的 `身份證字號 / 戶籍地址 / 期貨帳號` 為敏感個資，目前明碼儲存；正式營運前應於 MSSQL 端
加上加密與存取控管。
