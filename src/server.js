'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const db = require('./db');
const { parseGiftcodeCsv, TEMPLATE_CSV } = require('./csv');
const { importRows, getOrCreateCampaign, SIGNOFF_COLS } = require('./importer');
const { requireAdmin } = require('./auth');
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

// multer 記憶體儲存的 originalname 是 busboy 以 latin1 解出的位元組，
// 中文檔名會變亂碼（例：ã€æ¸¬è©¦…）。把位元組當 UTF-8 重新解碼即可還原。
function decodeFilename(name) {
  const raw = name || 'upload.csv';
  try {
    return Buffer.from(raw, 'latin1').toString('utf8');
  } catch {
    return raw;
  }
}

function parseFaceValue(value) {
  if (value == null || value === '') return null;
  const match = String(value).replace(/,/g, '').match(/\d+(\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : null;
}

// 顯示狀態（讀取時計算）
//   已兌換                                  → redeemed
//   已配給某活動（有圈存起訖，或狀態就是 earmarked）
//   且圈存迄日還沒過（含尚未開始）           → earmarked（不可釋出）
//   圈存迄日已過而仍未兌換                   → available（自動釋回）
// 判定看的是「圈存期間」而不是 status 欄位，因為取消兌換、或 CSV 狀態欄沒填「已圈存」
// 的資料，status 會是 available，但那批序號其實還被某個活動綁著。
// 迄日空白或格式無法解析時視為沒有期限，維持 earmarked。
const DISPLAY_STATUS_SQL = `
  CASE
    WHEN k.status = 'redeemed' THEN 'redeemed'
    WHEN (k.earmark_start <> '' OR k.earmark_end <> '' OR k.status = 'earmarked')
         AND (norm_date(k.earmark_end) = '' OR norm_date(k.earmark_end) >= date('now'))
      THEN 'earmarked'
    ELSE 'available'
  END`;

// ---- 總覽統計 ----
app.get('/api/stats', (req, res) => {
  // 統計與列表共用同一套顯示狀態判定，避免兩邊算出不同數字
  const totals = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN (${DISPLAY_STATUS_SQL}) = 'redeemed' THEN 1 ELSE 0 END) AS redeemed,
           SUM(CASE WHEN (${DISPLAY_STATUS_SQL}) = 'earmarked' THEN 1 ELSE 0 END) AS earmarked
    FROM codes k
  `).get();
  const byCampaign = db.prepare(`
    SELECT c.id, c.name, COUNT(k.id) AS redeemed_count
    FROM campaigns c LEFT JOIN codes k ON k.campaign_id = c.id AND k.status = 'redeemed'
    GROUP BY c.id ORDER BY c.created_at DESC
  `).all();
  const batchCount = db.prepare('SELECT COUNT(*) AS n FROM batches').get().n;
  const total = totals.total || 0;
  const redeemed = totals.redeemed || 0;
  const earmarked = totals.earmarked || 0;

  // 各狀態的面額總額（面額為文字欄，沿用 parseFaceValue 與活動成本一致的解析）
  const amounts = { total: 0, available: 0, earmarked: 0, redeemed: 0 };
  const amtRows = db.prepare(`SELECT face_value AS fv, (${DISPLAY_STATUS_SQL}) AS ds FROM codes k`).all();
  for (const r of amtRows) {
    const v = parseFaceValue(r.fv);
    if (v == null) continue;
    amounts.total += v;
    amounts[r.ds] += v;
  }

  res.json({
    total,
    redeemed,
    earmarked,
    available: total - redeemed - earmarked,
    amounts,
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
    // 整份檔案只剩範本範例列 = 使用者下載範本後直接上傳，沒填東西
    const templateOnly =
      parsed.errors.length > 0 &&
      parsed.errors.every((e) => e.includes('範本範例列'));
    return res.status(400).json({
      error: templateOnly
        ? '這是尚未填寫的 CSV 範本：請刪除範例列、填入實際禮券碼後再上傳'
        : '檔案中找不到任何禮券碼',
      details: parsed.errors,
    });
  }

  const note = String(req.body.note || '').trim();
  const uploadedBy = String(req.body.uploaded_by || '').trim();
  // 優先用手動填入的名稱，否則從 CSV 欄位偵測（作為缺名稱那幾列的預設值）
  const giftName = String(req.body.gift_name || '').trim() || parsed.gift_name || '';
  // multer/busboy 以 latin1 解讀檔名，中文會變亂碼；還原成 UTF-8。
  const filename = decodeFilename(req.file.originalname);

  const result = db.transaction(() => {
    const batch = db.prepare(
      'INSERT INTO batches (filename, note, uploaded_by, gift_name) VALUES (?, ?, ?, ?)'
    ).run(filename, note, uploadedBy, giftName);
    const batchId = batch.lastInsertRowid;

    const { imported, duplicates } = importRows(db, {
      rows: parsed.rows,
      batchId,
      defaultGiftName: giftName,
    });

    db.prepare(
      'UPDATE batches SET total_count = ?, imported_count = ?, duplicate_count = ? WHERE id = ?'
    ).run(parsed.rows.length, imported, duplicates.length, batchId);

    return { batchId, imported, duplicates };
  })();
  const duplicates = result.duplicates;

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
  res.json(db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM codes k WHERE k.batch_id = b.id) AS code_count,
      (SELECT COUNT(*) FROM codes k WHERE k.batch_id = b.id AND k.status = 'redeemed') AS redeemed_count
    FROM batches b ORDER BY b.id DESC
  `).all());
});

// 刪除整批（限管理員）：連同該批所有禮券與 NAS 同步追蹤一起刪，之後可重新上傳修正版
app.delete('/api/batches/:id', requireAdmin(db), (req, res) => {
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(req.params.id);
  if (!batch) return res.status(404).json({ error: '找不到這個批次' });

  const result = db.transaction(() => {
    const total = db.prepare('SELECT COUNT(*) AS n FROM codes WHERE batch_id = ?').get(batch.id).n;
    const redeemed = db.prepare("SELECT COUNT(*) AS n FROM codes WHERE batch_id = ? AND status = 'redeemed'").get(batch.id).n;
    db.prepare('DELETE FROM codes WHERE batch_id = ?').run(batch.id);
    db.prepare('DELETE FROM sync_files WHERE batch_id = ?').run(batch.id);
    db.prepare('DELETE FROM batches WHERE id = ?').run(batch.id);
    return { total, redeemed };
  })();

  res.json({ ok: true, deleted_codes: result.total, redeemed_count: result.redeemed });
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
  if (['available', 'redeemed', 'earmarked'].includes(query.status)) {
    where.push(`(${DISPLAY_STATUS_SQL}) = :status`);
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
  SELECT k.*, ${DISPLAY_STATUS_SQL} AS display_status,
         b.filename AS batch_filename, c.name AS campaign_name
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

// 依列表流水號範圍取 id（給前端「選取第 N ~ M 號」用，可跨頁）。
// 排序與篩選必須與 GET /api/codes 完全一致，流水號才對得起來。
const RANGE_MAX = 1000;

app.get('/api/codes/ids', (req, res) => {
  const from = Math.max(1, Number(req.query.from) || 0);
  const to = Math.max(1, Number(req.query.to) || 0);
  if (!from || !to) return res.status(400).json({ error: '請提供起訖流水號' });
  if (to < from) return res.status(400).json({ error: '結束流水號不可小於開始流水號' });
  if (to - from + 1 > RANGE_MAX) {
    return res.status(400).json({ error: `一次最多選取 ${RANGE_MAX} 張，請縮小範圍` });
  }

  const { clause, params } = buildCodeFilters(req.query);
  const rows = db.prepare(
    `${CODE_SELECT} ${clause} ORDER BY k.id DESC LIMIT :limit OFFSET :offset`
  ).all({ ...params, limit: to - from + 1, offset: from - 1 });

  // 已兌換的不能再兌換，直接排除，並回報略過幾張讓前端提示
  const selectable = rows.filter((r) => r.display_status !== 'redeemed');
  res.json({
    ids: selectable.map((r) => r.id),
    found: rows.length,
    skipped_redeemed: rows.length - selectable.length,
  });
});

// ---- 兌換 / 取消兌換 ----
app.post('/api/codes/:id/redeem', (req, res) => {
  const code = db.prepare('SELECT * FROM codes WHERE id = ?').get(req.params.id);
  if (!code) return res.status(404).json({ error: '找不到這張禮券' });
  if (code.status === 'redeemed') return res.status(409).json({ error: '這張禮券已經被兌換' });

  const campaignName = String(req.body.campaign || '').trim();
  if (!campaignName) return res.status(400).json({ error: '請填寫使用的活動名稱' });

  const campaignId = getOrCreateCampaign(db, campaignName);
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

// 單張編輯：修正 CSV 打錯的內容欄位（狀態仍由標記兌換／取消兌換管理）
app.put('/api/codes/:id', (req, res) => {
  const code = db.prepare('SELECT * FROM codes WHERE id = ?').get(req.params.id);
  if (!code) return res.status(404).json({ error: '找不到這張禮券' });

  const newCode = String(req.body.code ?? code.code).trim();
  if (!newCode) return res.status(400).json({ error: '密碼／序號不可為空' });

  // 兌換連結：空字串正規化為 NULL（維持唯一索引語意），非空則檢查未被其他張佔用
  let redeemUrl = req.body.redeem_url === undefined
    ? code.redeem_url
    : String(req.body.redeem_url || '').trim();
  redeemUrl = redeemUrl || null;
  if (redeemUrl) {
    const clash = db.prepare('SELECT id FROM codes WHERE redeem_url = ? AND id != ?').get(redeemUrl, code.id);
    if (clash) return res.status(409).json({ error: '這個兌換連結已被其他禮券使用' });
  }

  const pick = (key) => (req.body[key] === undefined ? code[key] : String(req.body[key] || '').trim());
  // 內容欄位 + 簽收表欄位（客戶與發送資訊）一併可編輯
  const editable = [
    'gift_name', 'face_value', 'expires_at', 'earmark_start', 'earmark_end',
    ...SIGNOFF_COLS,
  ];
  const setSql = ['code = ?', 'redeem_url = ?', ...editable.map((c) => `${c} = ?`)].join(', ');
  const params = [newCode, redeemUrl, ...editable.map((c) => pick(c)), code.id];
  db.prepare(`UPDATE codes SET ${setSql} WHERE id = ?`).run(...params);
  res.json(db.prepare(`${CODE_SELECT} WHERE k.id = ?`).get(code.id));
});

// 刪除單張禮券（限管理員）。回傳該張是否原本已兌換，供前端確認訊息。
app.delete('/api/codes/:id', requireAdmin(db), (req, res) => {
  const code = db.prepare('SELECT * FROM codes WHERE id = ?').get(req.params.id);
  if (!code) return res.status(404).json({ error: '找不到這張禮券' });
  db.prepare('DELETE FROM codes WHERE id = ?').run(code.id);
  res.json({ ok: true, was_redeemed: code.status === 'redeemed' });
});

// 批次兌換：貼上多個禮券碼，一次標記到同一個活動。
// 帶 dry_run 時只回報「會發生什麼事」而不寫入，讓前端能先跳出圈存警告。
app.post('/api/codes/redeem-bulk', (req, res) => {
  const dryRun = req.body.dry_run === true;
  const campaignName = String(req.body.campaign || '').trim();
  if (!dryRun && !campaignName) return res.status(400).json({ error: '請填寫使用的活動名稱' });

  // 兩種指定方式：ids（列表勾選，可精準指到同碼的不同張）或 codes（批次兌換頁貼上的文字）
  const rawIds = Array.isArray(req.body.ids) ? req.body.ids : [];
  const ids = [...new Set(rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const rawCodes = Array.isArray(req.body.codes) ? req.body.codes : [];
  const codes = [...new Set(rawCodes.map((c) => String(c).trim()).filter(Boolean))];
  const useIds = ids.length > 0;
  if (!useIds && codes.length === 0) return res.status(400).json({ error: '請提供至少一個禮券碼' });

  const redeemedBy = String(req.body.redeemed_by || '').trim();
  const note = String(req.body.note || '').trim();

  // 先分類：找不到 / 已兌換（略過）/ 可兌換。已圈存仍可兌換，只是要先警告。
  const findByCode = db.prepare(`${CODE_SELECT} WHERE k.code = ?`);
  const findById = db.prepare(`${CODE_SELECT} WHERE k.id = ?`);
  const targets = useIds
    ? ids.map((id) => [String(id), findById.get(id)])
    : codes.map((c) => [c, findByCode.get(c)]);

  const notFound = [];
  const alreadyRedeemed = [];
  const redeemable = [];
  for (const [label, row] of targets) {
    if (!row) notFound.push(label);
    else if (row.display_status === 'redeemed') alreadyRedeemed.push(row.code);
    else redeemable.push(row);
  }
  const earmarked = redeemable
    .filter((r) => r.display_status === 'earmarked')
    .map((r) => ({
      id: r.id,
      code: r.code,
      earmark_start: r.earmark_start,
      earmark_end: r.earmark_end,
      campaign_name: r.campaign_name || '',
    }));

  if (dryRun) {
    return res.json({
      dry_run: true,
      would_redeem_count: redeemable.length,
      earmarked,
      not_found: notFound,
      already_redeemed: alreadyRedeemed,
    });
  }

  const redeemed = db.transaction(() => {
    const campaignId = getOrCreateCampaign(db, campaignName);
    const redeem = db.prepare(`
      UPDATE codes SET status = 'redeemed', campaign_id = ?, redeemed_by = ?, redeemed_note = ?, redeemed_at = ?
      WHERE id = ?
    `);
    return redeemable.map((row) => {
      redeem.run(campaignId, redeemedBy, note, nowIso(), row.id);
      return row.code;
    });
  })();

  res.json({
    redeemed_count: redeemed.length,
    redeemed,
    earmarked,
    not_found: notFound,
    already_redeemed: alreadyRedeemed,
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
  const statusText = (disp) =>
    disp === 'redeemed' ? '已兌換' : disp === 'earmarked' ? '已圈存' : '未兌換';
  // 欄序與上傳範本一致（禮品名稱／兌換連結／密碼…），匯出檔可直接再上傳；
  // 後段兌換時間／備註／批次檔名／建立時間為參考欄，解析時會被忽略。
  const header = [
    '禮品名稱', '兌換連結', '密碼', '面額', '到期日', '經手人', '適用專案',
    '圈存開始日', '圈存結束日', '狀態', '兌換時間', '備註', '批次檔名', '建立時間',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.gift_name || '',
      r.redeem_url || '',
      r.code,
      r.face_value,
      r.expires_at,
      r.redeemed_by,
      r.campaign_name || '',
      r.earmark_start,
      r.earmark_end,
      statusText(r.display_status),
      r.redeemed_at || '',
      r.redeemed_note,
      r.batch_filename,
      r.created_at,
    ].map(esc).join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="giftcodes-export.csv"');
  res.send('\uFEFF' + lines.join('\n') + '\n');
});

// ---- 匯出簽收表（虛擬禮品贈送紀錄）----
// 欄序比照公司「【簽收表】虛擬禮品贈送紀錄」。含客戶個資，屬敏感資料。
app.get('/api/signoff.csv', (req, res) => {
  const { clause, params } = buildCodeFilters(req.query);
  const rows = db.prepare(`${CODE_SELECT} ${clause} ORDER BY k.id`).all(params);

  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    '編號', '專案名稱', '產品名稱', 'Email/SMS', 'Mobile', 'Email', '兌換連結', '密碼',
    '發送時間', '發送狀態', '狀態更新時間', '期貨帳號', '購買人姓名', '身份證字號',
    '戶籍地址', '面額', '單位', '營業員',
  ];
  const lines = [header.join(',')];
  rows.forEach((r, i) => {
    lines.push([
      i + 1,
      r.campaign_name || '',
      r.gift_name || '',
      r.send_method,
      r.recipient_mobile,
      r.recipient_email,
      r.redeem_url || '',
      r.code,
      r.sent_at,
      r.send_status,
      r.status_updated_at,
      r.account_no,
      r.recipient_name,
      r.national_id,
      r.address,
      r.face_value,
      r.unit,
      r.sales_rep,
    ].map(esc).join(','));
  });

  const filename = encodeURIComponent('虛擬禮品贈送紀錄.csv');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="signoff.csv"; filename*=UTF-8''${filename}`);
  res.send('﻿' + lines.join('\n') + '\n');
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
