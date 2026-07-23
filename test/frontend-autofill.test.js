'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('redeem dialog reapplies current user after form reset', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const redeemClickBlock = appJs.match(/if \(btn\.dataset\.action === 'redeem'\) \{[\s\S]*?\} else if/);

  assert.ok(redeemClickBlock, 'redeem click handler should exist');
  assert.match(
    redeemClickBlock[0],
    /\$\('#redeem-form'\)\.reset\(\);[\s\S]*autoFillUserFields\(\);/,
    'redeem dialog should auto-fill current user after reset clears the form'
  );
});


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
