'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-schema-'));
process.env.DATA_DIR = tmpDir;

const db = require('../src/db');

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('staff table has required columns', () => {
  const cols = db.prepare('PRAGMA table_info(staff)').all().map((c) => c.name);
  assert.ok(cols.includes('id'));
  assert.ok(cols.includes('name'));
  assert.ok(cols.includes('department'));
  assert.ok(cols.includes('employee_id'));
  assert.ok(cols.includes('windows_username'));
  assert.ok(cols.includes('created_at'));
});

test('campaigns table has planned_count and budget columns', () => {
  const cols = db.prepare('PRAGMA table_info(campaigns)').all().map((c) => c.name);
  assert.ok(cols.includes('planned_count'));
  assert.ok(cols.includes('budget'));
});

