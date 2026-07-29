'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// startup-config.json（project root）是正式啟動時路徑設定的唯一來源，優先於環境變數。
// 測試可用 STARTUP_CONFIG_FILE 環境變數指向不存在的檔案，繞開正式設定、
// 讓 DATA_DIR 環境變數生效，避免測試誤寫正式資料庫。
const STARTUP_CONFIG_FILE = (process.env.STARTUP_CONFIG_FILE || '').trim()
  || path.join(__dirname, '..', 'startup-config.json');

function readStartupCfg() {
  try {
    if (fs.existsSync(STARTUP_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(STARTUP_CONFIG_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

const _startupCfg = readStartupCfg();
const DATA_DIR = (_startupCfg.data_dir || '').trim()
  || process.env.DATA_DIR
  || path.join(__dirname, '..', 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'giftcodes.db');

// 本機無 DB 時，嘗試從 NAS 備份還原
// 備份路徑來源：startup-config.json → BACKUP_DIR 環境變數
if (!fs.existsSync(DB_FILE)) {
  const backupDir = (_startupCfg.backup_dir || '').trim() || (process.env.BACKUP_DIR || '').trim();
  if (backupDir) {
    console.log(`[DB] 本機無資料庫，嘗試從備份還原：${backupDir}`);
    try {
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
    } catch (err) {
      console.error(`[DB] 嘗試還原失敗（${err.message}），將建立新資料庫`);
    }
  } else {
    console.log('[DB] 未設定備份路徑，將建立新資料庫');
  }
}

const { applySchema } = require('./schema');

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// CSV 來源的日期格式不一致（2026/8/1、2026-08-01、20260801 都有），
// SQLite 的 date() 只吃零填補的 YYYY-MM-DD，其餘一律回 NULL，比較就會失效。
// 註冊一個 SQL 函式統一正規化，無法解析時回空字串（視同沒有期限）。
const { normalizeDate } = require('./dates');
db.function('norm_date', { deterministic: true }, (value) => normalizeDate(value));

applySchema(db);

module.exports = db;
