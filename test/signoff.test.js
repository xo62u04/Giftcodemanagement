'use strict';

// 簽收表欄位：客戶與發送資訊（購買人、期貨帳號、身分證、地址、手機、email、
// 發送方式/時間/狀態、營業員、單位），可由上傳帶入、可編輯、可匯出成簽收表格式。
// 註：身分證字號/戶籍地址/期貨帳號為敏感個資，試行版先明碼開欄，正式版（MSSQL）再強化。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

require('./helpers/isolate-db')('giftcode-signoff-');

const app = require('../src/server');
const db = require('../src/db');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const HEADER = '禮品名稱,兌換連結,密碼,面額,購買人姓名,期貨帳號,身份證字號,戶籍地址,Mobile,Email,Email/SMS,發送時間,發送狀態,狀態更新時間,單位,營業員,狀態';
async function upload(rows) {
  const fd = new FormData();
  fd.append('file', new Blob([[HEADER, ...rows].join('\n')], { type: 'text/csv' }), 'signoff.csv');
  const res = await fetch(`${base}/api/batches`, { method: 'POST', body: fd });
  return res.json();
}

test('上傳帶簽收表欄位，客戶與發送資訊正確存入', async () => {
  await upload([
    '統一超商100元虛擬商品卡,https://x/SO1,SOPW1,100,王大明,F1234567,A123456789,台北市中正區,0912345678,a@b.com,SMS,2026/08/10 09:00,已送達手機,2026/08/10 09:05,張,李營業',
  ]);
  const it = (await (await fetch(`${base}/api/codes?q=SOPW1`)).json()).items[0];
  assert.strictEqual(it.recipient_name, '王大明');
  assert.strictEqual(it.account_no, 'F1234567');
  assert.strictEqual(it.national_id, 'A123456789');
  assert.strictEqual(it.address, '台北市中正區');
  assert.strictEqual(it.recipient_mobile, '0912345678');
  assert.strictEqual(it.recipient_email, 'a@b.com');
  assert.strictEqual(it.send_method, 'SMS');
  assert.strictEqual(it.send_status, '已送達手機');
  assert.strictEqual(it.unit, '張');
  assert.strictEqual(it.sales_rep, '李營業');
});

test('匯出（依自訂欄位）：可輸出簽收所需的客戶欄位', async () => {
  // 已整合為單一「匯出」，依使用者的自訂欄位（cols）輸出；帶入簽收表需要的欄位即可報帳。
  const cols = 'campaign,name,url,code,account,recipient,nid,address,value,unit,salesrep,sendstatus';
  const csv = await (await fetch(`${base}/api/export.csv?q=SOPW1&cols=${cols}`)).text();
  const header = csv.split('\n')[0];
  for (const h of ['使用活動', '兌換連結', '密碼/序號', '期貨帳號', '兌換人', '身分證字號', '戶籍地址', '面額', '單位', '營業員', '發送狀態']) {
    assert.ok(header.includes(h), `匯出應含欄位 ${h}`);
  }
  const line = csv.split('\n').find((l) => l.includes('SOPW1'));
  assert.ok(line.includes('王大明') && line.includes('F1234567') && line.includes('李營業'));
});

test('單張編輯可更新簽收欄位（如購買人姓名、發送狀態）', async () => {
  const id = (await (await fetch(`${base}/api/codes?q=SOPW1`)).json()).items[0].id;
  const res = await fetch(`${base}/api/codes/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient_name: '陳小華', send_status: '已兌換' }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.recipient_name, '陳小華');
  assert.strictEqual(body.send_status, '已兌換');
});
