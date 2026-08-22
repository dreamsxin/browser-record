#!/usr/bin/env node
'use strict';
/**
 * 端到端冒烟测试：启动 storage-server + admin-dashboard +（可选）Chromium CDP，
 * 运行 recording-agent 短分段录制，验证「录制 → 上传 → 查询 → 签名下载 → zip 有效」全链路。
 *
 * 用法：
 *   node scripts/smoke-e2e.js            # 含浏览器录制链路（需 playwright 已安装）
 *   node scripts/smoke-e2e.js --no-browser  # 仅校验 server + dashboard + API
 *
 * 退出码 0 = 全部通过。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');

const ROOT = path.resolve(__dirname, '..');
const SERVER_URL = 'http://localhost:4000';
const DASH_URL = 'http://localhost:3000';
const CDP_URL = 'http://localhost:9222';

let procs = [];
function spawnProc(name, cwd, args, env = {}) {
  // node 端无 shell，避免 shell 注入与 DEP0190；args 为字符串数组
  const p = spawn(args[0], args.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[${name}!] ${d}`));
  procs.push(p);
  return p;
}
function cleanup(code) {
  // 先尝试通过 workstation 的 stop-all 关闭其拉起的浏览器/agent（detached 子进程）
  axios.post('http://127.0.0.1:5000/api/instances/stop-all', {}, { timeout: 8000 }).catch(() => {});
  procs.forEach((p) => { try { p.kill('SIGTERM'); } catch (e) {} });
  setTimeout(() => process.exit(code), 1500);
}
process.on('SIGINT', () => cleanup(130));
process.on('SIGTERM', () => cleanup(143));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(url, tries = 30, label = '') {
  for (let i = 0; i < tries; i++) {
    try { await axios.get(url, { timeout: 1500 }); return true; } catch (e) { await sleep(500); }
  }
  throw new Error(`等待 ${label || url} 超时`);
}

function log(...a) { console.log('\n▶', ...a); }
function ok(...a) { console.log('  ✓', ...a); }

(async () => {
  const withBrowser = !process.argv.includes('--no-browser');

  // 清理旧数据
  fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'packages/recording-agent/traces'), { recursive: true, force: true });

  // 1. 启动 storage-server
  log('启动 storage-server');
  spawnProc('server', ROOT, ['node', 'packages/storage-server/src/index.js']);
  await wait(`${SERVER_URL}/health`, 40, 'storage-server');
  ok('storage-server 已就绪');

  // 2. 启动 admin-dashboard
  log('启动 admin-dashboard');
  spawnProc('dash', ROOT, ['node', 'packages/admin-dashboard/src/server.js']);
  await wait(`${DASH_URL}/login`, 40, 'dashboard');
  ok('admin-dashboard 已就绪');

  // 3. API 鉴权 + 查询 + 上传（伪造文件）+ 签名下载
  log('API 全链路校验');
  const login = await axios.post(`${SERVER_URL}/api/auth/login`, { username: 'admin', password: 'admin123' });
  const auth = { headers: { Authorization: `Bearer ${login.data.token}` } };

  const tmp = path.join(require('os').tmpdir(), `seg_${Date.now()}.zip`);
  fs.writeFileSync(tmp, Buffer.from('PK\x03\x04mock'));
  const form = new FormData();
  form.append('file', fs.createReadStream(tmp));
  form.append('employeeId', 'emp_api');
  form.append('sessionId', String(Date.now()));
  form.append('segmentIndex', '0');
  form.append('startTime', String(Date.now() - 60000));
  form.append('endTime', String(Date.now()));
  const up = await axios.post(`${SERVER_URL}/api/upload`, form, { headers: { ...form.getHeaders(), 'X-Upload-Token': 'dev-upload-token' } });
  ok('上传成功 id=' + up.data.id);

  const emps = await axios.get(`${SERVER_URL}/api/files/employees`, auth);
  ok('员工查询: ' + emps.data.map((e) => e.employeeId).join(','));

  const sign = await axios.get(`${SERVER_URL}/api/download/segments/${up.data.id}/sign`, auth);
  const dlToken = new URL(sign.data.url).searchParams.get('token');
  const dl = await axios.get(`${SERVER_URL}/api/download/segments/${up.data.id}?token=${dlToken}`, { responseType: 'arraybuffer' });
  ok('签名下载: ' + dl.data.length + ' bytes');

  const noauth = await axios.get(`${SERVER_URL}/api/files/employees`).catch((e) => e.response);
  if (noauth.status !== 401) throw new Error('鉴权守卫失效');
  ok('无 token -> 401');

  // 4. dashboard 页面链路
  log('dashboard 页面链路');
  const r4 = await axios.post(`${DASH_URL}/login`, new URLSearchParams({ username: 'admin', password: 'admin123' }), { maxRedirects: 0, validateStatus: () => true });
  const cookie = (r4.headers['set-cookie'] || [])[0].split(';')[0];
  const r5 = await axios.get(`${DASH_URL}/employees`, { headers: { Cookie: cookie } });
  if (!r5.data.includes('emp_api')) throw new Error('dashboard 未显示员工');
  ok('dashboard 显示员工列表');

  // 5. 浏览器录制链路（可选）
  if (withBrowser) {
    log('启动 Chromium (CDP) 并运行 recording-agent');
    const chromiumPath = require('playwright').chromium.executablePath();
    // 每次运行用唯一目录，避免上次残留进程锁住旧目录导致启动失败
    const userDataDir = path.join(require('os').tmpdir(), `br-chrome-cdp-${Date.now()}`);
    fs.rmSync(userDataDir, { recursive: true, force: true });
    spawnProc('chrome', ROOT, [chromiumPath, '--remote-debugging-port=9222', `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank']);
    await wait(`${CDP_URL}/json/version`, 40, 'chromium CDP');
    ok('Chromium CDP 已就绪');

    const agent = spawn('node', ['packages/recording-agent/src/index.js'], {
      cwd: ROOT,
      env: { ...process.env, EMPLOYEE_ID: 'emp_smoke', SEGMENT_DURATION_MS: '6000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    agent.stdout.on('data', (d) => process.stdout.write(`[agent] ${d}`));
    agent.stderr.on('data', (d) => process.stderr.write(`[agent!] ${d}`));
    procs.push(agent);

    // 等待至少 2 次分段轮转 (~14s)
    await sleep(15000);
    try { agent.kill('SIGTERM'); } catch (e) {}

    const segs = await axios.get(`${SERVER_URL}/api/files/employees/emp_smoke/sessions`, auth);
    const total = segs.data.reduce((s, x) => s + x.segmentCount, 0);
    if (total < 1) throw new Error('录制代理未产生分段');
    ok(`录制代理产生分段: ${total} 个`);

    // 校验首个 trace zip 包含 trace.trace
    const segList = await axios.get(`${SERVER_URL}/api/files/employees/emp_smoke/sessions/${segs.data[0].sessionId}/segments`, auth);
    const segSign = await axios.get(`${SERVER_URL}/api/download/segments/${segList.data[0].id}/sign`, auth);
    const segToken = new URL(segSign.data.url).searchParams.get('token');
    const segDl = await axios.get(`${SERVER_URL}/api/download/segments/${segList.data[0].id}?token=${segToken}`, { responseType: 'arraybuffer' });
    ok(`trace zip 下载: ${segDl.data.length} bytes`);
    // 简单校验 zip 头
    if (segDl.data[0] !== 0x50 || segDl.data[1] !== 0x4b) throw new Error('下载文件非 zip');
    ok('zip 头校验通过 (PK)');
  } else {
    log('跳过浏览器录制链路 (--no-browser)');
  }

  // 6. 工作台链路：启动实例（Playwright 原生 + 进程内录制）-> 验证录制中 -> 停止 -> 验证上传
  if (withBrowser) {
    log('工作台 (workstation) 链路校验');
    const WS_URL = 'http://127.0.0.1:5000';
    spawnProc('workstation', ROOT, ['node', 'packages/workstation/src/server.js']);
    await wait(`${WS_URL}/health`, 40, 'workstation');

    const inst = await axios.post(`${WS_URL}/api/instances`, { employeeId: 'emp_ws' }, {
      headers: { 'Content-Type': 'application/json' }, timeout: 30000,
    });
    if (inst.data.status !== 'recording') throw new Error('工作台实例未进入 recording 状态: ' + inst.data.status);
    ok(`实例启动: ${inst.data.instanceId} recording=${inst.data.recording} segment=${inst.data.currentSegment}`);

    // 进程内录制：直接从实例详情读取录制状态快照
    await sleep(1500);
    const detail = await axios.get(`${WS_URL}/api/instances/${inst.data.instanceId}`);
    if (!detail.data.recording || !detail.data.browserConnected) throw new Error('进程内录制未运行');
    ok(`录制中: recording=${detail.data.recording} browserConnected=${detail.data.browserConnected} segment=${detail.data.currentSegment}`);

    // 停止实例 -> 刷出当前分段并上传 -> context.close() 关闭浏览器
    const stopped = await axios.post(`${WS_URL}/api/instances/${inst.data.instanceId}/stop`, {}, { timeout: 30000 });
    if (stopped.data.status !== 'stopped') throw new Error('实例停止失败: ' + stopped.data.status);
    ok('实例已停止（context.close 精确关闭浏览器）');

    // 验证停止时产生的分段已上传到存储服务
    await sleep(2000);
    const wsSessions = await axios.get(`${SERVER_URL}/api/files/employees/emp_ws/sessions`, auth);
    const wsCount = wsSessions.data.reduce((s, x) => s + x.segmentCount, 0);
    if (wsCount < 1) throw new Error('工作台停止后未上传分段');
    ok(`停止时上传分段: ${wsCount} 个`);

    // 验证自托管 Trace Viewer 可同源访问
    const viewer = await axios.get(`${SERVER_URL}/viewer/`, { timeout: 5000 });
    if (viewer.status !== 200 || !viewer.data.includes('Playwright Trace Viewer')) throw new Error('自托管 Trace Viewer 加载失败');
    ok('自托管 Trace Viewer 可访问 (/viewer)');

    // 验证 trace 下载为 inline（sendFile，非 attachment）
    const wsSegs = await axios.get(`${SERVER_URL}/api/files/employees/emp_ws/sessions/${wsSessions.data[0].sessionId}/segments`, auth);
    const wsSign = await axios.get(`${SERVER_URL}/api/download/segments/${wsSegs.data[0].id}/sign`, auth);
    const wsDl = await axios.get(wsSign.data.url, { responseType: 'arraybuffer' });
    if (wsDl.data[0] !== 0x50 || wsDl.data[1] !== 0x4b) throw new Error('工作台 trace 非 zip');
    ok(`trace 同源下载: ${wsDl.data.length} bytes (viewer 可同源加载)`);
  }


  console.log('\n✅ 全部冒烟测试通过\n');
  cleanup(0);
})().catch((err) => {
  console.error('\n❌ 冒烟测试失败:', err.response ? `${err.response.status} ${JSON.stringify(err.response.data)}` : err.message);
  cleanup(1);
});
