# -*- coding: utf-8 -*-
"""顯示狀態判定（對應 Node 版 server.js 的 DISPLAY_STATUS 邏輯）。

已兌換維持已兌換；圈存期間內（含尚未開始、或無迄日）→ 已圈存；
圈存迄日已過而仍未兌換 → 回退為未兌換。判定看「圈存期間」而非 status 欄，
因為取消兌換或 CSV 未填圈存狀態時，序號其實仍被某活動綁著。
"""
import datetime

from dates import normalize_date


def display_status(status, earmark_start='', earmark_end='', today=None):
    if today is None:
        today = datetime.date.today().isoformat()
    if status == 'redeemed':
        return 'redeemed'
    has_period = bool((earmark_start or '').strip()) or bool((earmark_end or '').strip()) or status == 'earmarked'
    if has_period:
        end = normalize_date(earmark_end)
        if end == '' or end >= today:
            return 'earmarked'
    return 'available'


def status_text(display):
    return {'redeemed': '已兌換', 'earmarked': '已圈存'}.get(display, '未兌換')
