'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('../../playwright-custom/playwright');
const { InProcessRecorder } = require('./inProcessRecorder');
const { VideoRecorder } = require('../../video-recorder/src/videoRecorder');

class InstanceManager {
  constructor(config) { this.config = config; this.instances = new Map(); }
  _resolveChromiumPath() { return this.config.browser.executablePath || chromium.executablePath(); }

  async start({ employeeId, startingUrl, recordingMode } = {}) {
    const instanceId = employeeId || `employee_${crypto.randomBytes(3).toString('hex')}`;
    if (this.instances.has(instanceId)) throw new Error(`实例已存在: ${instanceId}（请先 stop/remove）`);
    const mode = recordingMode || 'trace';
    if (!['trace', 'video'].includes(mode)) throw new Error(`不支持的录制模式: ${mode}`);
    const sessionId = String(Date.now());
    const profileDir = path.join(this.config.profilesDir, instanceId);
    const rawTracesDir = path.join(profileDir, 'live-trace-raw');
    const liveVideoDir = path.join(profileDir, 'video-sessions', sessionId, 'live');
    fs.mkdirSync(profileDir, { recursive: true });
    if (mode === 'trace') fs.mkdirSync(rawTracesDir, { recursive: true }); else fs.mkdirSync(liveVideoDir, { recursive: true });
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: !!this.config.browser.headless,
      executablePath: this._resolveChromiumPath(),
      args: this.config.browser.args || [],
      tracesDir: mode === 'trace' ? rawTracesDir : undefined,
      recordVideo: mode === 'video' ? { dir: liveVideoDir, size: this.config.video?.size || { width: 1280, height: 720 } } : undefined,
    });
    const instance = { instanceId, sessionId, recordingMode: mode, profileDir, context, recorder: null, startedAt: Date.now(), status: 'browser_ready', closed: false, intentionalStop: false, stopPromise: null };
    this.instances.set(instanceId, instance);
    context.on('close', () => {
      instance.closed = true;
      if (instance.intentionalStop) return;
      instance.status = 'browser_closed';
      instance.recorder?.markBrowserClosed().catch((err) => { instance.error = err.message; });
    });
    const rc = this.config.recording || {};
    instance.recorder = mode === 'video'
      ? new VideoRecorder({ employeeId: instanceId, sessionId, liveDir: liveVideoDir, archiveDir: path.join(profileDir, 'video-sessions', sessionId), storageServerUrl: this.config.storageServerUrl, uploadToken: this.config.uploadToken })
      : new InProcessRecorder({ employeeId: instanceId, sessionId, segmentDurationMs: this.config.liveTrace?.checkpointIntervalMs || 30000, storageServerUrl: this.config.storageServerUrl, uploadToken: this.config.uploadToken, localTracesDir: path.join(profileDir, 'traces'), rawTracesDir, retry: rc.retry, deleteAfterUpload: rc.deleteAfterUpload !== false });
    try {
      await instance.recorder.start(context);
      instance.status = 'recording';
      const page = context.pages()[0];
      const url = startingUrl || this.config.browser.startingUrl || 'about:blank';
      if (page && url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    } catch (err) { instance.status = 'error'; instance.error = err.message; }
    return this._public(instance);
  }

  async stop(instanceId) {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`实例不存在: ${instanceId}`);
    if (instance.status === 'stopped') return this._public(instance);
    if (instance.stopPromise) return instance.stopPromise;
    instance.intentionalStop = true;
    instance.stopPromise = (async () => {
      try {
        if (instance.recordingMode === 'video') {
          if (!instance.closed) await instance.context.close();
          await instance.recorder?.stop();
        } else {
          await instance.recorder?.stop();
          if (!instance.closed) await instance.context.close();
        }
      } catch (err) { instance.error = err.message; }
      instance.status = 'stopped'; instance.stoppedAt = Date.now();
      return this._public(instance);
    })();
    return instance.stopPromise;
  }

  list() { return [...this.instances.values()].map((i) => this._public(i)); }
  get(id) { const i = this.instances.get(id); return i ? this._public(i) : null; }
  async remove(id) { const i = this.instances.get(id); if (!i) throw new Error(`实例不存在: ${id}`); if (!['stopped', 'browser_closed'].includes(i.status)) await this.stop(id); this.instances.delete(id); return { instanceId: id, removed: true }; }
  _public(i) { const s = i.recorder?.snapshot() || {}; return { instanceId: i.instanceId, profileDir: i.profileDir, recordingMode: i.recordingMode, status: i.status, startedAt: i.startedAt, stoppedAt: i.stoppedAt || null, error: i.error || null, recording: !!s.recording, browserConnected: !!s.browserConnected, sessionId: s.sessionId || i.sessionId, currentSegment: s.currentSegment ?? null, totalSegments: s.totalSegments ?? 0, lastUploadTime: s.lastUploadTime || null, lastError: s.lastError || null }; }
}
module.exports = { InstanceManager };
