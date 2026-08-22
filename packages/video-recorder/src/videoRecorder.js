'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const yazl = require('yazl');

async function waitForStableFiles(dir, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  let stable = 0;
  while (Date.now() < deadline) {
    const files = fs.existsSync(dir) ? (await fsp.readdir(dir)).filter((f) => f.endsWith('.webm')).sort() : [];
    const signature = (await Promise.all(files.map(async (f) => `${f}:${(await fsp.stat(path.join(dir, f))).size}`))).join('|');
    if (signature && signature === previous) stable++; else stable = 0;
    if (stable >= 2) return files.map((f) => path.join(dir, f));
    previous = signature;
    await new Promise((r) => setTimeout(r, 500));
  }
  return fs.existsSync(dir) ? (await fsp.readdir(dir)).filter((f) => f.endsWith('.webm')).map((f) => path.join(dir, f)) : [];
}

async function createVideoArchive({ employeeId, sessionId, startedAt, endedAt, status, files, outputZip }) {
  const videos = files.map((file, index) => ({ pageId: `page-${index + 1}`, file: `videos/page-${index + 1}.webm`, size: fs.statSync(file).size }));
  const manifest = { employeeId, sessionId, startedAt, endedAt, status, videos };
  const tmp = `${outputZip}.tmp-${process.pid}-${Date.now()}`;
  await fsp.mkdir(path.dirname(outputZip), { recursive: true });
  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.outputStream.on('error', reject).on('close', resolve);
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');
    files.forEach((file, index) => zip.addFile(file, `videos/page-${index + 1}.webm`));
    zip.end();
    zip.outputStream.pipe(fs.createWriteStream(tmp));
  });
  await fsp.rename(tmp, outputZip);
  return manifest;
}

class VideoRecorder {
  constructor({ employeeId, sessionId, liveDir, archiveDir, storageServerUrl, uploadToken }) {
    this.employeeId = employeeId;
    this.sessionId = String(sessionId);
    this.liveDir = path.resolve(liveDir);
    this.archiveDir = path.resolve(archiveDir);
    this.storageServerUrl = storageServerUrl.replace(/\/$/, '');
    this.uploadToken = uploadToken;
    this.startedAt = Date.now();
    this.context = null;
    this.running = false;
    this.stopPromise = null;
    this.status = 'recording';
  }

  async start(context) {
    this.context = context;
    this.running = true;
    await fsp.mkdir(this.liveDir, { recursive: true });
    await axios.post(`${this.storageServerUrl}/api/lifecycle/session/start`, {
      employeeId: this.employeeId, sessionId: this.sessionId, startedAt: this.startedAt, recordingMode: 'video',
    }, { headers: { 'X-Upload-Token': this.uploadToken }, timeout: 5000 }).catch(() => {});
  }

  async _finalize(status) {
    const files = await waitForStableFiles(this.liveDir);
    if (!files.length) throw new Error('未生成视频文件');
    const endedAt = Date.now();
    const outputZip = path.join(this.archiveDir, `${this.employeeId}_${this.sessionId}.zip`);
    const manifest = await createVideoArchive({ employeeId: this.employeeId, sessionId: this.sessionId, startedAt: this.startedAt, endedAt, status, files, outputZip });
    const form = new FormData();
    form.append('employeeId', this.employeeId);
    form.append('sessionId', this.sessionId);
    form.append('status', status);
    form.append('archive', fs.createReadStream(outputZip));
    await axios.post(`${this.storageServerUrl}/api/videos/upload`, form, { headers: { ...form.getHeaders(), 'X-Upload-Token': this.uploadToken }, maxBodyLength: Infinity, timeout: 60000 });
    await axios.post(`${this.storageServerUrl}/api/lifecycle/session/close`, {
      employeeId: this.employeeId, sessionId: this.sessionId, endedAt,
    }, { headers: { 'X-Upload-Token': this.uploadToken }, timeout: 5000 }).catch(() => {});
    this.status = status;
    return manifest;
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.running = false;
    this.stopPromise = this._finalize('closed');
    return this.stopPromise;
  }

  async markBrowserClosed() {
    if (this.stopPromise) return this.stopPromise;
    this.running = false;
    this.stopPromise = this._finalize('browser_closed').catch(async (err) => {
      await axios.post(`${this.storageServerUrl}/api/lifecycle/session/close`, { employeeId: this.employeeId, sessionId: this.sessionId, endedAt: Date.now() }, { headers: { 'X-Upload-Token': this.uploadToken }, timeout: 5000 }).catch(() => {});
      throw err;
    });
    return this.stopPromise;
  }

  snapshot() {
    return { employeeId: this.employeeId, sessionId: this.sessionId, recording: this.running, browserConnected: this.running, currentSegment: null, totalSegments: 0, lastUploadTime: null, lastError: null, timestamp: Date.now() };
  }
}

module.exports = { VideoRecorder, waitForStableFiles, createVideoArchive };
