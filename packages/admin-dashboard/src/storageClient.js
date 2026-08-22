'use strict';

const axios = require('axios');

/**
 * 封装对中央存储服务的调用。
 * 自动以管理员身份登录获取 JWT，缓存并在过期时重新获取。
 */
class StorageClient {
  constructor({ baseUrl, username, password }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this.token = null;
    this.tokenExpiry = 0;
  }

  async ensureToken() {
    if (this.token && Date.now() < this.tokenExpiry - 60_000) return;
    const res = await axios.post(`${this.baseUrl}/api/auth/login`, {
      username: this.username,
      password: this.password,
    });
    this.token = res.data.token;
    this.tokenExpiry = Date.now() + (res.data.expiresIn || 1800) * 1000;
  }

  async _get(path, params) {
    await this.ensureToken();
    try {
      return await axios.get(`${this.baseUrl}${path}`, {
        params,
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch (err) {
      // token 过期则重试一次
      if (err.response && err.response.status === 401) {
        this.token = null;
        this.tokenExpiry = 0;
        await this.ensureToken();
        return axios.get(`${this.baseUrl}${path}`, {
          params,
          headers: { Authorization: `Bearer ${this.token}` },
        });
      }
      throw err;
    }
  }

  async listEmployees() {
    const res = await this._get('/api/files/employees');
    return res.data;
  }

  async listSessions(employeeId) {
    const res = await this._get(`/api/files/employees/${encodeURIComponent(employeeId)}/sessions`);
    return res.data;
  }

  async listSegments(employeeId, sessionId) {
    const res = await this._get(
      `/api/files/employees/${encodeURIComponent(employeeId)}/sessions/${encodeURIComponent(sessionId)}/segments`
    );
    return res.data;
  }

  async signDownload(segmentId) {
    const res = await this._get(`/api/download/segments/${encodeURIComponent(segmentId)}/sign`);
    return res.data; // { url, expiresAt }
  }
}

module.exports = { StorageClient };
