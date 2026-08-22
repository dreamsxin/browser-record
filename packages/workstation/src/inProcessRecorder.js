'use strict';

const fs = require('fs');
const path = require('path');
const { uploadSegment } = require('../../recording-agent/src/uploader');

/**
 * 进程内录制器：在 workstation（InstanceManager）已通过 Playwright
 * launchPersistentContext 创建的 BrowserContext 上运行 Playwright Tracing，
 * 按固定时长分段，停止时刷出当前分段并异步上传。
 *
 * 与独立 recording-agent 的 recorder.js 同源逻辑，但：
 *  - 不负责连接/启动浏览器（context 由 InstanceManager 提供）
 *  - 不含 CDP 重连（workstation 拥有 context 句柄，崩溃走 close 事件）
 *  - sessionId 每次启动实例生成（不绑定进程生命周期）
 *  - 不关闭 context（由 InstanceManager 在 stop 时关闭）
 */
class InProcessRecorder {
  constructor({ employeeId, segmentDurationMs, storageServerUrl, uploadToken, localTracesDir, retry, deleteAfterUpload }) {
    this.employeeId = employeeId;
    this.segmentDurationMs = segmentDurationMs || 1800000;
    this.storageServerUrl = storageServerUrl;
    this.uploadToken = uploadToken;
    this.localTracesDir = path.resolve(localTracesDir);
    this.retry = retry;
    this.deleteAfterUpload = deleteAfterUpload !== false;

    this.context = null;
    this.sessionId = String(Date.now());
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
    await this._startSegment();
  }

  async _startSegment() {
    this.currentSegmentStart = Date.now();
    const fileName = `${this.employeeId}_${this.sessionId}_${this.segmentIndex}_${this.currentSegmentStart}.zip`;
    this.currentTracePath = path.join(this.localTracesDir, fileName);

    await this.context.tracing.start({
      screenshots: true,
      snapshots: false,
      sources: false,
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
    await this._stopAndUpload();
    this.segmentIndex += 1;
    this.state.totalSegments = (this.state.totalSegments || 0) + 1;
    await this._startSegment();
  }

  async _stopAndUpload() {
    if (this.segmentTimer) {
      clearTimeout(this.segmentTimer);
      this.segmentTimer = null;
    }

    const segmentEnd = Date.now();
    const segmentIndex = this.segmentIndex;
    const startTime = this.currentSegmentStart;
    const tracePath = this.currentTracePath;

    try {
      await this.context.tracing.stop({ path: tracePath });
      console.log(`[recorder:${this.employeeId}] 分段 ${segmentIndex} 已保存: ${path.basename(tracePath)}`);
    } catch (err) {
      // 浏览器已被关闭时 tracing.stop 会抛错；此为正常情况，仅记录，不再视为错误
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

  async stop() {
    this.stopping = true;
    this.running = false;
    if (!this.context) return;
    try {
      await this._stopAndUpload();
    } catch (err) {
      console.error(`[recorder:${this.employeeId}] 停止时异常:`, err);
    }
    this.state.recording = false;
    this.state.browserConnected = false;
  }

  snapshot() {
    return { ...this.state, timestamp: Date.now() };
  }
}

module.exports = { InProcessRecorder };
