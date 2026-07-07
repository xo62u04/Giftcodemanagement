'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-backup-db-'));
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-backup-dest-'));
process.env.DATA_DIR = tmpDir;

const db = require('../src/db');
const app = require('../src/server');

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
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(backupDir, { recursive: true, force: true });
});

async function req(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('GET /api/backup/config returns unconfigured state', async () => {
  const { status, body } = await req('GET', '/api/backup/config');
  assert.equal(status, 200);
  assert.equal(body.configured, false);
  assert.equal(body.backup_dir, null);
  assert.deepEqual(body.files, []);
});

test('PUT /api/backup/config stores backup directory', async () => {
  const { status, body } = await req('PUT', '/api/backup/config', { backup_dir: backupDir });
  assert.equal(status, 200);
  assert.equal(body.configured, true);
  assert.equal(body.backup_dir, backupDir);
  assert.equal(body.dir_exists, true);
});

test('POST /api/backup copies current database', async () => {
  db.prepare('INSERT INTO campaigns (name) VALUES (?)').run('Backup Smoke');
  const { status, body } = await req('POST', '/api/backup');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(fs.existsSync(body.dest));
  assert.ok(path.basename(body.dest).startsWith('giftcodes-'));
});

