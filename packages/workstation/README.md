# 员工工作台程序 (workstation)

运行在员工电脑上的本地控制程序：启动/关闭浏览器实例，自动为每个实例分配独立的 profile 目录与 CDP 端口，并在启动浏览器后**自动拉起 recording-agent 连接该实例开始录制**。提供 Web UI 与 CLI 两种操作方式。

## 职责
- **启动浏览器实例**：为每个实例分配 `<profilesDir>/<instanceId>` 独立 profile 目录与 [9300,9399] 范围内的空闲 CDP 端口。
- **自动挂接录制**：浏览器 CDP 就绪后，自动以子进程启动 `recording-agent`，通过环境变量传入 `CDP_ENDPOINT`、`EMPLOYEE_ID`、上传地址等，无需员工干预。
- **关闭实例**：先优雅停止 agent（SIGINT 完成当前分段上传）再关闭浏览器，保留 profile 目录供下次复用。
- **实例列表**：查看已启动实例的 ID、CDP 端口、浏览器/agent PID、状态、启动时间。

## 配置
默认配置在 `config/default.json`，可用 `config/local.json` 或环境变量覆盖：

| 环境变量 | 默认 | 说明 |
|---------|------|------|
| `PORT` | `5000` | 工作台服务端口（仅监听 127.0.0.1） |
| `PROFILES_DIR` | `./profiles` | 浏览器 profile 根目录 |
| `BROWSER_EXECUTABLE` | 自动探测 | 浏览器可执行文件路径；留空则复用 recording-agent 的 Playwright Chromium |
| `BROWSER_STARTING_URL` | `about:blank` | 浏览器起始页 |
| `CDP_PORT_MIN` / `CDP_PORT_MAX` | `9300` / `9399` | CDP 端口分配范围 |
| `STORAGE_SERVER_URL` | `http://localhost:4000` | 传给 agent 的上传服务地址 |
| `UPLOAD_TOKEN` | `dev-upload-token` | 传给 agent 的上传令牌 |
| `AGENT_SEGMENT_MS` | `1800000` | 传给 agent 的分段时长（毫秒） |

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
| `browser_starting` | 浏览器进程已启动，等待 CDP 就绪 |
| `browser_ready` | CDP 就绪，agent 尚未挂接或已退出 |
| `recording` | 浏览器就绪且 recording-agent 正在录制 |
| `stopped` | 已主动停止 |
| `browser_exited` | 浏览器进程已退出 |
| `error` | 初始化失败 |

## 端口分配规则
- CDP 端口：从 `cdpPortRange.min` 起逐个探测空闲端口。
- Agent 健康检查端口：`4100 + (cdpPort - cdpPortRange.min)`，与 CDP 端口一一对应，避免多实例冲突。

## 典型工作流
1. 员工开机后工作台自启（注册为 Windows 服务 / systemd）。
2. 工作台启动浏览器实例 → 自动开始录制。
3. 员工在该浏览器中操作店铺后台，全程被分段录制并上传。
4. 下班或换班时，通过 Web UI / CLI 停止实例，agent 完成当前分段上传后退出。
