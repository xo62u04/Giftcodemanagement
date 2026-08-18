# -*- coding: utf-8 -*-
"""連線與執行設定。

MSSQL 帳密不寫死、不進 git：優先讀 api/config.local.json，其次環境變數。
config.local.json 範例（自行建立、勿加入版控）：
{
  "db_host": "172.22.112.2",
  "db_port": 1433,
  "db_name": "EGift",
  "db_user": "egift_app",
  "db_password": "********"
}
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


DB_HOST = str(_get('db_host', 'EGIFT_DB_HOST', '172.22.112.2'))
DB_PORT = int(_get('db_port', 'EGIFT_DB_PORT', 1433) or 1433)
DB_NAME = str(_get('db_name', 'EGIFT_DB_NAME', 'EGift'))
DB_USER = str(_get('db_user', 'EGIFT_DB_USER', ''))
DB_PASSWORD = str(_get('db_password', 'EGIFT_DB_PASSWORD', ''))

# 前端靜態檔目錄（部署時前端在 IIS，本機開發用這個目錄自帶服務）
PUBLIC_DIR = str(pathlib.Path(__file__).resolve().parent.parent / 'public')
PORT = int(os.environ.get('PORT', os.environ.get('HTTP_PLATFORM_PORT', 8000)))
