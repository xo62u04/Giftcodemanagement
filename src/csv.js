'use strict';

const { parse } = require('csv-parse/sync');
const iconv = require('iconv-lite');

// 各欄位可接受的標頭名稱（不分大小寫）
const CODE_HEADERS = [
  'code', 'codes', 'giftcode', 'gift_code', 'gift code', 'voucher', 'voucher_code',
  'voucher code', 'coupon', 'coupon_code', 'serial', 'serial_no', 'sn', 'pin',
  '禮券碼', '禮券序號', '禮券代碼', '兌換碼', '序號', '卡號', '代碼',
];
const VALUE_HEADERS = ['face_value', 'facevalue', 'value', 'amount', 'price', '面額', '金額', '票面金額'];
const EXPIRY_HEADERS = ['expires_at', 'expiry', 'expire', 'expiration', 'expire_date', 'valid_until', '到期日', '有效期限', '效期'];
const GIFT_NAME_HEADERS = [
  'gift_name', 'giftname', 'gift name', 'product_name', 'productname', 'product name', 'item_name',
  '禮品名稱', '禮券名稱', '商品名稱', '品名', '禮品', '禮券',
];

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
  return String(h || '').replace(/^﻿/, '').trim().toLowerCase();
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
  if (codeIdx !== -1) {
    valueIdx = findColumn(headers, VALUE_HEADERS);
    expiryIdx = findColumn(headers, EXPIRY_HEADERS);
    giftNameIdx = findColumn(headers, GIFT_NAME_HEADERS);
  } else {
    // 無法辨識標頭：把第一欄當禮券碼
    codeIdx = 0;
    const first = normalizeHeader(headers[0]);
    const looksLikeHeader = /[一-鿿]/.test(first) || /^(code|codes|no|number|id|name)$/.test(first);
    dataStart = looksLikeHeader ? 1 : 0;
  }

  const rows = [];
  const errors = [];
  const seen = new Set();
  for (let i = dataStart; i < records.length; i++) {
    const rec = records[i];
    const code = String(rec[codeIdx] || '').trim();
    if (!code) {
      errors.push(`第 ${i + 1} 列：禮券碼為空，已略過`);
      continue;
    }
    if (seen.has(code)) {
      errors.push(`第 ${i + 1} 列：禮券碼「${code}」在檔案內重複，已略過`);
      continue;
    }
    seen.add(code);
    rows.push({
      code,
      face_value: valueIdx !== -1 ? String(rec[valueIdx] || '').trim() : '',
      expires_at: expiryIdx !== -1 ? String(rec[expiryIdx] || '').trim() : '',
      gift_name: giftNameIdx !== -1 ? String(rec[giftNameIdx] || '').trim() : '',
    });
  }
  // 取第一個非空的 gift_name 作為整批的禮品名稱
  const gift_name = giftNameIdx !== -1
    ? (rows.find((r) => r.gift_name)?.gift_name || '')
    : '';
  return { rows, errors, gift_name };
}

module.exports = { parseGiftcodeCsv };
