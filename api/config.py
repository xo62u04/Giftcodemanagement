# -*- coding: utf-8 -*-
"""連線與執行設定。

資料庫可切換：db_engine = "sqlite"（預設，試行）或 "mssql"（正式）。
兩者共用同一套 SQL——差異集中在 db.py 與 schema_sql.py，換引擎只改這一個設定值。

MSSQL 帳密不寫死、不進 git：優先讀 api/config.local.json，其次環境變數。
config.local.json 範例（自行建立、勿加入版控）：
{
  "db_engine": "sqlite",
  "sqlite_path": "D:\\\\EGift\\\\data\\\\giftcodes.db",
  "db_host": "172.22.112.2",
  "db_port": 1433,
  "db_name": "EGift",
  "db_user": "egift_app",
  "db_password": "********"
}

SQLite 注意：檔案必須放在「本機磁碟」。放 NAS／SMB 共享會因檔案鎖不可靠而有損毀風險。
"""
import json
import os
import pathlib

_local = {}
_p = pathlib.Path(__file__).with_name('config.local.json')
if _p.exists():
    try:
        _local = json.loads(_p.read_text(encoding='utf-8'))
    except Exception:
        _local = {}


def _get(key, env, default=''):
    v = _local.get(key)
    if v is None:
        v = os.environ.get(env, default)
    return v


# 'sqlite'（試行，預設）或 'mssql'（正式）
DB_ENGINE = str(_get('db_engine', 'EGIFT_DB_ENGINE', 'sqlite')).strip().lower()

# SQLite 檔案位置。預設與 Node 版同一個檔（<專案根>\data\giftcodes.db），
# 直接指過去即可沿用現有資料，不需搬遷。務必放本機磁碟，勿放 NAS。
SQLITE_PATH = str(_get('sqlite_path', 'EGIFT_SQLITE_PATH', '')) \
    or str(pathlib.Path(__file__).resolve().parent.parent / 'data' / 'giftcodes.db')

DB_HOST = str(_get('db_host', 'EGIFT_DB_HOST', '172.22.112.2'))
DB_PORT = int(_get('db_port', 'EGIFT_DB_PORT', 1433) or 1433)
DB_NAME = str(_get('db_name', 'EGIFT_DB_NAME', 'EGift'))
DB_USER = str(_get('db_user', 'EGIFT_DB_USER', ''))
DB_PASSWORD = str(_get('db_password', 'EGIFT_DB_PASSWORD', ''))

# ---- 使用者身分 ----
# 三層部署時 API 在獨立主機，行程自己的 Windows 帳號不等於使用者，
# 改由前端那台 IIS 驗完 AD 後、轉址時帶進 header（見 docs/python-architecture-deploy.md）。
REMOTE_USER_HEADER = str(_get('remote_user_header', 'EGIFT_REMOTE_USER_HEADER', 'x-remote-user')).lower()

# 只信任來自這些來源的身分 header（前端那台 IIS 的 IP）。留空＝不限制。
# 空字串代表本機開發；正式部署務必填入前端主機 IP，否則任何人都能直接打 API 冒用身分。
TRUSTED_PROXIES = [s.strip() for s in str(_get('trusted_proxies', 'EGIFT_TRUSTED_PROXIES', '')).split(',') if s.strip()]

# 前端靜態檔目錄（部署時前端在 IIS，本機開發用這個目錄自帶服務）
PUBLIC_DIR = str(pathlib.Path(__file__).resolve().parent.parent / 'public')
PORT = int(os.environ.get('PORT', os.environ.get('HTTP_PLATFORM_PORT', 8000)))
