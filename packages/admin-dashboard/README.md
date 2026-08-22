# 管理后台 (admin-dashboard)

Web 后台：管理员登录后按员工 → 会话 → 分段浏览录制，点击「回放」在内嵌的 Playwright Trace Viewer 中查看操作过程。

## 配置
默认配置在 `config/default.json`，可用 `config/local.json` 或环境变量覆盖：

| 环境变量 | 默认 | 说明 |
|---------|------|------|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `STORAGE_SERVER_URL` | `http://localhost:4000` | 中央存储服务地址 |
| `ADMIN_USERNAME` | `admin` | 后台登录账号 |
| `ADMIN_PASSWORD` | `admin123` | 后台登录密码 |
| `SESSION_SECRET` | `change-me-...` | 会话签名密钥 |

## 运行
```bash
cd packages/admin-dashboard
npm install
npm start
# 打开 http://localhost:3000
```

## 功能
- **登录**：用户名/密码 → 签名 cookie 会话。
- **员工列表**：每个员工的会话数、分段数、总大小、最近活动。
- **会话列表**：某员工各会话的起止时间、分段数、总大小。
- **分段列表**：会话内每个分段的起止时间、大小、上传时间，每条带「回放」。
- **回放**：调用存储服务生成签名下载 URL，iframe 嵌入 `https://trace.playwright.dev/?trace=<signed-url>` 加载 Trace 文件。

> 生产环境建议自托管 Trace Viewer（`npx playwright show-trace` 或构建独立前端），将 `viewerUrl` 指向内部域名。
