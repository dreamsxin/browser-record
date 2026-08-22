'use strict';

const fs = require('fs');
const path = require('path');

const ENV_MAP = {
  EMPLOYEE_ID: 'employeeId',
  CDP_ENDPOINT: 'cdpEndpoint',
  STORAGE_SERVER_URL: 'storageServerUrl',
  UPLOAD_TOKEN: 'uploadToken',
  SEGMENT_DURATION_MS: 'segmentDurationMs',
  HEALTH_PORT: ['health', 'port'],
  AGENT_CONFIG: null,
};

function loadConfigFile() {
  const candidates = [
    process.env.AGENT_CONFIG && path.resolve(process.env.AGENT_CONFIG),
    path.join(process.cwd(), 'config', 'local.json'),
    path.join(__dirname, '..', 'config', 'local.json'),
    path.join(__dirname, '..', 'config', 'default.json'),
  ].filter(Boolean);

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      return JSON.parse(raw);
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

function loadConfig() {
  const config = loadConfigFile();

  for (const [envKey, cfgPath] of Object.entries(ENV_MAP)) {
    if (process.env[envKey] === undefined) continue;
    if (cfgPath === null) continue;
    if (Array.isArray(cfgPath)) {
      setPath(config, cfgPath, coerce(process.env[envKey], cfgPath));
    } else {
      config[cfgPath] = coerce(process.env[envKey], [cfgPath]);
    }
  }

  config.segmentDurationMs = Number(config.segmentDurationMs) || 1800000;
  config.localTracesDir = path.resolve(
    config.localTracesDir || path.join(__dirname, '..', 'traces')
  );
  config.uploadUrl = `${config.storageServerUrl.replace(/\/$/, '')}/api/upload`;

  return config;
}

function coerce(value, cfgPath) {
  const last = Array.isArray(cfgPath) ? cfgPath[cfgPath.length - 1] : cfgPath;
  if (last === 'port' || last === 'segmentDurationMs' || last.includes('Ms') || last.includes('port')) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

module.exports = { loadConfig };
