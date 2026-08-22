'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { requireUploadToken, requireAuth } = require('./auth');
const { registerSession, upsertLifecycleForFile, getDb } = require('../db');

function buildOperationRouter(config) {
  const router = express.Router();
  const root = path.join(config.dataDir, 'operations');
  fs.mkdirSync(root, { recursive: true });
  const upload = multer({ dest: path.join(root, '.tmp') });
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });

  router.post('/screenshots', requireUploadToken(config), upload.single('screenshot'), (req, res) => {
    const { employeeId, sessionId, relativePath } = req.body || {};
    if (!req.file || !employeeId || !sessionId || !relativePath) return res.status(400).json({ error: 'missing_metadata' });
    const base = path.resolve(root, String(employeeId), String(sessionId));
    const target = path.resolve(base, relativePath);
    if (!target.startsWith(base + path.sep) || !relativePath.startsWith('screenshots/')) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'invalid_path' });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(req.file.path, target);
    res.json({ ok: true, path: relativePath });
  });

  router.post('/chunks', requireUploadToken(config), upload.single('events'), (req, res) => {
    const { employeeId, sessionId, chunkIndex, startTime, endTime } = req.body || {};
    if (!req.file || !employeeId || !sessionId || chunkIndex === undefined) return res.status(400).json({ error: 'missing_metadata' });
    registerSession({ employeeId, sessionId, startedAt: Number(startTime) || Date.now() });
    const dir = path.join(root, String(employeeId), String(sessionId), `chunk_${Number(chunkIndex)}`);
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, 'events.ndjson');
    fs.renameSync(req.file.path, finalPath);
    const stat = fs.statSync(finalPath);
    const now = Date.now();
    getDb().prepare(`INSERT INTO operation_chunks(id,employee_id,session_id,chunk_index,events_path,start_time,end_time,file_size,upload_time)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(employee_id,session_id,chunk_index) DO UPDATE SET events_path=excluded.events_path,end_time=excluded.end_time,file_size=excluded.file_size,upload_time=excluded.upload_time`)
      .run(randomUUID(), employeeId, String(sessionId), Number(chunkIndex), path.relative(root, finalPath), Number(startTime) || now, Number(endTime) || now, stat.size, now);
    res.json({ ok: true, chunkIndex: Number(chunkIndex), fileSize: stat.size });
  });

  router.get('/:employeeId/:sessionId/manifest', requireAuth(config), (req, res) => {
    const rows = getDb().prepare(`SELECT chunk_index chunkIndex,start_time startTime,end_time endTime,file_size fileSize,upload_time uploadTime FROM operation_chunks WHERE employee_id=? AND session_id=? ORDER BY chunk_index`).all(req.params.employeeId, req.params.sessionId);
    res.json({ employeeId: req.params.employeeId, sessionId: req.params.sessionId, chunks: rows });
  });

  router.get('/:employeeId/:sessionId/events', requireAuth(config), (req, res) => {
    const rows = getDb().prepare('SELECT events_path FROM operation_chunks WHERE employee_id=? AND session_id=? ORDER BY chunk_index').all(req.params.employeeId, req.params.sessionId);
    const events = [];
    for (const row of rows) {
      const file = path.resolve(root, row.events_path);
      if (!file.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (line.trim()) { try { events.push(JSON.parse(line)); } catch (_) {} }
    }
    events.sort((a, b) => a.seq - b.seq);
    res.json(events);
  });

  router.get('/:employeeId/:sessionId/screenshots/*', requireAuth(config), (req, res) => {
    const relative = req.params[0];
    const base = path.resolve(root, req.params.employeeId, req.params.sessionId);
    const file = path.resolve(base, relative);
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) return res.status(404).json({ error: 'not_found' });
    res.sendFile(file);
  });

  return router;
}
module.exports = { buildOperationRouter };
