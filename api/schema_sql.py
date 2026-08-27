# -*- coding: utf-8 -*-
"""結構定義（欄位名沿用現行 snake_case，維持與前端相同的 JSON 契約）。

兩套 DDL，由 db.py 依 config.DB_ENGINE 挑一套：
  STATEMENTS         MSSQL（正式）——每段用 IF ... IS NULL 保護
  SQLITE_STATEMENTS  SQLite（試行）——每段 CREATE ... IF NOT EXISTS
兩者都是冪等的，可重複執行。

SQLite 這套刻意與 Node 版 src/schema.js 逐欄對齊，因此可以直接指向 Node 版正在用的
data\\giftcodes.db，既有資料不必搬遷；對既有 DB 執行時全部是 no-op。
但本檔不做 Node 版那些舊結構的升級（codes 重建等）——若是尚未升級的舊 DB，請先用 Node 版開一次。

敏感個資（national_id / address / account_no）於此版明碼儲存——正式營運須加密與存取控管。
"""

SIGNOFF_COLS = [
    'send_method', 'recipient_mobile', 'recipient_email', 'sent_at', 'send_status',
    'status_updated_at', 'account_no', 'recipient_name', 'national_id', 'address', 'unit', 'sales_rep',
]

_signoff_ddl = ",\n  ".join("%s NVARCHAR(200) NOT NULL DEFAULT ''" % c for c in SIGNOFF_COLS)

STATEMENTS = [
    """
IF OBJECT_ID(N'dbo.batches', N'U') IS NULL
CREATE TABLE dbo.batches (
  id INT IDENTITY(1,1) PRIMARY KEY,
  filename NVARCHAR(400) NOT NULL,
  note NVARCHAR(400) NOT NULL DEFAULT '',
  uploaded_by NVARCHAR(100) NOT NULL DEFAULT '',
  total_count INT NOT NULL DEFAULT 0,
  imported_count INT NOT NULL DEFAULT 0,
  duplicate_count INT NOT NULL DEFAULT 0,
  gift_name NVARCHAR(200) NOT NULL DEFAULT '',
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
)""",
    """
IF OBJECT_ID(N'dbo.campaigns', N'U') IS NULL
CREATE TABLE dbo.campaigns (
  id INT IDENTITY(1,1) PRIMARY KEY,
  name NVARCHAR(200) NOT NULL UNIQUE,
  planned_count INT NOT NULL DEFAULT 0,
  budget DECIMAL(18,2) NOT NULL DEFAULT 0,
  start_date NVARCHAR(20) NOT NULL DEFAULT '',
  end_date NVARCHAR(20) NOT NULL DEFAULT '',
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
)""",
    """
IF OBJECT_ID(N'dbo.codes', N'U') IS NULL
CREATE TABLE dbo.codes (
  id INT IDENTITY(1,1) PRIMARY KEY,
  code NVARCHAR(100) NOT NULL,
  batch_id INT NOT NULL REFERENCES dbo.batches(id),
  gift_name NVARCHAR(200) NOT NULL DEFAULT '',
  redeem_url NVARCHAR(400) NULL,
  face_value NVARCHAR(50) NOT NULL DEFAULT '',
  expires_at NVARCHAR(20) NOT NULL DEFAULT '',
  status VARCHAR(12) NOT NULL DEFAULT 'available',
  campaign_id INT NULL REFERENCES dbo.campaigns(id),
  redeemed_by NVARCHAR(100) NOT NULL DEFAULT '',
  redeemed_note NVARCHAR(400) NOT NULL DEFAULT '',
  redeemed_at DATETIME2 NULL,
  earmark_start NVARCHAR(20) NOT NULL DEFAULT '',
  earmark_end NVARCHAR(20) NOT NULL DEFAULT '',
  %s,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
)""" % _signoff_ddl,
    """
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='ux_codes_redeem_url' AND object_id=OBJECT_ID(N'dbo.codes'))
CREATE UNIQUE INDEX ux_codes_redeem_url ON dbo.codes(redeem_url) WHERE redeem_url IS NOT NULL""",
    """
IF OBJECT_ID(N'dbo.staff', N'U') IS NULL
CREATE TABLE dbo.staff (
  id INT IDENTITY(1,1) PRIMARY KEY,
  name NVARCHAR(100) NOT NULL,
  department NVARCHAR(100) NOT NULL DEFAULT '',
  employee_id NVARCHAR(50) NOT NULL DEFAULT '',
  windows_username NVARCHAR(100) NOT NULL DEFAULT '',
  is_admin BIT NOT NULL DEFAULT 0,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
)""",
    """
IF OBJECT_ID(N'dbo.settings', N'U') IS NULL
CREATE TABLE dbo.settings (
  [key] NVARCHAR(100) PRIMARY KEY,
  value NVARCHAR(MAX) NOT NULL
)""",
    """
IF OBJECT_ID(N'dbo.sync_files', N'U') IS NULL
CREATE TABLE dbo.sync_files (
  id INT IDENTITY(1,1) PRIMARY KEY,
  path NVARCHAR(500) NOT NULL UNIQUE,
  mtime_ms FLOAT NOT NULL,
  size BIGINT NOT NULL,
  batch_id INT NULL REFERENCES dbo.batches(id),
  imported_count INT NOT NULL DEFAULT 0,
  duplicate_count INT NOT NULL DEFAULT 0,
  synced_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
)""",
]


# ---------------------------------------------------------------------------
# SQLite（試行）
# ---------------------------------------------------------------------------
# 逐欄對齊 Node 版 src/schema.js。Node 版是「先建表、再 ALTER 補欄」，這裡直接一次建齊，
# 欄位集合相同（順序不同不影響——查詢一律具名）。時間欄沿用 Node 的 ISO 字串格式。
_NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
_sqlite_signoff_ddl = ",\n  ".join("%s TEXT NOT NULL DEFAULT ''" % c for c in SIGNOFF_COLS)

SQLITE_STATEMENTS = [
    """
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT NOT NULL DEFAULT '',
  total_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  gift_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT %s
)""" % _NOW,
    """
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  planned_count INTEGER NOT NULL DEFAULT 0,
  budget REAL NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT %s
)""" % _NOW,
    """
CREATE TABLE IF NOT EXISTS codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  gift_name TEXT NOT NULL DEFAULT '',
  redeem_url TEXT,
  face_value TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','redeemed','earmarked')),
  campaign_id INTEGER REFERENCES campaigns(id),
  redeemed_by TEXT NOT NULL DEFAULT '',
  redeemed_note TEXT NOT NULL DEFAULT '',
  redeemed_at TEXT,
  earmark_start TEXT NOT NULL DEFAULT '',
  earmark_end TEXT NOT NULL DEFAULT '',
  %s,
  created_at TEXT NOT NULL DEFAULT %s
)""" % (_sqlite_signoff_ddl, _NOW),
    """
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  employee_id TEXT NOT NULL DEFAULT '',
  windows_username TEXT NOT NULL DEFAULT '',
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT %s
)""" % _NOW,
    """
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)""",
    """
CREATE TABLE IF NOT EXISTS user_prefs (
  windows_username TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (windows_username, key)
)""",
    """
CREATE TABLE IF NOT EXISTS sync_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  mtime_ms REAL NOT NULL,
  size INTEGER NOT NULL,
  batch_id INTEGER REFERENCES batches(id),
  imported_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL DEFAULT %s
)""" % _NOW,
    "CREATE INDEX IF NOT EXISTS idx_codes_status ON codes(status)",
    "CREATE INDEX IF NOT EXISTS idx_codes_batch ON codes(batch_id)",
    "CREATE INDEX IF NOT EXISTS idx_codes_campaign ON codes(campaign_id)",
    # 索引名沿用 Node 版，對既有 DB 才會是 no-op
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_codes_redeem_url ON codes(redeem_url)",
]
