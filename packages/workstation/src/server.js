'use strict';

const express = require('express');
const morgan = require('morgan');
const path = require('path');
const { loadConfig } = require('./config');
const { InstanceManager } = require('./instanceManager');

function createApp(config) {
  config._root = path.resolve(__dirname, '..', '..', '..');
  const manager = new InstanceManager(config);
  const app = express();
  app.use(morgan('tiny'));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'workstation', instances: manager.list().length });
  });

  // 启动实例
  app.post('/api/instances', async (req, res) => {
    const { employeeId, startingUrl } = req.body || {};
    try {
      const instance = await manager.start({ employeeId, startingUrl });
      res.json(instance);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 实例列表
  app.get('/api/instances', (req, res) => {
    res.json(manager.list());
  });

  // 单个实例详情（含录制状态快照）
  app.get('/api/instances/:id', (req, res) => {
    const instance = manager.get(req.params.id);
    if (!instance) return res.status(404).json({ error: 'not_found' });
    res.json(instance);
  });

  // 停止实例
  app.post('/api/instances/:id/stop', async (req, res) => {
    try {
      const instance = await manager.stop(req.params.id);
      res.json(instance);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 关闭全部
  app.post('/api/instances/stop-all', async (req, res) => {
    const ids = manager.list().map((i) => i.instanceId);
    const results = [];
    for (const id of ids) {
      try { results.push(await manager.stop(id)); } catch (e) { results.push({ instanceId: id, error: e.message }); }
    }
    res.json({ stopped: results });
  });

  // 从列表中移除已停止/已关闭的实例
  app.delete('/api/instances/:id', async (req, res) => {
    try {
      const result = await manager.remove(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return { app, manager };
}

async function main() {
  const config = loadConfig();
  console.log('=== Browser Record Workstation 启动 ===');
  console.log(`profile 目录: ${config.profilesDir}`);
  console.log(`录制分段时长: ${((config.recording?.segmentDurationMs || config.agent?.segmentDurationMs || 1800000) / 60000).toFixed(0)} 分钟`);
  console.log(`存储服务: ${config.storageServerUrl}`);
  const { app } = createApp(config);
  app.listen(config.port, config.host, () => {
    console.log(`[workstation] 监听: http://${config.host}:${config.port}`);
  });
}

main().catch((err) => {
  console.error('[workstation] 启动失败:', err);
  process.exit(1);
});

module.exports = { createApp };
