# 定制 Playwright 1.62.1 构建说明

本目录包含 Browser Record 使用的精简 Playwright 1.62.1 runtime、源码 overrides 和可重复构建脚本。

## 目录

```text
packages/playwright-custom/
├── build.js
├── overrides/
│   └── packages/
│       ├── utils/serializedFS.ts
│       ├── playwright-core/src/server/videoRecorder.ts
│       └── trace-viewer/src/ui/
│           ├── playbackControl.tsx
│           └── snapshotTab.tsx
├── playwright/                  # 薄 wrapper
└── playwright-core/             # 精简运行时 + Trace Viewer
```

完整 Playwright 源码不提交到业务仓库。默认构建输入目录为仓库根目录的：

```text
playwright-1.62.1/
```

该目录已被根 `.gitignore` 忽略。

## 环境要求

- Node.js 20 或更高版本；
- npm；
- Playwright 1.62.1 源码 checkout；
- Windows、Linux 或 macOS 均可构建。

## 准备源码

```bash
git clone --branch v1.62.1 --depth 1 https://github.com/microsoft/playwright.git playwright-1.62.1
cd playwright-1.62.1
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
cd ..
```

Windows PowerShell：

```powershell
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD='1'
npm ci --prefix playwright-1.62.1
```

## 应用定制源码并构建

在仓库根目录运行：

```bash
node packages/playwright-custom/build.js --build
```

脚本会：

1. 将 `overrides/` 中的文件覆盖到 `playwright-1.62.1` 对应源码路径；
2. 执行 Playwright 的 `utils/build/build.js`；
3. 生成 `playwright-core/lib` 与 Trace Viewer；
4. 将构建后的 core runtime 复制到 `packages/playwright-custom/playwright-core`；
5. 删除不需要的源码目录；
6. 生成仅导出 core API 的薄 `playwright` wrapper；
7. 保留 Apache-2.0 LICENSE、NOTICE 和第三方声明。

若源码已经构建，只重新复制 runtime：

```bash
node packages/playwright-custom/build.js
```

## 当前 overrides

### `serializedFS.ts`

使 Trace append buffer 默认每 1000ms 刷入磁盘，而不是只依赖 64KB buffer 或最终 stop：

```text
PLAYWRIGHT_TRACE_FLUSH_INTERVAL_MS=1000
```

可通过环境变量覆盖：

```bash
PLAYWRIGHT_TRACE_FLUSH_INTERVAL_MS=500 npm run workstation
```

### `videoRecorder.ts`

给 FFmpeg 增加：

```text
-flush_packets 1
-cluster_time_limit 1000
-cluster_size_limit 1048576
```

让 WebM 运行期间尽早写出容器 header/cluster；浏览器关闭后等待 FFmpeg 收尾，再从持久目录打包上传。

### Trace Viewer

`playbackControl.tsx` 向快照区域暴露当前播放时间。

`snapshotTab.tsx` 在没有可用 DOM snapshot 时，显示离当前播放时间最近的 screencast JPEG，使时间轴与主画面同步。

## 生成 Trace Viewer

### 完整构建（推荐）

```bash
cd playwright-1.62.1
node utils/build/build.js
```

Trace Viewer 输出目录：

```text
playwright-1.62.1/packages/playwright-core/lib/vite/traceViewer/
```

其中包括：

```text
index.html
snapshot.html
uiMode.html
sw.bundle.js
assets/
```

### 只构建 Trace Viewer

先应用 overrides，再运行 Vite：

```bash
cp packages/playwright-custom/overrides/packages/trace-viewer/src/ui/playbackControl.tsx \
  playwright-1.62.1/packages/trace-viewer/src/ui/playbackControl.tsx
cp packages/playwright-custom/overrides/packages/trace-viewer/src/ui/snapshotTab.tsx \
  playwright-1.62.1/packages/trace-viewer/src/ui/snapshotTab.tsx

cd playwright-1.62.1/packages/trace-viewer
node ../../node_modules/vite/bin/vite.js build --clearScreen=false
```

Vite 配置中的 `sw` environment 会将：

```text
packages/trace-viewer/src/sw-main.ts
```

构建为：

```text
packages/playwright-core/lib/vite/traceViewer/sw.bundle.js
```

### 生成 `packages/trace-viewer/public/sw.bundle.js`

Playwright 标准构建不会把 service worker 写回 `public/`，正式运行时使用的是 core `lib/vite/traceViewer/sw.bundle.js`。

如果本地开发或其他工具明确需要 `public/sw.bundle.js`，在完成上面的 Viewer 构建后复制：

```bash
cp playwright-1.62.1/packages/playwright-core/lib/vite/traceViewer/sw.bundle.js \
  playwright-1.62.1/packages/trace-viewer/public/sw.bundle.js
```

PowerShell：

```powershell
Copy-Item `
  playwright-1.62.1/packages/playwright-core/lib/vite/traceViewer/sw.bundle.js `
  playwright-1.62.1/packages/trace-viewer/public/sw.bundle.js
```

不要把 `public/sw.bundle.js` 作为源码手工修改；它是 `src/sw-main.ts` 的生成产物。

## 验证内嵌 runtime

```bash
node - <<'NODE'
const playwright = require('./packages/playwright-custom/playwright');
const corePackage = require('./packages/playwright-custom/playwright-core/package.json');
console.log(corePackage.version);
console.log(typeof playwright.chromium.launchPersistentContext);
NODE
```

期望：

```text
1.62.1
function
```

验证 Trace Viewer：

```bash
test -f packages/playwright-custom/playwright-core/lib/vite/traceViewer/index.html
test -f packages/playwright-custom/playwright-core/lib/vite/traceViewer/sw.bundle.js
```

## 升级 Playwright

升级版本时：

1. 准备目标版本源码 checkout；
2. 对比每个 override 对应的上游文件；
3. 重新应用 overrides；
4. 构建 runtime；
5. 验证 Trace ZIP、异常关闭恢复、Video WebM、Range streaming 和 Viewer；
6. 更新 wrapper/core package 版本；
7. 保留对应版本的 LICENSE、NOTICE 和 ThirdPartyNotices。
