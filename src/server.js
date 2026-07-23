'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const db = require('./db');
const { parseGiftcodeCsv, TEMPLATE_CSV } = require('./csv');
const { runSync, getSyncStatus, setSyncDir } = require('./sync');
const staffRouter = require('./staff');
const backup = require('./backup');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use('/api', staffRouter);
app.use('/api', backup.router);
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- 系統設定（DB 路徑）----
const STARTUP_CONFIG_FILE = path.join(__dirname, '..', 'startup-config.json');

function readStartupCfg() {
  try {
    if (fs.existsSync(STARTUP_CONFIG_FILE)) return JSON.parse(fs.readFileSync(STARTUP_CONFIG_FILE, 'utf8'));
  } catch { /* ignore */ }
  return {};
}

app.get('/api/db-config', (req, res) => {
  const cfg = readStartupCfg();
  res.json({
    data_dir: cfg.data_dir || '',
    current_data_dir: path.dirname(db.name),
  });
});

app.put('/api/db-config', (req, res) => {
  const cfg = readStartupCfg();
  cfg.data_dir = String(req.body.data_dir || '').trim();
  fs.writeFileSync(STARTUP_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  res.json({ ok: true, restart_required: true, data_dir: cfg.data_dir });
});

const nowIso = () => new Date().toISOString();

function parseFaceValue(value) {
  if (value == null || value === '') return null;
  const match = String(value).replace(/,/g, '').match(/\d+(\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : null;
}

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
  // 優先用手動填入的名稱，否則從 CSV 欄位偵測
  const giftName = String(req.body.gift_name || '').trim() || parsed.gift_name || '';
  const duplicates = [];

  const result = db.transaction(() => {
    const batch = db.prepare(
      'INSERT INTO batches (filename, note, uploaded_by, gift_name) VALUES (?, ?, ?, ?)'
    ).run(req.file.originalname || 'upload.csv', note, uploadedBy, giftName);
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

  const allImported = db.prepare('SELECT face_value FROM codes WHERE batch_id = ?').all(result.batchId);
  let totalCost = 0;
  let withValue = 0;
  let noValue = 0;
  for (const row of allImported) {
    const value = parseFaceValue(row.face_value);
    if (value == null) {
      noValue++;
    } else {
      totalCost += value;
      withValue++;
    }
  }

  res.status(201).json({
    batch_id: result.batchId,
    total: parsed.rows.length,
    imported: result.imported,
    duplicates,
    warnings: parsed.errors,
    cost_summary: { total: totalCost, with_value: withValue, no_value: noValue },
  });
});

app.get('/api/batches', (req, res) => {
  res.json(db.prepare('SELECT * FROM batches ORDER BY id DESC').all());
});

// ---- 活動 ----
app.get('/api/campaigns', (req, res) => {
  const campaigns = db.prepare(`
    SELECT c.*, COUNT(k.id) AS redeemed_count
    FROM campaigns c LEFT JOIN codes k ON k.campaign_id = c.id AND k.status = 'redeemed'
    GROUP BY c.id ORDER BY c.created_at DESC
  `).all();

  const costRows = db.prepare(`
    SELECT campaign_id, face_value
    FROM codes
    WHERE status = 'redeemed' AND campaign_id IS NOT NULL
  `).all();
  const costMap = new Map();
  for (const row of costRows) {
    const value = parseFaceValue(row.face_value);
    if (value == null) continue;
    costMap.set(row.campaign_id, (costMap.get(row.campaign_id) || 0) + value);
  }

  res.json(campaigns.map((campaign) => {
    const cost = costMap.get(campaign.id) || 0;
    return {
      ...campaign,
      cost,
      remaining: campaign.budget > 0 ? campaign.budget - cost : null,
    };
  }));
});

app.post('/api/campaigns', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '活動名稱不可為空' });
  try {
    const result = db.prepare(`
      INSERT INTO campaigns (name, planned_count, budget, start_date, end_date)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      name,
      Math.max(0, Number(req.body.planned_count) || 0),
      Math.max(0, Number(req.body.budget) || 0),
      String(req.body.start_date || '').trim(),
      String(req.body.end_date || '').trim()
    );
    res.status(201).json(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Campaign already exists' });
    throw err;
  }
});

// ---- 禮券查詢 ----
app.put('/api/campaigns/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM campaigns WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Campaign not found' });

  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Campaign name is required' });

  try {
    db.prepare(`
      UPDATE campaigns
      SET name = ?, planned_count = ?, budget = ?, start_date = ?, end_date = ?
      WHERE id = ?
    `).run(
      name,
      Math.max(0, Number(req.body.planned_count) || 0),
      Math.max(0, Number(req.body.budget) || 0),
      String(req.body.start_date || '').trim(),
      String(req.body.end_date || '').trim(),
      req.params.id
    );
    res.json(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id));
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Campaign already exists' });
    throw err;
  }
});

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
  SELECT k.*, b.filename AS batch_filename, b.gift_name AS gift_name, c.name AS campaign_name
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
  const header = ['gift_name', 'code', 'status', 'campaign', 'redeemed_by', 'redeemed_note', 'redeemed_at', 'face_value', 'expires_at', 'batch_filename', 'created_at'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.gift_name || '',
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

app.get('/api/template.csv', (req, res) => {
  const filename = encodeURIComponent('禮券上傳範本.csv');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="giftcode-template.csv"; filename*=UTF-8''${filename}`
  );
  res.send(String.fromCharCode(0xFEFF) + TEMPLATE_CSV); // UTF-8 BOM，與 export.csv 一致
});

// ---- NAS 同步 ----
app.get('/api/sync/status', (req, res) => {
  res.json(getSyncStatus());
});

app.put('/api/sync/config', (req, res) => {
  setSyncDir(req.body.sync_dir);
  res.json(getSyncStatus());
});

app.post('/api/sync', (req, res) => {
  try {
    res.json(runSync());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || '伺服器發生錯誤' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`電子禮券管理後台已啟動：http://localhost:${PORT}`);
    if (process.env.SYNC_DIR) {
      console.log(`NAS 同步資料夾：${process.env.SYNC_DIR}`);
    }
  });

  // 設定 SYNC_INTERVAL_MINUTES 後，定時自動同步 NAS 上的 CSV
  const intervalMin = Number(process.env.SYNC_INTERVAL_MINUTES);
  if (intervalMin > 0) {
    console.log(`每 ${intervalMin} 分鐘自動同步一次`);
    setInterval(() => {
      try {
        const s = runSync();
        if (s.imported_files.length || s.errors.length) {
          console.log(`[自動同步] 新增 ${s.new_codes} 筆禮券，錯誤 ${s.errors.length} 件`);
        }
      } catch (err) {
        console.error(`[自動同步] 失敗：${err.message}`);
      }
    }, intervalMin * 60 * 1000).unref();
  }

  backup.syncBackupConfigFile(); // 確保 backup-config.json 存在，讓下次啟動能自動還原
  backup.scheduleDailyBackup();
}

app.parseFaceValue = parseFaceValue;
module.exports = app;
