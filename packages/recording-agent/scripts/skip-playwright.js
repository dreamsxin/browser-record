'use strict';

// 如果 `playwright install chromium` 在受限环境（如无浏览器下载权限的 CI）失败，
// postinstall 会调用此脚本以避免整个 npm install 中断。
// 录制代理连接的是员工已有的 Chrome（--remote-debugging-port），
// 因此本地无需拥有 Playwright 自带的 Chromium 二进制。
console.warn('[skip-playwright] 已跳过本地 Chromium 下载（录制代理通过 CDP 连接外部浏览器）。');
