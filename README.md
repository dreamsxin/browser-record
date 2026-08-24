# Browser Record — 浏览器操作录制与回放系统

基于内嵌定制版 **Playwright 1.62.1** 的浏览器操作录制与回放系统。员工工作台支持 **Trace** 和 **Video** 两种录制模式；中央存储服务负责归档与元数据；管理后台直接展示全部录制会话，并支持按员工筛选、Trace Viewer 回放和 WebM 视频回放。

详见 [DESIGN.md](./DESIGN.md)。

## 架构

```
员工电脑
┌────────────────────────────────────────────────────────────┐
│ 工作台 (workstation, Node 进程)                             │
│   └─ 定制 Playwright 1.62.1 ──▶ Chromium 浏览器实例        │
│        ├─ Trace：原始数据实时落盘 + 标准 Trace ZIP          │
│        └─ Video：持久 WebM + 会话 ZIP                       │
└────────────────────────────┬───────────────────────────────┘
                             │ upload
                             ▼
                    中央存储服务 (Express+SQLite)
                    └─ /viewer 自托管 Trace Viewer（同源）
                             ▲
                             │ 查询/签名下载
                    管理后台 (Express+EJS) ── iframe 嵌入 /viewer
```

## 仓库结构（npm workspaces monorepo）

```
browser-record/
├── DESIGN.md
├── package.json            # workspaces 根配置
├── packages/
│   ├── workstation/        # 员工工作台：启动实例，选择 Trace/Video
│   ├── live-trace-recorder/# 浏览器关闭后从 raw trace 生成标准 ZIP
│   ├── video-recorder/     # WebM 稳定检测、归档和上传
│   ├── playwright-custom/  # 精简 Playwright 1.62.1 runtime、overrides 和构建脚本
│   ├── recording-agent/    # 独立 CDP 录制代理（兼容模式）
│   ├── storage-server/     # Trace/Video 存储、Range streaming、Trace Viewer
│   └── admin-dashboard/    # 全局会话列表、筛选与回放
```

## 快速开始

### 1. 安装依赖
```bash
cd browser-record
npm install
```

### 2. 启动中央存储服务
```bash
npm run server
# http://localhost:4000
```

### 3. 启动管理后台
```bash
npm run dashboard
# http://localhost:3000  (账号 admin / admin123)
```

### 4. 启动员工工作台（推荐方式）
工作台会自动启动浏览器实例并挂接录制代理，无需手动分别启动浏览器与 agent：
```bash
npm run workstation
# http://127.0.0.1:5000
```
然后通过 Web UI 选择录制模式，或使用 CLI：
```bash
npm run workstation:cli -- list
npm run workstation:cli -- start --id alice --url https://example.com --mode trace
npm run workstation:cli -- start --id bob --url https://example.com --mode video
npm run workstation:cli -- stop alice
```

管理后台登录后直接进入：

```text
http://localhost:3000/sessions
```

会话列表支持按员工 ID 筛选，并根据模式显示 Trace 回放或视频回放。

> 员工无需关心 CDP 端口、profile 目录或录制代理的启动——工作台自动分配并拉起录制。

### 5. 手动方式（不使用工作台）
```bash
# 先启动浏览器（远程调试模式）
chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\chrome-debug"
# 再启动录制代理
npm run agent
```
默认每 30 分钟分段保存并上传。可用环境变量调整：
```bash
EMPLOYEE_ID=emp_001 SEGMENT_DURATION_MS=60000 npm run agent   # 测试：1 分钟一段
```

## 端口与默认凭据

| 服务 | 端口 | 凭据 |
|------|------|------|
| 员工工作台 | 5000 | — |
| 中央存储服务 | 4000 | 上传令牌 `dev-upload-token` |
| 管理后台 | 3000 | `admin` / `admin123` |

> 所有默认凭据/密钥仅用于开发，生产请通过环境变量或 `config/local.json` 覆盖。

## 录制策略

### Trace

- 内嵌定制 Playwright 1.62.1；
- `screenshots:true`、`snapshots:true`、`sources:false`、`live:true`；
- raw `trace/network/resources` 运行中持续写入 profile 目录；
- 默认每 30 秒生成一个标准 Trace checkpoint ZIP；
- 浏览器异常关闭后，可从已经落盘的 raw trace 生成恢复 ZIP；
- 自托管同版本 Trace Viewer 回放。

### Video

- Playwright 原生 `recordVideo`，输出到持久 profile 目录；
- 定制 FFmpeg 参数使 WebM 尽早写出 header/cluster；
- 正常或异常关闭后等待 WebM 文件稳定，再生成 session ZIP；
- storage-server 解压并以 HTTP Range 提供 `video/webm`；
- 管理后台使用原生 `<video controls>` 回放。

## 编译定制 Playwright

完整的源码准备、overrides 应用、精简 runtime 复制、Trace Viewer 构建和 `sw.bundle.js` 生成方法见：

[packages/playwright-custom/README.md](packages/playwright-custom/README.md)

常用命令：

```bash
# 准备源码依赖（不下载浏览器）
cd playwright-1.62.1
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
cd ..

# 应用 overrides、完整构建并复制精简 runtime
node packages/playwright-custom/build.js --build

# 源码已构建，仅重新复制 runtime
node packages/playwright-custom/build.js
```

Trace Viewer 构建输出：

```text
playwright-1.62.1/packages/playwright-core/lib/vite/traceViewer/
```

其中包括 `sw.bundle.js`。标准构建不会自动写回 `packages/trace-viewer/public/sw.bundle.js`；如开发工具确实需要该路径，在 Viewer 构建后复制生成文件，详见定制构建文档。

## 存储与清理
- 文件：`data/recordings/<employeeId>/<sessionId>/segment_<index>.zip`
- 元数据：SQLite `data/storage.db`
- 循环覆盖：每员工保留最近 20 个会话 + 总大小 ≤ 5GB；每次上传后异步清理，每日 03:00 全量清理。
