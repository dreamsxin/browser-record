'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('../../../playwright-custom/playwright');
const { uploadSegment } = require('./uploader');

/**
 * 录制代理核心：连接浏览器，按固定时长分段录制 Playwright Tracing，
 * 每段停止后立即启动下一段（无缝衔接），并将文件异步上传。
 *
 * 设计要点：
 * - segments 通过 segmentIndex 递增，每段一个 .zip。
 * - 停止与重启之间仅几百毫秒间隙，可接受。
 * - 浏览器断开时触发重连（指数退避），恢复录制并继续累加 segmentIndex。
 */
class Recorder {
  constructor(config, state) {
    this.config = config;
    this.state = state; // 共享运行状态对象（供 health 接口读取）

    this.browser = null;
    this.context = null;

    this.sessionId = String(Date.now());
    this.segmentIndex = 0;
    this.currentSegmentStart = 0;
    this.currentTracePath = '';

    this.segmentTimer = null;
    this.running = false;
    this.stopping = false;
  }

  async connect() {
    const { cdpEndpoint, localTracesDir } = this.config;
    fs.mkdirSync(localTracesDir, { recursive: true });

    console.log(`[recorder] 连接浏览器: ${cdpEndpoint}`);
    this.browser = await chromium.connectOverCDP(cdpEndpoint);

    const contexts = this.browser.contexts();
    this.context = contexts[0] || (await this.browser.newContext());

    // 监听浏览器断开，触发重连
    this.browser.on('disconnected', () => {
      console.warn('[recorder] 浏览器连接断开');
      this.state.browserConnected = false;
      if (this.stopping) return;
      this._scheduleReconnect();
    });
    this.state.browserConnected = true;
    console.log('[recorder] 已连接浏览器');
  }

  async start() {
    if (this.running) return;
    await this.connect();
    this.running = true;
    this.state.sessionId = this.sessionId;
    await this._startSegment();
  }

  async _startSegment() {
    const { localTracesDir, employeeId, segmentDurationMs } = this.config;
    this.currentSegmentStart = Date.now();

    const fileName = `${employeeId}_${this.sessionId}_${this.segmentIndex}_${this.currentSegmentStart}.zip`;
    this.currentTracePath = path.join(localTracesDir, fileName);

    try {
      await this.context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: false,
      });
    } catch (err) {
      console.error(`[recorder] 启动 Tracing 失败: ${err.message}`);
      this.state.lastError = err.message;
      throw err;
    }

    console.log(`[recorder] 分段 ${this.segmentIndex} 已开始 @ ${new Date(this.currentSegmentStart).toISOString()}`);
    this.state.currentSegment = this.segmentIndex;
    this.state.segmentStartTime = this.currentSegmentStart;

    this.segmentTimer = setTimeout(() => {
      this._rotateSegment().catch((err) => console.error('[recorder] 分段轮转异常:', err));
    }, segmentDurationMs);
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
      console.log(`[recorder] 分段 ${segmentIndex} 已保存: ${path.basename(tracePath)}`);
    } catch (err) {
      console.error(`[recorder] 停止 Tracing 失败 (段 ${segmentIndex}): ${err.message}`);
      this.state.lastError = err.message;
      return;
    }

    // 异步上传，不阻塞下一段录制
    const { employeeId } = this.config;
    uploadSegment({
      filePath: tracePath,
      employeeId,
      sessionId: this.sessionId,
      segmentIndex,
      startTime,
      endTime: segmentEnd,
      config: this.config,
    }).catch((err) => console.error('[recorder] 上传异常:', err));

    this.state.lastUploadTime = Date.now();
  }

  _scheduleReconnect() {
    const { reconnect } = this.config;
    if (!reconnect || !reconnect.enabled) return;

    const initialDelay = reconnect.initialDelayMs || 1000;
    const maxDelay = reconnect.maxDelayMs || 30000;
    const maxAttempts = reconnect.maxAttempts || 0; // 0 = 无限
    let attempt = 0;
    let delay = initialDelay;

    const tryReconnect = async () => {
      if (this.stopping) return;
      attempt += 1;
      if (maxAttempts > 0 && attempt > maxAttempts) {
        console.error(`[recorder] 达到最大重连次数 (${maxAttempts})，放弃`);
        this.state.lastError = 'reconnect_max_attempts_exceeded';
        return;
      }
      try {
        console.log(`[recorder] 第 ${attempt} 次尝试重连...`);
        // 清理旧的 timer/上下文
        if (this.segmentTimer) { clearTimeout(this.segmentTimer); this.segmentTimer = null; }
        await this.connect();
        await this._startSegment();
        console.log('[recorder] 重连成功，录制已恢复');
      } catch (err) {
        console.error(`[recorder] 重连失败: ${err.message}`);
        delay = Math.min(maxDelay, delay * 2);
        setTimeout(tryReconnect, delay);
      }
    };

    setTimeout(tryReconnect, initialDelay);
  }

  async stop() {
    this.stopping = true;
    this.running = false;
    console.log('[recorder] 正在优雅停止...');
    try {
      await this._stopAndUpload();
    } catch (err) {
      console.error('[recorder] 停止时上传异常:', err);
    }
    try { if (this.browser) await this.browser.close(); } catch (e) { /* 忽略 */ }
  }
}

module.exports = { Recorder };
