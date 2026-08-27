# -*- coding: utf-8 -*-
"""逐列匯入禮券（上傳與 NAS 同步共用），對應 Node 版 src/importer.js。

重複判定：有兌換連結時以連結為唯一鍵，否則以（無連結的）禮券碼比對。
上傳時直接套用該列狀態（已兌換／已圈存／未兌換）、經手人與適用專案，
並寫入簽收表的客戶與發送資訊。
"""
import db
from schema_sql import SIGNOFF_COLS


def get_or_create_campaign(cur, name):
    name = (name or '').strip()
    if not name:
        return None
    cur.execute("SELECT id FROM campaigns WHERE name=?", (name,))
    row = cur.fetchone()
    if row:
        return row[0]
    return db.insert_returning_id(cur, 'campaigns', ['name'], (name,))


def import_rows(cur, rows, batch_id, default_gift_name=''):
    """cur：一般（非 as_dict）cursor，位於交易中。回傳 (imported, duplicates[list])。"""
    imported = 0
    duplicates = []
    cols = (['code', 'batch_id', 'gift_name', 'redeem_url', 'face_value', 'expires_at', 'status',
             'campaign_id', 'redeemed_by', 'redeemed_note', 'redeemed_at', 'earmark_start', 'earmark_end']
            + SIGNOFF_COLS)
    insert_sql = "INSERT INTO codes ({}) VALUES ({})".format(
        ",".join(cols), ",".join(["?"] * len(cols)))

    for row in rows:
        url = row.get('redeem_url') or None
        if url:
            cur.execute("SELECT id FROM codes WHERE redeem_url=?", (url,))
        else:
            cur.execute("SELECT id FROM codes WHERE code=? AND redeem_url IS NULL", (row['code'],))
        if cur.fetchone():
            duplicates.append(row['code'])
            continue

        status = row.get('status') or 'available'
        campaign_id = None
        if status in ('redeemed', 'earmarked') and row.get('project'):
            campaign_id = get_or_create_campaign(cur, row['project'])
        redeemed_at = db.now_utc() if status == 'redeemed' else None
        handler = (row.get('handler') or '') if status in ('redeemed', 'earmarked') else ''

        vals = [
            row['code'], batch_id,
            row.get('gift_name') or default_gift_name or '',
            url,
            row.get('face_value') or '',
            row.get('expires_at') or '',
            status, campaign_id, handler, '', redeemed_at,
            row.get('earmark_start') or '', row.get('earmark_end') or '',
        ] + [row.get(c) or '' for c in SIGNOFF_COLS]
        cur.execute(insert_sql, tuple(vals))
        imported += 1

    return imported, duplicates
