'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { parseGiftcodeCsv } = require('./csv');

db.exec(`
CREATE TABLE IF NOT EXISTS sync_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  mtime_ms REAL NOT NULL,
  size INTEGER NOT NULL,
  batch_id INTEGER REFERENCES batches(id),
  imported_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// 同步資料夾：後台介面設定（存在資料庫）優先，環境變數 SYNC_DIR 為備援
function getSyncDir() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sync_dir'").get();
  if (row && row.value.trim()) return row.value.trim();
  return (process.env.SYNC_DIR || '').trim();
}

function setSyncDir(dir) {
  const trimmed = String(dir || '').trim();
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('sync_dir', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(trimmed);
  return trimmed;
}

function listCsvFiles(dir) {
  const found = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.csv$/i.test(entry.name)) found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * 掃描 SYNC_DIR（NAS 掛載資料夾）內的 CSV 並匯入。
 * 已同步過且未變動（mtime + size 相同）的檔案會跳過；
 * 檔案有更新時重新解析，既有的禮券碼因 INSERT OR IGNORE 只會補進新的碼。
 */
function runSync() {
  const dir = getSyncDir();
  if (!dir) {
    const err = new Error('尚未設定 SYNC_DIR（NAS 同步資料夾）');
    err.status = 400;
    throw err;
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    const err = new Error(`同步資料夾不存在或無法讀取：${dir}（請確認 NAS 已掛載）`);
    err.status = 400;
    throw err;
  }

  const files = listCsvFiles(dir);
  const summary = {
    sync_dir: dir,
    scanned: files.length,
    imported_files: [],
    skipped_files: 0,
    new_codes: 0,
    duplicate_codes: 0,
    errors: [],
  };

  const findSynced = db.prepare('SELECT * FROM sync_files WHERE path = ?');
  const insertCode = db.prepare(
    'INSERT OR IGNORE INTO codes (code, batch_id, face_value, expires_at) VALUES (?, ?, ?, ?)'
  );

  for (const file of files) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    const stat = fs.statSync(file);
    const prev = findSynced.get(rel);
    if (prev && prev.mtime_ms === stat.mtimeMs && prev.size === stat.size) {
      summary.skipped_files++;
      continue;
    }

    let parsed;
    try {
      parsed = parseGiftcodeCsv(fs.readFileSync(file));
    } catch (err) {
      summary.errors.push(`${rel}：CSV 解析失敗（${err.message}）`);
      continue;
    }
    if (parsed.rows.length === 0) {
      summary.errors.push(`${rel}：檔案中找不到任何禮券碼`);
      continue;
    }

    // 優先用 CSV 內偵測到的禮品名稱欄位，否則退回檔名（去副檔名）
    const giftName = parsed.gift_name || path.basename(file, path.extname(file));

    const fileResult = db.transaction(() => {
      const batch = db.prepare(
        'INSERT INTO batches (filename, note, uploaded_by, gift_name) VALUES (?, ?, ?, ?)'
      ).run(rel, `NAS 同步（${dir}）`, 'NAS 同步', giftName);
      const batchId = batch.lastInsertRowid;

      let imported = 0;
      for (const row of parsed.rows) {
        if (insertCode.run(row.code, batchId, row.face_value, row.expires_at).changes === 1) imported++;
      }
      db.prepare(
        'UPDATE batches SET total_count = ?, imported_count = ?, duplicate_count = ? WHERE id = ?'
      ).run(parsed.rows.length, imported, parsed.rows.length - imported, batchId);

      db.prepare(`
        INSERT INTO sync_files (path, mtime_ms, size, batch_id, imported_count, duplicate_count, synced_at)
        VALUES (:path, :mtime, :size, :batch, :imported, :dup, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(path) DO UPDATE SET
          mtime_ms = :mtime, size = :size, batch_id = :batch,
          imported_count = :imported, duplicate_count = :dup,
          synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      `).run({
        path: rel, mtime: stat.mtimeMs, size: stat.size, batch: batchId,
        imported, dup: parsed.rows.length - imported,
      });

      return { imported, duplicates: parsed.rows.length - imported };
    })();

    summary.new_codes += fileResult.imported;
    summary.duplicate_codes += fileResult.duplicates;
    summary.imported_files.push({
      path: rel,
      imported: fileResult.imported,
      duplicates: fileResult.duplicates,
      warnings: parsed.errors,
    });
  }

  return summary;
}

function getSyncStatus() {
  const dir = getSyncDir();
  const files = db.prepare('SELECT * FROM sync_files ORDER BY synced_at DESC LIMIT 50').all();
  return {
    sync_dir: dir || null,
    configured: Boolean(dir),
    dir_exists: Boolean(dir) && fs.existsSync(dir),
    last_synced_at: files.length ? files[0].synced_at : null,
    files,
  };
}

module.exports = { runSync, getSyncStatus, setSyncDir };
