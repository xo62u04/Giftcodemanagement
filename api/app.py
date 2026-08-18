# -*- coding: utf-8 -*-
"""電子禮券管理後台 — Python/Flask API（取代 Node 版）。

部署：IIS + HttpPlatformHandler 直接起這支程式（見專案根目錄 web.config）；
前端靜態檔由 IIS 或本程式服務。資料庫為 MSSQL（pymssql）。

本檔為第一階段：核心流程（上傳、列表、統計、活動、匯出、簽收表匯出）。
兌換／編輯／刪除／批次／NAS 同步／備份／同仁 CRUD 於後續階段補上（見 TODO）。
"""
import getpass
import os
import re

from flask import Flask, request, jsonify, Response, send_from_directory

import config
import db
from csv_parse import parse_giftcode_csv, TEMPLATE_CSV
from importer import import_rows, get_or_create_campaign
from status import display_status, status_text

app = Flask(__name__, static_folder=None)


# ---------- 共用工具 ----------
def parse_face_value(v):
    if v is None or v == '':
        return None
    m = re.search(r'\d+(\.\d+)?', str(v).replace(',', ''))
    return float(m.group(0)) if m else None


def current_windows_user():
    try:
        return (os.environ.get('USERNAME') or getpass.getuser() or '').strip()
    except Exception:
        return ''


def _fetch_codes(q=None, batch_id=None, campaign_id=None, order='DESC'):
    where, params = [], []
    if q:
        where.append("k.code LIKE %s")
        params.append('%' + str(q).strip() + '%')
    if batch_id:
        where.append("k.batch_id=%s")
        params.append(int(batch_id))
    if campaign_id:
        where.append("k.campaign_id=%s")
        params.append(int(campaign_id))
    clause = ('WHERE ' + ' AND '.join(where)) if where else ''
    sql = ("SELECT k.*, b.filename AS batch_filename, c.name AS campaign_name "
           "FROM codes k JOIN batches b ON b.id=k.batch_id "
           "LEFT JOIN campaigns c ON c.id=k.campaign_id " + clause +
           " ORDER BY k.id " + order)
    rows = db.query(sql, tuple(params))
    for r in rows:
        r['display_status'] = display_status(r.get('status'), r.get('earmark_start'), r.get('earmark_end'))
    return rows


def _csv_response(header, lines, filename):
    body = '﻿' + ",".join(header) + "\n" + "\n".join(lines) + "\n"
    from urllib.parse import quote
    resp = Response(body, mimetype='text/csv; charset=utf-8')
    resp.headers['Content-Disposition'] = "attachment; filename=\"export.csv\"; filename*=UTF-8''%s" % quote(filename)
    return resp


def _esc(v):
    s = '' if v is None else str(v)
    return '"%s"' % s.replace('"', '""') if re.search(r'[",\n]', s) else s


# ---------- 健康檢查 ----------
@app.get('/api/health')
def health():
    info = {'ok': True, 'db_host': config.DB_HOST, 'db_name': config.DB_NAME}
    try:
        db.query("SELECT 1 AS ok")
        info['db'] = 'connected'
    except Exception as e:
        info['db'] = 'error: %s' % e
        info['ok'] = False
    return jsonify(info)


# ---------- 目前使用者 / 權限 ----------
@app.get('/api/current-user')
def current_user():
    user = current_windows_user()
    staff = None
    if user:
        rows = db.query("SELECT * FROM staff WHERE LOWER(windows_username)=LOWER(%s)", (user,))
        staff = rows[0] if rows else None
    admin_count = db.query("SELECT COUNT(*) AS n FROM staff WHERE is_admin=1")[0]['n']
    is_admin = bool(staff and staff.get('is_admin'))
    can_admin = admin_count == 0 or is_admin  # zero-admin 引導
    return jsonify(windows_username=user, matched=bool(staff), staff=staff,
                   is_admin=is_admin, can_admin=can_admin)


# ---------- 範本 ----------
@app.get('/api/template.csv')
def template_csv():
    return Response('﻿' + TEMPLATE_CSV, mimetype='text/csv; charset=utf-8',
                   headers={'Content-Disposition': "attachment; filename=\"giftcode-template.csv\""})


# ---------- 總覽統計 ----------
@app.get('/api/stats')
def stats():
    rows = db.query("SELECT status, earmark_start, earmark_end, face_value FROM codes")
    total = len(rows)
    redeemed = earmarked = 0
    amounts = {'total': 0.0, 'available': 0.0, 'earmarked': 0.0, 'redeemed': 0.0}
    for r in rows:
        ds = display_status(r.get('status'), r.get('earmark_start'), r.get('earmark_end'))
        if ds == 'redeemed':
            redeemed += 1
        elif ds == 'earmarked':
            earmarked += 1
        v = parse_face_value(r.get('face_value'))
        if v is not None:
            amounts['total'] += v
            amounts[ds] += v
    campaigns = db.query(
        "SELECT c.id, c.name, COUNT(k.id) AS redeemed_count "
        "FROM campaigns c LEFT JOIN codes k ON k.campaign_id=c.id AND k.status='redeemed' "
        "GROUP BY c.id, c.name ORDER BY c.id DESC")
    batch_count = db.query("SELECT COUNT(*) AS n FROM batches")[0]['n']
    return jsonify(total=total, redeemed=redeemed, earmarked=earmarked,
                   available=total - redeemed - earmarked, amounts=amounts,
                   batch_count=batch_count, campaigns=campaigns)


# ---------- 批次：上傳 CSV ----------
@app.post('/api/batches')
def upload_batch():
    f = request.files.get('file')
    if not f:
        return jsonify(error='請選擇要上傳的 CSV 檔案'), 400
    parsed = parse_giftcode_csv(f.read())
    if not parsed['rows']:
        template_only = bool(parsed['errors']) and all('範本範例列' in e for e in parsed['errors'])
        return jsonify(error=('這是尚未填寫的 CSV 範本：請刪除範例列、填入實際禮券碼後再上傳'
                              if template_only else '檔案中找不到任何禮券碼'),
                       details=parsed['errors']), 400

    note = (request.form.get('note') or '').strip()
    uploaded_by = (request.form.get('uploaded_by') or '').strip()
    gift_name = (request.form.get('gift_name') or '').strip() or parsed['gift_name'] or ''
    filename = f.filename or 'upload.csv'  # werkzeug 已正確以 UTF-8 解出檔名，無 Node 的亂碼問題

    conn = db.get_conn()
    try:
        cur = conn.cursor()
        cur.execute("INSERT INTO batches (filename, note, uploaded_by, gift_name) "
                    "OUTPUT INSERTED.id VALUES (%s,%s,%s,%s)", (filename, note, uploaded_by, gift_name))
        batch_id = cur.fetchone()[0]
        imported, duplicates = import_rows(cur, parsed['rows'], batch_id, gift_name)
        cur.execute("UPDATE batches SET total_count=%s, imported_count=%s, duplicate_count=%s WHERE id=%s",
                    (len(parsed['rows']), imported, len(duplicates), batch_id))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    imported_rows = db.query("SELECT face_value FROM codes WHERE batch_id=%s", (batch_id,))
    total_cost = with_value = no_value = 0
    for r in imported_rows:
        v = parse_face_value(r.get('face_value'))
        if v is None:
            no_value += 1
        else:
            total_cost += v
            with_value += 1
    return jsonify(batch_id=batch_id, total=len(parsed['rows']), imported=imported,
                   duplicates=duplicates, warnings=parsed['errors'],
                   cost_summary={'total': total_cost, 'with_value': with_value, 'no_value': no_value}), 201


@app.get('/api/batches')
def list_batches():
    return jsonify(db.query(
        "SELECT b.*, "
        "(SELECT COUNT(*) FROM codes k WHERE k.batch_id=b.id) AS code_count, "
        "(SELECT COUNT(*) FROM codes k WHERE k.batch_id=b.id AND k.status='redeemed') AS redeemed_count "
        "FROM batches b ORDER BY b.id DESC"))


# ---------- 禮券查詢 ----------
@app.get('/api/codes')
def list_codes():
    q = request.args.get('q')
    status_f = request.args.get('status')
    page = max(1, int(request.args.get('page') or 1))
    page_size = min(200, max(1, int(request.args.get('page_size') or 50)))
    rows = _fetch_codes(q, request.args.get('batch_id'), request.args.get('campaign_id'))
    if status_f in ('available', 'redeemed', 'earmarked'):
        rows = [r for r in rows if r['display_status'] == status_f]
    total = len(rows)
    start = (page - 1) * page_size
    return jsonify(items=rows[start:start + page_size], total=total, page=page, page_size=page_size)


# ---------- 活動 ----------
@app.get('/api/campaigns')
def list_campaigns():
    campaigns = db.query(
        "SELECT c.*, COUNT(k.id) AS redeemed_count "
        "FROM campaigns c LEFT JOIN codes k ON k.campaign_id=c.id AND k.status='redeemed' "
        "GROUP BY c.id, c.name, c.planned_count, c.budget, c.start_date, c.end_date, c.created_at "
        "ORDER BY c.id DESC")
    cost_rows = db.query("SELECT campaign_id, face_value FROM codes WHERE status='redeemed' AND campaign_id IS NOT NULL")
    cost_map = {}
    for r in cost_rows:
        v = parse_face_value(r.get('face_value'))
        if v is not None:
            cost_map[r['campaign_id']] = cost_map.get(r['campaign_id'], 0) + v
    out = []
    for c in campaigns:
        cost = cost_map.get(c['id'], 0)
        c['cost'] = cost
        c['remaining'] = (c['budget'] - cost) if (c.get('budget') or 0) > 0 else None
        out.append(c)
    return jsonify(out)


@app.post('/api/campaigns')
def create_campaign():
    body = request.get_json(silent=True) or {}
    name = (body.get('name') or '').strip()
    if not name:
        return jsonify(error='活動名稱不可為空'), 400
    conn = db.get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT id FROM campaigns WHERE name=%s", (name,))
        if cur.fetchone():
            return jsonify(error='Campaign already exists'), 409
        cur.execute("INSERT INTO campaigns (name, planned_count, budget, start_date, end_date) "
                    "OUTPUT INSERTED.id VALUES (%s,%s,%s,%s,%s)",
                    (name, max(0, int(body.get('planned_count') or 0)),
                     max(0.0, float(body.get('budget') or 0)),
                     (body.get('start_date') or '').strip(), (body.get('end_date') or '').strip()))
        new_id = cur.fetchone()[0]
        conn.commit()
    finally:
        conn.close()
    return jsonify(db.query("SELECT * FROM campaigns WHERE id=%s", (new_id,))[0]), 201


# ---------- 匯出 ----------
@app.get('/api/export.csv')
def export_csv():
    rows = _fetch_codes(request.args.get('q'), request.args.get('batch_id'),
                        request.args.get('campaign_id'), order='ASC')
    header = ['禮品名稱', '兌換連結', '密碼', '面額', '到期日', '經手人', '適用專案',
              '圈存開始日', '圈存結束日', '狀態', '兌換時間', '備註', '批次檔名', '建立時間']
    lines = []
    for r in rows:
        lines.append(",".join(_esc(x) for x in [
            r.get('gift_name') or '', r.get('redeem_url') or '', r.get('code'), r.get('face_value'),
            r.get('expires_at'), r.get('redeemed_by'), r.get('campaign_name') or '',
            r.get('earmark_start'), r.get('earmark_end'), status_text(r['display_status']),
            r.get('redeemed_at') or '', r.get('redeemed_note'), r.get('batch_filename'), r.get('created_at'),
        ]))
    return _csv_response(header, lines, '禮券匯出.csv')


@app.get('/api/signoff.csv')
def signoff_csv():
    rows = _fetch_codes(request.args.get('q'), request.args.get('batch_id'),
                        request.args.get('campaign_id'), order='ASC')
    header = ['編號', '專案名稱', '產品名稱', 'Email/SMS', 'Mobile', 'Email', '兌換連結', '密碼',
              '發送時間', '發送狀態', '狀態更新時間', '期貨帳號', '購買人姓名', '身份證字號',
              '戶籍地址', '面額', '單位', '營業員']
    lines = []
    for i, r in enumerate(rows):
        lines.append(",".join(_esc(x) for x in [
            i + 1, r.get('campaign_name') or '', r.get('gift_name') or '', r.get('send_method'),
            r.get('recipient_mobile'), r.get('recipient_email'), r.get('redeem_url') or '', r.get('code'),
            r.get('sent_at'), r.get('send_status'), r.get('status_updated_at'), r.get('account_no'),
            r.get('recipient_name'), r.get('national_id'), r.get('address'), r.get('face_value'),
            r.get('unit'), r.get('sales_rep'),
        ]))
    return _csv_response(header, lines, '虛擬禮品贈送紀錄.csv')


# ---------- 靜態前端（本機開發；正式由 IIS 服務）----------
@app.get('/')
def index():
    return send_from_directory(config.PUBLIC_DIR, 'index.html')


@app.get('/<path:path>')
def static_files(path):
    return send_from_directory(config.PUBLIC_DIR, path)


# TODO 後續階段：/api/codes/:id/redeem、unredeem、redeem-bulk、PUT/DELETE codes、
#      DELETE batches、staff CRUD、NAS 同步、每日備份、圈存警告。

if __name__ == '__main__':
    try:
        db.ensure_schema()
        print('[schema] ensured')
    except Exception as e:
        print('[schema] 略過（DB 尚未就緒）：%s' % e)
    from waitress import serve
    print('電子禮券 API 啟動：http://127.0.0.1:%d' % config.PORT)
    serve(app, host='127.0.0.1', port=config.PORT)
