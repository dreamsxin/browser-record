'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

/**
 * 异步上传一个分段文件至中央存储服务。
 * 失败时按指数退避重试；所有尝试失败后保留本地文件，待后续补传。
 *
 * @param {object} opts
 * @param {string} opts.filePath        本地 .zip 文件路径
 * @param {string} opts.employeeId
 * @param {string} opts.sessionId
 * @param {number} opts.segmentIndex
 * @param {number} opts.startTime       分段开始时间 (ms)
 * @param {number} opts.endTime         分段结束时间 (ms)
 * @param {object} opts.config          agent 配置
 * @returns {Promise<boolean>}          是否最终成功
 */
async function uploadSegment({ filePath, employeeId, sessionId, segmentIndex, startTime, endTime, config }) {
  const { uploadUrl, uploadToken, retry, deleteAfterUpload } = config;
  const maxAttempts = (retry && retry.maxAttempts) || 5;
  const baseDelay = (retry && retry.baseDelayMs) || 2000;
  const maxDelay = (retry && retry.maxDelayMs) || 60000;

  if (!fs.existsSync(filePath)) {
    console.warn(`[uploader] 文件不存在，跳过上传: ${filePath}`);
    return false;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const form = new FormData();
      form.append('file', fs.createReadStream(filePath));
      form.append('employeeId', employeeId);
      form.append('sessionId', String(sessionId));
      form.append('segmentIndex', String(segmentIndex));
      form.append('startTime', String(startTime));
      form.append('endTime', String(endTime));

      const headers = { ...form.getHeaders() };
      if (uploadToken) headers['X-Upload-Token'] = uploadToken;

      await axios.post(uploadUrl, form, { headers, maxContentLength: Infinity, maxBodyLength: Infinity });
      console.log(`[uploader] 上传成功: ${path.basename(filePath)} (第 ${attempt} 次尝试)`);

      if (deleteAfterUpload) {
        try { fs.unlinkSync(filePath); } catch (e) { /* 忽略删除失败 */ }
      }
      return true;
    } catch (err) {
      const status = err.response ? err.response.status : 'N/A';
      console.error(`[uploader] 上传失败 (尝试 ${attempt}/${maxAttempts}, status=${status}): ${err.message}`);
      if (attempt < maxAttempts) {
        const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt - 1));
        await sleep(delay);
      }
    }
  }

  console.error(`[uploader] 放弃上传，文件保留在本地待补传: ${filePath}`);
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { uploadSegment };
