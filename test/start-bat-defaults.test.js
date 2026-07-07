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

