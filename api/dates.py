# -*- coding: utf-8 -*-
"""日期正規化（對應 Node 版 src/dates.js）。

CSV 是人工填的，同一欄可能出現 2026/8/1、2026-8-1、2026.08.01、20260801、
2026-08-01T00:00:00 等寫法；一律轉成 YYYY-MM-DD 以便與資料庫日期比較。
認不出來的（空字串、民國年、亂填）回傳空字串，由呼叫端當成「沒有期限」。
"""
import re

_COMPACT = re.compile(r"^(\d{4})(\d{2})(\d{2})$")
_SEP = re.compile(r"^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})$")


def _pad(y, m, d):
    return "%04d-%02d-%02d" % (int(y), int(m), int(d))


def normalize_date(value):
    raw = ("" if value is None else str(value)).strip()
    if not raw:
        return ""
    # 2026-08-01T00:00:00 → 取日期部分
    iso_like = re.split(r"[T ]", raw)[0]

    m = _COMPACT.match(iso_like)
    if m:
        return _pad(m.group(1), m.group(2), m.group(3))

    m = _SEP.match(iso_like)
    if m:
        mo, da = int(m.group(2)), int(m.group(3))
        if 1 <= mo <= 12 and 1 <= da <= 31:
            return _pad(m.group(1), mo, da)
    return ""
