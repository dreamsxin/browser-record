'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');

class OperationRecorder {
  constructor(options) {
    this.employeeId = options.employeeId;
    this.sessionId = String(options.sessionId || Date.now());
    this.storageServerUrl = options.storageServerUrl.replace(/\/$/, '');
    this.uploadToken = options.uploadToken;
    this.lifecycleUrl = `${this.storageServerUrl}/api/lifecycle`;
    this.rootDir = path.resolve(options.localDir);
    this.chunkDurationMs = options.chunkDurationMs || 30000;
    this.maxEvents = options.maxEvents || 100;
    this.maxScreenshotsPerSecond = options.maxScreenshotsPerSecond || 4;
    this.screenshotQuality = options.screenshotQuality || 65;
    this.captureNetworkSummary = options.captureNetworkSummary !== false;
    this.captureConsole = options.captureConsole !== false;
    this.context = null;
    this.pages = new Map();
    this.events = [];
    this.seq = 0;
    this.chunkIndex = 0;
    this.chunkStartedAt = Date.now();
    this.flushTimer = null;
    this.screenshotCounter = 0;
    this.lastScreenshotAt = 0;
    this.running = false;
    this.stopping = false;
    this.closePromise = null;
  }

  async start(context) {
    this.context = context;
    await fsp.mkdir(path.join(this.rootDir, 'events'), { recursive: true });
    await fsp.mkdir(path.join(this.rootDir, 'screenshots'), { recursive: true });
    await this._writeJson('session.json', { employeeId: this.employeeId, sessionId: this.sessionId, startedAt: Date.now(), mode: 'operations' });
    this.running = true;
    await axios.post(`${this.lifecycleUrl}/session/start`, { employeeId: this.employeeId, sessionId: this.sessionId, startedAt: Date.now() }, { headers: { 'X-Upload-Token': this.uploadToken }, timeout: 5000 }).catch(() => {});
    await this._event('session-start', { employeeId: this.employeeId, sessionId: this.sessionId });
    context.on('page', (page) => this._attachPage(page).catch((err) => this._event('error', { message: err.message })));
    context.on('close', () => this._onBrowserClosed());
    for (const page of context.pages()) await this._attachPage(page);
    this.flushTimer = setInterval(() => this._flush(false).catch(() => {}), 1000);
    this.flushTimer.unref?.();
  }

  async _attachPage(page) {
    if (this.pages.has(page)) return;
    const pageId = `page-${this.pages.size + 1}-${crypto.randomBytes(2).toString('hex')}`;
    const state = { pageId, page, cdp: null, lastUrl: page.url() };
    this.pages.set(page, state);
    await this._event('page-open', { pageId, url: page.url(), title: await page.title().catch(() => '') });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      state.lastUrl = url;
      this._event('navigation', { pageId, url }).catch(() => {});
    });
    page.on('close', () => {
      this._event('page-close', { pageId, url: state.lastUrl }).catch(() => {});
      this._detachPage(state).catch(() => {});
    });
    if (this.captureConsole) page.on('console', (msg) => this._event('console', { pageId, type: msg.type(), text: msg.text(), url: page.url() }).catch(() => {}));
    if (this.captureNetworkSummary) {
      page.on('request', (req) => this._event('network-request', { pageId, method: req.method(), url: req.url(), resourceType: req.resourceType() }).catch(() => {}));
      page.on('response', (res) => this._event('network-response', { pageId, url: res.url(), status: res.status() }).catch(() => {}));
      page.on('requestfailed', (req) => this._event('network-failed', { pageId, url: req.url(), failure: req.failure()?.errorText || '' }).catch(() => {}));
    }
    state.cdp = await this.context.newCDPSession(page);
    state.cdp.on('Page.lifecycleEvent', (e) => this._event('lifecycle', { pageId, name: e.name, frameId: e.frameId }).catch(() => {}));
    state.cdp.on('Page.screencastFrame', (e) => this._onFrame(state, e).catch(() => {}));
    await state.cdp.send('Page.enable').catch(() => {});
    await state.cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {});
    await state.cdp.send('Page.startScreencast', { format: 'jpeg', quality: this.screenshotQuality, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 }).catch(() => {});
    await this._screenshot(state, 'page-open');
  }

  async _onFrame(state, event) {
    await state.cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    const now = Date.now();
    if (now - this.lastScreenshotAt < 1000 / this.maxScreenshotsPerSecond) return;
    this.lastScreenshotAt = now;
    await this._saveScreenshot(state, Buffer.from(event.data, 'base64'), 'screencast');
  }

  async _screenshot(state, reason) {
    if (!state.cdp) return;
    const result = await state.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: this.screenshotQuality }).catch(() => null);
    if (result?.data) await this._saveScreenshot(state, Buffer.from(result.data, 'base64'), reason);
  }

  async _saveScreenshot(state, buffer, reason) {
    const name = `${String(++this.screenshotCounter).padStart(8, '0')}.jpg`;
    const dir = path.join(this.rootDir, 'screenshots', state.pageId);
    await fsp.mkdir(dir, { recursive: true });
    const relative = path.join('screenshots', state.pageId, name).replace(/\\/g, '/');
    await fsp.writeFile(path.join(this.rootDir, relative), buffer);
    await this._uploadScreenshot(relative);
    await this._event('screenshot', { pageId: state.pageId, file: relative, bytes: buffer.length, reason });
  }

  async _uploadScreenshot(relative) {
    const form = new FormData();
    form.append('employeeId', this.employeeId);
    form.append('sessionId', this.sessionId);
    form.append('relativePath', relative);
    form.append('screenshot', fs.createReadStream(path.join(this.rootDir, relative)));
    await axios.post(`${this.storageServerUrl}/api/operations/screenshots`, form, {
      headers: { ...form.getHeaders(), 'X-Upload-Token': this.uploadToken },
      maxBodyLength: Infinity, timeout: 30000,
    }).catch(() => {});
  }

  async _detachPage(state) {
    await state.cdp?.send('Page.stopScreencast').catch(() => {});
    await state.cdp?.detach().catch(() => {});
    this.pages.delete(state.page);
  }

  async _event(type, data = {}) {
    if (!this.running && type !== 'session-close' && type !== 'browser-close') return;
    this.events.push({ seq: ++this.seq, timestamp: Date.now(), type, ...data });
    if (this.events.length >= this.maxEvents) await this._flush(false);
  }

  async _flush(force) {
    if (!this.events.length) return;
    if (!force && this.events.length < this.maxEvents && Date.now() - this.chunkStartedAt < this.chunkDurationMs) return;
    const events = this.events.splice(0);
    const chunkIndex = this.chunkIndex++;
    const startTime = events[0].timestamp;
    const endTime = events[events.length - 1].timestamp;
    const file = path.join(this.rootDir, 'events', `${String(chunkIndex).padStart(8, '0')}.ndjson`);
    await fsp.writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    this.chunkStartedAt = Date.now();
    await this._uploadChunk(file, chunkIndex, startTime, endTime).catch(() => {});
  }

  async _uploadChunk(eventsFile, chunkIndex, startTime, endTime) {
    const form = new FormData();
    form.append('employeeId', this.employeeId);
    form.append('sessionId', this.sessionId);
    form.append('chunkIndex', String(chunkIndex));
    form.append('startTime', String(startTime));
    form.append('endTime', String(endTime));
    form.append('events', fs.createReadStream(eventsFile));
    const manifest = { employeeId: this.employeeId, sessionId: this.sessionId, chunkIndex, startTime, endTime };
    form.append('manifest', JSON.stringify(manifest));
    await axios.post(`${this.storageServerUrl}/api/operations/chunks`, form, { headers: { ...form.getHeaders(), 'X-Upload-Token': this.uploadToken }, maxBodyLength: Infinity, timeout: 30000 });
    await fsp.unlink(eventsFile).catch(() => {});
  }

  async _onBrowserClosed() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      await this._event('browser-close', {});
      this.running = false;
      if (this.flushTimer) clearInterval(this.flushTimer);
      await this._flush(true);
      await this._writeJson('manifest.json', { employeeId: this.employeeId, sessionId: this.sessionId, endedAt: Date.now(), totalEvents: this.seq, totalScreenshots: this.screenshotCounter, status: 'browser_closed' });
      await axios.post(`${this.lifecycleUrl}/session/close`, { employeeId: this.employeeId, sessionId: this.sessionId, endedAt: Date.now() }, { headers: { 'X-Upload-Token': this.uploadToken }, timeout: 5000 }).catch(() => {});
    })();
    return this.closePromise;
  }

  async stop() {
    if (this.stopping) return this.closePromise;
    this.stopping = true;
    if (this.closePromise) return this.closePromise;
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this._event('session-close', {});
    this.running = false;
    await this._flush(true);
    for (const state of [...this.pages.values()]) await this._detachPage(state);
    await this._writeJson('manifest.json', { employeeId: this.employeeId, sessionId: this.sessionId, endedAt: Date.now(), totalEvents: this.seq, totalScreenshots: this.screenshotCounter, status: 'closed' });
    await axios.post(`${this.lifecycleUrl}/session/close`, { employeeId: this.employeeId, sessionId: this.sessionId, endedAt: Date.now() }, { headers: { 'X-Upload-Token': this.uploadToken }, timeout: 5000 }).catch(() => {});
  }

  snapshot() {
    return {
      employeeId: this.employeeId,
      sessionId: this.sessionId,
      recording: this.running,
      browserConnected: this.running,
      currentSegment: this.chunkIndex,
      totalSegments: this.chunkIndex,
      lastUploadTime: null,
      lastError: null,
      timestamp: Date.now(),
    };
  }

  async _writeJson(name, data) {
    const tmp = path.join(this.rootDir, `.${name}.tmp`);
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, path.join(this.rootDir, name));
  }
}

module.exports = { OperationRecorder };
