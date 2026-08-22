'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');

let dbInstance = null;

/**
 * 初始化 SQLite 数据库并返回实例。
 * 表结构：
 *  - files: 每个分段文件的元数据
 *  - audit_logs: 管理员访问审计日志
 */
function initDb(config) {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id            TEXT PRIMARY KEY,
      employee_id   TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      file_path     TEXT NOT NULL,
      start_time    INTEGER NOT NULL,
      end_time      INTEGER NOT NULL,
      file_size     INTEGER NOT NULL DEFAULT 0,
      upload_time   INTEGER NOT NULL,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_files_employee_session
      ON files(employee_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_files_employee_end
      ON files(employee_id, end_time);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      actor         TEXT,
      action        TEXT,
      employee_id   TEXT,
      file_id       TEXT,
      detail        TEXT,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
  `);

  dbInstance = db;
  return db;
}

function getDb() {
  if (!dbInstance) throw new Error('数据库未初始化：请先调用 initDb');
  return dbInstance;
}

// ---- 文件元数据操作 ----

function insertFile({ employeeId, sessionId, segmentIndex, filePath, startTime, endTime, fileSize }) {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO files (id, employee_id, session_id, segment_index, file_path, start_time, end_time, file_size, upload_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, employeeId, String(sessionId), Number(segmentIndex), filePath, Number(startTime), Number(endTime), Number(fileSize || 0), now);
  return { id, uploadTime: now };
}

function getFileById(id) {
  return getDb().prepare('SELECT * FROM files WHERE id = ?').get(id);
}

function listEmployees() {
  return getDb().prepare(`
    SELECT employee_id AS employeeId,
           COUNT(*)     AS segmentCount,
           COUNT(DISTINCT session_id) AS sessionCount,
           SUM(file_size) AS totalBytes,
           MIN(start_time) AS firstStart,
           MAX(end_time)   AS lastEnd
    FROM files
    GROUP BY employee_id
    ORDER BY lastEnd DESC
  `).all();
}

function listSessions(employeeId) {
  return getDb().prepare(`
    SELECT session_id AS sessionId,
           COUNT(*)     AS segmentCount,
           SUM(file_size) AS totalBytes,
           MIN(start_time) AS startTime,
           MAX(end_time)   AS endTime
    FROM files
    WHERE employee_id = ?
    GROUP BY session_id
    ORDER BY startTime DESC
  `).all(employeeId);
}

function listSegments(employeeId, sessionId) {
  return getDb().prepare(`
    SELECT id, segment_index AS segmentIndex, file_path AS filePath,
           start_time AS startTime, end_time AS endTime,
           file_size AS fileSize, upload_time AS uploadTime
    FROM files
    WHERE employee_id = ? AND session_id = ?
    ORDER BY segment_index ASC
  `).all(employeeId, sessionId);
}

function listSegmentsByTimeRange(employeeId, fromTs, toTs, limit = 100) {
  return getDb().prepare(`
    SELECT id, session_id AS sessionId, segment_index AS segmentIndex,
           file_path AS filePath, start_time AS startTime, end_time AS endTime,
           file_size AS fileSize, upload_time AS uploadTime
    FROM files
    WHERE employee_id = ?
      AND end_time >= ? AND start_time <= ?
    ORDER BY start_time DESC
    LIMIT ?
  `).all(employeeId, Number(fromTs), Number(toTs), Number(limit));
}

function deleteFileRow(id) {
  return getDb().prepare('DELETE FROM files WHERE id = ?').run(id);
}

/**
 * 返回某员工按会话结束时间降序排列的会话列表（用于保留最近 N 个会话）。
 */
function listSessionsOrdered(employeeId) {
  return getDb().prepare(`
    SELECT session_id AS sessionId, MAX(end_time) AS lastEnd, COUNT(*) AS cnt
    FROM files
    WHERE employee_id = ?
    GROUP BY session_id
    ORDER BY lastEnd DESC
  `).all(employeeId);
}

/**
 * 返回某员工所有文件总大小（字节）。
 */
function totalBytesForEmployee(employeeId) {
  const row = getDb().prepare('SELECT COALESCE(SUM(file_size),0) AS total FROM files WHERE employee_id = ?').get(employeeId);
  return Number(row.total) || 0;
}

// ---- 审计日志 ----

function insertAudit({ actor, action, employeeId, fileId, detail }) {
  getDb().prepare(`
    INSERT INTO audit_logs (actor, action, employee_id, file_id, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(actor || 'unknown', action, employeeId || null, fileId || null, detail || null);
}

module.exports = {
  initDb,
  getDb,
  insertFile,
  getFileById,
  listEmployees,
  listSessions,
  listSegments,
  listSegmentsByTimeRange,
  deleteFileRow,
  listSessionsOrdered,
  totalBytesForEmployee,
  insertAudit,
};
