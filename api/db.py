# -*- coding: utf-8 -*-
"""MSSQL 連線與結構初始化（pymssql）。"""
import datetime

import pymssql

import config
import schema_sql


def get_conn():
    return pymssql.connect(
        server=config.DB_HOST,
        port=str(config.DB_PORT),
        user=config.DB_USER,
        password=config.DB_PASSWORD,
        database=config.DB_NAME,
        charset='UTF-8',
        autocommit=False,
    )


def ensure_schema():
    """從空資料庫建立所有資料表（冪等）。"""
    conn = get_conn()
    try:
        cur = conn.cursor()
        for stmt in schema_sql.STATEMENTS:
            cur.execute(stmt)
        conn.commit()
    finally:
        conn.close()


def query(sql, params=()):
    """回傳 list[dict]。"""
    conn = get_conn()
    try:
        cur = conn.cursor(as_dict=True)
        cur.execute(sql, params)
        return _jsonable_rows(cur.fetchall())
    finally:
        conn.close()


def _jsonable(v):
    if isinstance(v, datetime.datetime):
        return v.strftime('%Y-%m-%dT%H:%M:%S.000Z')
    from decimal import Decimal
    if isinstance(v, Decimal):
        return float(v)
    return v


def _jsonable_rows(rows):
    return [{k: _jsonable(v) for k, v in r.items()} for r in (rows or [])]
