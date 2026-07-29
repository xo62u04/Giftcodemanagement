'use strict';

/*
 * 日期正規化。CSV 是人工填的，同一個欄位可能出現：
 *   2026/8/1、2026-8-1、2026.08.01、20260801、2026-08-01T00:00:00
 * 一律轉成 YYYY-MM-DD，這樣才能跟 SQLite 的 date('now') 直接比較。
 * 認不出來的（空字串、民國年、亂填）回傳空字串，由呼叫端當成「沒有期限」處理。
 */
function normalizeDate(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';

  // 2026-08-01T00:00:00 → 取前面的日期部分
  const isoLike = raw.split(/[T ]/)[0];

  // 20260801
  const compact = isoLike.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return pad(compact[1], compact[2], compact[3]);

  // 2026/8/1、2026-8-1、2026.08.01
  const parts = isoLike.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (!parts) return '';

  const [, y, m, d] = parts;
  if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) return '';
  return pad(y, m, d);
}

function pad(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

module.exports = { normalizeDate };
