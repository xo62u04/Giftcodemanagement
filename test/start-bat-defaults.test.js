'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('start.bat provides first-run default CSV sync and DB backup paths', () => {
  const startBat = fs.readFileSync(path.join(__dirname, '..', 'start.bat'), 'utf8');

  assert.match(
    startBat,
    /set "SYNC_DIR=\\\\172\.22\.91\.100\\數位增長部\\數位規劃處\\【電子禮券後台】E-gift\\gifts"/
  );
  assert.match(
    startBat,
    /set "BACKUP_DIR=\\\\172\.22\.91\.100\\數位增長部\\數位規劃處\\【電子禮券後台】E-gift\\DB"/
  );
});

test('start.bat uses cmd-safe comments and checks whether the port is already in use', () => {
  const startBat = fs.readFileSync(path.join(__dirname, '..', 'start.bat'), 'utf8');
  const remLines = startBat.split(/\r?\n/).filter((line) => line.startsWith('REM'));

  assert.ok(remLines.length > 0);
  assert.deepEqual(
    remLines.filter((line) => /[^\x00-\x7F]/.test(line)),
    [],
    'REM lines should stay ASCII-only so cmd never treats mojibake as commands'
  );
  assert.match(startBat, /netstat -ano/);
  assert.match(startBat, /:%PORT%/);
  assert.match(startBat, /already running/);
});
