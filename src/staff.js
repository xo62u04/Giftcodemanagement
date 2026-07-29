'use strict';

const { Router } = require('express');
const db = require('./db');
const { getCurrentWindowsUser, isAuthorizedAdmin } = require('./auth');

const router = Router();

function cleanBody(body) {
  return {
    name: String(body.name || '').trim(),
    department: String(body.department || '').trim(),
    employee_id: String(body.employee_id || '').trim(),
    windows_username: String(body.windows_username || '').trim(),
    is_admin: body.is_admin ? 1 : 0,
  };
}

router.get('/current-user', (req, res) => {
  const windowsUsername = getCurrentWindowsUser();
  const staff = windowsUsername
    ? db.prepare('SELECT * FROM staff WHERE LOWER(windows_username) = LOWER(?)').get(windowsUsername)
    : null;
  res.json({
    windows_username: windowsUsername,
    matched: Boolean(staff),
    staff: staff || null,
    is_admin: Boolean(staff && staff.is_admin),
    can_admin: isAuthorizedAdmin(db), // 含 zero-admin 引導：據此決定前端是否顯示刪除按鈕
  });
});

router.get('/staff', (req, res) => {
  res.json(db.prepare('SELECT * FROM staff ORDER BY name, id').all());
});

router.post('/staff', (req, res) => {
  const body = cleanBody(req.body || {});
  if (!body.name) return res.status(400).json({ error: 'Name is required' });

  const result = db.prepare(`
    INSERT INTO staff (name, department, employee_id, windows_username, is_admin)
    VALUES (?, ?, ?, ?, ?)
  `).run(body.name, body.department, body.employee_id, body.windows_username, body.is_admin);

  res.status(201).json(db.prepare('SELECT * FROM staff WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/staff/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM staff WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Staff not found' });

  const body = cleanBody(req.body || {});
  if (!body.name) return res.status(400).json({ error: 'Name is required' });

  db.prepare(`
    UPDATE staff
    SET name = ?, department = ?, employee_id = ?, windows_username = ?, is_admin = ?
    WHERE id = ?
  `).run(body.name, body.department, body.employee_id, body.windows_username, body.is_admin, req.params.id);

  res.json(db.prepare('SELECT * FROM staff WHERE id = ?').get(req.params.id));
});

router.delete('/staff/:id', (req, res) => {
  const result = db.prepare('DELETE FROM staff WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Staff not found' });
  res.json({ ok: true });
});

module.exports = router;
