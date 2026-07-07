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

