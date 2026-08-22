'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { insertFile } = require('../db');
const { runRetention } = require('../retention');
const { requireUploadToken } = require('./auth');

/**
 * multer 在处理 'file' 字段时，文本字段（employeeId 等）可能尚未被解析进
 * req.body，因此 destination 里无法可靠拿到 employeeId/sessionId。
 * 这里先落盘到一个临时目录，文件接收完成后再移动到最终目录。
 */
const TMP_DIR = '.tmp-uploads';

function buildUploadRouter(config) {
  const router = express.Router();

  const tmpRoot = path.join(config.recordingsDir, TMP_DIR);
  fs.mkdirSync(tmpRoot, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, tmpRoot),
    filename: (req, file, cb) => {
      // 唯一临时文件名
      cb(null, `upload_${Date.now()}_${Math.random().toString(36).slice(2)}.zip`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: config.uploads.maxFileSize || 524288000 },
  });

  router.post('/', requireUploadToken(config), upload.single('file'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'no_file' });
    }
    const { employeeId, sessionId, segmentIndex, startTime, endTime } = req.body;
    if (!employeeId || !sessionId || segmentIndex === undefined) {
      // 清理临时文件
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'missing_metadata' });
    }

    // 移动到最终目录: {recordingsDir}/{employeeId}/{sessionId}/segment_{index}.zip
    const finalDir = path.join(config.recordingsDir, employeeId, sessionId);
    fs.mkdirSync(finalDir, { recursive: true });
    const finalName = `segment_${segmentIndex}.zip`;
    const finalPath = path.join(finalDir, finalName);

    try {
      fs.renameSync(req.file.path, finalPath);
    } catch (e) {
      // 跨设备时退回复制 + 删除
      fs.copyFileSync(req.file.path, finalPath);
      fs.unlinkSync(req.file.path);
    }

    const relPath = path.relative(config.recordingsDir, finalPath);
    const { id, uploadTime } = insertFile({
      employeeId,
      sessionId,
      segmentIndex,
      filePath: relPath,
      startTime,
      endTime,
      fileSize: fs.statSync(finalPath).size,
    });

    // 上传成功后异步触发循环覆盖清理
    setImmediate(() => {
      try {
        runRetention(config, employeeId);
      } catch (err) {
        console.error('[upload] 清理任务异常:', err);
      }
    });

    res.json({ ok: true, id, uploadTime });
  });

  return router;
}

module.exports = { buildUploadRouter };
