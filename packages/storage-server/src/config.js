'use strict';

const fs = require('fs');
const path = require('path');

function loadConfigFile() {
  const candidates = [
    process.env.SERVER_CONFIG && path.resolve(process.env.SERVER_CONFIG),
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

function coerce(value, key) {
  if (/port|ttl|hour|minute|max|size|bytes|ttl/i.test(key)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

const ENV_MAP = {
  PORT: ['port'],
  HOST: ['host'],
  DATA_DIR: ['dataDir'],
  RECORDINGS_DIR: ['recordingsDir'],
  DB_PATH: ['dbPath'],
  JWT_SECRET: ['auth', 'jwtSecret'],
  UPLOAD_TOKEN: ['auth', 'uploadToken'],
  ADMIN_USERNAME: ['auth', 'adminUsername'],
  ADMIN_PASSWORD: ['auth', 'adminPassword'],
  RETENTION_MAX_SESSIONS: ['retention', 'maxSessionsPerEmployee'],
  RETENTION_MAX_BYTES: ['retention', 'maxBytesPerEmployee'],
};

function loadConfig() {
  const config = loadConfigFile();

  for (const [envKey, cfgPath] of Object.entries(ENV_MAP)) {
    if (process.env[envKey] === undefined) continue;
    setPath(config, cfgPath, coerce(process.env[envKey], cfgPath[cfgPath.length - 1]));
  }

  // 解析为绝对路径
  config.dataDir = path.resolve(config.dataDir || './data');
  config.recordingsDir = path.resolve(config.recordingsDir || path.join(config.dataDir, 'recordings'));
  config.dbPath = path.resolve(config.dbPath || path.join(config.dataDir, 'storage.db'));

  return config;
}

module.exports = { loadConfig };
