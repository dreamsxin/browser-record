'use strict';

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const { loadConfig } = require('./config');
const { initDb } = require('./db');
const { startDailyCleanup } = require('./retention');
const { buildAuthRouter } = require('./routes/auth');
const { buildUploadRouter } = require('./routes/upload');
const { buildFilesRouter } = require('./routes/files');
const { buildDownloadRouter } = require('./routes/download');
const { buildLifecycleRouter } = require('./routes/lifecycle');

function createApp(config) {
  fs.mkdirSync(config.recordingsDir, { recursive: true });
  initDb(config);

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(morgan('tiny'));

  // 健康检查（无需鉴权）
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'storage-server', timestamp: Date.now() });
  });

  // 自托管 Playwright Trace Viewer（静态前端）。
  // viewer 与 trace 下载同源，避免 trace.playwright.dev 跨域 fetch localhost
  // 触发的混合内容 / Private Network Access 阻断。
  const viewerDir = path.join(path.dirname(require.resolve('playwright-core')), 'lib', 'vite', 'traceViewer');
  if (fs.existsSync(viewerDir)) {
    app.use('/viewer', express.static(viewerDir));
    console.log(`[viewer] Trace Viewer 自托管于 /viewer (来源: ${viewerDir})`);
  } else {
    console.warn(`[viewer] 未找到 Playwright Trace Viewer 静态目录: ${viewerDir}`);
  }

  app.use('/api/auth', buildAuthRouter(config));
  app.use('/api/lifecycle', buildLifecycleRouter(config));
  app.use('/api/upload', buildUploadRouter(config));
  app.use('/api/files', buildFilesRouter(config));
  app.use('/api/download', buildDownloadRouter(config));

  // 404
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));

  // 错误处理
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[server] 未处理错误:', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

async function main() {
  const config = loadConfig();
  console.log('=== Browser Record Storage Server 启动 ===');
  console.log(`数据目录: ${config.dataDir}`);
  console.log(`录制目录: ${config.recordingsDir}`);
  console.log(`数据库: ${config.dbPath}`);
  console.log(`保留策略: 最近 ${config.retention.maxSessionsPerEmployee} 个会话 / 每人 ${(config.retention.maxBytesPerEmployee / 1024 / 1024 / 1024).toFixed(2)}GB`);

  const app = createApp(config);

  // 启动每日全量清理
  startDailyCleanup(config);

  app.listen(config.port, config.host, () => {
    console.log(`[server] 监听: http://${config.host}:${config.port}`);
  });
}

main().catch((err) => {
  console.error('[server] 启动失败:', err);
  process.exit(1);
});
