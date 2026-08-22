'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { insertAudit } = require('../db');

/**
 * 鉴权中间件：从 Authorization: Bearer <token> 校验 JWT。
 * 通过后 req.admin = { username }。
 */
function requireAuth(config) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'missing_token' });
    }
    try {
      const payload = jwt.verify(token, config.auth.jwtSecret);
      req.admin = { username: payload.username };
      next();
    } catch (err) {
      return res.status(401).json({ error: 'invalid_token' });
    }
  };
}

/**
 * 上传鉴权中间件：校验录制代理携带的 X-Upload-Token。
 * 录制代理不持有管理员 JWT，使用独立的共享上传令牌。
 */
function requireUploadToken(config) {
  return (req, res, next) => {
    const token = req.headers['x-upload-token'];
    if (!token || token !== config.auth.uploadToken) {
      return res.status(403).json({ error: 'invalid_upload_token' });
    }
    next();
  };
}

function buildAuthRouter(config) {
  const router = express.Router();

  // 管理员登录，签发 JWT
  router.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'missing_credentials' });
    }
    const okUsername = username === config.auth.adminUsername;
    const okPassword = password === config.auth.adminPassword;
    if (!okUsername || !okPassword) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const token = jwt.sign({ username }, config.auth.jwtSecret, {
      expiresIn: config.auth.tokenTtlSeconds || 1800,
    });
    res.json({ token, expiresIn: config.auth.tokenTtlSeconds || 1800 });
  });

  return router;
}

/**
 * 生成临时签名下载令牌（HMAC）。
 * viewer 通过 ?token=... 下载 trace 文件，无需长期 JWT。
 */
function signDownloadToken(config, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', config.auth.jwtSecret)
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

function verifyDownloadToken(config, token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto
    .createHmac('sha256', config.auth.jwtSecret)
    .update(body)
    .digest('base64url');
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

module.exports = { buildAuthRouter, requireAuth, requireUploadToken, signDownloadToken, verifyDownloadToken };
