'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('./db');
const { parseGiftcodeCsv } = require('./csv');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const nowIso = () => new Date().toISOString();

function getOrCreateCampaign(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const existing = db.prepare('SELECT id FROM campaigns WHERE name = ?').get(trimmed);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO campaigns (name) VALUES (?)').run(trimmed).lastInsertRowid;
}

// ---- 總覽統計 ----
app.get('/api/stats', (req, res) => {
  const totals = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed
    FROM codes
  `).get();
  const byCampaign = db.prepare(`
    SELECT c.id, c.name, COUNT(k.id) AS redeemed_count
    FROM campaigns c LEFT JOIN codes k ON k.campaign_id = c.id AND k.status = 'redeemed'
    GROUP BY c.id ORDER BY c.created_at DESC
  `).all();
  const batchCount = db.prepare('SELECT COUNT(*) AS n FROM batches').get().n;
  res.json({
    total: totals.total || 0,
    redeemed: totals.redeemed || 0,
    available: (totals.total || 0) - (totals.redeemed || 0),
    batch_count: batchCount,
    campaigns: byCampaign,
  });
});

// ---- 批次：上傳 CSV ----
app.post('/api/batches', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請選擇要上傳的 CSV 檔案' });

  let parsed;
  try {
    parsed = parseGiftcodeCsv(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ error: `CSV 解析失敗：${err.message}` });
  }
  if (parsed.rows.length === 0) {
    return res.status(400).json({ error: '檔案中找不到任何禮券碼', details: parsed.errors });
  }

  const note = String(req.body.note || '').trim();
  const uploadedBy = String(req.body.uploaded_by || '').trim();
  const duplicates = [];

  const result = db.transaction(() => {
    const batch = db.prepare(
      'INSERT INTO batches (filename, note, uploaded_by) VALUES (?, ?, ?)'
    ).run(req.file.originalname || 'upload.csv', note, uploadedBy);
    const batchId = batch.lastInsertRowid;

    const insert = db.prepare(
      'INSERT OR IGNORE INTO codes (code, batch_id, face_value, expires_at) VALUES (?, ?, ?, ?)'
    );
    let imported = 0;
    for (const row of parsed.rows) {
      const r = insert.run(row.code, batchId, row.face_value, row.expires_at);
      if (r.changes === 1) imported++;
      else duplicates.push(row.code);
    }

    db.prepare(
      'UPDATE batches SET total_count = ?, imported_count = ?, duplicate_count = ? WHERE id = ?'
    ).run(parsed.rows.length, imported, duplicates.length, batchId);

    return { batchId, imported };
  })();

  res.status(201).json({
    batch_id: result.batchId,
    total: parsed.rows.length,
    imported: result.imported,
    duplicates,
    warnings: parsed.errors,
  });
});

app.get('/api/batches', (req, res) => {
  res.json(db.prepare('SELECT * FROM batches ORDER BY id DESC').all());
});

// ---- 活動 ----
app.get('/api/campaigns', (req, res) => {
  res.json(db.prepare(`
    SELECT c.*, COUNT(k.id) AS redeemed_count
    FROM campaigns c LEFT JOIN codes k ON k.campaign_id = c.id AND k.status = 'redeemed'
    GROUP BY c.id ORDER BY c.created_at DESC
  `).all());
});

app.post('/api/campaigns', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '活動名稱不可為空' });
  const id = getOrCreateCampaign(name);
  res.status(201).json(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id));
});

// ---- 禮券查詢 ----
function buildCodeFilters(query) {
  const where = [];
  const params = {};
  if (query.q) {
    where.push('k.code LIKE :q');
    params.q = `%${String(query.q).trim()}%`;
  }
  if (query.status === 'available' || query.status === 'redeemed') {
    where.push('k.status = :status');
    params.status = query.status;
  }
  if (query.batch_id) {
    where.push('k.batch_id = :batch_id');
    params.batch_id = Number(query.batch_id);
  }
  if (query.campaign_id) {
    where.push('k.campaign_id = :campaign_id');
    params.campaign_id = Number(query.campaign_id);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const CODE_SELECT = `
  SELECT k.*, b.filename AS batch_filename, c.name AS campaign_name
  FROM codes k
  JOIN batches b ON b.id = k.batch_id
  LEFT JOIN campaigns c ON c.id = k.campaign_id
`;

app.get('/api/codes', (req, res) => {
  const { clause, params } = buildCodeFilters(req.query);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 50));

  const total = db.prepare(`SELECT COUNT(*) AS n FROM codes k ${clause}`).get(params).n;
  const items = db.prepare(
    `${CODE_SELECT} ${clause} ORDER BY k.id DESC LIMIT :limit OFFSET :offset`
  ).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

  res.json({ items, total, page, page_size: pageSize });
});

// ---- 兌換 / 取消兌換 ----
app.post('/api/codes/:id/redeem', (req, res) => {
  const code = db.prepare('SELECT * FROM codes WHERE id = ?').get(req.params.id);
  if (!code) return res.status(404).json({ error: '找不到這張禮券' });
  if (code.status === 'redeemed') return res.status(409).json({ error: '這張禮券已經被兌換' });

  const campaignName = String(req.body.campaign || '').trim();
  if (!campaignName) return res.status(400).json({ error: '請填寫使用的活動名稱' });

  const campaignId = getOrCreateCampaign(campaignName);
  db.prepare(`
    UPDATE codes SET status = 'redeemed', campaign_id = ?, redeemed_by = ?, redeemed_note = ?, redeemed_at = ?
    WHERE id = ?
  `).run(campaignId, String(req.body.redeemed_by || '').trim(), String(req.body.note || '').trim(), nowIso(), code.id);

  res.json(db.prepare(`${CODE_SELECT} WHERE k.id = ?`).get(code.id));
});

app.post('/api/codes/:id/unredeem', (req, res) => {
  const code = db.prepare('SELECT * FROM codes WHERE id = ?').get(req.params.id);
  if (!code) return res.status(404).json({ error: '找不到這張禮券' });
  if (code.status !== 'redeemed') return res.status(409).json({ error: '這張禮券尚未兌換' });

  db.prepare(`
    UPDATE codes SET status = 'available', campaign_id = NULL, redeemed_by = '', redeemed_note = '', redeemed_at = NULL
    WHERE id = ?
  `).run(code.id);

  res.json(db.prepare(`${CODE_SELECT} WHERE k.id = ?`).get(code.id));
});

// 批次兌換：貼上多個禮券碼，一次標記到同一個活動
app.post('/api/codes/redeem-bulk', (req, res) => {
  const campaignName = String(req.body.campaign || '').trim();
  if (!campaignName) return res.status(400).json({ error: '請填寫使用的活動名稱' });

  const rawCodes = Array.isArray(req.body.codes) ? req.body.codes : [];
  const codes = [...new Set(rawCodes.map((c) => String(c).trim()).filter(Boolean))];
  if (codes.length === 0) return res.status(400).json({ error: '請提供至少一個禮券碼' });

  const redeemedBy = String(req.body.redeemed_by || '').trim();
  const note = String(req.body.note || '').trim();

  const result = db.transaction(() => {
    const campaignId = getOrCreateCampaign(campaignName);
    const find = db.prepare('SELECT * FROM codes WHERE code = ?');
    const redeem = db.prepare(`
      UPDATE codes SET status = 'redeemed', campaign_id = ?, redeemed_by = ?, redeemed_note = ?, redeemed_at = ?
      WHERE id = ?
    `);
    const redeemed = [];
    const notFound = [];
    const alreadyRedeemed = [];
    for (const c of codes) {
      const row = find.get(c);
      if (!row) notFound.push(c);
      else if (row.status === 'redeemed') alreadyRedeemed.push(c);
      else {
        redeem.run(campaignId, redeemedBy, note, nowIso(), row.id);
        redeemed.push(c);
      }
    }
    return { redeemed, notFound, alreadyRedeemed };
  })();

  res.json({
    redeemed_count: result.redeemed.length,
    redeemed: result.redeemed,
    not_found: result.notFound,
    already_redeemed: result.alreadyRedeemed,
  });
});

// ---- 匯出 CSV（套用與列表相同的篩選）----
app.get('/api/export.csv', (req, res) => {
  const { clause, params } = buildCodeFilters(req.query);
  const rows = db.prepare(`${CODE_SELECT} ${clause} ORDER BY k.id`).all(params);

  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['code', 'status', 'campaign', 'redeemed_by', 'redeemed_note', 'redeemed_at', 'face_value', 'expires_at', 'batch_filename', 'created_at'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.code,
      r.status === 'redeemed' ? '已兌換' : '未兌換',
      r.campaign_name || '',
      r.redeemed_by,
      r.redeemed_note,
      r.redeemed_at || '',
      r.face_value,
      r.expires_at,
      r.batch_filename,
      r.created_at,
    ].map(esc).join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="giftcodes-export.csv"');
  res.send('\uFEFF' + lines.join('\n') + '\n');
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || '伺服器發生錯誤' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`電子禮券管理後台已啟動：http://localhost:${PORT}`);
  });
}

module.exports = app;
