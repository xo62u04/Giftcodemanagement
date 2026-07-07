'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'giftcode-sync-db-'));
const SYNC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'giftcode-sync-nas-'));
process.env.SYNC_DIR = SYNC_DIR;

const app = require('../src/server');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  fs.rmSync(SYNC_DIR, { recursive: true, force: true });
});

const postSync = async () => {
  const res = await fetch(`${base}/api/sync`, { method: 'POST' });
  return { status: res.status, body: await res.json() };
};

test('首次同步匯入 NAS 資料夾內的 CSV（含子資料夾）', async () => {
  fs.writeFileSync(path.join(SYNC_DIR, 'a.csv'), 'code\nNAS-A-001\nNAS-A-002\n');
  fs.mkdirSync(path.join(SYNC_DIR, '2026'));
  fs.writeFileSync(path.join(SYNC_DIR, '2026', 'b.csv'), '禮券碼,面額\nNAS-B-001,500\n');

  const { status, body } = await postSync();
  assert.strictEqual(status, 200);
  assert.strictEqual(body.scanned, 2);
  assert.strictEqual(body.imported_files.length, 2);
  assert.strictEqual(body.new_codes, 3);
  assert.deepStrictEqual(body.errors, []);
});

test('未變動的檔案再次同步會跳過', async () => {
  const { body } = await postSync();
  assert.strictEqual(body.skipped_files, 2);
  assert.strictEqual(body.new_codes, 0);
});

test('檔案更新後只補進新的禮券碼', async () => {
  const file = path.join(SYNC_DIR, 'a.csv');
  fs.writeFileSync(file, 'code\nNAS-A-001\nNAS-A-002\nNAS-A-003\n');
  // 確保 mtime 有變化
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);

  const { body } = await postSync();
  assert.strictEqual(body.imported_files.length, 1);
  assert.strictEqual(body.new_codes, 1);
  assert.strictEqual(body.duplicate_codes, 2);
});

test('壞掉的 CSV 回報錯誤但不影響其他檔案', async () => {
  fs.writeFileSync(path.join(SYNC_DIR, 'broken.csv'), '"never closed\nfoo');
  fs.writeFileSync(path.join(SYNC_DIR, 'good.csv'), 'code\nNAS-G-001\n');

  const { body } = await postSync();
  assert.strictEqual(body.errors.length, 1);
  assert.match(body.errors[0], /broken\.csv/);
  assert.strictEqual(body.new_codes, 1);
});

test('同步狀態列出已追蹤的檔案', async () => {
  const res = await fetch(`${base}/api/sync/status`);
  const body = await res.json();
  assert.strictEqual(body.configured, true);
  assert.strictEqual(body.dir_exists, true);
  assert.ok(body.last_synced_at);
  const paths = body.files.map((f) => f.path).sort();
  assert.deepStrictEqual(paths, ['2026/b.csv', 'a.csv', 'good.csv'].sort());
});

test('未設定 SYNC_DIR 時回傳 400', async () => {
  const saved = process.env.SYNC_DIR;
  delete process.env.SYNC_DIR;
  try {
    const { status, body } = await postSync();
    assert.strictEqual(status, 400);
    assert.match(body.error, /SYNC_DIR/);
  } finally {
    process.env.SYNC_DIR = saved;
  }
});

test('可由 API 設定同步資料夾（優先於環境變數）', async () => {
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'giftcode-sync-nas2-'));
  fs.writeFileSync(path.join(otherDir, 'other.csv'), 'code\nNAS-OTHER-001\n');
  try {
    const res = await fetch(`${base}/api/sync/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sync_dir: otherDir }),
    });
    const status = await res.json();
    assert.strictEqual(status.sync_dir, otherDir);

    const { body } = await postSync();
    assert.strictEqual(body.sync_dir, otherDir);
    assert.strictEqual(body.new_codes, 1);
  } finally {
    // 清空設定，回復為環境變數
    await fetch(`${base}/api/sync/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sync_dir: '' }),
    });
    fs.rmSync(otherDir, { recursive: true, force: true });
  }
  const status = await (await fetch(`${base}/api/sync/status`)).json();
  assert.strictEqual(status.sync_dir, SYNC_DIR);
});

test('同步匯入的禮券可以正常兌換', async () => {
  const list = await (await fetch(`${base}/api/codes?q=NAS-B-001`)).json();
  const res = await fetch(`${base}/api/codes/${list.items[0].id}/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaign: 'NAS 測試活動', redeemed_by: '測試員' }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.status, 'redeemed');
  assert.strictEqual(body.batch_filename, '2026/b.csv');
});
