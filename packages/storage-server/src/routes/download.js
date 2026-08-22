'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { getFileById, insertAudit } = require('../db');
const { requireAuth, signDownloadToken, verifyDownloadToken } = require('./auth');

function buildDownloadRouter(config) {
  const router = express.Router();

  /**
   * 管理员请求一个分段的临时签名下载 URL。
   * 返回可直接放入 Trace Viewer 的下载地址（带 token）。
   */
  router.get('/segments/:id/sign', requireAuth(config), (req, res) => {
    const file = getFileById(req.params.id);
    if (!file) return res.status(404).json({ error: 'not_found' });

    const token = signDownloadToken(config, {
      fileId: file.id,
      exp: Date.now() + (config.auth.tokenTtlSeconds || 1800) * 1000,
    });
    const url = `${req.protocol}://${req.get('host')}/api/download/segments/${file.id}?token=${token}`;

    insertAudit({
      actor: req.admin.username,
      action: 'sign_download',
      employeeId: file.employee_id,
      fileId: file.id,
      detail: 'requested signed download url',
    });

    res.json({ url, expiresAt: Date.now() + (config.auth.tokenTtlSeconds || 1800) * 1000 });
  });

  /**
   * 实际下载文件（通过签名 token，供 Trace Viewer 加载）。
   * 设置 trace 相关 MIME 便于 viewer 识别（实际为 zip）。
   */
  router.get('/segments/:id', (req, res) => {
    const token = req.query.token;
    const payload = verifyDownloadToken(config, token);
    if (!payload || payload.fileId !== req.params.id) {
      return res.status(403).json({ error: 'invalid_or_expired_token' });
    }
    const file = getFileById(req.params.id);
    if (!file) return res.status(404).json({ error: 'not_found' });

    const absPath = path.join(config.recordingsDir, file.file_path);
    if (!fs.existsSync(absPath)) {
      return res.status(410).json({ error: 'file_gone' });
    }

    insertAudit({
      actor: 'token:' + payload.fileId,
      action: 'download',
      employeeId: file.employee_id,
      fileId: file.id,
      detail: 'trace file downloaded via signed token',
    });

    res.download(absPath, path.basename(absPath));
  });

  return router;
}

module.exports = { buildDownloadRouter };
