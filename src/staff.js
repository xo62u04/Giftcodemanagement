'use strict';

const os = require('os');
const { Router } = require('express');
const db = require('./db');

const router = Router();

function getCurrentWindowsUser() {
  return String(process.env.USERNAME || os.userInfo().username || '').trim();
}

function cleanBody(body) {
  return {
    name: String(body.name || '').trim(),
    department: String(body.department || '').trim(),
    employee_id: String(body.employee_id || '').trim(),
    windows_username: String(body.windows_username || '').trim(),
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
  });
});

router.get('/staff', (req, res) => {
  res.json(db.prepare('SELECT * FROM staff ORDER BY name, id').all());
});

router.post('/staff', (req, res) => {
  const body = cleanBody(req.body || {});
  if (!body.name) return res.status(400).json({ error: 'Name is required' });

  const result = db.prepare(`
    INSERT INTO staff (name, department, employee_id, windows_username)
    VALUES (?, ?, ?, ?)
  `).run(body.name, body.department, body.employee_id, body.windows_username);

  res.status(201).json(db.prepare('SELECT * FROM staff WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/staff/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM staff WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Staff not found' });

  const body = cleanBody(req.body || {});
  if (!body.name) return res.status(400).json({ error: 'Name is required' });

  db.prepare(`
    UPDATE staff
    SET name = ?, department = ?, employee_id = ?, windows_username = ?
    WHERE id = ?
  `).run(body.name, body.department, body.employee_id, body.windows_username, req.params.id);

  res.json(db.prepare('SELECT * FROM staff WHERE id = ?').get(req.params.id));
});

router.delete('/staff/:id', (req, res) => {
  const result = db.prepare('DELETE FROM staff WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Staff not found' });
  res.json({ ok: true });
});

module.exports = router;
