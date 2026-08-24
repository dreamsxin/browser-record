'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const { randomUUID } = require('crypto');
const { requireUploadToken, requireAuth } = require('./auth');
const { getDb, registerSession } = require('../db');

function extractZip(zipPath, outputDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.readEntry();
      zip.on('entry', (entry) => {
        const normalized = entry.fileName.replace(/\\/g, '/');
        if (normalized.includes('..') || normalized.startsWith('/') || !/^(manifest\.json|videos\/[^/]+\.webm)$/.test(normalized)) {
          zip.close(); return reject(new Error(`非法 ZIP entry: ${entry.fileName}`));
        }
        const target = path.join(outputDir, ...normalized.split('/'));
        if (/\/$/.test(normalized)) { fs.mkdirSync(target, { recursive: true }); zip.readEntry(); return; }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          stream.pipe(fs.createWriteStream(target)).on('close', () => zip.readEntry()).on('error', reject);
        });
      });
      zip.on('end', resolve);
      zip.on('error', reject);
    });
  });
}

function buildVideoRouter(config) {
  const router = express.Router();
  const root = path.join(config.dataDir, 'videos');
  const temp = path.join(root, '.tmp');
  fs.mkdirSync(temp, { recursive: true });
  // Backfill media_size for archives created before the column existed.
  for (const row of getDb().prepare('SELECT employee_id employeeId,session_id sessionId,manifest_path manifestPath FROM video_archives WHERE media_size=0').all()) {
    try {
      const manifestPath = path.join(root, row.manifestPath);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const base = path.dirname(manifestPath);
      const mediaSize = (manifest.videos || []).reduce((sum, item) => {
        const file = path.resolve(base, item.file);
        return sum + (file.startsWith(base + path.sep) && fs.existsSync(file) ? fs.statSync(file).size : 0);
      }, 0);
      getDb().prepare('UPDATE video_archives SET media_size=? WHERE employee_id=? AND session_id=?').run(mediaSize, row.employeeId, row.sessionId);
    } catch (_) {}
  }
  const upload = multer({ dest: temp });

  router.post('/upload', requireUploadToken(config), upload.single('archive'), async (req, res, next) => {
    try {
      const { employeeId, sessionId, status } = req.body || {};
      if (!req.file || !employeeId || !sessionId) return res.status(400).json({ error: 'missing_metadata' });
      const dir = path.join(root, employeeId, String(sessionId));
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const archivePath = path.join(dir, 'session.zip');
      fs.renameSync(req.file.path, archivePath);
      const extracted = path.join(dir, 'extracted');
      fs.mkdirSync(extracted, { recursive: true });
      await extractZip(archivePath, extracted);
      const manifestPath = path.join(extracted, 'manifest.json');
      if (!fs.existsSync(manifestPath)) throw new Error('ZIP 缺少 manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const mediaSize = (manifest.videos || []).reduce((total, item) => {
        const file = path.resolve(extracted, item.file);
        return total + (file.startsWith(extracted + path.sep) && fs.existsSync(file) ? fs.statSync(file).size : 0);
      }, 0);
      registerSession({ employeeId, sessionId, startedAt: Number(manifest.startedAt) || Date.now(), recordingMode: 'video' });
      const now = Date.now();
      getDb().prepare(`INSERT INTO video_archives(id,employee_id,session_id,archive_path,manifest_path,file_size,media_size,upload_time,status)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(employee_id,session_id) DO UPDATE SET archive_path=excluded.archive_path,manifest_path=excluded.manifest_path,file_size=excluded.file_size,media_size=excluded.media_size,upload_time=excluded.upload_time,status=excluded.status`)
        .run(randomUUID(), employeeId, String(sessionId), path.relative(root, archivePath), path.relative(root, manifestPath), fs.statSync(archivePath).size, mediaSize, now, status || 'closed');
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  router.get('/:employeeId/:sessionId', requireAuth(config), (req, res) => {
    const row = getDb().prepare('SELECT manifest_path manifestPath,status,file_size fileSize,upload_time uploadTime FROM video_archives WHERE employee_id=? AND session_id=?').get(req.params.employeeId, req.params.sessionId);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, row.manifestPath), 'utf8'));
    res.json({ ...manifest, status: row.status, fileSize: row.fileSize, uploadTime: row.uploadTime });
  });

  router.get('/:employeeId/:sessionId/:pageId/stream', requireAuth(config), (req, res) => {
    const row = getDb().prepare('SELECT manifest_path manifestPath FROM video_archives WHERE employee_id=? AND session_id=?').get(req.params.employeeId, req.params.sessionId);
    if (!row) return res.status(404).end();
    const manifestPath = path.join(root, row.manifestPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const item = manifest.videos.find((v) => v.pageId === req.params.pageId);
    if (!item) return res.status(404).end();
    const base = path.dirname(manifestPath);
    const file = path.resolve(base, item.file);
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) return res.status(404).end();
    const stat = fs.statSync(file);
    const range = req.headers.range;
    res.setHeader('Content-Type', 'video/webm');
    res.setHeader('Accept-Ranges', 'bytes');
    if (!range) { res.setHeader('Content-Length', stat.size); return fs.createReadStream(file).pipe(res); }
    const [startText, endText] = range.replace(/bytes=/, '').split('-');
    const start = Number(startText); const end = endText ? Number(endText) : stat.size - 1;
    if (!Number.isFinite(start) || start < 0 || end >= stat.size || start > end) return res.status(416).end();
    res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  });
  return router;
}

module.exports = { buildVideoRouter };
