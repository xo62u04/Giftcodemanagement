'use strict';

/*
 * 測試資料庫隔離。任何會 require ../src/db 或 ../src/server 的測試檔，
 * 都必須在 require 之前先 require 這支 helper，例如：
 *
 *   const { dataDir } = require('./helpers/isolate-db')('gift-api-');
 *   const app = require('../src/server');
 *
 * 它做兩件事：
 *   1. 把 STARTUP_CONFIG_FILE 指向一個不存在的路徑，讓 src/db.js 忽略正式的
 *      startup-config.json —— 否則其中的 data_dir 會蓋過 DATA_DIR，測試就會
 *      寫進 NAS 上的正式資料庫。
 *   2. 建立暫存 DATA_DIR 並「斷言它確實位於系統暫存區」。萬一哪天隔離再度失效，
 *      這道守衛會讓測試直接中止，而不是無聲地污染正式資料。
 *
 * 回傳 { dataDir }，並掛在 process 上供 after() 清理。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

module.exports = function isolateDb(prefix = 'gift-test-') {
  // 指向暫存區內一個保證不存在的檔名，src/db.js 讀不到就會退回 DATA_DIR
  process.env.STARTUP_CONFIG_FILE = path.join(os.tmpdir(), `no-such-startup-config-${process.pid}.json`);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DATA_DIR = dataDir;
  // 保險起見不要在測試中誤觸「從備份還原」邏輯
  delete process.env.BACKUP_DIR;

  const tmpReal = fs.realpathSync(os.tmpdir());
  const dataReal = fs.realpathSync(dataDir);
  if (!dataReal.startsWith(tmpReal)) {
    throw new Error(
      `[測試守衛] DATA_DIR 未落在系統暫存區（${dataReal}），拒絕執行以免污染正式資料庫`
    );
  }

  return { dataDir };
};
