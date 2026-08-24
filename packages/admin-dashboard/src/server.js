'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const path = require('path');
const crypto = require('crypto');

const { loadConfig } = require('./config');
const { StorageClient } = require('./storageClient');

function fmtTime(ts) {
  if (!ts) return '-';
  // 本地时区显示
  return new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false });
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

function createApp(config) {
  const app = express();
  app.use(morgan('tiny'));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.static(path.join(__dirname, 'public')));

  const storage = new StorageClient({
    baseUrl: config.storageServerUrl,
    username: config.admin.username,
    password: config.admin.password,
  });

  // ---- 简易会话（签名 cookie） ----
  const sessions = new Map(); // token -> { username, exp }
  const SESSION_TTL = (config.session.ttlSeconds || 28800) * 1000;
  const SESSION_COOKIE = 'br_session';

  function sign(value) {
    return crypto.createHmac('sha256', config.session.secret).update(value).digest('base64url');
  }

  function createSession(username) {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { username, exp: Date.now() + SESSION_TTL });
    return token;
  }

  function getSession(req) {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return null;
    const [token, sig] = raw.split('.');
    if (sig !== sign(token)) return null;
    const s = sessions.get(token);
    if (!s || Date.now() > s.exp) return null;
    return s;
  }

  function requireLogin(req, res, next) {
    const s = getSession(req);
    if (!s) return res.redirect('/login');
    req.user = s;
    next();
  }

  // ---- 路由 ----

  app.get('/', (req, res) => {
    const s = getSession(req);
    if (s) return res.redirect('/sessions');
    res.redirect('/login');
  });

  app.get('/login', (req, res) => {
    res.render('login', { error: null });
  });

  app.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (username === config.admin.username && password === config.admin.password) {
      const token = createSession(username);
      res.cookie(SESSION_COOKIE, `${token}.${sign(token)}`, {
        httpOnly: true,
        maxAge: SESSION_TTL,
        sameSite: 'lax',
      });
      return res.redirect('/sessions');
    }
    res.render('login', { error: '用户名或密码错误' });
  });

  app.post('/logout', requireLogin, (req, res) => {
    const raw = req.cookies[SESSION_COOKIE];
    const token = raw && raw.split('.')[0];
    if (token) sessions.delete(token);
    res.clearCookie(SESSION_COOKIE);
    res.redirect('/login');
  });

  app.get('/employees', requireLogin, (req, res) => res.redirect('/sessions'));

  app.get('/sessions', requireLogin, async (req, res) => {
    const employeeId = String(req.query.employeeId || '').trim();
    try {
      const sessions = await storage.listAllSessions(employeeId || undefined);
      res.render('sessions', {
        user: req.user,
        employeeId,
        sessions: sessions.map((s) => ({ ...s, startTimeFmt: fmtTime(s.startTime), endTimeFmt: fmtTime(s.endTime), totalBytesFmt: fmtBytes(s.totalBytes) })),
      });
    } catch (err) { res.status(500).render('error', { error: err.message }); }
  });

  app.get('/employees/:employeeId/sessions', requireLogin, (req, res) => {
    res.redirect(`/sessions?employeeId=${encodeURIComponent(req.params.employeeId)}`);
  });

  app.get('/employees/:employeeId/sessions/:sessionId/segments', requireLogin, async (req, res) => {
    const { employeeId, sessionId } = req.params;
    try {
      const segments = await storage.listSegments(employeeId, sessionId);
      res.render('segments', {
        user: req.user,
        employeeId,
        sessionId,
        segments: segments.map((s) => ({
          ...s,
          startTimeFmt: fmtTime(s.startTime),
          endTimeFmt: fmtTime(s.endTime),
          fileSizeFmt: fmtBytes(s.fileSize),
        })),
      });
    } catch (err) {
      res.status(500).render('error', { error: err.message });
    }
  });

  app.get('/video/:employeeId/:sessionId', requireLogin, async (req, res) => {
    try {
      const manifest = await storage.videoManifest(req.params.employeeId, req.params.sessionId);
      res.render('video-viewer', { user: req.user, employeeId: req.params.employeeId, sessionId: req.params.sessionId, manifest });
    } catch (err) { res.status(500).render('error', { error: err.message }); }
  });

  app.get('/video/:employeeId/:sessionId/:pageId/stream', requireLogin, async (req, res) => {
    const upstream = await storage.getVideoStream(req.params.employeeId, req.params.sessionId, req.params.pageId, req.headers.range);
    res.status(upstream.status);
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (upstream.headers[header]) res.setHeader(header, upstream.headers[header]);
    upstream.data.pipe(res);
  });

  // 回放页：嵌入 Trace Viewer，iframe 加载签名 URL
  app.get('/view/:employeeId/:sessionId/:segmentId', requireLogin, async (req, res) => {
    const { employeeId, sessionId, segmentId } = req.params;
    try {
      const { url } = await storage.signDownload(segmentId);
      // 指向 storage-server 自托管的 Trace Viewer（与 trace 下载同源，避免跨域/混合内容阻断）
      const viewerUrl = `${config.storageServerUrl.replace(/\/$/, '')}/viewer/?trace=${encodeURIComponent(url)}`;
      res.render('viewer', {
        user: req.user,
        employeeId,
        sessionId,
        segmentId,
        traceUrl: url,
        viewerUrl,
      });
    } catch (err) {
      res.status(500).render('error', { error: err.message });
    }
  });

  return app;
}

async function main() {
  const config = loadConfig();
  console.log('=== Browser Record Admin Dashboard 启动 ===');
  console.log(`存储服务: ${config.storageServerUrl}`);
  const app = createApp(config);
  app.listen(config.port, config.host, () => {
    console.log(`[dashboard] 监听: http://${config.host}:${config.port}`);
  });
}

main().catch((err) => {
  console.error('[dashboard] 启动失败:', err);
  process.exit(1);
});

module.exports = { createApp };
