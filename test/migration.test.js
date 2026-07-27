'use strict';

// 舊資料庫（code UNIQUE、status 只允許 available/redeemed、gift_name 存在批次）
// 升級時應自動重建 codes 表並保留舊資料，gift_name 從批次補上。
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { applySchema } = require('../src/schema');

function buildOldDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      uploaded_by TEXT NOT NULL DEFAULT '',
      total_count INTEGER NOT NULL DEFAULT 0,
      imported_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      gift_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE codes (
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
  `);
  db.prepare("INSERT INTO batches (id, filename, gift_name) VALUES (1, 'old.csv', '舊禮品名稱')").run();
  db.prepare("INSERT INTO codes (code, batch_id, face_value, status) VALUES ('OLD-001', 1, '500', 'available')").run();
  db.prepare("INSERT INTO codes (code, batch_id, face_value, status) VALUES ('OLD-002', 1, '500', 'redeemed')").run();
  return db;
}

test('applySchema 重建舊 codes 表並新增欄位', () => {
  const db = buildOldDb();
  applySchema(db);
  const cols = db.prepare('PRAGMA table_info(codes)').all().map((c) => c.name);
  for (const c of ['redeem_url', 'gift_name', 'earmark_start', 'earmark_end']) {
    assert.ok(cols.includes(c), `codes 應含欄位 ${c}`);
  }
});

test('applySchema 保留舊資料，gift_name 從批次補上', () => {
  const db = buildOldDb();
  applySchema(db);
  const rows = db.prepare('SELECT code, gift_name, status FROM codes ORDER BY code').all();
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].code, 'OLD-001');
  assert.strictEqual(rows[0].gift_name, '舊禮品名稱');
  assert.strictEqual(rows[1].status, 'redeemed');
});

test('applySchema 之後 code 不再唯一、可接受 earmarked 狀態', () => {
  const db = buildOldDb();
  applySchema(db);
  // 相同 code 不同連結可並存
  db.prepare("INSERT INTO codes (code, batch_id, redeem_url) VALUES ('DUP', 1, 'http://a')").run();
  db.prepare("INSERT INTO codes (code, batch_id, redeem_url) VALUES ('DUP', 1, 'http://b')").run();
  // earmarked 狀態可寫入
  db.prepare("INSERT INTO codes (code, batch_id, redeem_url, status) VALUES ('E1', 1, 'http://c', 'earmarked')").run();
  const n = db.prepare("SELECT COUNT(*) n FROM codes WHERE code='DUP'").get().n;
  assert.strictEqual(n, 2);
});

test('applySchema 具冪等性：重覆執行不再重建', () => {
  const db = buildOldDb();
  applySchema(db);
  const before = db.prepare('SELECT COUNT(*) n FROM codes').get().n;
  applySchema(db);
  const after = db.prepare('SELECT COUNT(*) n FROM codes').get().n;
  assert.strictEqual(before, after);
});
