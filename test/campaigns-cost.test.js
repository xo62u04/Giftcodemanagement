'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-campaign-'));
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
});

async function req(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('parseFaceValue extracts numeric values', () => {
  assert.equal(app.parseFaceValue('200'), 200);
  assert.equal(app.parseFaceValue('$200'), 200);
  assert.equal(app.parseFaceValue('NT$1,500'), 1500);
  assert.equal(app.parseFaceValue('200 points'), 200);
  assert.equal(app.parseFaceValue(''), null);
  assert.equal(app.parseFaceValue(null), null);
  assert.equal(app.parseFaceValue('abc'), null);
});

test('POST /api/campaigns stores planned count and budget', async () => {
  const { status, body } = await req('POST', '/api/campaigns', {
    name: 'Anniversary 2026',
    planned_count: 100,
    budget: 20000,
  });
  assert.equal(status, 201);
  assert.equal(body.planned_count, 100);
  assert.equal(body.budget, 20000);
});

test('GET /api/campaigns includes cost and remaining', async () => {
  const { status, body } = await req('GET', '/api/campaigns');
  assert.equal(status, 200);
  const campaign = body.find((c) => c.name === 'Anniversary 2026');
  assert.ok(campaign);
  assert.equal(campaign.cost, 0);
  assert.equal(campaign.remaining, 20000);
});

test('PUT /api/campaigns/:id updates campaign budget fields', async () => {
  const campaign = db.prepare('SELECT id FROM campaigns WHERE name = ?').get('Anniversary 2026');
  const { status, body } = await req('PUT', `/api/campaigns/${campaign.id}`, {
    name: 'Anniversary 2026 Updated',
    planned_count: 150,
    budget: 25000,
  });
  assert.equal(status, 200);
  assert.equal(body.name, 'Anniversary 2026 Updated');
  assert.equal(body.planned_count, 150);
  assert.equal(body.budget, 25000);
});

