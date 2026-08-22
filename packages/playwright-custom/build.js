'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const checkout = path.join(root, 'playwright-1.62.1');
const shouldBuild = process.argv.includes('--build');

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(full));
    else result.push(full);
  }
  return result;
}

if (!fs.existsSync(path.join(checkout, 'package.json'))) throw new Error(`找不到 Playwright 1.62.1 源码: ${checkout}`);

// Apply Browser Record source overrides before building.
const overridesRoot = path.join(__dirname, 'overrides');
for (const file of walkFiles(overridesRoot)) {
  const relative = path.relative(overridesRoot, file);
  const destination = path.join(checkout, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(file, destination);
}

if (shouldBuild || !fs.existsSync(path.join(checkout, 'packages', 'playwright-core', 'lib', 'coreBundle.js'))) {
  const result = spawnSync(process.execPath, [path.join(checkout, 'utils', 'build', 'build.js')], {
    cwd: checkout, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

const coreSource = path.join(checkout, 'packages', 'playwright-core');
const coreTarget = path.join(__dirname, 'playwright-core');
fs.rmSync(coreTarget, { recursive: true, force: true });
fs.cpSync(coreSource, coreTarget, { recursive: true });
for (const removable of ['src', '.eslintrc.js', '.npmignore'])
  fs.rmSync(path.join(coreTarget, removable), { recursive: true, force: true });
fs.copyFileSync(path.join(checkout, 'LICENSE'), path.join(coreTarget, 'LICENSE'));
const notice = path.join(checkout, 'NOTICE');
if (fs.existsSync(notice)) fs.copyFileSync(notice, path.join(coreTarget, 'NOTICE'));
console.log(`embedded playwright-core: ${coreTarget}`);

// Thin wrapper: this project only needs Browser/Context/Page APIs from core.
const wrapper = path.join(__dirname, 'playwright');
fs.rmSync(wrapper, { recursive: true, force: true });
fs.mkdirSync(wrapper, { recursive: true });
fs.copyFileSync(path.join(checkout, 'LICENSE'), path.join(wrapper, 'LICENSE'));
fs.writeFileSync(path.join(wrapper, 'index.js'), "module.exports = require('../playwright-core');\n");
fs.writeFileSync(path.join(wrapper, 'package.json'), JSON.stringify({
  name: '@browser-record/playwright-custom', version: '1.62.1-browser-record', private: true,
  main: 'index.js', license: 'Apache-2.0',
}, null, 2) + '\n');
console.log(`embedded thin playwright wrapper: ${wrapper}`);
