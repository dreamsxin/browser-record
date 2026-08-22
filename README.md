# Browser Record — 浏览器操作录制与回放系统

基于 **Playwright Tracing** 的浏览器操作录制与回放系统：客户端代理按 30 分钟分段录制 → 中央存储服务落盘 + 元数据 → 循环覆盖清理 → 管理后台查询与 Trace Viewer 回放。适用于任意岗位的浏览器操作审计与回放。

详见 [DESIGN.md](./DESIGN.md)。

## 架构

```
员工电脑
┌──────────────────────────────────────────────────────┐
│ 工作台 (workstation) ──启动──▶ 浏览器实例 (CDP:9300+) │
│      │                         ▲                      │
│      └──自动拉起──▶ 录制代理 (Node) ──连接 CDP──┘     │
└──────────────────────────┬───────────────────────────┘
                           │ upload
                           ▼
                  中央存储服务 (Express+SQLite)
                           ▲
                           │ 查询/签名下载
                  管理后台 (Express+EJS) ── Trace Viewer (iframe)
```

## 仓库结构（npm workspaces monorepo）

```
browser-record/
├── DESIGN.md
├── package.json            # workspaces 根配置
├── packages/
│   ├── workstation/        # 员工工作台：启动/关闭浏览器实例并自动挂接录制
│   ├── recording-agent/    # 客户端录制代理（被工作台拉起）
│   ├── storage-server/     # 中央存储服务
│   └── admin-dashboard/    # 管理后台
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
然后通过 Web UI 或 CLI 启动/停止实例：
```bash
npm run workstation:cli -- list
npm run workstation:cli -- start --id alice --url https://example.com
npm run workstation:cli -- stop alice
```

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
| 录制代理健康检查 | 4100+ | — |
| 中央存储服务 | 4000 | 上传令牌 `dev-upload-token` |
| 管理后台 | 3000 | `admin` / `admin123` |

> 所有默认凭据/密钥仅用于开发，生产请通过环境变量或 `config/local.json` 覆盖。

## 录制策略
- `screenshots: true`、`snapshots: false`、`sources: false`，文件体积小。
- 每 30 分钟（可配）停止 → 保存 zip → 立即启动下一段，无缝衔接。
- 上传异步、指数退避重试，失败保留本地待补传。
- 浏览器断开自动重连，恢复后继续累加分段序号。

## 存储与清理
- 文件：`data/recordings/<employeeId>/<sessionId>/segment_<index>.zip`
- 元数据：SQLite `data/storage.db`
- 循环覆盖：每员工保留最近 20 个会话 + 总大小 ≤ 5GB；每次上传后异步清理，每日 03:00 全量清理。
