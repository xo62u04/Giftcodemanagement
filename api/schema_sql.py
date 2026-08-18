# -*- coding: utf-8 -*-
"""MSSQL 結構定義（從空資料庫建立；欄位名沿用現行 snake_case，維持與前端相同的 JSON 契約）。

敏感個資（national_id / address / account_no）於此版明碼儲存——正式營運須加密與存取控管。
每一段都用 IF ... IS NULL 保護，可重複執行（冪等）。
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
