'use strict';

const fs = require('fs');
const path = require('path');

function loadConfigFile() {
  const candidates = [
    process.env.WORKSTATION_CONFIG && path.resolve(process.env.WORKSTATION_CONFIG),
    path.join(process.cwd(), 'config', 'local.json'),
    path.join(__dirname, '..', 'config', 'local.json'),
    path.join(__dirname, '..', 'config', 'default.json'),
  ].filter(Boolean);

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  }
  return {};
}

function setPath(obj, pathArr, value) {
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i++) {
    cur[pathArr[i]] = cur[pathArr[i]] || {};
    cur = cur[pathArr[i]];
  }
  cur[pathArr[pathArr.length - 1]] = value;
}

const ENV_MAP = {
  PORT: ['port'],
  HOST: ['host'],
  PROFILES_DIR: ['profilesDir'],
  BROWSER_EXECUTABLE: ['browser', 'executablePath'],
  BROWSER_STARTING_URL: ['browser', 'startingUrl'],
  BROWSER_HEADLESS: ['browser', 'headless'],
  STORAGE_SERVER_URL: ['storageServerUrl'],
  UPLOAD_TOKEN: ['uploadToken'],
  AGENT_SEGMENT_MS: ['recording', 'segmentDurationMs'],
  RECORDING_SEGMENT_MS: ['recording', 'segmentDurationMs'],
};

function loadConfig(cwd) {
  const config = loadConfigFile();
  for (const [envKey, cfgPath] of Object.entries(ENV_MAP)) {
    if (process.env[envKey] === undefined) continue;
    setPath(config, cfgPath, process.env[envKey]);
  }

  const base = cwd || process.cwd();
  config.profilesDir = path.resolve(base, config.profilesDir || './profiles');

  if (config.recording) {
    config.recording.segmentDurationMs = Number(config.recording.segmentDurationMs) || 1800000;
  }
  if (config.browser && typeof config.browser.headless === 'string') {
    config.browser.headless = config.browser.headless === 'true';
  }

  return config;
}

module.exports = { loadConfig };
