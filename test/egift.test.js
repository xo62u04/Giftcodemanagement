'use strict';

// 電子禮券強化：每張各自的禮品名稱、兌換連結、圈存狀態、上傳套用狀態
// 對應使用者回報的四個問題（見 docs 內範本檔）。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

require('./helpers/isolate-db')('giftcode-egift-');

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

// 用 FormData 上傳（一般情況）
async function upload(content, filename = 'codes.csv') {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: 'text/csv' }), filename);
  const res = await fetch(`${base}/api/batches`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json() };
}

// 手工組 multipart，讓檔名以「原始 UTF-8 位元組」出現在 Content-Disposition，
// 重現 busboy 以 latin1 解讀中文檔名造成的亂碼情境（問題 2）。
async function uploadRawFilename(content, filename) {
  const boundary = '----egiftboundary1234';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + 'Content-Type: text/csv\r\n\r\n',
    'utf8'
  );
  const body = Buffer.concat([
    head,
    Buffer.from(content, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
  const res = await fetch(`${base}/api/batches`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  return { status: res.status, body: await res.json() };
}

const NEW_HEADER = '禮品名稱,兌換連結,密碼,面額,經手人,適用專案(選填),圈存開始日(選填),圈存結束日(選填),狀態';

// ---- 問題 1：每張禮券各自的禮品名稱 ----
test('問題1：同批不同禮品名稱應各自保留，而非整批統一', async () => {
  const rows = [
    NEW_HEADER,
    '7-ELEVEN 100元數位商品禮券,https://ibongift.com/Tickets/AAA100,P100A,100,代筆,,,,已兌換',
    '7-ELEVEN 100元數位商品禮券,https://ibongift.com/Tickets/AAA101,P100B,100,代筆,,,,已兌換',
    '7-ELEVEN 500元數位商品禮券,https://ibongift.com/Tickets/BBB500,P500A,500,代筆,,,,已兌換',
  ].join('\n');
  const { status, body } = await upload(rows, 'mix.csv');
  assert.strictEqual(status, 201);
  assert.strictEqual(body.imported, 3);

  const list = await (await fetch(`${base}/api/codes?q=P100A`)).json();
  assert.strictEqual(list.items[0].gift_name, '7-ELEVEN 100元數位商品禮券');
  const list500 = await (await fetch(`${base}/api/codes?q=P500A`)).json();
  assert.strictEqual(list500.items[0].gift_name, '7-ELEVEN 500元數位商品禮券');
});

// ---- 問題 2：中文檔名不應變亂碼 ----
test('問題2：中文檔名以 UTF-8 正確保存，不變亂碼', async () => {
  const filename = '【測試範本】100元電子禮券_CSV檔.csv';
  const csv = `${NEW_HEADER}\n名稱A,https://ibongift.com/Tickets/FN001,FNAAA,100,代筆,,,,未兌換\n`;
  const { status } = await uploadRawFilename(csv, filename);
  assert.strictEqual(status, 201);

  const batches = await (await fetch(`${base}/api/batches`)).json();
  const found = batches.find((b) => b.filename === filename);
  assert.ok(found, `批次檔名應為「${filename}」，實際：${batches.map((b) => b.filename).join(' / ')}`);
});

// ---- 問題 4：兌換連結為唯一鍵 ----
test('問題4：兌換連結相同視為重複，密碼相同但連結不同則各自匯入', async () => {
  const dupUrl = [
    NEW_HEADER,
    '禮品X,https://ibongift.com/Tickets/DUP001,SAME1,100,,,,,未兌換',
    '禮品X,https://ibongift.com/Tickets/DUP001,SAME2,100,,,,,未兌換',
  ].join('\n');
  const r1 = await upload(dupUrl, 'dupurl.csv');
  assert.strictEqual(r1.body.imported, 1, '相同兌換連結第二筆應被視為重複');

  const samePw = [
    NEW_HEADER,
    '禮品Y,https://ibongift.com/Tickets/PW111,SAMEPW,100,,,,,未兌換',
    '禮品Y,https://ibongift.com/Tickets/PW222,SAMEPW,100,,,,,未兌換',
  ].join('\n');
  const r2 = await upload(samePw, 'samepw.csv');
  assert.strictEqual(r2.body.imported, 2, '密碼相同但連結不同應各自匯入');
});

test('問題4：兌換連結出現在列表與匯出', async () => {
  const list = await (await fetch(`${base}/api/codes?q=SAMEPW`)).json();
  assert.strictEqual(list.items[0].redeem_url, 'https://ibongift.com/Tickets/PW222');

  const csv = await (await fetch(`${base}/api/export.csv?q=SAMEPW`)).text();
  assert.match(csv, /兌換連結/, '匯出標頭應含兌換連結');
  assert.match(csv, /https:\/\/ibongift\.com\/Tickets\/PW222/);
});

// ---- 問題 3：三態與圈存 ----
test('問題3：上傳套用狀態——已圈存(未過期)、已兌換、未兌換', async () => {
  const rows = [
    NEW_HEADER,
    '券,https://ibongift.com/Tickets/ST001,STRED,100,王經手,雙11活動,,,已兌換',
    '券,https://ibongift.com/Tickets/ST002,STERM,100,李經手,雙11活動,,2026-12-31,已圈存',
    '券,https://ibongift.com/Tickets/ST003,STAVA,100,,,,,未兌換',
  ].join('\n');
  const { status } = await upload(rows, 'status.csv');
  assert.strictEqual(status, 201);

  const redeemed = await (await fetch(`${base}/api/codes?q=STRED`)).json();
  assert.strictEqual(redeemed.items[0].display_status, 'redeemed');
  assert.strictEqual(redeemed.items[0].redeemed_by, '王經手');
  assert.strictEqual(redeemed.items[0].campaign_name, '雙11活動');

  const earmarked = await (await fetch(`${base}/api/codes?q=STERM`)).json();
  assert.strictEqual(earmarked.items[0].display_status, 'earmarked');
  assert.strictEqual(earmarked.items[0].campaign_name, '雙11活動');

  const avail = await (await fetch(`${base}/api/codes?q=STAVA`)).json();
  assert.strictEqual(avail.items[0].display_status, 'available');
});

test('問題3：圈存期已過且未兌換，顯示回退為未兌換', async () => {
  const rows = [
    NEW_HEADER,
    '券,https://ibongift.com/Tickets/EXP001,EXPIRE,100,,舊活動,2020-01-01,2020-12-31,已圈存',
  ].join('\n');
  await upload(rows, 'expired.csv');
  const list = await (await fetch(`${base}/api/codes?q=EXPIRE`)).json();
  assert.strictEqual(list.items[0].display_status, 'available', '過期圈存應顯示為未兌換');
});

test('問題3：無圈存日期的已圈存視為無限期圈存', async () => {
  const rows = [
    NEW_HEADER,
    '券,https://ibongift.com/Tickets/IND001,INDEF,100,,某活動,,,已圈存',
  ].join('\n');
  await upload(rows, 'indef.csv');
  const list = await (await fetch(`${base}/api/codes?q=INDEF`)).json();
  assert.strictEqual(list.items[0].display_status, 'earmarked');
});

test('問題3：狀態篩選支援已圈存，統計含已圈存張數', async () => {
  const onlyEarmarked = await (await fetch(`${base}/api/codes?status=earmarked&q=STERM`)).json();
  assert.strictEqual(onlyEarmarked.total, 1);

  const stats = await (await fetch(`${base}/api/stats`)).json();
  assert.ok(typeof stats.earmarked === 'number', '統計應含 earmarked 欄位');
  assert.ok(stats.earmarked >= 2, `至少 STERM 與 INDEF 兩張已圈存，實際 ${stats.earmarked}`);
  // 過期圈存不計入 earmarked
  assert.strictEqual(stats.total, stats.redeemed + stats.available + stats.earmarked);
});

// ---- 圈存＝「被某活動綁住、還不能釋出」----
// 判定看圈存期間本身，不看 status 欄位；期間未過（含尚未開始）就是已圈存。
const yyyymmdd = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const slash = (iso) => iso.replace(/-0?/g, '/').replace(/^\//, '');

test('圈存：期間尚未開始（起日在未來）仍算已圈存', async () => {
  await upload([
    NEW_HEADER,
    `券,https://ibongift.com/Tickets/FUT001,FUTERM,100,,未來活動,${yyyymmdd(4)},${yyyymmdd(34)},未兌換`,
  ].join('\n'), 'future-earmark.csv');
  const list = await (await fetch(`${base}/api/codes?q=FUTERM`)).json();
  assert.strictEqual(list.items[0].display_status, 'earmarked', '圈存還沒開始也應顯示已圈存');
});

test('圈存：有圈存期間但狀態欄填未兌換，仍算已圈存', async () => {
  await upload([
    NEW_HEADER,
    `券,https://ibongift.com/Tickets/NOF001,NOFLAG,100,,某活動,${yyyymmdd(-2)},${yyyymmdd(20)},未兌換`,
  ].join('\n'), 'noflag-earmark.csv');
  const list = await (await fetch(`${base}/api/codes?q=NOFLAG`)).json();
  assert.strictEqual(list.items[0].display_status, 'earmarked');
});

test('圈存：斜線日期格式也要正確判斷過期與否', async () => {
  await upload([
    NEW_HEADER,
    `券,https://ibongift.com/Tickets/SLA001,SLAOK,100,,活動A,${slash(yyyymmdd(-1))},${slash(yyyymmdd(30))},已圈存`,
    '券,https://ibongift.com/Tickets/SLA002,SLAOLD,100,,活動B,2020/1/1,2020/12/31,已圈存',
  ].join('\n'), 'slash-dates.csv');

  const ok = await (await fetch(`${base}/api/codes?q=SLAOK`)).json();
  assert.strictEqual(ok.items[0].display_status, 'earmarked', '斜線格式且未過期應為已圈存');

  const old = await (await fetch(`${base}/api/codes?q=SLAOLD`)).json();
  assert.strictEqual(old.items[0].display_status, 'available', '斜線格式且已過期應釋回未兌換');
});

test('圈存：狀態篩選只撈出圈存期尚有效的', async () => {
  const list = await (await fetch(`${base}/api/codes?status=earmarked`)).json();
  const codes = list.items.map((i) => i.code);
  assert.ok(codes.includes('FUTERM'), '尚未開始的圈存要在結果內');
  assert.ok(codes.includes('SLAOK'), '進行中的圈存要在結果內');
  assert.ok(!codes.includes('SLAOLD'), '過期的圈存不該出現');
  assert.ok(!codes.includes('EXPIRE'), '過期的圈存不該出現');
  assert.ok(list.items.every((i) => i.display_status === 'earmarked'));
});

test('圈存：取消兌換後若圈存期仍有效，回到已圈存而非未兌換', async () => {
  await upload([
    NEW_HEADER,
    `券,https://ibongift.com/Tickets/UNR001,UNRERM,100,,活動C,${yyyymmdd(-1)},${yyyymmdd(15)},未兌換`,
  ].join('\n'), 'unredeem-earmark.csv');
  const before = await (await fetch(`${base}/api/codes?q=UNRERM`)).json();
  const id = before.items[0].id;

  await fetch(`${base}/api/codes/${id}/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaign: '活動C', redeemed_by: '測試' }),
  });
  const redeemed = await (await fetch(`${base}/api/codes?q=UNRERM`)).json();
  assert.strictEqual(redeemed.items[0].display_status, 'redeemed');

  await fetch(`${base}/api/codes/${id}/unredeem`, { method: 'POST' });
  const after = await (await fetch(`${base}/api/codes?q=UNRERM`)).json();
  assert.strictEqual(after.items[0].display_status, 'earmarked', '圈存期還在，取消兌換應回到已圈存');
});

// ---- 圈存禮券要兌換前先警告（提醒，不阻擋）----
test('圈存警告：dry_run 只回報不寫入，並列出已圈存的那幾張', async () => {
  await upload([
    NEW_HEADER,
    `券,https://ibongift.com/Tickets/WRN001,WARN-圈存,100,,活動W,${yyyymmdd(-1)},${yyyymmdd(20)},未兌換`,
    '券,https://ibongift.com/Tickets/WRN002,WARN-一般,100,,,,,未兌換',
  ].join('\n'), 'warn.csv');

  const res = await fetch(`${base}/api/codes/redeem-bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes: ['WARN-圈存', 'WARN-一般'], dry_run: true }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.dry_run, true);
  assert.strictEqual(body.would_redeem_count, 2);
  assert.deepStrictEqual(body.earmarked.map((e) => e.code), ['WARN-圈存']);
  assert.ok(body.earmarked[0].earmark_end, '警告內容要帶圈存迄日給使用者看');

  // dry_run 不可以真的兌換
  const after = await (await fetch(`${base}/api/codes?q=WARN-`)).json();
  assert.ok(after.items.every((i) => i.display_status !== 'redeemed'), 'dry_run 不應寫入');
});

test('圈存警告：dry_run 不需要活動名稱', async () => {
  const res = await fetch(`${base}/api/codes/redeem-bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes: ['WARN-圈存'], dry_run: true }),
  });
  assert.strictEqual(res.status, 200);
});

test('圈存警告：只是提醒，實際兌換不會被擋下來', async () => {
  const res = await fetch(`${base}/api/codes/redeem-bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes: ['WARN-圈存'], campaign: '活動W2', redeemed_by: '測試' }),
  });
  const body = await res.json();
  assert.strictEqual(body.redeemed_count, 1, '已圈存仍應兌換成功');
  assert.deepStrictEqual(body.earmarked.map((e) => e.code), ['WARN-圈存'], '回應要標出哪幾張原本是圈存的');

  const after = await (await fetch(`${base}/api/codes?q=WARN-圈存`)).json();
  assert.strictEqual(after.items[0].display_status, 'redeemed');
  assert.strictEqual(after.items[0].campaign_name, '活動W2');
});

test('圈存警告：單張兌換 API 一樣不阻擋已圈存', async () => {
  await upload([
    NEW_HEADER,
    `券,https://ibongift.com/Tickets/WRN003,WARN-單張,100,,活動S,${yyyymmdd(-1)},${yyyymmdd(9)},未兌換`,
  ].join('\n'), 'warn-single.csv');
  const list = await (await fetch(`${base}/api/codes?q=WARN-單張`)).json();
  assert.strictEqual(list.items[0].display_status, 'earmarked');

  const res = await fetch(`${base}/api/codes/${list.items[0].id}/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaign: '活動S2', redeemed_by: '測試' }),
  });
  assert.strictEqual(res.status, 200);
});

// ---- 單張編輯（修正 CSV 打錯的內容）----
test('單張編輯：更新內容欄位並回傳更新後資料', async () => {
  await upload([
    NEW_HEADER,
    '打錯的名稱,https://ibongift.com/Tickets/EDIT001,WRONGPW,999,,,,,未兌換',
  ].join('\n'), 'edit.csv');
  const id = (await (await fetch(`${base}/api/codes?q=WRONGPW`)).json()).items[0].id;

  const res = await fetch(`${base}/api/codes/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      gift_name: '7-ELEVEN 100元數位商品禮券',
      code: 'FIXEDPW',
      redeem_url: 'https://ibongift.com/Tickets/EDIT001',
      face_value: '100',
      expires_at: '2026-12-31',
      earmark_start: '',
      earmark_end: '',
    }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.gift_name, '7-ELEVEN 100元數位商品禮券');
  assert.strictEqual(body.code, 'FIXEDPW');
  assert.strictEqual(body.face_value, '100');
  assert.strictEqual(body.expires_at, '2026-12-31');
});

test('單張編輯：兌換連結改成別張已用的連結會擋下（409）', async () => {
  await upload([
    NEW_HEADER,
    '甲,https://ibongift.com/Tickets/UNIQ_A,PWA,100,,,,,未兌換',
    '乙,https://ibongift.com/Tickets/UNIQ_B,PWB,100,,,,,未兌換',
  ].join('\n'), 'two.csv');
  const a = (await (await fetch(`${base}/api/codes?q=PWA`)).json()).items[0];

  const res = await fetch(`${base}/api/codes/${a.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: a.code, redeem_url: 'https://ibongift.com/Tickets/UNIQ_B' }),
  });
  assert.strictEqual(res.status, 409);
});

test('單張編輯：找不到禮券回傳 404，空密碼回傳 400', async () => {
  const notFound = await fetch(`${base}/api/codes/999999`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'X' }),
  });
  assert.strictEqual(notFound.status, 404);

  const id = (await (await fetch(`${base}/api/codes?q=PWB`)).json()).items[0].id;
  const empty = await fetch(`${base}/api/codes/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '  ' }),
  });
  assert.strictEqual(empty.status, 400);
});

// ---- 範本含新欄位 ----
test('範本包含兌換連結等新欄位', async () => {
  const buf = Buffer.from(await (await fetch(`${base}/api/template.csv`)).arrayBuffer());
  const text = buf.toString('utf8');
  for (const h of ['禮品名稱', '兌換連結', '密碼', '面額', '狀態']) {
    assert.ok(text.includes(h), `範本應含欄位 ${h}`);
  }
});
