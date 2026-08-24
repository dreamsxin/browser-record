'use strict';

const express = require('express');
const {
  listEmployees,
  listAllSessions,
  listSessions,
  listSegments,
  listSegmentsByTimeRange,
  getFileById,
  insertAudit,
} = require('../db');
const { requireAuth } = require('./auth');

function buildFilesRouter(config) {
  const router = express.Router();

  router.use(requireAuth(config));

  router.get('/sessions', (req, res) => {
    const employeeId = String(req.query.employeeId || '').trim() || undefined;
    res.json(listAllSessions(employeeId));
  });

  // 员工列表（带汇总统计）
  router.get('/employees', (req, res) => {
    const employees = listEmployees();
    res.json(employees);
  });

  // 某员工的会话列表
  router.get('/employees/:employeeId/sessions', (req, res) => {
    const { employeeId } = req.params;
    res.json(listSessions(employeeId));
  });

  // 某员工某会话的分段列表
  router.get('/employees/:employeeId/sessions/:sessionId/segments', (req, res) => {
    const { employeeId, sessionId } = req.params;
    res.json(listSegments(employeeId, sessionId));
  });

  // 按时间范围查询分段（供跨会话检索）
  router.get('/employees/:employeeId/segments', (req, res) => {
    const { employeeId } = req.params;
    const { from, to, limit } = req.query;
    const now = Date.now();
    res.json(listSegmentsByTimeRange(employeeId, from || 0, to || now, Number(limit) || 100));
  });

  // 单个分段详情
  router.get('/segments/:id', (req, res) => {
    const file = getFileById(req.params.id);
    if (!file) return res.status(404).json({ error: 'not_found' });
    res.json(file);
  });

  return router;
}

module.exports = { buildFilesRouter };
