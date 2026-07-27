'use strict';

// 把解析後的禮券列寫入資料庫（上傳與 NAS 同步共用）。
// 依 parseGiftcodeCsv 產出的 row 逐列匯入，並套用狀態／經手人／適用專案。

const nowIso = () => new Date().toISOString();

function getOrCreateCampaign(db, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const existing = db.prepare('SELECT id FROM campaigns WHERE name = ?').get(trimmed);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO campaigns (name) VALUES (?)').run(trimmed).lastInsertRowid;
}

/**
 * 逐列匯入禮券。重複判定：有兌換連結時以連結為唯一鍵，否則以（無連結的）禮券碼比對。
 * 上傳時直接套用該列的狀態（已兌換／已圈存／未兌換）、經手人與適用專案。
 * 回傳 { imported, duplicates: [被視為重複的禮券碼] }
 */
function importRows(db, { rows, batchId, defaultGiftName = '' }) {
  const findByUrl = db.prepare('SELECT id FROM codes WHERE redeem_url = ?');
  const findByCode = db.prepare('SELECT id FROM codes WHERE code = ? AND redeem_url IS NULL');
  const insert = db.prepare(`
    INSERT INTO codes
      (code, batch_id, gift_name, redeem_url, face_value, expires_at, status,
       campaign_id, redeemed_by, redeemed_note, redeemed_at, earmark_start, earmark_end)
    VALUES
      (@code, @batch_id, @gift_name, @redeem_url, @face_value, @expires_at, @status,
       @campaign_id, @redeemed_by, @redeemed_note, @redeemed_at, @earmark_start, @earmark_end)
  `);

  let imported = 0;
  const duplicates = [];
  for (const row of rows) {
    const url = row.redeem_url ? row.redeem_url : null;
    const exists = url ? findByUrl.get(url) : findByCode.get(row.code);
    if (exists) {
      duplicates.push(row.code);
      continue;
    }
    const status = row.status || 'available';
    // 已兌換／已圈存的列，適用專案 = 對應活動
    const campaignId = (status === 'redeemed' || status === 'earmarked') && row.project
      ? getOrCreateCampaign(db, row.project)
      : null;
    insert.run({
      code: row.code,
      batch_id: batchId,
      gift_name: row.gift_name || defaultGiftName || '',
      redeem_url: url,
      face_value: row.face_value || '',
      expires_at: row.expires_at || '',
      status,
      campaign_id: campaignId,
      redeemed_by: (status === 'redeemed' || status === 'earmarked') ? (row.handler || '') : '',
      redeemed_note: '',
      redeemed_at: status === 'redeemed' ? nowIso() : null,
      earmark_start: row.earmark_start || '',
      earmark_end: row.earmark_end || '',
    });
    imported++;
  }
  return { imported, duplicates };
}

module.exports = { importRows, getOrCreateCampaign, nowIso };
