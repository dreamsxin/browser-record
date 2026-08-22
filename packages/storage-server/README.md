# 中央存储服务 (storage-server)

接收录制代理上传的分段文件，存储元数据至 SQLite，执行循环覆盖清理，并提供签名下载接口供管理后台与 Trace Viewer 使用。

## 配置
默认配置在 `config/default.json`，可用 `config/local.json` 或环境变量覆盖：

| 环境变量 | 默认 | 说明 |
|---------|------|------|
| `PORT` | `4000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | 数据根目录 |
| `RECORDINGS_DIR` | `./data/recordings` | 文件存储目录 |
| `DB_PATH` | `./data/storage.db` | SQLite 路径 |
| `JWT_SECRET` | `change-me-in-production` | JWT 签名密钥 |
| `UPLOAD_TOKEN` | `dev-upload-token` | 录制代理上传令牌 |
| `ADMIN_USERNAME` | `admin` | 管理员账号 |
| `ADMIN_PASSWORD` | `admin123` | 管理员密码 |
| `RETENTION_MAX_SESSIONS` | `20` | 每员工保留最近会话数 |
| `RETENTION_MAX_BYTES` | `5368709120` | 每员工最大存储（5GB） |

## 运行
```bash
cd packages/storage-server
npm install
npm start
```

## API 概览

### 上传（录制代理调用）
- `POST /api/upload`  
  `X-Upload-Token` + multipart：`file`、`employeeId`、`sessionId`、`segmentIndex`、`startTime`、`endTime`

### 鉴权
- `POST /api/auth/login` `{ username, password }` → `{ token }`

### 查询（管理员，需 `Authorization: Bearer <token>`）
- `GET /api/files/employees`
- `GET /api/files/employees/:employeeId/sessions`
- `GET /api/files/employees/:employeeId/sessions/:sessionId/segments`
- `GET /api/files/employees/:employeeId/segments?from=&to=&limit=`
- `GET /api/files/segments/:id`

### 下载（管理员签名）
- `GET /api/download/segments/:id/sign` → `{ url }`
- `GET /api/download/segments/:id?token=...` → 文件流

## 存储结构
```
data/recordings/<employeeId>/<sessionId>/segment_<index>.zip
```

## 循环覆盖
- 每次上传成功后异步对当员工执行清理。
- 每日凌晨 03:00 全量扫描清理。
- 保留最近 N 个会话（默认 20）；同时每员工总大小不超过配额（默认 5GB）。
