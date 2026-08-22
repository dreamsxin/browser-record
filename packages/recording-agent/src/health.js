'use strict';

const http = require('http');

/**
 * 启动一个轻量 HTTP 健康检查 + 控制 服务，便于运维/监控探针查询代理状态，
 * 并提供 /shutdown 端点用于优雅停止（在 Windows 上比信号更可靠）。
 * 仅绑定到 127.0.0.1（可配置），不对外暴露。
 *
 * @param {object} state         共享运行状态（供 /health 读取）
 * @param {object} hooks
 * @param {function} hooks.shutdown  优雅停止回调（异步），由 /shutdown 触发
 */
function startHealthServer(state, { port, host }, hooks = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: state.running ? 'ok' : 'stopped',
        pid: process.pid,
        uptimeMs: process.uptime() * 1000,
        employeeId: state.employeeId,
        sessionId: state.sessionId,
        browserConnected: !!state.browserConnected,
        currentSegment: state.currentSegment,
        segmentStartTime: state.segmentStartTime,
        totalSegments: state.totalSegments || 0,
        lastUploadTime: state.lastUploadTime || null,
        lastError: state.lastError || null,
        timestamp: Date.now(),
      }, null, 2));
      return;
    }

    if (req.url === '/shutdown' && req.method === 'POST') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'shutting down' }));
      if (typeof hooks.shutdown === 'function') {
        // 异步触发，不阻塞响应
        Promise.resolve(hooks.shutdown()).catch((err) => {
          console.error('[health] shutdown 回调异常:', err);
          process.exit(1);
        });
      } else {
        process.exit(0);
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  server.listen(port, host, () => {
    console.log(`[health] 健康检查服务已启动: http://${host}:${port}/health`);
  });

  server.on('error', (err) => {
    console.error(`[health] 健康检查服务启动失败: ${err.message}`);
  });

  return server;
}

module.exports = { startHealthServer };
