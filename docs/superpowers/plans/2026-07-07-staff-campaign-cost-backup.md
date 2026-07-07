# 同仁管理、活動成本統計、DB 備份 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增部門同仁管理、Windows 登入自動偵測、活動預算成本統計、每日 DB 自動備份。

**Architecture:** 後端拆出兩個新 Express Router 模組（`src/staff.js`、`src/backup.js`），`src/db.js` 做 schema migration，`src/server.js` 更新活動路由並掛載新模組；前端在現有 HTML/JS 架構上新增分頁與 UI 元件，不引入任何框架。

**Tech Stack:** Node.js (built-in `os`, `node:test`), Express 4, better-sqlite3, vanilla JS/HTML/CSS

## Global Constraints

- 不安裝任何新 npm 套件
- 所有文字介面維持繁體中文
- 不破壞現有 API（現有 `GET /api/campaigns` 回應新增欄位，不移除舊欄位）
- 備份只在 `require.main === module` 時啟動排程（不在測試中執行）
- `face_value` 解析失敗不拋錯，回傳 `null` 並在統計中計為「無面額」

---

## File Map

| 動作 | 路徑 |
|------|------|
| Modify | `src/db.js` |
| Create | `src/staff.js` |
| Create | `src/backup.js` |
| Modify | `src/server.js` |
| Modify | `public/index.html` |
| Modify | `public/app.js` |
| Modify | `public/style.css` |
| Create | `tests/staff.test.js` |
| Create | `tests/backup.test.js` |
| Create | `tests/campaigns-cost.test.js` |

---

## Task 1: DB Schema Migration

**Files:**
- Modify: `src/db.js`
- Test: `tests/schema.test.js` (create)

**Interfaces:**
- Produces: `db` module exports same Database instance; `staff` table exists; `campaigns` has `planned_count`, `budget`

- [ ] **Step 1: 建立測試檔**

建立 `tests/schema.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// 使用暫存 DB 測試 schema
process.env.DATA_DIR = require('path').join(__dirname, '..', 'data');
const db = require('../src/db');

test('staff 表存在且有正確欄位', () => {
  const cols = db.prepare('PRAGMA table_info(staff)').all().map(c => c.name);
  assert.ok(cols.includes('id'));
  assert.ok(cols.includes('name'));
  assert.ok(cols.includes('department'));
  assert.ok(cols.includes('employee_id'));
  assert.ok(cols.includes('windows_username'));
  assert.ok(cols.includes('created_at'));
});

test('campaigns 表有 planned_count 和 budget 欄位', () => {
  const cols = db.prepare('PRAGMA table_info(campaigns)').all().map(c => c.name);
  assert.ok(cols.includes('planned_count'));
  assert.ok(cols.includes('budget'));
});
```

- [ ] **Step 2: 執行測試確認失敗**

```
node --test tests/schema.test.js
```

預期：`staff 表存在且有正確欄位` FAIL（表不存在）、`campaigns 表有 planned_count 和 budget 欄位` FAIL

- [ ] **Step 3: 更新 `src/db.js`**

將現有 `db.exec(...)` 區塊中的 `CREATE TABLE IF NOT EXISTS campaigns` 段落維持不動（相容性），在其後加入 `staff` 建表，並在 `module.exports` 前加入 migration：

```js
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'giftcodes.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT NOT NULL DEFAULT '',
  total_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  face_value TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','redeemed')),
  campaign_id INTEGER REFERENCES campaigns(id),
  redeemed_by TEXT NOT NULL DEFAULT '',
  redeemed_note TEXT NOT NULL DEFAULT '',
  redeemed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  employee_id TEXT NOT NULL DEFAULT '',
  windows_username TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_codes_status ON codes(status);
CREATE INDEX IF NOT EXISTS idx_codes_batch ON codes(batch_id);
CREATE INDEX IF NOT EXISTS idx_codes_campaign ON codes(campaign_id);
`);

// Migration: add columns to campaigns if not present (safe for existing DB)
const campaignCols = db.prepare('PRAGMA table_info(campaigns)').all().map(c => c.name);
if (!campaignCols.includes('planned_count')) {
  db.exec('ALTER TABLE campaigns ADD COLUMN planned_count INTEGER NOT NULL DEFAULT 0');
}
if (!campaignCols.includes('budget')) {
  db.exec('ALTER TABLE campaigns ADD COLUMN budget REAL NOT NULL DEFAULT 0');
}

module.exports = db;
```

- [ ] **Step 4: 執行測試確認通過**

```
node --test tests/schema.test.js
```

預期：兩個 test 都 PASS

- [ ] **Step 5: Commit**

```
git add src/db.js tests/schema.test.js
git commit -m "feat: add staff table and campaigns budget/planned_count columns"
```

---

## Task 2: Staff API

**Files:**
- Create: `src/staff.js`
- Test: `tests/staff.test.js` (create)

**Interfaces:**
- Consumes: `db` from `./db`
- Produces: Express Router exported as `module.exports`; routes: `GET /staff`, `POST /staff`, `PUT /staff/:id`, `DELETE /staff/:id`, `GET /current-user`

- [ ] **Step 1: 建立測試檔**

建立 `tests/staff.test.js`：

```js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 用獨立暫存 DB
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-staff-'));
process.env.DATA_DIR = tmpDir;
const db = require('../src/db');
const app = require('../src/server');
const http = require('http');

let server;
let baseUrl;

before(() => new Promise(res => {
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    res();
  });
}));

after(() => new Promise(res => server.close(res)));

async function req(method, path, body) {
  const url = new URL(path, baseUrl);
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('GET /api/staff 空列表', async () => {
  const { status, body } = await req('GET', '/api/staff');
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

test('POST /api/staff 新增同仁', async () => {
  const { status, body } = await req('POST', '/api/staff', {
    name: '王小明', department: '數位規劃處', employee_id: 'A99393', windows_username: 'a99393'
  });
  assert.equal(status, 201);
  assert.equal(body.name, '王小明');
  assert.equal(body.employee_id, 'A99393');
});

test('POST /api/staff 姓名為空回傳 400', async () => {
  const { status } = await req('POST', '/api/staff', { name: '' });
  assert.equal(status, 400);
});

test('PUT /api/staff/:id 編輯同仁', async () => {
  const staff = db.prepare('SELECT id FROM staff').get();
  const { status, body } = await req('PUT', `/api/staff/${staff.id}`, {
    name: '王大明', department: '數位增長部', employee_id: 'A99393', windows_username: 'a99393'
  });
  assert.equal(status, 200);
  assert.equal(body.name, '王大明');
});

test('DELETE /api/staff/:id 刪除同仁', async () => {
  const staff = db.prepare('SELECT id FROM staff').get();
  const { status } = await req('DELETE', `/api/staff/${staff.id}`);
  assert.equal(status, 200);
  const remaining = db.prepare('SELECT COUNT(*) AS n FROM staff').get().n;
  assert.equal(remaining, 0);
});

test('GET /api/current-user 回傳 windows_username', async () => {
  const { status, body } = await req('GET', '/api/current-user');
  assert.equal(status, 200);
  assert.ok(typeof body.windows_username === 'string');
  assert.equal(typeof body.matched, 'boolean');
});
```

- [ ] **Step 2: 執行測試確認失敗**

```
node --test tests/staff.test.js
```

預期：多個 FAIL（`/api/staff` 路由不存在，回傳 404）

- [ ] **Step 3: 建立 `src/staff.js`**

```js
'use strict';

const os = require('os');
const { Router } = require('express');
const db = require('./db');

const router = Router();

function getCurrentWindowsUser() {
  return (process.env.USERNAME || os.userInfo().username || '').trim();
}

router.get('/current-user', (req, res) => {
  const winUser = getCurrentWindowsUser();
  const staff = winUser
    ? db.prepare('SELECT * FROM staff WHERE LOWER(windows_username) = LOWER(?)').get(winUser)
    : null;
  res.json({
    windows_username: winUser,
    matched: Boolean(staff),
    staff: staff || null,
  });
});

router.get('/staff', (req, res) => {
  res.json(db.prepare('SELECT * FROM staff ORDER BY name').all());
});

router.post('/staff', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '姓名不可為空' });
  const result = db.prepare(
    'INSERT INTO staff (name, department, employee_id, windows_username) VALUES (?, ?, ?, ?)'
  ).run(
    name,
    String(req.body.department || '').trim(),
    String(req.body.employee_id || '').trim(),
    String(req.body.windows_username || '').trim()
  );
  res.status(201).json(db.prepare('SELECT * FROM staff WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/staff/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM staff WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '找不到此同仁' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '姓名不可為空' });
  db.prepare(
    'UPDATE staff SET name = ?, department = ?, employee_id = ?, windows_username = ? WHERE id = ?'
  ).run(
    name,
    String(req.body.department || '').trim(),
    String(req.body.employee_id || '').trim(),
    String(req.body.windows_username || '').trim(),
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM staff WHERE id = ?').get(req.params.id));
});

router.delete('/staff/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM staff WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '找不到此同仁' });
  db.prepare('DELETE FROM staff WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
```

- [ ] **Step 4: 掛載 router 到 `src/server.js`**

在 `src/server.js` 頂部 `require` 區塊後加入：

```js
const staffRouter = require('./staff');
```

在 `app.use(express.json())` 之後加入：

```js
app.use('/api', staffRouter);
```

- [ ] **Step 5: 執行測試確認通過**

```
node --test tests/staff.test.js
```

預期：所有 test PASS

- [ ] **Step 6: Commit**

```
git add src/staff.js src/server.js tests/staff.test.js
git commit -m "feat: add staff CRUD API and Windows current-user detection"
```

---

## Task 3: Campaign Cost API

**Files:**
- Modify: `src/server.js` (parseFaceValue + 更新 campaigns routes)
- Test: `tests/campaigns-cost.test.js` (create)

**Interfaces:**
- Consumes: `db` with `campaigns.planned_count`, `campaigns.budget`, `codes.face_value`
- Produces: `GET /api/campaigns` 回應新增 `cost: number`, `remaining: number | null`；新增 `PUT /api/campaigns/:id`

- [ ] **Step 1: 建立測試檔**

建立 `tests/campaigns-cost.test.js`：

```js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-camp-'));
process.env.DATA_DIR = tmpDir;
const db = require('../src/db');
const app = require('../src/server');
const http = require('http');

let server;
let baseUrl;

before(() => new Promise(res => {
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    res();
  });
}));

after(() => new Promise(res => server.close(res)));

async function req(method, path, body) {
  const url = new URL(path, baseUrl);
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('parseFaceValue 可解析各種格式', () => {
  // 直接測試 helper（從 server 模組取出）
  const { parseFaceValue } = require('../src/server');
  assert.equal(parseFaceValue('200'), 200);
  assert.equal(parseFaceValue('$200'), 200);
  assert.equal(parseFaceValue('200元'), 200);
  assert.equal(parseFaceValue('NT$1,500'), 1500);
  assert.equal(parseFaceValue(''), null);
  assert.equal(parseFaceValue(null), null);
  assert.equal(parseFaceValue('abc'), null);
});

test('POST /api/campaigns 可新增含預算的活動', async () => {
  const { status, body } = await req('POST', '/api/campaigns', {
    name: '週年慶', planned_count: 100, budget: 20000
  });
  assert.equal(status, 201);
  assert.equal(body.planned_count, 100);
  assert.equal(body.budget, 20000);
});

test('GET /api/campaigns 包含 cost 與 remaining', async () => {
  const { status, body } = await req('GET', '/api/campaigns');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  const camp = body.find(c => c.name === '週年慶');
  assert.ok(camp);
  assert.equal(typeof camp.cost, 'number');
  assert.equal(camp.remaining, 20000); // 尚無兌換，cost = 0
});

test('PUT /api/campaigns/:id 可編輯活動', async () => {
  const camp = db.prepare('SELECT id FROM campaigns WHERE name = ?').get('週年慶');
  const { status, body } = await req('PUT', `/api/campaigns/${camp.id}`, {
    name: '週年慶 2026', planned_count: 150, budget: 25000
  });
  assert.equal(status, 200);
  assert.equal(body.name, '週年慶 2026');
  assert.equal(body.budget, 25000);
});
```

- [ ] **Step 2: 執行測試確認失敗**

```
node --test tests/campaigns-cost.test.js
```

預期：`parseFaceValue` FAIL（未 export）、`PUT /api/campaigns/:id` FAIL（404）

- [ ] **Step 3: 更新 `src/server.js`**

在 `const nowIso = ...` 後加入：

```js
function parseFaceValue(str) {
  if (!str) return null;
  const m = String(str).replace(/,/g, '').match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
```

將現有 `app.get('/api/campaigns', ...)` 替換為：

```js
app.get('/api/campaigns', (req, res) => {
  const campaigns = db.prepare(`
    SELECT c.*, COUNT(k.id) AS redeemed_count
    FROM campaigns c LEFT JOIN codes k ON k.campaign_id = c.id AND k.status = 'redeemed'
    GROUP BY c.id ORDER BY c.created_at DESC
  `).all();

  const costRows = db.prepare(`
    SELECT campaign_id, face_value
    FROM codes
    WHERE status = 'redeemed' AND campaign_id IS NOT NULL
  `).all();
  const costMap = {};
  for (const row of costRows) {
    const v = parseFaceValue(row.face_value);
    if (v !== null) costMap[row.campaign_id] = (costMap[row.campaign_id] || 0) + v;
  }

  res.json(campaigns.map(c => ({
    ...c,
    cost: costMap[c.id] || 0,
    remaining: c.budget > 0 ? c.budget - (costMap[c.id] || 0) : null,
  })));
});
```

將現有 `app.post('/api/campaigns', ...)` 替換為：

```js
app.post('/api/campaigns', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '活動名稱不可為空' });
  try {
    const result = db.prepare(
      'INSERT INTO campaigns (name, planned_count, budget) VALUES (?, ?, ?)'
    ).run(name, Number(req.body.planned_count) || 0, Number(req.body.budget) || 0);
    res.status(201).json(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: '活動名稱已存在' });
    throw err;
  }
});
```

在 `app.post('/api/campaigns', ...)` 之後新增：

```js
app.put('/api/campaigns/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM campaigns WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '找不到此活動' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '活動名稱不可為空' });
  try {
    db.prepare(
      'UPDATE campaigns SET name = ?, planned_count = ?, budget = ? WHERE id = ?'
    ).run(name, Number(req.body.planned_count) || 0, Number(req.body.budget) || 0, req.params.id);
    res.json(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id));
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: '活動名稱已存在' });
    throw err;
  }
});
```

將 `src/server.js` 最後一行 `module.exports = app` 改為：

```js
app.parseFaceValue = parseFaceValue; // export for testing
module.exports = app;
```

- [ ] **Step 4: 執行測試確認通過**

```
node --test tests/campaigns-cost.test.js
```

預期：所有 test PASS

- [ ] **Step 5: Commit**

```
git add src/server.js tests/campaigns-cost.test.js
git commit -m "feat: campaign cost calculation and PUT /api/campaigns/:id"
```

---

## Task 4: DB Backup Module

**Files:**
- Create: `src/backup.js`
- Test: `tests/backup.test.js` (create)
- Modify: `src/server.js` (掛載 + 啟動排程)

**Interfaces:**
- Consumes: `db` (`settings` table), `DATA_DIR` env var
- Produces: Express Router at `module.exports.router`; `scheduleDailyBackup()`, `tryBackup()` at named exports

- [ ] **Step 1: 建立測試檔**

建立 `tests/backup.test.js`：

```js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-bak-'));
process.env.DATA_DIR = tmpDir;
const db = require('../src/db');
const app = require('../src/server');
const http = require('http');

let server;
let baseUrl;
let backupDir;

before(() => new Promise(res => {
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-bak-dest-'));
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    res();
  });
}));

after(() => new Promise(res => server.close(res)));

async function req(method, path, body) {
  const url = new URL(path, baseUrl);
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('GET /api/backup/config 未設定時回傳 configured: false', async () => {
  const { status, body } = await req('GET', '/api/backup/config');
  assert.equal(status, 200);
  assert.equal(body.configured, false);
});

test('PUT /api/backup/config 儲存備份路徑', async () => {
  const { status, body } = await req('PUT', '/api/backup/config', { backup_dir: backupDir });
  assert.equal(status, 200);
  assert.equal(body.configured, true);
  assert.equal(body.backup_dir, backupDir);
});

test('POST /api/backup 產生備份檔案', async () => {
  const { status, body } = await req('POST', '/api/backup');
  assert.equal(status, 200);
  assert.ok(body.ok);
  assert.ok(fs.existsSync(body.dest), `備份檔案應存在：${body.dest}`);
});

test('GET /api/backup/config 顯示備份清單', async () => {
  const { status, body } = await req('GET', '/api/backup/config');
  assert.equal(status, 200);
  assert.ok(body.files.length > 0);
});

test('POST /api/backup 未設路徑時回傳 400', async () => {
  // 清除設定
  db.prepare("DELETE FROM settings WHERE key = 'backup_dir'").run();
  const { status } = await req('POST', '/api/backup');
  assert.equal(status, 400);
});
```

- [ ] **Step 2: 執行測試確認失敗**

```
node --test tests/backup.test.js
```

預期：所有 test FAIL（路由不存在）

- [ ] **Step 3: 建立 `src/backup.js`**

```js
'use strict';

const fs = require('fs');
const path = require('path');
const { Router } = require('express');
const db = require('./db');

const router = Router();
const DB_PATH = path.join(
  process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  'giftcodes.db'
);

function getBackupDir() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'backup_dir'").get();
  return (row && row.value.trim()) ? row.value.trim() : '';
}

function setBackupDir(dir) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('backup_dir', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(dir || '').trim());
}

function listBackupFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^giftcodes-backup-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .reverse();
}

function doBackup() {
  const dir = getBackupDir();
  if (!dir) throw Object.assign(new Error('尚未設定備份資料夾'), { status: 400 });
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {
      throw Object.assign(new Error(`備份資料夾無法建立：${dir}`), { status: 400 });
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  const dest = path.join(dir, `giftcodes-backup-${date}.db`);
  db.pragma('wal_checkpoint(PASSIVE)');
  fs.copyFileSync(DB_PATH, dest);

  const files = listBackupFiles(dir);
  for (const f of files.slice(30)) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
  }
  return { dest, date };
}

function tryBackup() {
  try {
    const result = doBackup();
    console.log(`[備份] 已備份至 ${result.dest}`);
  } catch (err) {
    if (err.status !== 400) console.error(`[備份] 失敗：${err.message}`);
  }
}

function scheduleDailyBackup() {
  const now = new Date();
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  setTimeout(() => {
    tryBackup();
    setInterval(tryBackup, 24 * 60 * 60 * 1000).unref();
  }, next - now).unref();
}

router.get('/backup/config', (req, res) => {
  const dir = getBackupDir();
  res.json({
    backup_dir: dir || null,
    configured: Boolean(dir),
    dir_exists: Boolean(dir) && fs.existsSync(dir),
    files: listBackupFiles(dir).slice(0, 10),
  });
});

router.put('/backup/config', (req, res) => {
  setBackupDir(req.body.backup_dir);
  const dir = getBackupDir();
  res.json({
    backup_dir: dir || null,
    configured: Boolean(dir),
    dir_exists: Boolean(dir) && fs.existsSync(dir),
    files: listBackupFiles(dir).slice(0, 10),
  });
});

router.post('/backup', (req, res) => {
  try {
    const result = doBackup();
    res.json({ ok: true, dest: result.dest, date: result.date });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = { router, scheduleDailyBackup, tryBackup };
```

- [ ] **Step 4: 掛載 backup router 到 `src/server.js`**

在 `staffRouter` require 旁加入：

```js
const { router: backupRouter, scheduleDailyBackup, tryBackup } = require('./backup');
```

在 `app.use('/api', staffRouter)` 後加入：

```js
app.use('/api', backupRouter);
```

在 `server.js` 末尾 `if (require.main === module)` 區塊的 `app.listen(...)` callback 中加入：

```js
tryBackup();
scheduleDailyBackup();
```

- [ ] **Step 5: 執行測試確認通過**

```
node --test tests/backup.test.js
```

預期：所有 test PASS

- [ ] **Step 6: 執行所有測試確認沒有 regression**

```
node --test tests/schema.test.js tests/staff.test.js tests/campaigns-cost.test.js tests/backup.test.js
```

預期：全部 PASS

- [ ] **Step 7: Commit**

```
git add src/backup.js src/server.js tests/backup.test.js
git commit -m "feat: daily DB backup with NAS path config and manual trigger"
```

---

## Task 5: Frontend — User Badge + Staff Management Tab

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `GET /api/current-user`, `GET /api/staff`, `POST /api/staff`, `PUT /api/staff/:id`, `DELETE /api/staff/:id`

- [ ] **Step 1: 更新 `public/index.html`**

將 `<header class="topbar">` 改為：

```html
<header class="topbar">
  <h1>🎁 電子禮券管理後台</h1>
  <nav>
    <button class="tab-btn active" data-tab="overview">總覽</button>
    <button class="tab-btn" data-tab="codes">禮券管理</button>
    <button class="tab-btn" data-tab="upload">上傳 CSV</button>
    <button class="tab-btn" data-tab="bulk">批次兌換</button>
    <button class="tab-btn" data-tab="batches">上傳紀錄</button>
    <button class="tab-btn" data-tab="staff">同仁管理</button>
  </nav>
  <div id="current-user-badge" class="user-badge">載入中…</div>
</header>
```

在 `</main>` 前（上傳紀錄 section 後）加入同仁管理 section：

```html
<!-- 同仁管理 -->
<section id="tab-staff" class="tab">
  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
    <h2 style="margin:0">部門同仁</h2>
    <button class="btn" id="btn-add-staff">新增同仁</button>
  </div>
  <table class="data-table">
    <thead>
      <tr><th>姓名</th><th>部門</th><th>工號（原編）</th><th>Windows 帳號</th><th>操作</th></tr>
    </thead>
    <tbody id="staff-body"><tr><td colspan="5" class="empty">載入中…</td></tr></tbody>
  </table>
</section>
```

在 `<!-- 兌換對話框 -->` 前加入同仁對話框：

```html
<!-- 同仁對話框 -->
<dialog id="staff-dialog">
  <form id="staff-form" method="dialog" class="card-form">
    <h2 id="staff-dialog-title">新增同仁</h2>
    <input type="hidden" id="staff-id">
    <label>姓名 <input type="text" id="staff-name" required placeholder="例：王小明"></label>
    <label>部門 <input type="text" id="staff-dept" placeholder="例：數位規劃處"></label>
    <label>工號（原編）<input type="text" id="staff-empid" placeholder="例：A99393"></label>
    <label>Windows 登入帳號 <input type="text" id="staff-winuser" placeholder="例：A99393"></label>
    <div class="dialog-actions">
      <button type="button" class="btn btn-secondary" id="staff-cancel">取消</button>
      <button type="submit" class="btn">儲存</button>
    </div>
  </form>
</dialog>
```

- [ ] **Step 2: 在 `public/style.css` 加入 user badge 樣式**

在檔案末尾加入：

```css
.user-badge {
  margin-left: auto;
  font-size: 0.85rem;
  color: #e2e8f0;
  white-space: nowrap;
  padding: 4px 10px;
  background: rgba(255,255,255,0.15);
  border-radius: 20px;
}
```

- [ ] **Step 3: 在 `public/app.js` 加入同仁管理邏輯**

在檔案末尾加入：

```js
// ---- 目前使用者 ----
let currentUser = null;

async function loadCurrentUser() {
  try {
    currentUser = await api('/api/current-user');
    const name = currentUser.staff
      ? `${currentUser.staff.name}（${currentUser.staff.employee_id || currentUser.windows_username}）`
      : `未知帳號（${currentUser.windows_username}）`;
    $('#current-user-badge').textContent = name;
    autoFillUserFields();
  } catch {
    $('#current-user-badge').textContent = '–';
  }
}

function autoFillUserFields() {
  if (!currentUser) return;
  const displayName = currentUser.staff ? currentUser.staff.name : currentUser.windows_username;
  ['#upload-by', '#bulk-by', '#redeem-by'].forEach(sel => {
    const el = $(sel);
    if (el && !el.value) el.value = displayName;
  });
}

// ---- 同仁管理 ----
async function loadStaff() {
  try {
    const staff = await api('/api/staff');
    const body = $('#staff-body');
    body.innerHTML = staff.length
      ? staff.map(s => `<tr>
          <td>${escapeHtml(s.name)}</td>
          <td>${escapeHtml(s.department)}</td>
          <td>${escapeHtml(s.employee_id)}</td>
          <td>${escapeHtml(s.windows_username)}</td>
          <td>
            <button class="btn btn-small" data-action="edit-staff" data-id="${s.id}">編輯</button>
            <button class="btn btn-small btn-danger" data-action="del-staff" data-id="${s.id}" data-name="${escapeHtml(s.name)}">刪除</button>
          </td>
        </tr>`).join('')
      : '<tr><td colspan="5" class="empty">尚無同仁資料</td></tr>';
  } catch (err) {
    toast(err.message, true);
  }
}

$('#btn-add-staff').addEventListener('click', () => {
  $('#staff-dialog-title').textContent = '新增同仁';
  $('#staff-id').value = '';
  $('#staff-form').reset();
  $('#staff-dialog').showModal();
});

$('#staff-cancel').addEventListener('click', () => $('#staff-dialog').close());

$('#staff-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'edit-staff') {
    const staff = await api(`/api/staff`).then(list => list.find(s => s.id == btn.dataset.id));
    if (!staff) return;
    $('#staff-dialog-title').textContent = '編輯同仁';
    $('#staff-id').value = staff.id;
    $('#staff-name').value = staff.name;
    $('#staff-dept').value = staff.department;
    $('#staff-empid').value = staff.employee_id;
    $('#staff-winuser').value = staff.windows_username;
    $('#staff-dialog').showModal();
  } else if (btn.dataset.action === 'del-staff') {
    if (!confirm(`確定刪除「${btn.dataset.name}」？`)) return;
    try {
      await api(`/api/staff/${btn.dataset.id}`, { method: 'DELETE' });
      toast('已刪除');
      loadStaff();
    } catch (err) {
      toast(err.message, true);
    }
  }
});

$('#staff-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#staff-id').value;
  const body = {
    name: $('#staff-name').value,
    department: $('#staff-dept').value,
    employee_id: $('#staff-empid').value,
    windows_username: $('#staff-winuser').value,
  };
  try {
    if (id) {
      await api(`/api/staff/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast('已更新');
    } else {
      await api('/api/staff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast('已新增');
    }
    $('#staff-dialog').close();
    loadStaff();
  } catch (err) {
    toast(err.message, true);
  }
});
```

- [ ] **Step 4: 更新分頁切換邏輯（`public/app.js`）**

找到現有的 `document.querySelectorAll('.tab-btn').forEach(...)` 區塊，在其中加入：

```js
if (btn.dataset.tab === 'staff') loadStaff();
```

- [ ] **Step 5: 在初始載入區塊加入 `loadCurrentUser()`**

找到 `// 初始載入` 區塊：

```js
// 初始載入
loadStats();
```

改為：

```js
// 初始載入
loadStats();
loadCurrentUser();
```

- [ ] **Step 6: 啟動 server 在瀏覽器驗證**

```
npm start
```

開啟 `http://localhost:3000`，確認：
- header 右上角顯示目前使用者（或「未知帳號」）
- 頂部導覽有「同仁管理」分頁
- 可新增同仁（填姓名、部門、工號、Windows 帳號）
- 可編輯、刪除同仁
- 上傳人／經手人欄位已自動帶入目前使用者名稱

- [ ] **Step 7: Commit**

```
git add public/index.html public/app.js public/style.css
git commit -m "feat: staff management tab and Windows user auto-detect in header"
```

---

## Task 6: Frontend — Campaign Cost Display + Edit Dialog

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `GET /api/campaigns`（含 `cost`, `remaining`, `planned_count`, `budget`）、`PUT /api/campaigns/:id`
- Produces: 總覽頁活動表格顯示預算資訊；可開 dialog 新增／編輯活動

- [ ] **Step 1: 更新 `public/index.html` — 活動表格**

找到：

```html
<h2>各活動使用狀況</h2>
<table class="data-table">
  <thead><tr><th>活動名稱</th><th>已兌換張數</th></tr></thead>
  <tbody id="campaign-stats"><tr><td colspan="2" class="empty">尚無活動</td></tr></tbody>
</table>
```

替換為：

```html
<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
  <h2 style="margin:0">各活動使用狀況</h2>
  <button class="btn" id="btn-add-campaign">新增活動</button>
</div>
<table class="data-table">
  <thead>
    <tr>
      <th>活動名稱</th><th>預計張數</th><th>已發張數</th>
      <th>預算</th><th>已發成本</th><th>剩餘預算</th><th>操作</th>
    </tr>
  </thead>
  <tbody id="campaign-stats"><tr><td colspan="7" class="empty">尚無活動</td></tr></tbody>
</table>
```

在同仁對話框後加入活動對話框：

```html
<!-- 活動對話框 -->
<dialog id="campaign-dialog">
  <form id="campaign-form" method="dialog" class="card-form">
    <h2 id="campaign-dialog-title">新增活動</h2>
    <input type="hidden" id="campaign-id">
    <label>活動名稱 <input type="text" id="campaign-name" required placeholder="例：週年慶抽獎"></label>
    <label>預計發送張數 <input type="number" id="campaign-planned" min="0" value="0"></label>
    <label>預算金額（元）<input type="number" id="campaign-budget" min="0" step="100" value="0"></label>
    <div class="dialog-actions">
      <button type="button" class="btn btn-secondary" id="campaign-cancel">取消</button>
      <button type="submit" class="btn">儲存</button>
    </div>
  </form>
</dialog>
```

- [ ] **Step 2: 在 `public/style.css` 加入預算超支樣式**

```css
tr.over-budget td {
  background: #fff5f5;
  color: #c53030;
}
tr.over-budget td:first-child {
  font-weight: 600;
}
```

- [ ] **Step 3: 更新 `public/app.js` — loadStats 與活動對話框**

找到 `async function loadStats()` 中 `const body = $('#campaign-stats');` 以下的部分，將整個 `body.innerHTML = ...` 替換為：

```js
const body = $('#campaign-stats');
body.innerHTML = s.campaigns.length
  ? s.campaigns.map((c) => {
      const fmt = (n) => n == null ? '–' : `$${Number(n).toLocaleString()}`;
      const over = c.remaining != null && c.remaining < 0;
      return `<tr class="${over ? 'over-budget' : ''}">
        <td>${escapeHtml(c.name)}</td>
        <td>${c.planned_count || '–'}</td>
        <td>${c.redeemed_count}</td>
        <td>${c.budget ? fmt(c.budget) : '–'}</td>
        <td>${fmt(c.cost || 0)}</td>
        <td>${c.budget ? fmt(c.remaining) : '–'}</td>
        <td><button class="btn btn-small" data-action="edit-campaign" data-id="${c.id}">編輯</button></td>
      </tr>`;
    }).join('')
  : '<tr><td colspan="7" class="empty">尚無活動</td></tr>';
```

注意：需同時更新 `GET /api/stats` 的回應使用，現有的 `loadStats` 呼叫 `/api/stats`，而 `/api/stats` 的 `campaigns` 陣列目前不含 `cost`/`remaining`/`planned_count`。需改為直接呼叫 `/api/campaigns`：

將 `async function loadStats()` 中的：
```js
const s = await api('/api/stats');
// ...
const body = $('#campaign-stats');
body.innerHTML = s.campaigns.length
  ? s.campaigns.map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${c.redeemed_count}</td></tr>`).join('')
  : '<tr><td colspan="2" class="empty">尚無活動</td></tr>';
```

改為：
```js
const [s, campaigns] = await Promise.all([api('/api/stats'), api('/api/campaigns')]);
$('#stat-total').textContent = s.total;
$('#stat-available').textContent = s.available;
$('#stat-redeemed').textContent = s.redeemed;
$('#stat-batches').textContent = s.batch_count;
const body = $('#campaign-stats');
const fmt = (n) => n == null ? '–' : `$${Number(n).toLocaleString()}`;
body.innerHTML = campaigns.length
  ? campaigns.map((c) => {
      const over = c.remaining != null && c.remaining < 0;
      return `<tr class="${over ? 'over-budget' : ''}">
        <td>${escapeHtml(c.name)}</td>
        <td>${c.planned_count || '–'}</td>
        <td>${c.redeemed_count}</td>
        <td>${c.budget ? fmt(c.budget) : '–'}</td>
        <td>${fmt(c.cost || 0)}</td>
        <td>${c.budget ? fmt(c.remaining) : '–'}</td>
        <td><button class="btn btn-small" data-action="edit-campaign" data-id="${c.id}">編輯</button></td>
      </tr>`;
    }).join('')
  : '<tr><td colspan="7" class="empty">尚無活動</td></tr>';
```

在 `loadStats` 後加入活動對話框邏輯：

```js
// ---- 活動管理 ----
$('#btn-add-campaign').addEventListener('click', () => {
  $('#campaign-dialog-title').textContent = '新增活動';
  $('#campaign-id').value = '';
  $('#campaign-form').reset();
  $('#campaign-dialog').showModal();
});

$('#campaign-cancel').addEventListener('click', () => $('#campaign-dialog').close());

$('#campaign-stats').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="edit-campaign"]');
  if (!btn) return;
  const campaigns = await api('/api/campaigns');
  const c = campaigns.find(x => x.id == btn.dataset.id);
  if (!c) return;
  $('#campaign-dialog-title').textContent = '編輯活動';
  $('#campaign-id').value = c.id;
  $('#campaign-name').value = c.name;
  $('#campaign-planned').value = c.planned_count || 0;
  $('#campaign-budget').value = c.budget || 0;
  $('#campaign-dialog').showModal();
});

$('#campaign-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#campaign-id').value;
  const body = {
    name: $('#campaign-name').value,
    planned_count: Number($('#campaign-planned').value) || 0,
    budget: Number($('#campaign-budget').value) || 0,
  };
  try {
    if (id) {
      await api(`/api/campaigns/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast('活動已更新');
    } else {
      await api('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast('活動已新增');
    }
    $('#campaign-dialog').close();
    loadStats();
  } catch (err) {
    toast(err.message, true);
  }
});
```

- [ ] **Step 4: 啟動 server 在瀏覽器驗證**

```
npm start
```

開啟 `http://localhost:3000`，確認：
- 總覽頁活動表格顯示：預計張數、已發張數、預算、已發成本、剩餘預算
- 新增活動可填預算與預計張數
- 編輯活動可修改上述欄位
- 超出預算的活動列顯示紅色

- [ ] **Step 5: Commit**

```
git add public/index.html public/app.js public/style.css
git commit -m "feat: campaign cost/budget display with edit dialog"
```

---

## Task 7: Frontend — Upload Cost Summary + Backup Config UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `GET /api/backup/config`, `PUT /api/backup/config`, `POST /api/backup`
- Produces: 上傳後顯示面額統計；上傳分頁備份設定區塊

- [ ] **Step 1: 更新 `public/index.html` — 備份設定區塊**

找到 `<div id="sync-result" class="result-box hidden"></div>` 後，加入：

```html
<form class="card-form" style="margin-top: 24px;" id="backup-form">
  <h2>DB 備份</h2>
  <p class="hint">
    填入備份目標資料夾路徑（建議指向 NAS 子目錄），每天 00:00 自動備份一次，保留最近 30 份。
  </p>
  <label>備份資料夾路徑
    <input type="text" id="backup-dir" placeholder="\\172.22.91.100\數位增長部\backup">
  </label>
  <p class="hint" id="backup-info">載入備份狀態中…</p>
  <ul id="backup-list" style="margin:4px 0 12px; padding-left:20px; font-size:0.85rem; color:#555;"></ul>
  <div class="dialog-actions" style="justify-content: flex-start;">
    <button type="submit" class="btn btn-secondary">儲存路徑</button>
    <button type="button" class="btn" id="btn-backup-now">立即備份</button>
  </div>
</form>
<div id="backup-result" class="result-box hidden"></div>
```

- [ ] **Step 2: 在 `public/app.js` 加入備份 UI 邏輯**

在 NAS 同步邏輯（`$('#btn-sync').addEventListener...`）後加入：

```js
// ---- DB 備份 ----
function renderBackupStatus(s) {
  const info = $('#backup-info');
  const dirInput = $('#backup-dir');
  if (document.activeElement !== dirInput) dirInput.value = s.backup_dir || '';
  if (!s.configured) {
    info.textContent = '尚未設定備份資料夾：填入路徑並按「儲存路徑」。';
    $('#btn-backup-now').disabled = true;
  } else {
    $('#btn-backup-now').disabled = false;
    info.textContent = s.dir_exists ? '路徑可讀取 ✓' : '⚠️ 目前無法讀取此路徑，請確認連線';
  }
  const list = $('#backup-list');
  list.innerHTML = s.files.length
    ? s.files.slice(0, 5).map(f => `<li>${escapeHtml(f)}</li>`).join('')
    : '';
}

async function loadBackupStatus() {
  try {
    renderBackupStatus(await api('/api/backup/config'));
  } catch (err) {
    $('#backup-info').textContent = err.message;
  }
}

$('#backup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const s = await api('/api/backup/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backup_dir: $('#backup-dir').value }),
    });
    $('#backup-dir').blur();
    renderBackupStatus(s);
    toast('已儲存備份路徑');
  } catch (err) {
    toast(err.message, true);
  }
});

$('#btn-backup-now').addEventListener('click', async () => {
  const box = $('#backup-result');
  const btn = $('#btn-backup-now');
  btn.disabled = true;
  btn.textContent = '備份中…';
  try {
    const r = await api('/api/backup', { method: 'POST' });
    box.classList.remove('hidden', 'error');
    box.textContent = `備份完成：${r.dest}`;
    toast('備份完成');
    loadBackupStatus();
  } catch (err) {
    box.classList.remove('hidden');
    box.classList.add('error');
    box.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '立即備份';
  }
});
```

- [ ] **Step 3: 更新 `loadSyncStatus` 的呼叫位置，同時載入備份狀態**

找到分頁切換中的：

```js
if (btn.dataset.tab === 'upload') loadSyncStatus();
```

改為：

```js
if (btn.dataset.tab === 'upload') { loadSyncStatus(); loadBackupStatus(); }
```

- [ ] **Step 4: 更新上傳 CSV 成功後顯示成本摘要**

找到 `$('#upload-form').addEventListener('submit', ...)` 中的：

```js
let html = `上傳完成：檔內共 <strong>${r.total}</strong> 筆，成功匯入 <strong>${r.imported}</strong> 筆`;
```

在這行後加入：

```js
if (r.cost_summary) {
  html += `<br>本批面額合計：<strong>$${Number(r.cost_summary.total).toLocaleString()}</strong> 元`;
  if (r.cost_summary.no_value > 0) {
    html += `（${r.cost_summary.with_value} 張有面額、${r.cost_summary.no_value} 張無面額）`;
  }
}
```

- [ ] **Step 5: 更新 `src/server.js` — 上傳 CSV 回應加入 cost_summary**

找到 `app.post('/api/batches', ...)` 中的 `res.status(201).json({...})` 部分，在回傳前計算成本：

```js
const allImported = db.prepare(
  'SELECT face_value FROM codes WHERE batch_id = ?'
).all(result.batchId);
let totalCost = 0;
let withValue = 0;
let noValue = 0;
for (const row of allImported) {
  const v = parseFaceValue(row.face_value);
  if (v !== null) { totalCost += v; withValue++; } else { noValue++; }
}

res.status(201).json({
  batch_id: result.batchId,
  total: parsed.rows.length,
  imported: result.imported,
  duplicates,
  warnings: parsed.errors,
  cost_summary: { total: totalCost, with_value: withValue, no_value: noValue },
});
```

- [ ] **Step 6: 啟動 server 在瀏覽器驗證**

```
npm start
```

開啟 `http://localhost:3000`，確認：
- 上傳分頁有「DB 備份」區塊，可設定路徑
- 「立即備份」按鈕可觸發備份並顯示檔案路徑
- 上傳 CSV 後結果框顯示「本批面額合計」
- 切換到上傳分頁時備份狀態自動載入

- [ ] **Step 7: 執行全部測試確認無 regression**

```
node --test tests/schema.test.js tests/staff.test.js tests/campaigns-cost.test.js tests/backup.test.js
```

預期：全部 PASS

- [ ] **Step 8: Commit**

```
git add public/index.html public/app.js src/server.js
git commit -m "feat: upload cost summary and backup config UI"
```
