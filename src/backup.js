'use strict';

const fs = require('fs');
const path = require('path');
const { Router } = require('express');
const db = require('./db');

const DATA_DIR = path.dirname(db.name); // 從 db 取得實際 DATA_DIR，保持一致
const DB_PATH = db.name;
const STARTUP_CONFIG_FILE = path.join(__dirname, '..', 'startup-config.json');
const SETTING_KEY = 'backup_dir';
const MAX_BACKUPS = 30;

const router = Router();

function getBackupDir() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY);
  if (row && row.value.trim()) return row.value.trim();
  return (process.env.BACKUP_DIR || '').trim();
}

function setBackupDir(dir) {
  const trimmed = String(dir || '').trim();
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(SETTING_KEY, trimmed);
  // 同步寫入 startup-config.json（db.js 開 DB 前讀取，避免循環依賴）
  try {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(STARTUP_CONFIG_FILE, 'utf8')); } catch { /* ok */ }
    cfg.backup_dir = trimmed;
    fs.writeFileSync(STARTUP_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch { /* 非致命 */ }
  return trimmed;
}

function listBackups(dir) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^giftcodes-\d{8}-\d{6}\.db$/i.test(name))
    .sort()
    .reverse();
}

function getBackupStatus() {
  const dir = getBackupDir();
  return {
    backup_dir: dir || null,
    configured: Boolean(dir),
    dir_exists: Boolean(dir) && fs.existsSync(dir) && fs.statSync(dir).isDirectory(),
    files: listBackups(dir),
  };
}

function backupFilename(date = new Date()) {
  const stamp = date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
  return `giftcodes-${stamp}.db`;
}

function pruneBackups(dir) {
  const files = listBackups(dir);
  for (const file of files.slice(MAX_BACKUPS)) {
    fs.rmSync(path.join(dir, file), { force: true });
  }
}

function tryBackup() {
  const dir = getBackupDir();
  if (!dir) {
    const err = new Error('Backup directory is not configured');
    err.status = 400;
    throw err;
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    const err = new Error(`Backup directory does not exist: ${dir}`);
    err.status = 400;
    throw err;
  }

  const dest = path.join(dir, backupFilename());
  db.pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB_PATH, dest);
  pruneBackups(dir);
  return { ok: true, dest, files: listBackups(dir) };
}

function scheduleDailyBackup() {
  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    const delay = Math.max(1000, next.getTime() - now.getTime());
    setTimeout(() => {
      try {
        tryBackup();
      } catch (err) {
        console.error(`[backup] ${err.message}`);
      } finally {
        scheduleNext();
      }
    }, delay).unref();
  };
  scheduleNext();
}

router.get('/backup/config', (req, res) => {
  res.json(getBackupStatus());
});

router.put('/backup/config', (req, res) => {
  setBackupDir(req.body.backup_dir);
  res.json(getBackupStatus());
});

router.post('/backup', (req, res) => {
  try {
    res.json(tryBackup());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 伺服器啟動時呼叫：把 DB 內的 backup_dir 同步寫入 startup-config.json
// 確保下次啟動（可能無 DB）能從 startup-config.json 讀到備份路徑
function syncBackupConfigFile() {
  try {
    const dir = getBackupDir();
    if (!dir) return;
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(STARTUP_CONFIG_FILE, 'utf8')); } catch { /* ok */ }
    if (cfg.backup_dir === dir) return; // 已同步，不需重寫
    cfg.backup_dir = dir;
    fs.writeFileSync(STARTUP_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    console.log(`[backup] startup-config.json backup_dir 已同步（${dir}）`);
  } catch { /* 非致命 */ }
}

module.exports = { router, scheduleDailyBackup, tryBackup, getBackupStatus, setBackupDir, syncBackupConfigFile };
