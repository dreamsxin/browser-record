'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { uploadSegment } = require('../../recording-agent/src/uploader');
const { finalizeTrace } = require('../../live-trace-recorder/src/finalizeTrace');

/**
 * 进程内录制器：在 workstation（InstanceManager）已通过 Playwright
 * launchPersistentContext 创建的 BrowserContext 上运行 Playwright Tracing，
 * 按固定时长分段，停止时刷出当前分段并异步上传。
 *
 * 使用 tracing.start 一次 + startChunk/stopChunk 轮转的分段模型：
 *  - start() 调用 tracing.start（整段 trace 的根），再 startChunk 开第一段。
 *  - 定时器到点：stopChunk({path}) 把当前分段刷到磁盘 → 上传 → startChunk 开下一段。
 *  - stop()：stopChunk 刷出当前分段 → 上传。
 * 这样即使浏览器被用户手动关闭，stopChunk 仍可能在 context 彻底销毁前
 * 完成刷盘；即便失败，已轮转的前续分段也已落盘。
 *
 *  - 不负责连接/启动浏览器（context 由 InstanceManager 提供）
 *  - 不含 CDP 重连（workstation 拥有 context 句柄，崩溃走 close 事件）
 *  - sessionId 每次启动实例生成（不绑定进程生命周期）
 */
class InProcessRecorder {
  constructor({ employeeId, sessionId, segmentDurationMs, storageServerUrl, uploadToken, localTracesDir, rawTracesDir, retry, deleteAfterUpload }) {
    this.employeeId = employeeId;
    this.segmentDurationMs = segmentDurationMs || 1800000;
    this.storageServerUrl = storageServerUrl;
    this.uploadToken = uploadToken;
    this.localTracesDir = path.resolve(localTracesDir);
    this.rawTracesDir = path.resolve(rawTracesDir || localTracesDir);
    this.retry = retry;
    this.deleteAfterUpload = deleteAfterUpload !== false;
    this.lifecycleUrl = `${this.storageServerUrl.replace(/\/$/, '')}/api/lifecycle`;
    this.heartbeatTimer = null;
    this.lifecycleClosed = false;
    this.context = null;
    this.sessionId = String(sessionId || Date.now());
    this.segmentIndex = 0;
    this.currentSegmentStart = 0;
    this.currentTracePath = '';
    this.segmentTimer = null;
    this.running = false;
    this.stopping = false;

    this.state = {
      employeeId,
      sessionId: this.sessionId,
      browserConnected: false,
      recording: false,
      currentSegment: null,
      segmentStartTime: null,
      totalSegments: 0,
      lastUploadTime: null,
      lastError: null,
    };
  }

  async start(context) {
    this.context = context;
    fs.mkdirSync(this.localTracesDir, { recursive: true });
    this.state.browserConnected = true;
    this.running = true;
    this.state.sessionId = this.sessionId;

    await this._registerSession();
    this._startHeartbeat();
    // start 整段 trace 的根（只调一次），随后用 startChunk 开第一个分段。
    // live:true 让 trace 实时写入磁盘而非缓存，浏览器异常关闭时也能保留数据。
    await this.context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: false,
      live: true,
    });
    await this._startChunk();
  }

  _traceName() {
    return `${this.employeeId}_${this.sessionId}_${this.segmentIndex}_${this.currentSegmentStart}`;
  }

  async _startChunk() {
    this.currentSegmentStart = Date.now();
    const fileName = `${this._traceName()}.zip`;
    this.currentTracePath = path.join(this.localTracesDir, fileName);

    await this.context.tracing.startChunk({
      name: this._traceName(),
      title: `segment-${this.segmentIndex}`,
    });

    console.log(`[recorder:${this.employeeId}] 分段 ${this.segmentIndex} 已开始 @ ${new Date(this.currentSegmentStart).toISOString()}`);
    this.state.recording = true;
    this.state.currentSegment = this.segmentIndex;
    this.state.segmentStartTime = this.currentSegmentStart;

    this.segmentTimer = setTimeout(() => {
      this._rotateSegment().catch((err) => console.error(`[recorder:${this.employeeId}] 分段轮转异常:`, err));
    }, this.segmentDurationMs);
  }

  async _rotateSegment() {
    await this._stopAndUploadChunk();
    this.segmentIndex += 1;
    this.state.totalSegments = (this.state.totalSegments || 0) + 1;
    await this._startChunk();
  }

  async _stopAndUploadChunk() {
    if (this.segmentTimer) {
      clearTimeout(this.segmentTimer);
      this.segmentTimer = null;
    }

    const segmentEnd = Date.now();
    const segmentIndex = this.segmentIndex;
    const startTime = this.currentSegmentStart;
    const tracePath = this.currentTracePath;

    try {
      await this.context.tracing.stopChunk({ path: tracePath });
      console.log(`[recorder:${this.employeeId}] 分段 ${segmentIndex} 已保存: ${path.basename(tracePath)}`);
    } catch (err) {
      const msg = err.message || String(err);
      this.state.lastError = msg;
      console.warn(`[recorder:${this.employeeId}] Tracing 已停止（段 ${segmentIndex} 未保存）: ${msg}`);
      return;
    }

    this.state.recording = false;

    // 异步上传，不阻塞下一段录制
    uploadSegment({
      filePath: tracePath,
      employeeId: this.employeeId,
      sessionId: this.sessionId,
      segmentIndex,
      startTime,
      endTime: segmentEnd,
      config: {
        storageServerUrl: this.storageServerUrl,
        uploadToken: this.uploadToken,
        uploadUrl: `${this.storageServerUrl.replace(/\/$/, '')}/api/upload`,
        retry: this.retry,
        deleteAfterUpload: this.deleteAfterUpload,
      },
    }).catch((err) => console.error(`[recorder:${this.employeeId}] 上传异常:`, err));

    this.state.lastUploadTime = Date.now();
  }

  async _registerSession() {
    try {
      await axios.post(`${this.lifecycleUrl}/session/start`, {
        employeeId: this.employeeId, sessionId: this.sessionId, startedAt: Date.now(), recordingMode: 'trace',
      }, { headers: { 'X-Upload-Token': this.uploadToken }, timeout: 5000 });
    } catch (err) {
      this.state.lastError = `lifecycle start: ${err.message}`;
      console.warn(`[recorder:${this.employeeId}] 生命周期登记失败: ${err.message}`);
    }
  }

  _startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      axios.post(`${this.lifecycleUrl}/session/heartbeat`, {
        employeeId: this.employeeId, sessionId: this.sessionId, timestamp: Date.now(),
      }, { headers: { 'X-Upload-Token': this.uploadToken }, timeout: 5000 }).catch(() => {});
    }, 60000);
    this.heartbeatTimer.unref?.();
  }

  async _closeSession() {
    if (this.lifecycleClosed) return;
    this.lifecycleClosed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    try {
      await axios.post(`${this.lifecycleUrl}/session/close`, {
        employeeId: this.employeeId, sessionId: this.sessionId, endedAt: Date.now(),
      }, { headers: { 'X-Upload-Token': this.uploadToken }, timeout: 5000 });
    } catch (err) {
      console.warn(`[recorder:${this.employeeId}] 生命周期关闭通知失败: ${err.message}`);
    }
  }

  /**
   * 只收敛本地状态并通知服务端；浏览器 context 已关闭时不再调用 tracing API。
   */
  async markBrowserClosed() {
    this.stopping = true;
    this.running = false;
    if (this.segmentTimer) clearTimeout(this.segmentTimer);
    this.state.recording = false;
    this.state.browserConnected = false;
    // BrowserContext 已失效，但 patched SerializedFS 会在 Node 侧定时 flush。
    // 等待一次 flush 周期，然后直接从磁盘 raw trace 生成标准恢复 ZIP。
    try {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const traceName = this._traceName();
      const recoveryPath = path.join(this.localTracesDir, `${traceName}-recovered.zip`);
      await finalizeTrace(this.rawTracesDir, recoveryPath, traceName);
      await uploadSegment({
        filePath: recoveryPath,
        employeeId: this.employeeId,
        sessionId: this.sessionId,
        segmentIndex: this.segmentIndex,
        startTime: this.currentSegmentStart,
        endTime: Date.now(),
        config: {
          storageServerUrl: this.storageServerUrl,
          uploadToken: this.uploadToken,
          uploadUrl: `${this.storageServerUrl.replace(/\/$/, '')}/api/upload`,
          retry: this.retry,
          deleteAfterUpload: this.deleteAfterUpload,
        },
      });
      this.state.lastUploadTime = Date.now();
    } catch (err) {
      this.state.lastError = `recovery archive: ${err.message}`;
      console.warn(`[recorder:${this.employeeId}] 浏览器关闭后恢复归档失败: ${err.message}`);
    }
    await this._closeSession();
  }

  async stop() {
    this.stopping = true;
    this.running = false;
    if (!this.context) return;
    try {
      await this._stopAndUploadChunk();
    } catch (err) {
      console.error(`[recorder:${this.employeeId}] 停止时异常:`, err);
    }
    // 关闭整段 trace 根
    try {
      await this.context.tracing.stop();
    } catch (e) { /* context 可能已关闭，忽略 */ }
    this.state.recording = false;
    this.state.browserConnected = false;
    await this._closeSession();
  }

  snapshot() {
    return { ...this.state, timestamp: Date.now() };
  }
}

module.exports = { InProcessRecorder };
