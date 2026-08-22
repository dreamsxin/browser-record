# 客户端录制代理 (recording-agent)

运行在员工电脑上的 Node.js 进程，通过 CDP 连接本地浏览器，使用 Playwright Tracing 按 30 分钟分段录制操作并上传至中央存储服务。

## 前置条件
- Node.js >= 18
- 浏览器（Chrome / Edge）以远程调试模式启动：

  ```bash
  # Chrome
  chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\chrome-debug"
  # Edge
  msedge.exe --remote-debugging-port=9222 --user-data-dir="C:\edge-debug"
  ```

## 配置
默认配置在 `config/default.json`，可用 `config/local.json` 或环境变量覆盖：

| 环境变量 | 说明 |
|---------|------|
| `EMPLOYEE_ID` | 员工 ID |
| `CDP_ENDPOINT` | 浏览器 CDP 地址（默认 `http://localhost:9222`） |
| `STORAGE_SERVER_URL` | 中央存储服务地址 |
| `UPLOAD_TOKEN` | 上传鉴权 Token（与服务端一致） |
| `SEGMENT_DURATION_MS` | 单段时长（毫秒） |
| `HEALTH_PORT` | 健康检查端口 |
| `AGENT_CONFIG` | 自定义配置文件路径 |

## 运行
```bash
# 在仓库根目录
npm install
npm run agent

# 或直接
cd packages/recording-agent && node src/index.js
```

## 健康检查
代理启动后会在 `127.0.0.1:4100/health` 暴露状态：
```json
{
  "status": "ok",
  "employeeId": "employee_001",
  "sessionId": "...",
  "browserConnected": true,
  "currentSegment": 3,
  "totalSegments": 3,
  ...
}
```

## 录制策略
- `screenshots: true`、`snapshots: false`、`sources: false`，文件体积小。
- 每 30 分钟（可配）停止当前 Tracing → 保存 zip → 立即启动下一段，无缝衔接。
- 上传异步执行，不阻塞新录制；失败按指数退避重试，最终失败则保留本地待补传。
- 浏览器断开时自动重连（指数退避），恢复后继续累加 segmentIndex。

## 开机自启
建议打包为可执行文件（如 `pkg`）后注册为 Windows 服务（`sc create` / NSSM）或 Linux systemd unit。
