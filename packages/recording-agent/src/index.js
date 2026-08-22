'use strict';

const { loadConfig } = require('./config');
const { Recorder } = require('./recorder');
const { startHealthServer } = require('./health');

async function main() {
  const config = loadConfig();

  console.log('=== Browser Record Agent 启动 ===');
  console.log(`员工: ${config.employeeId}`);
  console.log(`CDP: ${config.cdpEndpoint}`);
  console.log(`分段时长: ${config.segmentDurationMs / 60000} 分钟`);
  console.log(`上传地址: ${config.uploadUrl}`);

  // 共享运行状态（health 接口读取）
  const state = {
    employeeId: config.employeeId,
    running: false,
    browserConnected: false,
    sessionId: null,
    currentSegment: null,
    segmentStartTime: null,
    totalSegments: 0,
    lastUploadTime: null,
    lastError: null,
  };

  // 健康检查服务
  let healthServer = null;
  if (config.health && config.health.enabled) {
    healthServer = startHealthServer(state, config.health, {
      shutdown: () => stop('HTTP /shutdown'),
    });
  }

  const recorder = new Recorder(config, state);

  const stop = async (reason) => {
    console.log(`\n[index] 收到 ${reason} 信号，准备退出...`);
    try {
      await recorder.stop();
    } catch (err) {
      console.error('[index] recorder.stop 异常:', err);
    }
    if (healthServer) healthServer.close();
    process.exit(0);
  };

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  try {
    await recorder.start();
    state.running = true;
    console.log('[index] 录制代理已进入主循环，等待分段触发...');
  } catch (err) {
    console.error('[index] 启动失败:', err.message);
    console.error('请确认浏览器已以 --remote-debugging-port=9222 启动。');
    state.lastError = err.message;
    // 不立即退出：若启用重连，recorder 会自行尝试重连
    if (!config.reconnect || !config.reconnect.enabled) {
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('[index] 致命错误:', err);
  process.exit(1);
});
