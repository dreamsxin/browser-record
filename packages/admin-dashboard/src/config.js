'use strict';

const fs = require('fs');
const path = require('path');

function loadConfigFile() {
  const candidates = [
    process.env.DASHBOARD_CONFIG && path.resolve(process.env.DASHBOARD_CONFIG),
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
  STORAGE_SERVER_URL: ['storageServerUrl'],
  ADMIN_USERNAME: ['admin', 'username'],
  ADMIN_PASSWORD: ['admin', 'password'],
  SESSION_SECRET: ['session', 'secret'],
};

function loadConfig() {
  const config = loadConfigFile();
  for (const [envKey, cfgPath] of Object.entries(ENV_MAP)) {
    if (process.env[envKey] === undefined) continue;
    setPath(config, cfgPath, process.env[envKey]);
  }
  return config;
}

module.exports = { loadConfig };
