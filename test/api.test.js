'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

require('./helpers/isolate-db')('giftcode-test-');

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

async function uploadCsv(content, filename = 'codes.csv') {
  const fd = new FormData();
  const payload = typeof content === 'string' ? content : new Uint8Array(content);
  fd.append('file', new Blob([payload], { type: 'text/csv' }), filename);
  fd.append('uploaded_by', '測試員');
  fd.append('note', '單元測試批次');
  const res = await fetch(`${base}/api/batches`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json() };
}

test('上傳含標頭的 CSV 並匯入禮券', async () => {
  const { status, body } = await uploadCsv('code,面額,到期日\nGIFT-001,500,2026-12-31\nGIFT-002,500,2026-12-31\nGIFT-003,1000,2026-12-31\n');
  assert.strictEqual(status, 201);
  assert.strictEqual(body.total, 3);
  assert.strictEqual(body.imported, 3);
  assert.deepStrictEqual(body.duplicates, []);
});

test('重複上傳同樣的禮券碼會被略過', async () => {
  const { status, body } = await uploadCsv('禮券碼\nGIFT-001\nGIFT-100\n');
  assert.strictEqual(status, 201);
  assert.strictEqual(body.imported, 1);
  assert.deepStrictEqual(body.duplicates, ['GIFT-001']);
});

test('無標頭的 CSV 以第一欄作為禮券碼', async () => {
  const { status, body } = await uploadCsv('NOHEAD-01\nNOHEAD-02\n');
  assert.strictEqual(status, 201);
  assert.strictEqual(body.imported, 2);
});

test('檔內重複的禮券碼會回報警告', async () => {
  const { body } = await uploadCsv('code\nDUP-01\nDUP-01\n');
  assert.strictEqual(body.imported, 1);
  assert.strictEqual(body.warnings.length, 1);
});

test('Big5（CP950）編碼的 CSV 可正確匯入中文標頭', async () => {
  const iconv = require('iconv-lite');
  const big5 = iconv.encode('禮券碼,面額\r\nBIG5-001,500\r\nBIG5-002,500\r\n', 'cp950');
  const { status, body } = await uploadCsv(big5, 'big5.csv');
  assert.strictEqual(status, 201);
  assert.strictEqual(body.imported, 2);

  const list = await (await fetch(`${base}/api/codes?q=BIG5-`)).json();
  assert.strictEqual(list.total, 2);
  assert.strictEqual(list.items[0].face_value, '500');
});

test('UTF-16 LE（含 BOM）的 CSV 可正確匯入', async () => {
  const iconv = require('iconv-lite');
  const utf16 = iconv.encode('code,面額\r\nU16-001,300\r\n', 'utf16-le', { addBOM: true });
  const { status, body } = await uploadCsv(utf16, 'utf16.csv');
  assert.strictEqual(status, 201);
  assert.strictEqual(body.imported, 1);
});

test('空檔案回傳 400', async () => {
  const { status } = await uploadCsv('code\n');
  assert.strictEqual(status, 400);
});

test('查詢禮券列表與篩選', async () => {
  const res = await fetch(`${base}/api/codes?q=GIFT-00`);
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.total, 3);
  assert.ok(body.items.every((i) => i.code.startsWith('GIFT-00')));
});

test('單筆兌換：寫入活動、經手人與時間', async () => {
  const list = await (await fetch(`${base}/api/codes?q=GIFT-001`)).json();
  const id = list.items[0].id;

  const res = await fetch(`${base}/api/codes/${id}/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaign: '週年慶抽獎', redeemed_by: '王小明', note: '中獎序號 42' }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.status, 'redeemed');
  assert.strictEqual(body.campaign_name, '週年慶抽獎');
  assert.strictEqual(body.redeemed_by, '王小明');
  assert.ok(body.redeemed_at);

  // 重複兌換要被擋下
  const again = await fetch(`${base}/api/codes/${id}/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaign: '別的活動' }),
  });
  assert.strictEqual(again.status, 409);
});

test('缺少活動名稱時兌換失敗', async () => {
  const list = await (await fetch(`${base}/api/codes?q=GIFT-002`)).json();
  const res = await fetch(`${base}/api/codes/${list.items[0].id}/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.strictEqual(res.status, 400);
});

test('批次兌換：成功、已兌換、找不到分別回報', async () => {
  const res = await fetch(`${base}/api/codes/redeem-bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      codes: ['GIFT-002', 'GIFT-001', 'NO-SUCH-CODE'],
      campaign: '聖誕活動',
      redeemed_by: '李小華',
    }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(body.redeemed, ['GIFT-002']);
  assert.deepStrictEqual(body.already_redeemed, ['GIFT-001']);
  assert.deepStrictEqual(body.not_found, ['NO-SUCH-CODE']);
});

test('取消兌換後禮券恢復可用', async () => {
  const list = await (await fetch(`${base}/api/codes?q=GIFT-002`)).json();
  const id = list.items[0].id;
  const res = await fetch(`${base}/api/codes/${id}/unredeem`, { method: 'POST' });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.status, 'available');
  assert.strictEqual(body.campaign_name, null);
  assert.strictEqual(body.redeemed_at, null);
});

test('統計數字正確', async () => {
  const stats = await (await fetch(`${base}/api/stats`)).json();
  assert.strictEqual(stats.total, 10); // GIFT-001~003, GIFT-100, NOHEAD-01~02, DUP-01, BIG5-001~002, U16-001
  assert.strictEqual(stats.redeemed, 1); // 只剩 GIFT-001（GIFT-002 已取消兌換）
  assert.strictEqual(stats.available, 9);
  const campaign = stats.campaigns.find((c) => c.name === '週年慶抽獎');
  assert.strictEqual(campaign.redeemed_count, 1);
});

test('依活動篩選並匯出 CSV', async () => {
  const campaigns = await (await fetch(`${base}/api/campaigns`)).json();
  const anniversary = campaigns.find((c) => c.name === '週年慶抽獎');

  const listRes = await fetch(`${base}/api/codes?campaign_id=${anniversary.id}&status=redeemed`);
  const list = await listRes.json();
  assert.strictEqual(list.total, 1);
  assert.strictEqual(list.items[0].code, 'GIFT-001');

  const csvRes = await fetch(`${base}/api/export.csv?campaign_id=${anniversary.id}`);
  const csv = await csvRes.text();
  assert.match(csvRes.headers.get('content-type'), /text\/csv/);
  // 新匯出欄序：禮品名稱,兌換連結,密碼,面額,到期日,經手人,適用專案,…,狀態,…
  assert.match(csv.split('\n')[0], /兌換連結/, '匯出標頭應含兌換連結');
  const line = csv.split('\n').find((l) => l.includes('GIFT-001'));
  assert.ok(line.includes('王小明') && line.includes('週年慶抽獎') && line.includes('已兌換'));
});

test('範本範例列不會被匯入，實際填寫的禮券碼不受影響', async () => {
  const { status, body } = await uploadCsv(
    '禮券碼,禮品名稱,面額,到期日\n' +
    'ABC12345678,全家便利商店500元禮券,500,2026-12-31\n' +
    'ABC12345679,全家便利商店500元禮券,500,2026-12-31\n' +
    'REAL-001,實際禮品,100,2026-12-31\n'
  );
  assert.strictEqual(status, 201);
  assert.strictEqual(body.total, 1);
  assert.strictEqual(body.imported, 1);
  assert.strictEqual(
    body.warnings.filter((w) => w.includes('範本範例列')).length,
    2
  );
});

test('GET /api/template.csv 回傳可直接被解析器吃下的範本', async () => {
  const res = await fetch(`${base}/api/template.csv`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);

  // 檢查原始位元組：UTF-8 BOM 為 EF BB BF，Excel 才不會亂碼。
  // 注意 fetch 的 res.text() 會吃掉開頭 BOM，故必須看 arrayBuffer。
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepStrictEqual([buf[0], buf[1], buf[2]], [0xef, 0xbb, 0xbf], '應以 UTF-8 BOM 開頭');

  const text = buf.toString('utf8');
  for (const header of ['禮品名稱', '兌換連結', '密碼', '面額', '狀態']) {
    assert.ok(text.includes(header), `範本應包含欄位 ${header}`);
  }

  const { parseGiftcodeCsv } = require('../src/csv');
  const parsed = parseGiftcodeCsv(buf);
  assert.deepStrictEqual(parsed.rows, [], '範本本身不應產生任何可匯入的禮券');
  assert.strictEqual(
    parsed.errors.filter((e) => e.includes('範本範例列')).length,
    2
  );
});

test('原封不動上傳範本會提示要先填寫，而不是說找不到禮券碼', async () => {
  const text = await (await fetch(`${base}/api/template.csv`)).text();
  const { status, body } = await uploadCsv(text, '禮券上傳範本.csv');
  assert.strictEqual(status, 400);
  assert.match(body.error, /範本/, '錯誤訊息應點出這是未填寫的範本');
  assert.strictEqual(body.details.filter((d) => d.includes('範本範例列')).length, 2);
});
