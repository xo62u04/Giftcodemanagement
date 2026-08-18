# -*- coding: utf-8 -*-
"""禮券 CSV 解析（對應 Node 版 src/csv.js）。

- 自動判斷編碼：UTF-16 LE/BE（BOM）、UTF-8（含 BOM）、否則 Big5/CP950。
- 以標頭找禮券碼欄；找不到時退回第一欄。
- 支援禮品名稱、兌換連結（唯一鍵）、面額、到期日、經手人、適用專案、
  圈存起訖、狀態，以及簽收表的客戶與發送資訊。
- 去除 Excel 文字前置符（開頭單引號）。
"""
import csv
import io
import re

CODE_HEADERS = [
    'code', 'codes', 'giftcode', 'gift_code', 'gift code', 'voucher', 'voucher_code',
    'voucher code', 'coupon', 'coupon_code', 'serial', 'serial_no', 'sn', 'pin',
    'password', 'pw',
    '禮券碼', '禮券序號', '禮券代碼', '兌換碼', '兌換密碼', '密碼', '序號', '卡號', '代碼',
]
VALUE_HEADERS = ['face_value', 'facevalue', 'value', 'amount', 'price', '面額', '金額', '票面金額']
EXPIRY_HEADERS = ['expires_at', 'expiry', 'expire', 'expiration', 'expire_date', 'valid_until', '到期日', '有效期限', '效期']
GIFT_NAME_HEADERS = [
    'gift_name', 'giftname', 'gift name', 'product_name', 'productname', 'product name', 'item_name',
    '禮品名稱', '禮券名稱', '商品名稱', '產品名稱', '品名', '禮品', '禮券',
]
REDEEM_URL_HEADERS = [
    'redeem_url', 'redeemurl', 'redeem url', 'redemption_url', 'url', 'link',
    '兌換連結', '兌換網址', '連結', '網址',
]
HANDLER_HEADERS = ['handler', 'redeemed_by', 'operator', '經手人', '代領人', '承辦人', '處理人']
PROJECT_HEADERS = ['project', 'campaign', 'campaign_name', '適用專案', '專案名稱', '專案', '活動', '活動名稱', '使用活動']
EARMARK_START_HEADERS = ['earmark_start', 'hold_start', '圈存開始日', '圈存起日', '圈存開始', '圈存起']
EARMARK_END_HEADERS = ['earmark_end', 'hold_end', '圈存結束日', '圈存迄日', '圈存結束', '圈存迄']
STATUS_HEADERS = ['status', 'state', '狀態']

# 簽收表：客戶與發送資訊。key = codes 欄位名，值 = 可接受的標頭
SIGNOFF_FIELDS = {
    'send_method': ['email/sms', '發送方式'],
    'recipient_mobile': ['mobile', '手機', '手機號碼', '行動電話'],
    'recipient_email': ['email', '電子郵件', '信箱'],
    'sent_at': ['發送時間'],
    'send_status': ['發送狀態'],
    'status_updated_at': ['狀態更新時間'],
    'account_no': ['期貨帳號', '帳號'],
    'recipient_name': ['購買人姓名', '購買人', '兌換人', '兌換人姓名', '客戶姓名', '姓名'],
    'national_id': ['身份證字號', '身分證字號', '身份證', '身分證'],
    'address': ['戶籍地址', '地址'],
    'unit': ['單位'],
    'sales_rep': ['營業員'],
}

TEMPLATE_SAMPLE_CODES = ['ABC12345678', 'ABC12345679']
TEMPLATE_CSV = "\r\n".join([
    '禮品名稱,兌換連結,密碼,面額,到期日(選填),經手人,適用專案(選填),圈存開始日(選填),圈存結束日(選填),狀態',
    '7-ELEVEN 100元數位商品禮券,https://example.com/redeem/SAMPLE1,%s,100,2026-12-31,,,,,未兌換' % TEMPLATE_SAMPLE_CODES[0],
    '7-ELEVEN 100元數位商品禮券,https://example.com/redeem/SAMPLE2,%s,100,2026-12-31,,,,,未兌換' % TEMPLATE_SAMPLE_CODES[1],
    '',
])

_PAREN = re.compile(r'[（(][^）)]*[）)]')
_CJK = re.compile(r'[一-鿿]')


def decode_csv_bytes(data):
    if len(data) >= 2 and data[0] == 0xff and data[1] == 0xfe:
        return data.decode('utf-16')  # 依 BOM 判 LE
    if len(data) >= 2 and data[0] == 0xfe and data[1] == 0xff:
        return data.decode('utf-16')  # 依 BOM 判 BE
    if len(data) >= 3 and data[0] == 0xef and data[1] == 0xbb and data[2] == 0xbf:
        return data.decode('utf-8-sig')
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        return data.decode('cp950', errors='replace')  # 非合法 UTF-8，視為 Big5


def normalize_header(h):
    s = ('' if h is None else str(h)).lstrip('﻿')
    s = _PAREN.sub('', s)
    return s.strip().lower()


def find_column(headers, candidates):
    normalized = [normalize_header(h) for h in headers]
    for cand in candidates:
        if cand in normalized:
            return normalized.index(cand)
    return -1


def map_status(raw):
    t = ('' if raw is None else str(raw)).strip()
    if t == '已兌換' or re.search(r'redeem', t, re.I):
        return 'redeemed'
    if t == '已圈存' or re.search(r'earmark|hold|reserv', t, re.I):
        return 'earmarked'
    return 'available'


def _strip_prefix(s):
    return s[1:] if s.startswith("'") else s


def parse_giftcode_csv(data):
    """data: bytes 或 str。回傳 dict: {rows, errors, gift_name}。"""
    text = data if isinstance(data, str) else decode_csv_bytes(data)
    text = text.lstrip('﻿')
    records = [r for r in csv.reader(io.StringIO(text)) if any((c or '').strip() for c in r)]
    if not records:
        return {'rows': [], 'errors': ['CSV 檔案沒有內容'], 'gift_name': ''}

    headers = records[0]
    code_idx = find_column(headers, CODE_HEADERS)
    value_idx = expiry_idx = gift_idx = url_idx = handler_idx = project_idx = -1
    es_idx = ee_idx = status_idx = -1
    signoff_idx = {}
    data_start = 1

    if code_idx != -1:
        value_idx = find_column(headers, VALUE_HEADERS)
        expiry_idx = find_column(headers, EXPIRY_HEADERS)
        gift_idx = find_column(headers, GIFT_NAME_HEADERS)
        url_idx = find_column(headers, REDEEM_URL_HEADERS)
        handler_idx = find_column(headers, HANDLER_HEADERS)
        project_idx = find_column(headers, PROJECT_HEADERS)
        es_idx = find_column(headers, EARMARK_START_HEADERS)
        ee_idx = find_column(headers, EARMARK_END_HEADERS)
        status_idx = find_column(headers, STATUS_HEADERS)
        for field, aliases in SIGNOFF_FIELDS.items():
            signoff_idx[field] = find_column(headers, aliases)
    else:
        code_idx = 0
        first = normalize_header(headers[0])
        looks_like_header = bool(_CJK.search(first)) or first in ('code', 'codes', 'no', 'number', 'id', 'name')
        data_start = 1 if looks_like_header else 0

    def cell(rec, idx):
        if idx is None or idx < 0 or idx >= len(rec):
            return ''
        return _strip_prefix((rec[idx] or '').strip())

    rows = []
    errors = []
    seen = set()
    for i in range(data_start, len(records)):
        rec = records[i]
        code = _strip_prefix((rec[code_idx].strip() if code_idx < len(rec) else ''))
        if not code:
            errors.append('第 %d 列：禮券碼為空，已略過' % (i + 1))
            continue
        if code in TEMPLATE_SAMPLE_CODES:
            errors.append('第 %d 列：範本範例列，已略過' % (i + 1))
            continue
        redeem_url = cell(rec, url_idx)
        dedup_key = redeem_url or code
        if dedup_key in seen:
            label = ('兌換連結「%s」' % redeem_url) if redeem_url else ('禮券碼「%s」' % code)
            errors.append('第 %d 列：%s在檔案內重複，已略過' % (i + 1, label))
            continue
        seen.add(dedup_key)
        row = {
            'code': code,
            'redeem_url': redeem_url,
            'face_value': cell(rec, value_idx),
            'expires_at': cell(rec, expiry_idx),
            'gift_name': cell(rec, gift_idx),
            'handler': cell(rec, handler_idx),
            'project': cell(rec, project_idx),
            'earmark_start': cell(rec, es_idx),
            'earmark_end': cell(rec, ee_idx),
            'status': map_status(cell(rec, status_idx)),
        }
        for field in SIGNOFF_FIELDS:
            row[field] = cell(rec, signoff_idx.get(field, -1))
        rows.append(row)

    gift_name = ''
    if gift_idx != -1:
        for r in rows:
            if r['gift_name']:
                gift_name = r['gift_name']
                break
    return {'rows': rows, 'errors': errors, 'gift_name': gift_name}
