# -*- coding: utf-8 -*-
"""資料庫存取層——SQLite（試行）與 MSSQL（正式）共用一套 SQL。

方言差異全部收在這一支，上層（app.py／importer.py）只寫中性 SQL：

  佔位符   一律寫 `?`；MSSQL（pymssql，pyformat）在送出前轉成 `%s`
  取新 id  一律用 insert_returning_id()；SQLite 走 lastrowid，MSSQL 走 OUTPUT INSERTED.id
  時間     一律用 now_utc() 產生 ISO 字串，兩邊都吃得下，格式與 Node 版一致
  結構     schema_sql 各備一套 DDL

換引擎只需改 config.db_engine，上層一行都不用動。

注意：`?` → `%s` 是整串取代，SQL 字串常值裡不可出現 `?`（目前沒有，新增查詢時留意）。
"""
import datetime
import pathlib
import sqlite3

import config
import schema_sql

ENGINE = config.DB_ENGINE
if ENGINE not in ('sqlite', 'mssql'):
    raise RuntimeError("db_engine 只能是 'sqlite' 或 'mssql'，目前是 %r" % ENGINE)


def _to_dialect(sql):
    return sql if ENGINE == 'sqlite' else sql.replace('?', '%s')


def now_utc():
    """ISO 字串（毫秒 3 位、Z 結尾），與 Node 版 strftime('%Y-%m-%dT%H:%M:%fZ') 同格式。"""
    t = datetime.datetime.utcnow()
    return '%s.%03dZ' % (t.strftime('%Y-%m-%dT%H:%M:%S'), t.microsecond // 1000)


# ---------- 連線 ----------
class _Cursor:
    """轉方言的薄包裝；其餘行為與底層 cursor 相同。"""

    def __init__(self, cur):
        self._cur = cur

    def execute(self, sql, params=()):
        self._cur.execute(_to_dialect(sql), tuple(params))
        return self

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    @property
    def lastrowid(self):
        return self._cur.lastrowid


class _Conn:
    def __init__(self, conn):
        self._conn = conn

    def cursor(self, as_dict=False):
        if ENGINE == 'sqlite':
            return _Cursor(self._conn.cursor())  # row_factory 已給具名列，整數索引也可用
        return _Cursor(self._conn.cursor(as_dict=as_dict))

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()


def _connect_sqlite():
    path = pathlib.Path(config.SQLITE_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10)
    conn.row_factory = sqlite3.Row
    # WAL：讀不擋寫，多人同時看列表時不會互卡（設定寫在 DB 檔上，設一次即長期有效）
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA synchronous=NORMAL')
    conn.execute('PRAGMA foreign_keys=ON')
    conn.execute('PRAGMA busy_timeout=5000')
    return conn


def _connect_mssql():
    import pymssql
    return pymssql.connect(
        server=config.DB_HOST,
        port=str(config.DB_PORT),
        user=config.DB_USER,
        password=config.DB_PASSWORD,
        database=config.DB_NAME,
        charset='UTF-8',
        autocommit=False,
    )


def get_conn():
    return _Conn(_connect_sqlite() if ENGINE == 'sqlite' else _connect_mssql())


# ---------- 結構 ----------
def _assert_sqlite_upgraded(conn):
    """擋掉「尚未升級的舊 Node DB」，給出可行動的訊息，而不是 no such column。

    舊結構（code UNIQUE、無 redeem_url）需要重建 codes 表才能升級。那段搬遷邏輯在
    Node 版 src/schema.js，這裡不重寫一份——兩份實作遲早會走鐘，資料搬遷尤其不能賭。
    """
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='codes'")
    if not cur.fetchone():
        return  # 空庫，等下建表
    cur.execute("PRAGMA table_info(codes)")
    cols = {r[1] for r in cur.fetchall()}
    missing = {'redeem_url', 'earmark_start', 'send_method'} - cols
    if missing:
        raise RuntimeError(
            "這個 SQLite 檔還是舊結構（缺少 %s）。請先用 Node 版開啟一次讓它完成升級，"
            "再讓 Python 版接手：%s" % (', '.join(sorted(missing)), config.SQLITE_PATH)
        )


def ensure_schema():
    """從空資料庫建立所有資料表（冪等）。指向既有且已升級的 DB 時全部是 no-op。"""
    statements = schema_sql.SQLITE_STATEMENTS if ENGINE == 'sqlite' else schema_sql.STATEMENTS
    conn = get_conn()
    try:
        if ENGINE == 'sqlite':
            _assert_sqlite_upgraded(conn)
        cur = conn.cursor()
        for stmt in statements:
            cur.execute(stmt)
        conn.commit()
    finally:
        conn.close()


# ---------- 查詢 ----------
def query(sql, params=()):
    """回傳 list[dict]。"""
    conn = get_conn()
    try:
        cur = conn.cursor(as_dict=True)
        cur.execute(sql, params)
        rows = cur.fetchall() or []
        if ENGINE == 'sqlite':
            rows = [dict(r) for r in rows]
        return _jsonable_rows(rows)
    finally:
        conn.close()


def insert_returning_id(cur, table, cols, values):
    """新增一列並回傳新的 id。cur 需位於交易中（呼叫端負責 commit）。"""
    collist = ",".join(cols)
    marks = ",".join(["?"] * len(cols))
    if ENGINE == 'sqlite':
        cur.execute("INSERT INTO {} ({}) VALUES ({})".format(table, collist, marks), values)
        return cur.lastrowid
    cur.execute("INSERT INTO {} ({}) OUTPUT INSERTED.id VALUES ({})".format(table, collist, marks), values)
    return cur.fetchone()[0]


def _jsonable(v):
    if isinstance(v, datetime.datetime):
        return v.strftime('%Y-%m-%dT%H:%M:%S.000Z')
    from decimal import Decimal
    if isinstance(v, Decimal):
        return float(v)
    return v


def _jsonable_rows(rows):
    return [{k: _jsonable(v) for k, v in r.items()} for r in (rows or [])]
