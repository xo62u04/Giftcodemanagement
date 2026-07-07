'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'giftcodes.db');
const BACKUP_CONFIG_FILE = path.join(DATA_DIR, 'backup-config.json');

// 本機無 DB 時，嘗試從 NAS 備份還原
// 備份路徑來源優先順序：backup-config.json → BACKUP_DIR 環境變數
if (!fs.existsSync(DB_FILE)) {
  let backupDir = '';
  try {
    if (fs.existsSync(BACKUP_CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(BACKUP_CONFIG_FILE, 'utf8'));
      backupDir = (cfg.backup_dir || '').trim();
    }
    if (!backupDir) backupDir = (process.env.BACKUP_DIR || '').trim();

    if (backupDir) {
      console.log(`[DB] 本機無資料庫，嘗試從備份還原：${backupDir}`);
      if (fs.existsSync(backupDir)) {
        const latest = fs.readdirSync(backupDir)
          .filter((n) => /^giftcodes-\d{8}-\d{6}\.db$/i.test(n))
          .sort()
          .reverse()[0];
        if (latest) {
          fs.copyFileSync(path.join(backupDir, latest), DB_FILE);
          console.log(`[DB] 已從備份還原：${latest}`);
        } else {
          console.log('[DB] 備份資料夾內無備份檔案，將建立新資料庫');
        }
      } else {
        console.log(`[DB] 備份資料夾無法讀取（${backupDir}），將建立新資料庫`);
      }
    } else {
      console.log('[DB] 未設定備份路徑，將建立新資料庫');
    }
  } catch (err) {
    console.error(`[DB] 嘗試還原失敗（${err.message}），將建立新資料庫`);
  }
}

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT NOT NULL DEFAULT '',
  total_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  planned_count INTEGER NOT NULL DEFAULT 0,
  budget REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  face_value TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','redeemed')),
  campaign_id INTEGER REFERENCES campaigns(id),
  redeemed_by TEXT NOT NULL DEFAULT '',
  redeemed_note TEXT NOT NULL DEFAULT '',
  redeemed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  employee_id TEXT NOT NULL DEFAULT '',
  windows_username TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_codes_status ON codes(status);
CREATE INDEX IF NOT EXISTS idx_codes_batch ON codes(batch_id);
CREATE INDEX IF NOT EXISTS idx_codes_campaign ON codes(campaign_id);
`);

const batchCols = db.prepare('PRAGMA table_info(batches)').all().map((c) => c.name);
if (!batchCols.includes('gift_name')) {
  db.exec("ALTER TABLE batches ADD COLUMN gift_name TEXT NOT NULL DEFAULT ''");
}

const campaignCols = db.prepare('PRAGMA table_info(campaigns)').all().map((c) => c.name);
if (!campaignCols.includes('planned_count')) {
  db.exec('ALTER TABLE campaigns ADD COLUMN planned_count INTEGER NOT NULL DEFAULT 0');
}
if (!campaignCols.includes('budget')) {
  db.exec('ALTER TABLE campaigns ADD COLUMN budget REAL NOT NULL DEFAULT 0');
}
if (!campaignCols.includes('start_date')) {
  db.exec("ALTER TABLE campaigns ADD COLUMN start_date TEXT NOT NULL DEFAULT ''");
}
if (!campaignCols.includes('end_date')) {
  db.exec("ALTER TABLE campaigns ADD COLUMN end_date TEXT NOT NULL DEFAULT ''");
}

module.exports = db;
