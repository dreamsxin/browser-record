# 员工工作台程序 (workstation)

运行在员工电脑上的本地控制程序：用 **Playwright 原生 API** 启动/关闭浏览器实例，自动为每个实例分配独立的 profile 目录，并在启动浏览器后**在进程内直接启动 Playwright Tracing 分段录制**。无需独立录制代理子进程，进程生命周期控制精确。提供 Web UI 与 CLI 两种操作方式。

## 职责
- **启动浏览器实例**：用 `chromium.launchPersistentContext(profileDir, ...)` 启动，自动分配 `<profilesDir>/<instanceId>` 独立 profile 目录。Playwright 拥有浏览器句柄，生命周期可控。
- **进程内录制**：浏览器启动后立即在同一个 Node 进程内对该 context 启动 `tracing.start`，按配置时长（默认 30 分钟）分段录制并上传。无独立 agent 子进程。
- **关闭实例**：`recorder.stop()` 刷出并上传当前分段 → `context.close()`（Playwright 原生关闭，精确终止所有子进程，无残留）。
- **实例列表**：查看每个实例的 ID、状态、录制中/否、当前分段、累计分段、启动时间。

## 配置
默认配置在 `config/default.json`，可用 `config/local.json` 或环境变量覆盖：

| 环境变量 | 默认 | 说明 |
|---------|------|------|
| `PORT` | `5000` | 工作台服务端口（仅监听 127.0.0.1） |
| `PROFILES_DIR` | `./profiles` | 浏览器 profile 根目录 |
| `BROWSER_EXECUTABLE` | 自动探测 | 浏览器可执行文件路径；留空则用 Playwright 自带 Chromium |
| `BROWSER_HEADLESS` | `false` | 是否无头（员工用需可见窗口） |
| `BROWSER_STARTING_URL` | `about:blank` | 浏览器起始页 |
| `STORAGE_SERVER_URL` | `http://localhost:4000` | 上传服务地址 |
| `UPLOAD_TOKEN` | `dev-upload-token` | 上传令牌 |
| `RECORDING_SEGMENT_MS` | `1800000` | 分段时长（毫秒） |

## 运行
```bash
# 在仓库根目录
npm install
npm run workstation          # 启动工作台服务 http://127.0.0.1:5000
```

### Web UI
浏览器打开 `http://127.0.0.1:5000`，填入员工 ID（可留空自动生成）与起始页，点击「启动实例」。

### CLI
```bash
npm run workstation:cli -- list
npm run workstation:cli -- start --id alice --url https://shop.example.com
npm run workstation:cli -- stop alice
npm run workstation:cli -- stop-all
npm run workstation:cli -- get alice
```
> `npm run workstation:cli --` 中的 `--` 用于将后续参数透传给 CLI。也可 `cd packages/workstation && node src/cli.js list`。

## 实例状态
| 状态 | 含义 |
|------|------|
| `browser_ready` | 浏览器已启动，录制尚未开始 |
| `recording` | 浏览器运行中且 Tracing 正在分段录制 |
| `stopped` | 已主动停止（分段已上传，浏览器已关闭） |
| `browser_closed` | 浏览器被用户手动关闭或崩溃 |
| `error` | 录制启动失败 |

## 架构说明
工作台进程内同时完成「浏览器启动 + 录制」，不再 spawn 独立 recording-agent 子进程：
- 启动：`launchPersistentContext` → 在 context 上 `tracing.start` → 定时器到点 `tracing.stop` 写 zip → 异步上传 → 立即 `tracing.start` 下一段。
- 停止：`tracing.stop` 刷出当前分段 → 上传 → `context.close()`。
- 这意味着无需 CDP 端口分配、无需跨进程健康检查、无需 `taskkill /T /F` 兜底——Playwright 原生关闭即精确终止浏览器全树。

## 典型工作流
1. 员工开机后工作台自启（注册为 Windows 服务 / systemd）。
2. 工作台启动浏览器实例 → 进程内立即开始录制。
3. 员工在该浏览器中操作，全程被分段录制并上传。
4. 下班或换班时，通过 Web UI / CLI 停止实例，当前分段刷出并上传后浏览器关闭。
