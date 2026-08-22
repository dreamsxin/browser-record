#!/usr/bin/env node
'use strict';

/**
 * workstation CLI 客户端。
 *
 * 用法：
 *   workstation start [--id <employeeId>] [--url <startingUrl>]
 *   workstation stop <instanceId>
 *   workstation stop-all
 *   workstation list
 *   workstation get <instanceId>
 *
 * 默认连接 http://127.0.0.1:5000，可用 WORKSTATION_URL 覆盖。
 */

const http = require('http');

const BASE_HOST = (process.env.WORKSTATION_URL || 'http://127.0.0.1:5000')
  .replace(/^https?:\/\//, '').replace(/\/$/, '');

function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: BASE_HOST.split(':')[0], port: Number(BASE_HOST.split(':')[1] || 5000), path: p, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
          catch (e) { resolve({ status: res.statusCode, data: buf }); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function fmtInstance(i) {
  const started = i.startedAt ? new Date(i.startedAt).toLocaleString() : '-';
  const rec = i.recording ? '录制中' : '未录制';
  return `${i.instanceId.padEnd(22)} mode=${(i.recordingMode || 'trace').padEnd(6)} status=${(i.status || '').padEnd(16)} ${rec.padEnd(6)} seg=${i.currentSegment ?? '-'}  total=${i.totalSegments ?? 0}  started=${started}`;
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'list' || cmd === 'ls') {
      const r = await request('GET', '/api/instances');
      const list = r.data || [];
      if (!list.length) { console.log('（无实例）'); return; }
      console.log('实例列表：');
      list.map(fmtInstance).forEach((s) => console.log('  ' + s));
    } else if (cmd === 'start') {
      const idx = rest.indexOf('--id'); const employeeId = idx >= 0 ? rest[idx + 1] : undefined;
      const uidx = rest.indexOf('--url'); const url = uidx >= 0 ? rest[uidx + 1] : undefined;
      const midx = rest.indexOf('--mode'); const recordingMode = midx >= 0 ? rest[midx + 1] : 'trace';
      const r = await request('POST', '/api/instances', { employeeId, startingUrl: url, recordingMode });
      if (r.status !== 200) { console.error('启动失败:', r.data); process.exit(1); }
      console.log('已启动实例：\n  ' + fmtInstance(r.data));
    } else if (cmd === 'stop') {
      const id = rest[0];
      if (!id) { console.error('用法: workstation stop <instanceId>'); process.exit(1); }
      const r = await request('POST', `/api/instances/${encodeURIComponent(id)}/stop`);
      if (r.status !== 200) { console.error('停止失败:', r.data); process.exit(1); }
      console.log('已停止实例：\n  ' + fmtInstance(r.data));
    } else if (cmd === 'stop-all') {
      const r = await request('POST', '/api/instances/stop-all');
      console.log('已停止全部实例：', (r.data.stopped || []).length, '个');
    } else if (cmd === 'remove' || cmd === 'rm') {
      const id = rest[0];
      if (!id) { console.error('用法: workstation remove <instanceId>'); process.exit(1); }
      const r = await request('DELETE', `/api/instances/${encodeURIComponent(id)}`);
      if (r.status !== 200) { console.error('移除失败:', r.data); process.exit(1); }
      console.log('已移除实例:', id);
    } else if (cmd === 'get') {
      const id = rest[0];
      if (!id) { console.error('用法: workstation get <instanceId>'); process.exit(1); }
      const r = await request('GET', `/api/instances/${encodeURIComponent(id)}`);
      if (r.status !== 200) { console.error('查询失败:', r.data); process.exit(1); }
      console.log(JSON.stringify(r.data, null, 2));
    } else {
      console.log('workstation — 浏览器实例管理 CLI\n');
      console.log('用法：');
      console.log('  workstation start [--id <employeeId>] [--url <startingUrl>] [--mode trace|video]');
      console.log('  workstation stop <instanceId>');
      console.log('  workstation stop-all');
      console.log('  workstation remove <instanceId>');
      console.log('  workstation list');
      console.log('  workstation get <instanceId>');
    }
  } catch (err) {
    console.error('CLI 错误：', err.message, '\n（workstation 服务是否已启动？npm run workstation）');
    process.exit(1);
  }
})();
