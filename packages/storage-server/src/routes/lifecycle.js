'use strict';

const express = require('express');
const { requireUploadToken } = require('./auth');
const { registerSession, touchSession, closeSession } = require('../db');

function buildLifecycleRouter(config) {
  const router = express.Router();
  router.use(requireUploadToken(config));

  router.post('/session/start', (req, res) => {
    const { employeeId, sessionId, startedAt } = req.body || {};
    if (!employeeId || !sessionId) return res.status(400).json({ error: 'missing_metadata' });
    registerSession({ employeeId, sessionId, startedAt: Number(startedAt) || Date.now() });
    res.json({ ok: true, employeeId, sessionId, status: 'recording' });
  });

  router.post('/session/heartbeat', (req, res) => {
    const { employeeId, sessionId, timestamp } = req.body || {};
    if (!employeeId || !sessionId) return res.status(400).json({ error: 'missing_metadata' });
    touchSession(employeeId, sessionId, Number(timestamp) || Date.now());
    res.json({ ok: true });
  });

  router.post('/session/close', (req, res) => {
    const { employeeId, sessionId, endedAt } = req.body || {};
    if (!employeeId || !sessionId) return res.status(400).json({ error: 'missing_metadata' });
    closeSession(employeeId, sessionId, Number(endedAt) || Date.now());
    res.json({ ok: true, employeeId, sessionId, status: 'closed' });
  });

  return router;
}

module.exports = { buildLifecycleRouter };
