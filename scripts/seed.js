'use strict';

// 塞入測試資料：3 個批次、4 個活動、部分禮券已兌換。
// 用法：npm run seed（DATA_DIR 可指定資料庫位置，重複執行時已存在的碼會略過）

const db = require('../src/db');

const pad = (n, w) => String(n).padStart(w, '0');

const BATCHES = [
  {
    filename: '2026Q1_家樂福500元即享券.csv',
    note: '2026 Q1 採購，行銷部',
    uploaded_by: '王小明',
    prefix: 'CARR-500',
    count: 200,
    face_value: '500',
    expires_at: '2026-12-31',
  },
  {
    filename: '2026Q2_全家拿鐵咖啡券.csv',
    note: '2026 Q2 採購，人資部活動用',
    uploaded_by: '李小華',
    prefix: 'FAMI-CFE',
    count: 150,
    face_value: '65',
    expires_at: '2027-03-31',
  },
  {
    filename: '2026Q3_誠品1000元禮券.csv',
    note: '2026 Q3 採購，VIP 客戶贈禮',
    uploaded_by: '陳大文',
    prefix: 'ESLT-1000',
    count: 100,
    face_value: '1000',
    expires_at: '2027-06-30',
  },
];

const CAMPAIGNS = [
  { name: '週年慶抽獎', redeem: { batch: 0, from: 1, to: 60 }, by: '王小明', note: '官網抽獎活動' },
  { name: '母親節滿額贈', redeem: { batch: 0, from: 61, to: 100 }, by: '林美玲', note: '滿 3000 贈 500 元券' },
  { name: '員工季度獎勵', redeem: { batch: 1, from: 1, to: 45 }, by: '李小華', note: 'Q2 績優員工' },
  { name: 'VIP 客戶回饋', redeem: { batch: 2, from: 1, to: 25 }, by: '陳大文', note: '年度 VIP 感謝禮' },
];

// 讓兌換時間分散在過去 90 天內，資料看起來比較真實
function randomPastIso(daysBack = 90) {
  const ms = Date.now() - Math.floor(Math.random() * daysBack * 24 * 60 * 60 * 1000);
  return new Date(ms).toISOString();
}

const seed = db.transaction(() => {
  const insertBatch = db.prepare(
    'INSERT INTO batches (filename, note, uploaded_by, total_count, imported_count, duplicate_count) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertCode = db.prepare(
    'INSERT OR IGNORE INTO codes (code, batch_id, face_value, expires_at) VALUES (?, ?, ?, ?)'
  );
  const redeemCode = db.prepare(`
    UPDATE codes SET status = 'redeemed', campaign_id = ?, redeemed_by = ?, redeemed_note = ?, redeemed_at = ?
    WHERE code = ? AND status = 'available'
  `);

  let totalImported = 0;
  const batchCodes = [];
  for (const b of BATCHES) {
    const codes = Array.from({ length: b.count }, (_, i) => `${b.prefix}-${pad(i + 1, 4)}`);
    batchCodes.push(codes);
    if (db.prepare('SELECT 1 FROM batches WHERE filename = ?').get(b.filename)) {
      console.log(`批次「${b.filename}」已存在，跳過`);
      continue;
    }
    const batchId = insertBatch.run(b.filename, b.note, b.uploaded_by, b.count, 0, 0).lastInsertRowid;
    let imported = 0;
    for (const code of codes) {
      if (insertCode.run(code, batchId, b.face_value, b.expires_at).changes === 1) imported++;
    }
    db.prepare('UPDATE batches SET imported_count = ?, duplicate_count = ? WHERE id = ?')
      .run(imported, b.count - imported, batchId);
    totalImported += imported;
    console.log(`批次「${b.filename}」：${imported}/${b.count} 筆匯入`);
  }

  let totalRedeemed = 0;
  for (const c of CAMPAIGNS) {
    const existing = db.prepare('SELECT id FROM campaigns WHERE name = ?').get(c.name);
    const campaignId = existing
      ? existing.id
      : db.prepare('INSERT INTO campaigns (name) VALUES (?)').run(c.name).lastInsertRowid;

    let redeemed = 0;
    for (let i = c.redeem.from; i <= c.redeem.to; i++) {
      const code = batchCodes[c.redeem.batch][i - 1];
      if (redeemCode.run(campaignId, c.by, c.note, randomPastIso(), code).changes === 1) redeemed++;
    }
    totalRedeemed += redeemed;
    console.log(`活動「${c.name}」：兌換 ${redeemed} 筆`);
  }

  return { totalImported, totalRedeemed };
});

const { totalImported, totalRedeemed } = seed();
const stats = db.prepare(
  "SELECT COUNT(*) AS total, SUM(status = 'redeemed') AS redeemed FROM codes"
).get();
console.log(`\n完成：本次新增 ${totalImported} 筆禮券、兌換 ${totalRedeemed} 筆`);
console.log(`資料庫現況：共 ${stats.total} 筆，已兌換 ${stats.redeemed} 筆，未兌換 ${stats.total - stats.redeemed} 筆`);
