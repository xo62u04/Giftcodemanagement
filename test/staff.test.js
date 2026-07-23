'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { dataDir: tmpDir } = require('./helpers/isolate-db')('gift-staff-');

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

test('GET /api/staff returns an empty list initially', async () => {
  const { status, body } = await req('GET', '/api/staff');
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

test('POST /api/staff creates staff', async () => {
  const { status, body } = await req('POST', '/api/staff', {
    name: 'Alice Chen',
    department: 'Marketing',
    employee_id: 'A99393',
    windows_username: 'a99393',
  });
  assert.equal(status, 201);
  assert.equal(body.name, 'Alice Chen');
  assert.equal(body.employee_id, 'A99393');
});

test('POST /api/staff rejects missing name', async () => {
  const { status } = await req('POST', '/api/staff', { name: '' });
  assert.equal(status, 400);
});

test('PUT /api/staff/:id updates staff', async () => {
  const staff = db.prepare('SELECT id FROM staff').get();
  const { status, body } = await req('PUT', `/api/staff/${staff.id}`, {
    name: 'Alice Wang',
    department: 'Operations',
    employee_id: 'A99393',
    windows_username: 'a99393',
  });
  assert.equal(status, 200);
  assert.equal(body.name, 'Alice Wang');
  assert.equal(body.department, 'Operations');
});

test('GET /api/current-user returns Windows username and match state', async () => {
  const { status, body } = await req('GET', '/api/current-user');
  assert.equal(status, 200);
  assert.equal(typeof body.windows_username, 'string');
  assert.equal(typeof body.matched, 'boolean');
});

test('DELETE /api/staff/:id deletes staff', async () => {
  const staff = db.prepare('SELECT id FROM staff').get();
  const { status } = await req('DELETE', `/api/staff/${staff.id}`);
  assert.equal(status, 200);
  const remaining = db.prepare('SELECT COUNT(*) AS n FROM staff').get().n;
  assert.equal(remaining, 0);
});

