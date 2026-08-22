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
  STORAGE_SERVER_URL: ['storageServerUrl'],
  UPLOAD_TOKEN: ['uploadToken'],
  AGENT_SEGMENT_MS: ['agent', 'segmentDurationMs'],
  CDP_PORT_MIN: ['cdpPortRange', 'min'],
  CDP_PORT_MAX: ['cdpPortRange', 'max'],
};

function loadConfig(cwd) {
  const config = loadConfigFile();
  for (const [envKey, cfgPath] of Object.entries(ENV_MAP)) {
    if (process.env[envKey] === undefined) continue;
    setPath(config, cfgPath, process.env[envKey]);
  }

  const base = cwd || process.cwd();
  config.profilesDir = path.resolve(base, config.profilesDir || './profiles');

  // 数值化
  if (config.cdpPortRange) {
    config.cdpPortRange.min = Number(config.cdpPortRange.min) || 9300;
    config.cdpPortRange.max = Number(config.cdpPortRange.max) || 9399;
  }
  config.agent.segmentDurationMs = Number(config.agent.segmentDurationMs) || 1800000;

  return config;
}

module.exports = { loadConfig };
