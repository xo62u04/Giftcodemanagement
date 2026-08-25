'use strict';

const { parse } = require('csv-parse/sync');
const iconv = require('iconv-lite');

// 各欄位可接受的標頭名稱（不分大小寫）
const CODE_HEADERS = [
  'code', 'codes', 'giftcode', 'gift_code', 'gift code', 'voucher', 'voucher_code',
  'voucher code', 'coupon', 'coupon_code', 'serial', 'serial_no', 'sn', 'pin',
  'password', 'pw',
  '禮券碼', '禮券序號', '禮券代碼', '兌換碼', '兌換密碼', '密碼', '序號', '卡號', '代碼',
];
const VALUE_HEADERS = ['face_value', 'facevalue', 'value', 'amount', 'price', '面額', '金額', '票面金額'];
const EXPIRY_HEADERS = ['expires_at', 'expiry', 'expire', 'expiration', 'expire_date', 'valid_until', '到期日', '有效期限', '效期'];
const GIFT_NAME_HEADERS = [
  'gift_name', 'giftname', 'gift name', 'product_name', 'productname', 'product name', 'item_name',
  '禮品名稱', '禮券名稱', '商品名稱', '品名', '禮品', '禮券',
];
// 電子禮券：兌換連結（一個密碼對應一個連結，作為唯一鍵）、操作者、適用專案、圈存起訖日、狀態
const REDEEM_URL_HEADERS = [
  'redeem_url', 'redeemurl', 'redeem url', 'redemption_url', 'url', 'link',
  '兌換連結', '兌換網址', '連結', '網址',
];
const HANDLER_HEADERS = ['handler', 'redeemed_by', 'operator', '操作者', '經手人', '代領人', '承辦人', '處理人'];
const PROJECT_HEADERS = ['project', 'campaign', 'campaign_name', '適用專案', '專案', '活動', '活動名稱', '使用活動'];
const EARMARK_START_HEADERS = ['earmark_start', 'hold_start', '圈存開始日', '圈存起日', '圈存開始', '圈存起'];
const EARMARK_END_HEADERS = ['earmark_end', 'hold_end', '圈存結束日', '圈存迄日', '圈存結束', '圈存迄'];
const STATUS_HEADERS = ['status', 'state', '狀態'];
// 簽收表：客戶與發送資訊。key = codes 欄位名，值 = 可接受的標頭（normalizeHeader 後比對）
const SIGNOFF_FIELDS = {
  send_method: ['email/sms', '發送方式'],
  recipient_mobile: ['mobile', '手機', '手機號碼', '行動電話'],
  recipient_email: ['email', '電子郵件', '信箱'],
  sent_at: ['發送時間'],
  send_status: ['發送狀態'],
  status_updated_at: ['狀態更新時間'],
  account_no: ['期貨帳號', '帳號'],
  recipient_name: ['購買人姓名', '購買人', '兌換人', '兌換人姓名', '客戶姓名', '姓名'],
  national_id: ['身份證字號', '身分證字號', '身份證', '身分證'],
  address: ['戶籍地址', '地址'],
  unit: ['單位'],
  sales_rep: ['營業員'],
};

// 下載用的 CSV 範本。欄位名稱與順序比照使用者實際的電子禮券檔（禮品名稱／兌換連結／密碼…）。
const TEMPLATE_SAMPLE_CODES = ['ABC12345678', 'ABC12345679'];
const TEMPLATE_CSV = [
  '禮品名稱,兌換連結,密碼,面額,到期日(選填),操作者,適用專案(選填),圈存開始日(選填),圈存結束日(選填),狀態',
  `7-ELEVEN 100元數位商品禮券,https://example.com/redeem/SAMPLE1,${TEMPLATE_SAMPLE_CODES[0]},100,2026-12-31,,,,,未兌換`,
  `7-ELEVEN 100元數位商品禮券,https://example.com/redeem/SAMPLE2,${TEMPLATE_SAMPLE_CODES[1]},100,2026-12-31,,,,,未兌換`,
  '',
].join('\r\n');

// 把 CSV 內的狀態文字對應成內部狀態值
function mapStatus(raw) {
  const t = String(raw || '').trim();
  if (t === '已兌換' || /redeem/i.test(t)) return 'redeemed';
  if (t === '已圈存' || /earmark|hold|reserv/i.test(t)) return 'earmarked';
  return 'available'; // 未兌換／空白
}

/**
 * 把 CSV buffer 解成字串，處理 Windows 上常見的編碼：
 * - UTF-8（含 BOM）
 * - UTF-16 LE/BE（Excel「Unicode 文字」）
 * - Big5/CP950（繁中 Windows Excel 存「CSV (逗號分隔)」的 ANSI 預設）
 */
function decodeCsvBuffer(buffer) {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return iconv.decode(buffer, 'utf16-le');
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return iconv.decode(buffer, 'utf16-be');
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.toString('utf8');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return iconv.decode(buffer, 'cp950'); // 非合法 UTF-8，視為 Big5（CP950）
  }
}

function normalizeHeader(h) {
  return String(h || '')
    .replace(/^﻿/, '')
    .replace(/[（(][^）)]*[）)]/g, '') // 去掉「(選填)」之類的括號註記
    .trim()
    .toLowerCase();
}

function findColumn(headers, candidates) {
  const normalized = headers.map(normalizeHeader);
  for (const cand of candidates) {
    const idx = normalized.indexOf(cand);
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * 解析禮券 CSV。
 * 優先以標頭找出禮券碼欄位；找不到符合的標頭時退回「第一欄即禮券碼」，
 * 並在第一列看起來像標頭（含中文欄名或常見英文欄名）時略過它。
 * 回傳 { rows: [{code, face_value, expires_at}], errors: [string] }
 */
function parseGiftcodeCsv(buffer) {
  const records = parse(decodeCsvBuffer(buffer), {
    bom: true,
    trim: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  if (records.length === 0) return { rows: [], errors: ['CSV 檔案沒有內容'] };

  const headers = records[0];
  let codeIdx = findColumn(headers, CODE_HEADERS);
  let valueIdx = -1;
  let expiryIdx = -1;
  let dataStart = 1;

  let giftNameIdx = -1;
  let urlIdx = -1;
  let handlerIdx = -1;
  let projectIdx = -1;
  let earmarkStartIdx = -1;
  let earmarkEndIdx = -1;
  let statusIdx = -1;
  const signoffIdx = {}; // 簽收表欄位 → 欄索引
  if (codeIdx !== -1) {
    valueIdx = findColumn(headers, VALUE_HEADERS);
    expiryIdx = findColumn(headers, EXPIRY_HEADERS);
    giftNameIdx = findColumn(headers, GIFT_NAME_HEADERS);
    urlIdx = findColumn(headers, REDEEM_URL_HEADERS);
    handlerIdx = findColumn(headers, HANDLER_HEADERS);
    projectIdx = findColumn(headers, PROJECT_HEADERS);
    earmarkStartIdx = findColumn(headers, EARMARK_START_HEADERS);
    earmarkEndIdx = findColumn(headers, EARMARK_END_HEADERS);
    statusIdx = findColumn(headers, STATUS_HEADERS);
    for (const [field, aliases] of Object.entries(SIGNOFF_FIELDS)) {
      signoffIdx[field] = findColumn(headers, aliases);
    }
  } else {
    // 無法辨識標頭：把第一欄當禮券碼
    codeIdx = 0;
    const first = normalizeHeader(headers[0]);
    const looksLikeHeader = /[一-鿿]/.test(first) || /^(code|codes|no|number|id|name)$/.test(first);
    dataStart = looksLikeHeader ? 1 : 0;
  }

  // 去掉 Excel「文字前置符」殘留的開頭單引號（例：'YAC38 → YAC38）
  const stripTextPrefix = (s) => s.replace(/^'/, '');
  const cell = (rec, idx) => (idx !== -1 ? stripTextPrefix(String(rec[idx] || '').trim()) : '');

  const rows = [];
  const errors = [];
  const seen = new Set();
  for (let i = dataStart; i < records.length; i++) {
    const rec = records[i];
    const code = stripTextPrefix(String(rec[codeIdx] || '').trim());
    if (!code) {
      errors.push(`第 ${i + 1} 列：禮券碼為空，已略過`);
      continue;
    }
    if (TEMPLATE_SAMPLE_CODES.includes(code)) {
      errors.push(`第 ${i + 1} 列：範本範例列，已略過`);
      continue;
    }
    // 有兌換連結時以連結為唯一鍵，否則退回以禮券碼／密碼判斷檔內重複
    const redeem_url = cell(rec, urlIdx);
    const dedupKey = redeem_url || code;
    if (seen.has(dedupKey)) {
      const label = redeem_url ? `兌換連結「${redeem_url}」` : `禮券碼「${code}」`;
      errors.push(`第 ${i + 1} 列：${label}在檔案內重複，已略過`);
      continue;
    }
    seen.add(dedupKey);
    rows.push({
      code,
      redeem_url,
      face_value: cell(rec, valueIdx),
      expires_at: cell(rec, expiryIdx),
      gift_name: cell(rec, giftNameIdx),
      handler: cell(rec, handlerIdx),
      project: cell(rec, projectIdx),
      earmark_start: cell(rec, earmarkStartIdx),
      earmark_end: cell(rec, earmarkEndIdx),
      status: mapStatus(cell(rec, statusIdx)),
      ...Object.fromEntries(
        Object.keys(SIGNOFF_FIELDS).map((f) => [f, cell(rec, signoffIdx[f] ?? -1)])
      ),
    });
  }
  // 取第一個非空的 gift_name 作為整批的禮品名稱
  const gift_name = giftNameIdx !== -1
    ? (rows.find((r) => r.gift_name)?.gift_name || '')
    : '';
  return { rows, errors, gift_name };
}

module.exports = { parseGiftcodeCsv, TEMPLATE_CSV, TEMPLATE_SAMPLE_CODES };
