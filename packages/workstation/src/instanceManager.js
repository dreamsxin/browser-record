'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

/**
 * 浏览器实例管理器。
 *
 * 每个实例：
 *  - 分配唯一 instanceId（默认为 employee_<短随机>，可由调用方指定）
 *  - 分配唯一 profile 目录：<profilesDir>/<instanceId>
 *  - 分配唯一 CDP 端口（从 [min,max] 范围内取空闲端口）
 *  - 启动浏览器，并以独立子进程启动 recording-agent 指向该端口
 *
 * 停止实例时：先停 agent，再关闭浏览器；并保留 profile 目录（可复用）。
 */
class InstanceManager {
  constructor(config) {
    this.config = config;
    this.instances = new Map(); // instanceId -> { instanceId, profileDir, cdpPort, browser, agent, startedAt, status }
    this._playwrightChromiumPath = null;
  }

  /**
   * 在端口范围内找一个空闲端口。优先使用 config 给定范围，逐个尝试 listen。
   */
  _findFreePort() {
    const net = require('net');
    const { min, max } = this.config.cdpPortRange;
    const used = new Set([...this.instances.values()].map((i) => i.cdpPort));

    return new Promise((resolve, reject) => {
      const tryPort = (port) => {
        if (port > max) return reject(new Error('CDP 端口范围内无空闲端口'));
        if (used.has(port)) return tryPort(port + 1);
        const server = net.createServer();
        server.unref();
        server.on('error', () => tryPort(port + 1));
        server.listen(port, '127.0.0.1', () => {
          server.close(() => resolve(port));
        });
      };
      tryPort(min);
    });
  }

  _resolveChromiumPath() {
    if (this._playwrightChromiumPath) return this._playwrightChromiumPath;
    if (this.config.browser.executablePath) {
      this._playwrightChromiumPath = this.config.browser.executablePath;
      return this._playwrightChromiumPath;
    }
    try {
      // 复用 recording-agent 的 playwright 安装
      const agentPath = path.join(this.config._root, 'packages', 'recording-agent');
      const { chromium } = require(require.resolve('playwright', { paths: [agentPath, this.config._root] }));
      this._playwrightChromiumPath = chromium.executablePath();
    } catch (e) {
      throw new Error('无法定位 Chromium 可执行文件：请在 config.browser.executablePath 指定，或安装 playwright');
    }
    return this._playwrightChromiumPath;
  }

  /**
   * 启动一个浏览器实例并挂接 recording-agent。
   * @param {object} opts
   * @param {string} [opts.employeeId]  可选，指定员工 ID；否则自动生成
   * @param {string} [opts.startingUrl] 可选，覆盖默认起始页
   * @returns {Promise<object>} 实例信息
   */
  async start({ employeeId, startingUrl } = {}) {
    const instanceId = employeeId || `employee_${crypto.randomBytes(3).toString('hex')}`;
    if (this.instances.has(instanceId)) {
      throw new Error(`实例已存在: ${instanceId}（请先 stop 再 start）`);
    }

    const profileDir = path.join(this.config.profilesDir, instanceId);
    fs.mkdirSync(profileDir, { recursive: true });

    const cdpPort = await this._findFreePort();
    const exePath = this._resolveChromiumPath();
    const url = startingUrl || this.config.browser.startingUrl || 'about:blank';

    const browserArgs = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      ...this.config.browser.args,
      url,
    ];

    console.log(`[workstation] 启动浏览器实例 ${instanceId} (cdp=:${cdpPort}, profile=${profileDir})`);
    const browser = spawn(exePath, browserArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
      detached: true,
    });

    const instance = {
      instanceId,
      profileDir,
      cdpPort,
      browser,
      agent: null,
      startedAt: Date.now(),
      status: 'browser_starting',
      browserPid: browser.pid,
      agentPid: null,
    };
    this.instances.set(instanceId, instance);

    browser.stdout.on('data', () => {});
    browser.stderr.on('data', () => {});

    browser.on('exit', (code) => {
      console.log(`[workstation] 浏览器进程退出: ${instanceId} (code=${code})`);
      const cur = this.instances.get(instanceId);
      if (cur) cur.status = 'browser_exited';
      // 浏览器退出后连带停止 agent
      this._stopAgent(instanceId).catch(() => {});
    });

    // 等待 CDP 端口可用，再启动 agent
    try {
      await this._waitForCdp(cdpPort);
      instance.status = 'browser_ready';
      await this._startAgent(instance);
    } catch (err) {
      instance.status = 'error';
      instance.error = err.message;
      console.error(`[workstation] 实例 ${instanceId} 初始化失败: ${err.message}`);
    }

    return this._public(instance);
  }

  async _waitForCdp(port, { timeout = 15000 } = {}) {
    const http = require('http');
    const deadline = Date.now() + timeout;
    const probe = () => new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        res.resume();
        res.statusCode === 200 ? resolve() : reject(new Error(`CDP 状态码 ${res.statusCode}`));
      });
      req.on('error', reject);
      req.setTimeout(1000, () => req.destroy(new Error('timeout')));
    });

    while (Date.now() < deadline) {
      try { await probe(); return; } catch (e) { await sleep(300); }
    }
    throw new Error(`等待 CDP :${port} 就绪超时`);
  }

  async _startAgent(instance) {
    const { instanceId, cdpPort } = instance;
    const agentScript = path.join(this.config._root, this.config.agent.script);
    if (!fs.existsSync(agentScript)) {
      throw new Error(`recording-agent 脚本不存在: ${agentScript}`);
    }

    const env = {
      ...process.env,
      EMPLOYEE_ID: instanceId,
      CDP_ENDPOINT: `http://127.0.0.1:${cdpPort}`,
      STORAGE_SERVER_URL: this.config.storageServerUrl,
      UPLOAD_TOKEN: this.config.uploadToken,
      SEGMENT_DURATION_MS: String(this.config.agent.segmentDurationMs),
      // agent 健康检查端口：基于 cdpPort 偏移，避免冲突（4100 基址 + 偏移）
      HEALTH_PORT: String(4100 + (cdpPort - (this.config.cdpPortRange.min))),
    };

    console.log(`[workstation] 启动 recording-agent: ${instanceId} -> ${env.CDP_ENDPOINT}`);
    const agent = spawn(process.execPath, [agentScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: this.config._root,
      detached: true,
    });
    instance.agent = agent;
    instance.agentPid = agent.pid;
    instance.agentHealthPort = Number(env.HEALTH_PORT);
    instance.status = instance.status === 'browser_ready' ? 'recording' : instance.status;

    agent.stdout.on('data', (d) => process.stdout.write(`[agent:${instanceId}] ${d}`));
    agent.stderr.on('data', (d) => process.stderr.write(`[agent:${instanceId}!] ${d}`));
    agent.on('exit', (code) => {
      console.log(`[workstation] recording-agent 退出: ${instanceId} (code=${code})`);
      const cur = this.instances.get(instanceId);
      if (cur && cur.agent === agent) {
        cur.agent = null;
        cur.agentPid = null;
        if (cur.status === 'recording') cur.status = 'browser_ready';
      }
    });
  }

  async _stopAgent(instanceId) {
    const instance = this.instances.get(instanceId);
    if (!instance || !instance.agent) return;
    const agent = instance.agent;
    try {
      // 优先通过 HTTP /shutdown 触发优雅停止（Windows 上比信号可靠）：
      // agent 完成 当前分段保存 + 上传 后自行退出。
      if (instance.agentHealthPort) {
        await this._httpShutdown(instance.agentHealthPort);
      }
      await waitForExit(agent, 10000);
    } catch (e) {
      // 兜底：信号杀进程
      try { agent.kill('SIGINT'); } catch (_) {}
      try { agent.kill('SIGKILL'); } catch (_) {}
    }
    instance.agent = null;
    instance.agentPid = null;
  }

  _httpShutdown(port) {
    return new Promise((resolve, reject) => {
      const req = require('http').request(
        { host: '127.0.0.1', port, path: '/shutdown', method: 'POST', timeout: 5000 },
        (res) => { res.resume(); res.statusCode === 202 ? resolve() : reject(new Error('shutdown ' + res.statusCode)); }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('shutdown timeout')); });
      req.end();
    });
  }

  /**
   * 停止实例：先停 agent，再关浏览器。
   */
  async stop(instanceId) {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`实例不存在: ${instanceId}`);

    await this._stopAgent(instanceId);

    const { browser } = instance;
    if (browser && !browser.killed) {
      try {
        browser.kill('SIGTERM');
        await waitForExit(browser, 8000);
      } catch (e) {
        try { browser.kill('SIGKILL'); } catch (_) {}
      }
    }
    instance.status = 'stopped';
    instance.stoppedAt = Date.now();
    return this._public(instance);
  }

  list() {
    return [...this.instances.values()].map((i) => this._public(i));
  }

  get(instanceId) {
    const i = this.instances.get(instanceId);
    return i ? this._public(i) : null;
  }

  /**
   * 查询实例的 recording-agent 健康状态（透传 agent 的 /health）。
   */
  async getAgentHealth(instanceId) {
    const instance = this.instances.get(instanceId);
    if (!instance || !instance.agentHealthPort) return null;
    const http = require('http');
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${instance.agentHealthPort}/health`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    });
  }

  _public(instance) {
    return {
      instanceId: instance.instanceId,
      profileDir: instance.profileDir,
      cdpPort: instance.cdpPort,
      browserPid: instance.browserPid,
      agentPid: instance.agentPid,
      agentHealthPort: instance.agentHealthPort || null,
      status: instance.status,
      startedAt: instance.startedAt,
      stoppedAt: instance.stoppedAt || null,
      error: instance.error || null,
    };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForExit(child, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(); } }, timeout);
    child.on('exit', () => { if (!done) { done = true; clearTimeout(timer); resolve(); } });
  });
}

module.exports = { InstanceManager };
