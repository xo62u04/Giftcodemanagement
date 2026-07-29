'use strict';

// 管理員角色與破壞性動作（刪除單張、刪除整批）。
// 身分以 Windows 帳號（process.env.USERNAME）比對 staff.is_admin。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

require('./helpers/isolate-db')('giftcode-admin-');

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

const HEADER = '禮品名稱,兌換連結,密碼,面額,狀態';
async function upload(rows, filename = 'a.csv') {
  const fd = new FormData();
  fd.append('file', new Blob([[HEADER, ...rows].join('\n')], { type: 'text/csv' }), filename);
  const res = await fetch(`${base}/api/batches`, { method: 'POST', body: fd });
  return res.json();
}
const asUser = (name) => { process.env.USERNAME = name; };
async function addStaff(name, isAdmin) {
  const res = await fetch(`${base}/api/staff`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, windows_username: name, is_admin: isAdmin }),
  });
  return res.json();
}

// 1) zero-admin 引導：尚無任何管理員時，任何人都能執行破壞性動作
test('尚無管理員時（引導期）任何人都能刪除', async () => {
  asUser('nobody');
  const up = await upload(['券A,https://g/BOOT1,PW_BOOT,100,未兌換']);
  const id = (await (await fetch(`${base}/api/codes?q=PW_BOOT`)).json()).items[0].id;
  const res = await fetch(`${base}/api/codes/${id}`, { method: 'DELETE' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await (await fetch(`${base}/api/codes?q=PW_BOOT`)).json()).total, 0);
});

// 2) 設定管理員後，非管理員被擋（403）
test('有管理員後，非管理員刪除回 403', async () => {
  await addStaff('boss', true); // 建立第一位管理員
  asUser('intern'); // 非管理員身分
  const up = await upload(['券B,https://g/N403,PW_403,100,未兌換']);
  const id = (await (await fetch(`${base}/api/codes?q=PW_403`)).json()).items[0].id;
  const res = await fetch(`${base}/api/codes/${id}`, { method: 'DELETE' });
  assert.strictEqual(res.status, 403);
  // 仍在
  assert.strictEqual((await (await fetch(`${base}/api/codes?q=PW_403`)).json()).total, 1);
});

// 3) 管理員可刪單張（含已兌換）
test('管理員可刪除單張禮券，已兌換也可刪並回報', async () => {
  asUser('boss');
  await upload(['券C,https://g/DEL1,PW_DEL,100,已兌換']);
  const id = (await (await fetch(`${base}/api/codes?q=PW_DEL`)).json()).items[0].id;
  const res = await fetch(`${base}/api/codes/${id}`, { method: 'DELETE' });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.was_redeemed, true);
  assert.strictEqual((await (await fetch(`${base}/api/codes?q=PW_DEL`)).json()).total, 0);
});

// 4) 刪除整批：連同該批所有禮券一起刪，回傳計數
test('管理員刪除整批會連同禮券一起刪，並回傳張數與已兌換數', async () => {
  asUser('boss');
  const batch = await upload([
    '券D,https://g/BAT1,PW_B1,100,已兌換',
    '券D,https://g/BAT2,PW_B2,100,未兌換',
    '券D,https://g/BAT3,PW_B3,100,已圈存',
  ], 'batch.csv');
  const res = await fetch(`${base}/api/batches/${batch.batch_id}`, { method: 'DELETE' });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.deleted_codes, 3);
  assert.strictEqual(body.redeemed_count, 1);
  // 批次與禮券都不見了
  assert.strictEqual((await (await fetch(`${base}/api/codes?q=PW_B2`)).json()).total, 0);
  const batches = await (await fetch(`${base}/api/batches`)).json();
  assert.ok(!batches.some((b) => b.id === batch.batch_id));
});

// 5) GET /api/batches 帶回 code_count / redeemed_count
test('批次列表帶回 code_count 與 redeemed_count', async () => {
  asUser('boss');
  await upload(['券E,https://g/CNT1,PW_C1,100,已兌換', '券E,https://g/CNT2,PW_C2,100,未兌換'], 'count.csv');
  const batches = await (await fetch(`${base}/api/batches`)).json();
  const b = batches.find((x) => x.filename === 'count.csv');
  assert.strictEqual(b.code_count, 2);
  assert.strictEqual(b.redeemed_count, 1);
});

// 6) current-user 回傳 is_admin 與 can_admin
test('current-user 回傳 is_admin 與 can_admin', async () => {
  asUser('boss');
  const me = await (await fetch(`${base}/api/current-user`)).json();
  assert.strictEqual(me.is_admin, true);
  assert.strictEqual(me.can_admin, true);

  asUser('intern');
  const other = await (await fetch(`${base}/api/current-user`)).json();
  assert.strictEqual(other.is_admin, false);
  assert.strictEqual(other.can_admin, false);
});

// 7) 非管理員刪整批也被擋
test('非管理員刪除整批回 403', async () => {
  asUser('boss');
  const batch = await upload(['券F,https://g/PROT1,PW_P1,100,未兌換'], 'protected.csv');
  asUser('intern');
  const res = await fetch(`${base}/api/batches/${batch.batch_id}`, { method: 'DELETE' });
  assert.strictEqual(res.status, 403);
});
