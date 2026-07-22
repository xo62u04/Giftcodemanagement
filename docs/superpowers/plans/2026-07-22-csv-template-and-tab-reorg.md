# CSV 範本下載與頁籤重組 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓行銷人員能下載 CSV 範本填寫上傳，並把上傳表單移到「禮券管理」頁、系統設定獨立成一個頁籤。

**Architecture:** 範本內容與「範例列略過」邏輯共用 `src/csv.js` 內同一份常數，避免兩處各寫一份而漂移；`src/server.js` 新增一條下載路由，沿用既有 `/api/export.csv` 的 BOM + Content-Disposition 寫法；前端純粹搬動 DOM 節點，所有 element id 不變，因此 `app.js` 幾乎不動。

**Tech Stack:** Node.js、Express 4、better-sqlite3、csv-parse、iconv-lite；測試用 Node 內建 `node:test` + 原生 `fetch`（無 supertest、無 jest）。

## Global Constraints

- 測試指令一律 `npm test`（等同 `node --test`）；跑單一檔案用 `node --test test/<file>.js`
- 範本編碼為 UTF-8 with BOM，範本字串本身不含 BOM，BOM 由路由送出時加上
- 範例禮券碼固定為 `ABC12345678` 與 `ABC12345679`，只在 `src/csv.js` 定義一次
- 略過範例列的警告訊息文字固定為 `第 N 列：範本範例列，已略過`（測試以 `範本範例列` 子字串比對）
- 搬動 DOM 時所有 element id 不得更名（`#upload-form`、`#upload-result`、`#sync-form`、`#db-config-form` 等）
- 不變動資料庫結構，不變動 `POST /api/batches` 的請求格式與成功回應欄位

---

### Task 1: `src/csv.js` 範本常數與範例列略過

**Files:**
- Modify: `src/csv.js`（在 `GIFT_NAME_HEADERS` 之後新增常數；在 `parseGiftcodeCsv` 迴圈內新增判斷；更新 `module.exports`）
- Test: `test/api.test.js`

**Interfaces:**
- Produces: `TEMPLATE_CSV`（string，CRLF 換行，結尾含換行，不含 BOM）、`TEMPLATE_SAMPLE_CODES`（string[]），由 `src/csv.js` export，Task 2 會用到

- [ ] **Step 1: 寫失敗的測試**

加到 `test/api.test.js` 最後：

```js
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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test test/api.test.js`
Expected: FAIL —— 範例列被當成真禮券匯入，`body.total` 為 3、`imported` 為 3，`warnings` 沒有任何 `範本範例列`

- [ ] **Step 3: 新增常數**

在 `src/csv.js` 的 `GIFT_NAME_HEADERS` 定義（約第 17 行）之後插入：

```js
// 下載用的 CSV 範本。欄位名稱刻意取自上方各 *_HEADERS 清單，
// 所以範本本身就是這支解析器吃得下的格式。
const TEMPLATE_SAMPLE_CODES = ['ABC12345678', 'ABC12345679'];
const TEMPLATE_CSV = [
  '禮券碼,禮品名稱,面額,到期日',
  `${TEMPLATE_SAMPLE_CODES[0]},全家便利商店500元禮券,500,2026-12-31`,
  `${TEMPLATE_SAMPLE_CODES[1]},全家便利商店500元禮券,500,2026-12-31`,
  '',
].join('\r\n');
```

- [ ] **Step 4: 在解析迴圈加入略過判斷**

在 `parseGiftcodeCsv` 中，緊接「禮券碼為空」那段 `if` 之後、「檔案內重複」那段 `if` 之前插入：

```js
    if (TEMPLATE_SAMPLE_CODES.includes(code)) {
      errors.push(`第 ${i + 1} 列：範本範例列，已略過`);
      continue;
    }
```

- [ ] **Step 5: 更新 export**

把 `src/csv.js` 最後一行改為：

```js
module.exports = { parseGiftcodeCsv, TEMPLATE_CSV, TEMPLATE_SAMPLE_CODES };
```

- [ ] **Step 6: 跑測試確認通過**

Run: `npm test`
Expected: PASS —— 新測試通過，且既有的上傳／重複／Big5 測試全數維持通過

- [ ] **Step 7: Commit**

```bash
git add src/csv.js test/api.test.js
git commit -m "feat: CSV 範本常數與範例列自動略過"
```

---

### Task 2: `GET /api/template.csv` 下載路由

**Files:**
- Modify: `src/server.js`（第 8 行的 require；在 `/api/export.csv` 區塊結束後、`// ---- NAS 同步 ----` 之前新增路由）
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: `TEMPLATE_CSV`（Task 1）
- Produces: `GET /api/template.csv` → 200、`text/csv; charset=utf-8`、body 為 BOM + `TEMPLATE_CSV`

- [ ] **Step 1: 寫失敗的測試**

加到 `test/api.test.js` 最後。這一條同時驗證「範本下得下來」「格式解析得動」「範例列會被擋掉」，範本一改壞就會紅：

```js
test('GET /api/template.csv 回傳可直接被解析器吃下的範本', async () => {
  const res = await fetch(`${base}/api/template.csv`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);

  const text = await res.text();
  assert.ok(text.charCodeAt(0) === 0xfeff, '應以 UTF-8 BOM 開頭，Excel 才不會亂碼');
  for (const header of ['禮券碼', '禮品名稱', '面額', '到期日']) {
    assert.ok(text.includes(header), `範本應包含欄位 ${header}`);
  }

  const { parseGiftcodeCsv } = require('../src/csv');
  const parsed = parseGiftcodeCsv(Buffer.from(text, 'utf8'));
  assert.deepStrictEqual(parsed.rows, [], '範本本身不應產生任何可匯入的禮券');
  assert.strictEqual(
    parsed.errors.filter((e) => e.includes('範本範例列')).length,
    2
  );
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test test/api.test.js`
Expected: FAIL —— 路由不存在，`res.status` 為 404

- [ ] **Step 3: 改 require**

把 `src/server.js` 第 8 行改為：

```js
const { parseGiftcodeCsv, TEMPLATE_CSV } = require('./csv');
```

- [ ] **Step 4: 新增路由**

在 `/api/export.csv` 那個 handler 的結尾 `});` 之後、`// ---- NAS 同步 ----` 註解之前插入。BOM 與 `export.csv`（同檔案內）的寫法一致：

```js
app.get('/api/template.csv', (req, res) => {
  const filename = encodeURIComponent('禮券上傳範本.csv');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="giftcode-template.csv"; filename*=UTF-8''${filename}`
  );
  res.send('\uFEFF' + TEMPLATE_CSV);
});
```

`filename*` 是 RFC 5987 的 UTF-8 檔名（現代瀏覽器會存成「禮券上傳範本.csv」），`filename` 是給舊瀏覽器的 ASCII 後備名。

- [ ] **Step 5: 跑測試確認通過**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/api.test.js
git commit -m "feat: 新增 GET /api/template.csv 範本下載路由"
```

---

### Task 3: 原封不動上傳範本時給出可行動的錯誤訊息

設計文件沒涵蓋這個情況，實作時才發現：`src/server.js:94-96` 在 `parsed.rows.length === 0` 時回 400「檔案中找不到任何禮券碼」。範例列被 Task 1 略過後，未填寫的範本正好落進這條路徑——但前端錯誤框只顯示 `err.message`（`public/app.js:341`），使用者會看到「找不到任何禮券碼」卻不知道是因為自己忘了填。

**Files:**
- Modify: `src/server.js:94-96`
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: Task 1 的略過警告文字、Task 2 的 `/api/template.csv`

- [ ] **Step 1: 寫失敗的測試**

加到 `test/api.test.js` 最後：

```js
test('原封不動上傳範本會提示要先填寫，而不是說找不到禮券碼', async () => {
  const text = await (await fetch(`${base}/api/template.csv`)).text();
  const { status, body } = await uploadCsv(text, '禮券上傳範本.csv');
  assert.strictEqual(status, 400);
  assert.match(body.error, /範本/, '錯誤訊息應點出這是未填寫的範本');
  assert.strictEqual(body.details.filter((d) => d.includes('範本範例列')).length, 2);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test test/api.test.js`
Expected: FAIL —— `body.error` 為「檔案中找不到任何禮券碼」，不含「範本」

- [ ] **Step 3: 改錯誤訊息**

把 `src/server.js:94-96` 那段改為：

```js
  if (parsed.rows.length === 0) {
    // 整份檔案只剩範本範例列 = 使用者下載範本後直接上傳，沒填東西
    const templateOnly =
      parsed.errors.length > 0 &&
      parsed.errors.every((e) => e.includes('範本範例列'));
    return res.status(400).json({
      error: templateOnly
        ? '這是尚未填寫的 CSV 範本：請刪除範例列、填入實際禮券碼後再上傳'
        : '檔案中找不到任何禮券碼',
      details: parsed.errors,
    });
  }
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/api.test.js
git commit -m "fix: 未填寫的範本上傳時提示填寫，不再回報找不到禮券碼"
```

---

### Task 4: 頁籤重組

**Files:**
- Modify: `public/index.html`（第 15-17 行頁籤按鈕；第 47-134 行兩個 section）
- Modify: `public/app.js:73`
- Test: `test/frontend-autofill.test.js`

**Interfaces:**
- Produces: `#tab-settings`（原 `#tab-upload`）；`#upload-form` 與 `#upload-result` 移入 `#tab-codes`

- [ ] **Step 1: 寫失敗的測試**

加到 `test/frontend-autofill.test.js` 最後。頁籤切換靠字串對應（`app.js:68` 的 `#tab-${btn.dataset.tab}`），漏改不會有任何錯誤訊息，只會靜靜地切不過去：

```js
test('每個頁籤按鈕都有對應的 section', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);

  assert.ok(tabs.length > 0, '應該要有頁籤按鈕');
  for (const tab of tabs) {
    assert.ok(
      html.includes(`id="tab-${tab}"`),
      `data-tab="${tab}" 缺少對應的 <section id="tab-${tab}">`
    );
  }
});

test('上傳表單位於禮券管理頁，系統設定頁只留同步與備份', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  const codesTab = html.match(/<section id="tab-codes"[\s\S]*?<\/section>/);
  assert.ok(codesTab, '應有 #tab-codes');
  assert.ok(codesTab[0].includes('id="upload-form"'), '上傳表單應在禮券管理頁');

  const settingsTab = html.match(/<section id="tab-settings"[\s\S]*?<\/section>/);
  assert.ok(settingsTab, '應有 #tab-settings');
  assert.ok(settingsTab[0].includes('id="sync-form"'), 'NAS 同步應在系統設定頁');
  assert.ok(settingsTab[0].includes('id="db-config-form"'), 'DB 設定應在系統設定頁');
  assert.ok(!settingsTab[0].includes('id="upload-form"'), '上傳表單不應留在系統設定頁');

  assert.match(
    appJs,
    /btn\.dataset\.tab === 'settings'/,
    '切到系統設定頁時要載入同步與備份狀態'
  );
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test test/frontend-autofill.test.js`
Expected: FAIL —— 第二條測試失敗，`#tab-settings` 不存在（目前叫 `#tab-upload`）

- [ ] **Step 3: 改頁籤按鈕**

`public/index.html` 第 15-18 行，把「上傳 CSV」那顆按鈕刪掉，並在「同仁管理」之後新增「系統設定」。改完的 `<nav>` 內容為：

```html
      <button class="tab-btn active" data-tab="overview">總覽</button>
      <button class="tab-btn" data-tab="codes">禮券管理</button>
      <button class="tab-btn" data-tab="bulk">批次兌換</button>
      <button class="tab-btn" data-tab="batches">上傳紀錄</button>
      <button class="tab-btn" data-tab="staff">同仁管理</button>
      <button class="tab-btn" data-tab="settings">系統設定</button>
```

- [ ] **Step 4: 把上傳表單搬進禮券管理頁**

把 `public/index.html` 第 79-92 行（`<form id="upload-form" …>` 整塊，含其後的 `<div id="upload-result" …>`）剪下，貼到 `<section id="tab-codes" class="tab">` 之後、`<form id="filter-form" …>` 之前。內容一字不改，維持原本的 id。

搬完後 `#tab-codes` 的順序為：上傳表單 → `#upload-result` → 篩選列 → 禮券列表 → 分頁。

- [ ] **Step 5: 原上傳頁改名為系統設定頁**

把 `<section id="tab-upload" class="tab">` 改為：

```html
    <!-- 系統設定 -->
    <section id="tab-settings" class="tab">
```

（原本第 77 行的 `<!-- 上傳 CSV -->` 註解一併換掉。）此時該 section 內只剩 `#sync-form` 與 `#db-config-form` 兩塊。

- [ ] **Step 6: 改內層重複的標題**

`#db-config-form` 內的 `<h2>系統設定</h2>`（原第 113 行）改為：

```html
        <h2>資料庫與備份</h2>
```

頁籤本身已叫「系統設定」，同頁不該再有一層同名標題。

- [ ] **Step 7: 改 app.js 的頁籤載入判斷**

`public/app.js:73` 改為：

```js
    if (btn.dataset.tab === 'settings') { loadSyncStatus(); loadBackupStatus(); loadDbConfig(); }
```

- [ ] **Step 8: 跑測試確認通過**

Run: `npm test`
Expected: PASS —— 全部測試通過

- [ ] **Step 9: Commit**

```bash
git add public/index.html public/app.js test/frontend-autofill.test.js
git commit -m "refactor: 上傳表單移入禮券管理頁，系統設定獨立成頁籤"
```

---

### Task 5: 範本下載連結與上傳後刷新列表

**Files:**
- Modify: `public/index.html`（`#upload-form` 內的 `<p class="hint">` 與 submit 按鈕區）
- Modify: `public/app.js`（上傳成功處理，原第 336 行附近）
- Test: `test/frontend-autofill.test.js`

**Interfaces:**
- Consumes: `GET /api/template.csv`（Task 2）；`#tab-codes` 內的上傳表單（Task 4）

- [ ] **Step 1: 寫失敗的測試**

加到 `test/frontend-autofill.test.js` 最後：

```js
test('上傳表單提供範本下載，且上傳成功後刷新禮券列表', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  assert.match(
    html,
    /href="\/api\/template\.csv"[^>]*download/,
    '上傳區應有指向範本路由的下載連結'
  );

  const uploadHandler = appJs.match(/\$\('#upload-form'\)\.addEventListener\([\s\S]*$/);
  assert.ok(uploadHandler, '應有上傳表單的 submit handler');
  assert.match(
    uploadHandler[0],
    /\$\('#upload-form'\)\.reset\(\);[\s\S]*?loadCodes\(\);/,
    '上傳成功後應重新載入禮券列表，否則同頁的列表會停在舊資料'
  );
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test test/frontend-autofill.test.js`
Expected: FAIL —— 找不到 `href="/api/template.csv"`

- [ ] **Step 3: 加下載連結與說明**

把 `#upload-form` 內的 `<p class="hint">…</p>`（原 `index.html:81-85`）整段換成：

```html
        <p class="hint">
          支援含標頭的 CSV（禮券碼欄位可命名為 code / 禮券碼 / 序號 / 兌換碼 等，
          可選欄位：禮品名稱、面額、到期日）。若無可辨識的標頭，會以第一欄作為禮券碼。
          與資料庫重複的禮券碼會自動略過。<br>
          不知道格式怎麼填？下載範本照著填即可；範本內的兩列範例資料上傳時會自動略過。
          另存檔名建議用實際禮品名稱（NAS 同步會以檔名作為禮品名稱）。
        </p>
        <p><a href="/api/template.csv" class="btn btn-secondary" download>下載 CSV 範本</a></p>
```

純 `<a download>`，不需要 `app.js` 介入。

- [ ] **Step 4: 上傳成功後刷新列表**

`public/app.js` 上傳 handler 內，把 `$('#upload-form').reset();` 那一行（原第 336 行）改為：

```js
    $('#upload-form').reset();
    // 上傳表單與禮券列表同頁，不刷新的話下方列表會停在舊資料
    loadFilterOptions();
    loadCodes();
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npm test`
Expected: PASS —— 全部測試通過

- [ ] **Step 6: 用真實瀏覽器驗證**

依 `verify` skill 啟動伺服器並操作實際畫面，確認：
1. 頁籤列為「總覽 / 禮券管理 / 批次兌換 / 上傳紀錄 / 同仁管理 / 系統設定」
2. 禮券管理頁上方有上傳表單與「下載 CSV 範本」按鈕
3. 點下載得到檔案，用 Excel 開啟中文不亂碼
4. 直接上傳未修改的範本 → 出現「這是尚未填寫的 CSV 範本…」
5. 填入真實禮券碼後上傳 → 匯入成功，下方列表立刻出現新禮券
6. 系統設定頁只剩 NAS 同步與「資料庫與備份」

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/app.js test/frontend-autofill.test.js
git commit -m "feat: 上傳區加入 CSV 範本下載，上傳成功後刷新列表"
```

---

## 完成後的驗收

Run: `npm test`
Expected: 全部測試通過，包含既有的 `api.test.js`、`backup.test.js`、`campaigns-cost.test.js`、`frontend-autofill.test.js`、`schema.test.js`、`staff.test.js`、`start-bat-defaults.test.js`、`sync.test.js`
