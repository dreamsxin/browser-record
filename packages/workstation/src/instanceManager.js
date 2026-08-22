'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { InProcessRecorder } = require('./inProcessRecorder');
const { OperationRecorder } = require('../../operation-recorder/src/operationRecorder');

/**
 * 浏览器实例管理器（Playwright 原生启动 + 进程内录制）。
 *
 * 每个实例：
 *  - 分配唯一 instanceId（默认 employee_<短随机>，可由调用方指定）
 *  - 分配唯一 profile 目录：<profilesDir>/<instanceId>
 *  - 用 chromium.launchPersistentContext 启动浏览器（Playwright 拥有句柄，精确控制生命周期）
 *  - 在该 context 上启动 InProcessRecorder 分段录制并上传
 *
 * 停止实例时：recorder.stop()（刷出当前分段并上传）→ await context.close()
 * （Playwright 原生关闭，精确终止所有子进程，无需 taskkill 兜底）。
 */
class InstanceManager {
  constructor(config) {
    this.config = config;
    this.instances = new Map();
  }

  _resolveChromiumPath() {
    if (this.config.browser.executablePath) return this.config.browser.executablePath;
    return chromium.executablePath();
  }

  /**
   * 启动一个浏览器实例并内置录制。
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

    const exePath = this._resolveChromiumPath();
    const url = startingUrl || this.config.browser.startingUrl || 'about:blank';
    const launchArgs = this.config.browser.args || [];

    console.log(`[workstation] 启动浏览器实例 ${instanceId} (profile=${profileDir})`);

    const context = await chromium.launchPersistentContext(profileDir, {
      headless: this.config.browser.headless !== false ? false : !!this.config.browser.headless,
      executablePath: exePath,
      args: launchArgs,
    });

    const instance = {
      instanceId,
      profileDir,
      context,
      recorder: null,
      startedAt: Date.now(),
      status: 'browser_ready',
      closed: false,
    };
    this.instances.set(instanceId, instance);

    // 浏览器关闭（用户手动关窗或崩溃）：尝试刷出当前分段并上传，
    // 更新录制状态（context 已关，tracing.stop 可能失败，recorder 内部会容忍）
    context.on('close', () => {
      console.log(`[workstation] 浏览器上下文已关闭: ${instanceId}`);
      const cur = this.instances.get(instanceId);
      if (!cur) return;
      cur.closed = true;
      if (cur.status !== 'stopped') cur.status = 'browser_closed';
      if (cur.recorder) {
        const close = cur.recorder.markBrowserClosed || cur.recorder.stop;
        close.call(cur.recorder).catch((err) => console.error(`[workstation] 浏览器关闭后状态收敛异常 (${instanceId}):`, err));
      }
    });

    // 根据模式启动进程内 Trace 或自定义 Operation Recorder
    const rc = this.config.recording || {};
    const oc = this.config.operations || {};
    const recorder = this.config.recordingMode === 'operations'
      ? new OperationRecorder({
          employeeId: instanceId,
          sessionId: Date.now(),
          storageServerUrl: this.config.storageServerUrl,
          uploadToken: this.config.uploadToken,
          localDir: path.join(profileDir, 'operations'),
          chunkDurationMs: oc.chunkDurationMs,
          maxEvents: oc.maxEvents,
          maxScreenshotsPerSecond: oc.maxScreenshotsPerSecond,
          screenshotQuality: oc.screenshotQuality,
          captureNetworkSummary: oc.captureNetworkSummary,
          captureConsole: oc.captureConsole,
        })
      : new InProcessRecorder({
          employeeId: instanceId,
          segmentDurationMs: rc.segmentDurationMs || this.config.agent?.segmentDurationMs || 1800000,
          storageServerUrl: this.config.storageServerUrl,
          uploadToken: this.config.uploadToken,
          localTracesDir: path.join(profileDir, 'traces'),
          retry: rc.retry,
          deleteAfterUpload: rc.deleteAfterUpload !== false,
        });
    instance.recorder = recorder;

    try {
      await recorder.start(context);
      instance.status = 'recording';
    } catch (err) {
      instance.status = 'error';
      instance.error = err.message;
      console.error(`[workstation] 实例 ${instanceId} 录制启动失败: ${err.message}`);
    }

    // 导航到起始页（在录制启动后，确保首屏被记录）
    try {
      const pages = context.pages();
      const page = pages[0];
      if (page && url && url !== 'about:blank') {
        await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    } catch (e) { /* 忽略导航错误 */ }

    return this._public(instance);
  }

  /**
   * 停止实例：先刷出并上传当前分段，再关闭浏览器。
   */
  async stop(instanceId) {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`实例不存在: ${instanceId}`);

    if (instance.recorder) {
      try {
        await instance.recorder.stop();
      } catch (err) {
        console.error(`[workstation] 实例 ${instanceId} recorder.stop 异常:`, err);
      }
    }

    if (instance.context && !instance.closed) {
      try {
        await instance.context.close();
      } catch (err) {
        console.error(`[workstation] 实例 ${instanceId} context.close 异常:`, err);
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
   * 从实例列表中移除一个已停止/已关闭的实例（不删除 profile 目录）。
   * 若实例仍在运行，会先尝试停止。
   */
  async remove(instanceId) {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`实例不存在: ${instanceId}`);
    const active = instance.status !== 'stopped' && instance.status !== 'browser_closed' && !instance.closed;
    if (active) {
      await this.stop(instanceId);
    }
    this.instances.delete(instanceId);
    return { instanceId, removed: true };
  }

  getRecorderSnapshot(instanceId) {
    const instance = this.instances.get(instanceId);
    if (!instance || !instance.recorder) return null;
    return instance.recorder.snapshot();
  }

  _public(instance) {
    const snap = instance.recorder ? instance.recorder.snapshot() : {};
    return {
      instanceId: instance.instanceId,
      profileDir: instance.profileDir,
      status: instance.status,
      startedAt: instance.startedAt,
      stoppedAt: instance.stoppedAt || null,
      error: instance.error || null,
      // 录制状态快照
      recording: !!snap.recording,
      browserConnected: !!snap.browserConnected,
      sessionId: snap.sessionId || null,
      currentSegment: snap.currentSegment ?? null,
      totalSegments: snap.totalSegments ?? 0,
      lastUploadTime: snap.lastUploadTime || null,
      lastError: snap.lastError || null,
    };
  }
}

module.exports = { InstanceManager };
