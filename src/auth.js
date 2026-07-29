'use strict';

// 以 Windows 帳號判定身分與管理員權限。屬防呆／責任劃分，非強資安（帳號可偽造）。

const os = require('os');

function getCurrentWindowsUser() {
  return String(process.env.USERNAME || os.userInfo().username || '').trim();
}

// 目前使用者是否對應到某位同仁（以 Windows 帳號比對，不分大小寫）
function getCurrentStaff(db) {
  const user = getCurrentWindowsUser();
  if (!user) return null;
  return db.prepare('SELECT * FROM staff WHERE LOWER(windows_username) = LOWER(?)').get(user) || null;
}

/**
 * 是否有權執行破壞性動作（刪除禮券／批次）。
 * 開機引導：系統尚無任何管理員時，暫時視所有人為管理員，
 * 以便有人能設定第一位管理員；一旦有管理員存在，就只認被標記者。
 */
function isAuthorizedAdmin(db) {
  const adminCount = db.prepare('SELECT COUNT(*) AS n FROM staff WHERE is_admin = 1').get().n;
  if (adminCount === 0) return true;
  const staff = getCurrentStaff(db);
  return Boolean(staff && staff.is_admin);
}

// Express 中介層：非管理員回 403
function requireAdmin(db) {
  return (req, res, next) => {
    if (isAuthorizedAdmin(db)) return next();
    return res.status(403).json({ error: '此動作僅限管理員' });
  };
}

module.exports = { getCurrentWindowsUser, getCurrentStaff, isAuthorizedAdmin, requireAdmin };
