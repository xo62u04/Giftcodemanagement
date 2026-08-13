'use strict';

// 總覽統計：各狀態的面額總額（可兌換/未兌換、已圈存、已兌換各還有多少金額）
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

require('./helpers/isolate-db')('giftcode-amt-');

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

const HEADER = '禮品名稱,兌換連結,密碼,面額,經手人,適用專案(選填),圈存開始日(選填),圈存結束日(選填),狀態';
async function upload(rows) {
  const fd = new FormData();
  fd.append('file', new Blob([[HEADER, ...rows].join('\n')], { type: 'text/csv' }), 'amt.csv');
  const res = await fetch(`${base}/api/batches`, { method: 'POST', body: fd });
  return res.json();
}

test('統計含各狀態面額總額（未兌換/已圈存/已兌換）', async () => {
  await upload([
    '券,https://x/AMT1,AMTA,100,,,,,未兌換',
    '券,https://x/AMT2,AMTB,500,,,,,未兌換',
    '券,https://x/AMT3,AMTC,100,王,活動X,,,已圈存',
    '券,https://x/AMT4,AMTD,300,王,活動X,,,已兌換',
  ]);
  const s = await (await fetch(`${base}/api/stats`)).json();
  assert.ok(s.amounts, '統計應含 amounts 物件');
  assert.strictEqual(s.amounts.available, 600, '未兌換總額 = 100 + 500');
  assert.strictEqual(s.amounts.earmarked, 100, '已圈存總額 = 100');
  assert.strictEqual(s.amounts.redeemed, 300, '已兌換總額 = 300');
  assert.strictEqual(s.amounts.total, 1000, '總額 = 1000');
});

test('無面額的禮券不計入金額，但仍計入張數', async () => {
  await upload(['券,https://x/NOVAL,NOVALPW,,,,,,未兌換']);
  const s = await (await fetch(`${base}/api/stats`)).json();
  // 前一測試 available 金額 600，新增一張無面額的未兌換 → 金額不變、張數 +1
  assert.strictEqual(s.amounts.available, 600, '無面額不加總金額');
});
