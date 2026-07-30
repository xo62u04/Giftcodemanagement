'use strict';

// 資料庫結構與版本升級。抽成獨立函式，讓 migration 能對任意 DB handle 測試。
// db.js 開啟正式資料庫後呼叫 applySchema(db)。

// codes 表：code 不再唯一（密碼可重複），改以 redeem_url（兌換連結）為唯一鍵；
// gift_name 改存每一張（修正整批共用名稱的問題）；status 新增 earmarked（圈存）；
// 另加圈存起訖日。
function codesDdl(table, ifNotExists = false) {
  return `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${table} (
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
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`;
}

function hasColumn(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

function addColumnIfMissing(db, table, col, ddl) {
  if (!hasColumn(db, table, col)) db.exec(ddl);
}

// 舊版 codes（code UNIQUE、status 只允許 available/redeemed、無 redeem_url）→ 重建。
// 保留全部舊資料，gift_name 從所屬批次補上。以「是否已有 redeem_url 欄」判斷是否需升級，
// 因此本函式具冪等性。
function migrateCodesTable(db) {
  const cols = db.prepare('PRAGMA table_info(codes)').all().map((c) => c.name);
  if (cols.length === 0) return; // 不該發生（CREATE 已建好）
  if (cols.includes('redeem_url')) return; // 已是新結構

  const fkWasOn = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(codesDdl('codes_new'));
    db.exec(`
      INSERT INTO codes_new
        (id, code, batch_id, gift_name, face_value, expires_at, status,
         campaign_id, redeemed_by, redeemed_note, redeemed_at, created_at)
      SELECT k.id, k.code, k.batch_id, COALESCE(b.gift_name, ''), k.face_value, k.expires_at, k.status,
             k.campaign_id, k.redeemed_by, k.redeemed_note, k.redeemed_at, k.created_at
      FROM codes k LEFT JOIN batches b ON b.id = k.batch_id
    `);
    db.exec('DROP TABLE codes');
    db.exec('ALTER TABLE codes_new RENAME TO codes');
  })();
  db.pragma(`foreign_keys = ${fkWasOn ? 'ON' : 'OFF'}`);
}

// 清掉既有資料中 Excel「文字前置符」殘留的開頭單引號（例：'YAC38 → YAC38）。
// 只處理開頭是單引號的列，跑過即無可再改，故具冪等性。
function stripLeadingApostrophes(db) {
  if (!hasColumn(db, 'codes', 'code')) return;
  const cols = ['code', 'redeem_url', 'gift_name', 'face_value', 'expires_at', 'earmark_start', 'earmark_end', 'redeemed_by'];
  for (const c of cols) {
    db.exec(`UPDATE codes SET ${c} = substr(${c}, 2) WHERE ${c} LIKE '''%'`);
  }
}

function applySchema(db) {
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

    ${codesDdl('codes', true)};

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
  `);

  // 批次與活動的欄位升級（保留既有作法）
  addColumnIfMissing(db, 'batches', 'gift_name', "ALTER TABLE batches ADD COLUMN gift_name TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'staff', 'is_admin', 'ALTER TABLE staff ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'campaigns', 'planned_count', 'ALTER TABLE campaigns ADD COLUMN planned_count INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'campaigns', 'budget', 'ALTER TABLE campaigns ADD COLUMN budget REAL NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'campaigns', 'start_date', "ALTER TABLE campaigns ADD COLUMN start_date TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'campaigns', 'end_date', "ALTER TABLE campaigns ADD COLUMN end_date TEXT NOT NULL DEFAULT ''");

  // codes 表升級（需在批次 gift_name 補上之後）
  migrateCodesTable(db);

  stripLeadingApostrophes(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_codes_status ON codes(status);
    CREATE INDEX IF NOT EXISTS idx_codes_batch ON codes(batch_id);
    CREATE INDEX IF NOT EXISTS idx_codes_campaign ON codes(campaign_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_codes_redeem_url ON codes(redeem_url);
  `);
}

module.exports = { applySchema };
