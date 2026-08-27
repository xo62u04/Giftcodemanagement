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

## 三層部署（前端 / API / DB 各一台）
```
同仁瀏覽器
    │ HTTP（只跟 .4 講話 → 同源，不需要 CORS）
    ▼
.4  IIS ── 驗 AD（Windows 驗證）
    ├── 直接發靜態檔 public\（index.html / app.js / style.css）
    └── URL Rewrite + ARR：/api/*  ──轉址並帶上身分 header──►
                                                              .5  uvicorn + FastAPI
                                                                  └── DB
                                                                      現在：本機 SQLite（.5 上）
                                                                      之後：MSSQL @ .2
```
**靜態檔由 IIS 發，不要由 FastAPI 發**——.4 本來就要裝 IIS 做轉址，靜態檔讓它直接發最省事。
`app.py` 的 `/` 與 `/{path:path}` 只給本機開發用。注意這只是「誰發網頁檔案」的分工，
**資料一律還是打 .5 的 FastAPI**，前端沒有 API 就沒有任何資料。

### .4 的轉址規則（需先裝 ARR 並勾選 Enable proxy；只有 URL Rewrite 模組不能跨機轉發）
```xml
<rule name="api-to-api-host" stopProcessing="true">
  <match url="^api/(.*)" />
  <action type="Rewrite" url="http://172.22.112.5:8000/api/{R:1}" />
  <serverVariables>
    <set name="HTTP_X_REMOTE_USER" value="{LOGON_USER}" />
  </serverVariables>
</rule>
```
`HTTP_X_REMOTE_USER` 需要先在 IIS 的 URL Rewrite「允許的伺服器變數」清單中加入才能設定。

### 身分怎麼傳（重要）
API 獨立一台之後，**行程自己的 Windows 帳號對所有人都一樣**，不能當身分用。流程是：

1. .4 的 IIS 驗 AD，拿到 `LOGON_USER`
2. 轉址時寫進 `X-Remote-User` header（上面的規則）
3. API 讀 header，`DOMAIN\user` 與 `user@domain` 都會被正規化成純帳號
4. 前端呼叫 `/api/current-user` 得知自己是誰，後續動作沿用同一個身分

**`trusted_proxies` 一定要填 .4 的 IP**。API 只在來源相符時才採信 header——否則任何人都能
繞過前端直接打 .5 並自稱是別人。設了信任來源卻收不到 header 時，身分判為「未識別」而**不會**
退回行程帳號（避免所有人被誤認成 .5 上的服務帳號、拿到管理員權限）。

`/api/current-user` 會回 `identity_source` 供維運判斷：`header`（正式三層）／
`process`（本機開發）／`none`（該有卻沒拿到，代表轉址規則或信任清單設錯）。

`trusted_proxies` 留空＝本機開發模式，退回行程帳號，方便一台機器跑完整套。

### 還要開的
- .4 → .5 的 API 埠（防火牆）
- .5 上跑服務的帳號需有 SQLite 資料夾寫入權（WAL 會另外產生 `-wal` / `-shm`）
- NAS 同步在 .5 執行，.5 需能讀 `\\172.22.91.100\...`
- 之後換 MSSQL：.5 → .2 的 1433

## 資料庫：先 SQLite，之後換 MSSQL
`api\config.local.json` 的 **`db_engine`** 決定用哪個引擎，其餘程式一行都不用改：

| | `sqlite`（試行，預設） | `mssql`（正式） |
|---|---|---|
| 資料位置 | server 本機的 `.db` 檔 | MSSQL 172.22.112.2 |
| 何時用 | 現在——不必等 DBA 開帳號就能上線試行 | 之後正式營運 |
| 切換方式 | — | 把 `db_engine` 改成 `mssql`、填帳密，重啟 |

方言差異全部收在 `db.py`：佔位符（`?` ↔ `%s`）、取新增 id（`lastrowid` ↔ `OUTPUT INSERTED.id`）、
DDL（`schema_sql.SQLITE_STATEMENTS` ↔ `STATEMENTS`）。**新增查詢時一律寫 `?`、取 id 一律用
`db.insert_returning_id()`**，不要直接寫死任一方言，否則之後換引擎會漏。

SQLite 的兩個前提：

1. **檔案放本機磁碟，不要放 NAS**。SQLite 走 SMB 共享的檔案鎖不可靠，多人同時寫有損毀風險。
   （Node 版目前把 DB 放在 `\\172.22.91.100\...\E-gift\DB`，搬到 server 本機正好修掉這個隱患。）
2. **IIS 應用程式集區的身分需要該資料夾的寫入權限**（WAL 模式會另外產生 `-wal` / `-shm` 檔）。

`sqlite_path` 留空時預設指向 `<專案根>\data\giftcodes.db`，也就是 Node 版正在用的那個檔——
結構逐欄對齊，資料不必搬遷。若是尚未升級的舊 DB（`codes` 還沒有 `redeem_url`），
啟動時會擋下並提示「先用 Node 版開一次完成升級」；那段搬遷邏輯留在 Node 版 `src/schema.js`，
不在 Python 這側重寫一份。

## 建置（在「有對外網路」的機器上做一次）
```powershell
.\build\setup_runtime.ps1   # 下載可攜式 Python 3.11、安裝套件到 runtime\
```
完成後，`runtime\` 內含可攜式 Python 與全部套件；整個專案資料夾即為可部署包。

## 部署到 IIS 測試機
1. 目標機安裝 **HttpPlatformHandler**（IIS 官方模組，一個小 MSI；非 Python 套件）。
2. 複製整個專案資料夾（含 `runtime\`）到測試機，設為 IIS 站台的實體路徑。
3. 建立 `api\config.local.json`（照 `.example` 填）。試行階段 `db_engine` 填 `sqlite` 即可，不必等 MSSQL。
4. 首次啟動會自動建表（`db.ensure_schema`），既有 DB 則為 no-op。
5. 瀏覽器開站台首頁即可；健康檢查：`/api/health`（會回報目前引擎與連線狀態）。

> 目標機**不需**安裝 Python 或任何 Python 套件——全部在 `runtime\` 內。唯一需要的是 IIS 的 HttpPlatformHandler。

## 進度
- ✅ 純邏輯（CSV 解析、日期、三態/圈存）已於本機以 Python 驗證，與 Node 版一致。
- ✅ 核心 API：健康檢查、目前使用者/權限、範本下載、總覽統計、上傳批次、禮券列表、活動、匯出 CSV、匯出簽收表。
- ✅ 打包：pymssql 等套件已可打包（自帶原生元件、免裝 ODBC）；IIS `web.config`、建置腳本就緒。
- ✅ 資料庫可切換 sqlite / mssql；SQLite 路徑已用 Node 版寫出的 DB 實測讀寫皆正常。
- ⏳ 待補（後續階段）：標記/取消/批次兌換、單張編輯、刪除單張/整批、同仁 CRUD、
  NAS 同步、每日備份、圈存警告；另有 Node 版 8/21～8/24 新增的自訂欄位、多條件篩選、
  依欄位匯出尚未移植。
- ⏳ 待你提供：測試機規格與 IIS HttpPlatformHandler；MSSQL 帳密可等正式階段再給。

## 安全提醒
簽收表的 `身份證字號 / 戶籍地址 / 期貨帳號` 為敏感個資，目前明碼儲存；正式營運前應於 MSSQL 端
加上加密與存取控管。
