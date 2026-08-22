'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');

let dbInstance = null;

function initDb(config) {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, session_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL, file_path TEXT NOT NULL, start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL, file_size INTEGER NOT NULL DEFAULT 0, upload_time INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_files_employee_session ON files(employee_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_files_employee_end ON files(employee_id, end_time);
    CREATE TABLE IF NOT EXISTS employees (
      employee_id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      employee_id TEXT NOT NULL, session_id TEXT NOT NULL, started_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL DEFAULT 'recording',
      PRIMARY KEY (employee_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_employee ON sessions(employee_id);
    CREATE TABLE IF NOT EXISTS video_archives (
      id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, session_id TEXT NOT NULL,
      archive_path TEXT NOT NULL, manifest_path TEXT NOT NULL, file_size INTEGER NOT NULL,
      upload_time INTEGER NOT NULL, status TEXT NOT NULL,
      UNIQUE(employee_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT, employee_id TEXT,
      file_id TEXT, detail TEXT, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
  `);
  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (!sessionColumns.includes('recording_mode'))
    db.exec("ALTER TABLE sessions ADD COLUMN recording_mode TEXT NOT NULL DEFAULT 'trace'");
  // Idempotent backfill for databases created before lifecycle tables existed.
  db.exec(`
    INSERT INTO employees(employee_id, first_seen, last_seen)
      SELECT employee_id, MIN(start_time), MAX(end_time) FROM files GROUP BY employee_id
      ON CONFLICT(employee_id) DO UPDATE SET
        first_seen=MIN(employees.first_seen, excluded.first_seen),
        last_seen=MAX(employees.last_seen, excluded.last_seen);
    INSERT INTO sessions(employee_id, session_id, started_at, last_seen, ended_at, status)
      SELECT employee_id, session_id, MIN(start_time), MAX(end_time), MAX(end_time), 'closed'
      FROM files GROUP BY employee_id, session_id
      ON CONFLICT(employee_id, session_id) DO UPDATE SET
        started_at=MIN(sessions.started_at, excluded.started_at),
        last_seen=MAX(sessions.last_seen, excluded.last_seen);
  `);
  dbInstance = db;
  return db;
}
function getDb() { if (!dbInstance) throw new Error('数据库未初始化'); return dbInstance; }

function registerEmployee(employeeId, now = Date.now()) {
  getDb().prepare(`INSERT INTO employees(employee_id,first_seen,last_seen,status) VALUES(?,?,?,'active')
    ON CONFLICT(employee_id) DO UPDATE SET last_seen=MAX(last_seen, excluded.last_seen)`).run(String(employeeId), now, now);
}
function registerSession({ employeeId, sessionId, startedAt = Date.now(), recordingMode = 'trace' }) {
  const now = Date.now();
  registerEmployee(employeeId, now);
  getDb().prepare(`INSERT INTO sessions(employee_id,session_id,started_at,last_seen,status,recording_mode)
    VALUES(?,?,?,?, 'recording', ?)
    ON CONFLICT(employee_id,session_id) DO UPDATE SET last_seen=MAX(last_seen, excluded.last_seen),recording_mode=excluded.recording_mode`).run(String(employeeId), String(sessionId), Number(startedAt), now, recordingMode);
}
function touchSession(employeeId, sessionId, now = Date.now()) {
  registerEmployee(employeeId, now);
  getDb().prepare(`UPDATE sessions SET last_seen=?, status=CASE WHEN ended_at IS NULL THEN 'recording' ELSE status END
    WHERE employee_id=? AND session_id=?`).run(now, String(employeeId), String(sessionId));
}
function closeSession(employeeId, sessionId, endedAt = Date.now()) {
  registerEmployee(employeeId, endedAt);
  getDb().prepare(`UPDATE sessions SET ended_at=?, last_seen=?, status='closed'
    WHERE employee_id=? AND session_id=?`).run(Number(endedAt), Number(endedAt), String(employeeId), String(sessionId));
}
function upsertLifecycleForFile({ employeeId, sessionId, startTime, endTime }) {
  registerSession({ employeeId, sessionId, startedAt: Number(startTime) || Date.now() });
  touchSession(employeeId, sessionId, Number(endTime) || Date.now());
}

function insertFile({ employeeId, sessionId, segmentIndex, filePath, startTime, endTime, fileSize }) {
  const db = getDb(); const id = randomUUID(); const now = Date.now();
  db.prepare(`INSERT INTO files(id,employee_id,session_id,segment_index,file_path,start_time,end_time,file_size,upload_time)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id, employeeId, String(sessionId), Number(segmentIndex), filePath, Number(startTime), Number(endTime), Number(fileSize || 0), now);
  return { id, uploadTime: now };
}
function getFileById(id) { return getDb().prepare('SELECT * FROM files WHERE id=?').get(id); }

function listEmployees() {
  return getDb().prepare(`
    WITH stats AS (SELECT employee_id, COUNT(*) segment_count, SUM(file_size) total_bytes,
      MIN(start_time) first_start, MAX(end_time) last_end FROM files GROUP BY employee_id),
    session_stats AS (SELECT employee_id, COUNT(*) session_count,
      MAX(CASE WHEN status='recording' THEN 1 ELSE 0 END) has_recording FROM sessions GROUP BY employee_id)
    SELECT e.employee_id employeeId, COALESCE(s.session_count,0) sessionCount,
      COALESCE(f.segment_count,0) segmentCount, COALESCE(f.total_bytes,0) totalBytes,
      COALESCE(f.first_start,e.first_seen) firstStart, COALESCE(f.last_end,e.last_seen) lastEnd,
      CASE WHEN COALESCE(s.has_recording,0)=1 THEN 'active' ELSE 'closed' END status
      FROM employees e LEFT JOIN stats f ON f.employee_id=e.employee_id
      LEFT JOIN session_stats s ON s.employee_id=e.employee_id ORDER BY lastEnd DESC`).all();
}
function listSessions(employeeId) {
  return getDb().prepare(`
    WITH stats AS (SELECT session_id, COUNT(*) segment_count, SUM(file_size) total_bytes,
      MIN(start_time) file_start, MAX(end_time) file_end FROM files WHERE employee_id=? GROUP BY session_id)
    SELECT s.session_id sessionId, COALESCE(f.segment_count,0) segmentCount,
      COALESCE(f.total_bytes,0) totalBytes, s.started_at startTime,
      COALESCE(s.ended_at,f.file_end) endTime, s.status status, s.last_seen lastSeen,
      s.recording_mode recordingMode
      FROM sessions s LEFT JOIN stats f ON f.session_id=s.session_id
      WHERE s.employee_id=? ORDER BY s.started_at DESC`).all(employeeId, employeeId);
}
function listSegments(employeeId, sessionId) { return getDb().prepare(`SELECT id,segment_index segmentIndex,file_path filePath,start_time startTime,end_time endTime,file_size fileSize,upload_time uploadTime FROM files WHERE employee_id=? AND session_id=? ORDER BY segment_index`).all(employeeId, sessionId); }
function listSegmentsByTimeRange(employeeId, fromTs, toTs, limit=100) { return getDb().prepare(`SELECT id,session_id sessionId,segment_index segmentIndex,file_path filePath,start_time startTime,end_time endTime,file_size fileSize,upload_time uploadTime FROM files WHERE employee_id=? AND end_time>=? AND start_time<=? ORDER BY start_time DESC LIMIT ?`).all(employeeId, Number(fromTs), Number(toTs), Number(limit)); }
function deleteFileRow(id) { return getDb().prepare('DELETE FROM files WHERE id=?').run(id); }
function listSessionsOrdered(employeeId) { return getDb().prepare(`SELECT session_id sessionId,MAX(end_time) lastEnd,COUNT(*) cnt FROM files WHERE employee_id=? GROUP BY session_id ORDER BY lastEnd DESC`).all(employeeId); }
function totalBytesForEmployee(employeeId) { return Number(getDb().prepare('SELECT COALESCE(SUM(file_size),0) total FROM files WHERE employee_id=?').get(employeeId).total) || 0; }
function insertAudit({ actor, action, employeeId, fileId, detail }) { getDb().prepare('INSERT INTO audit_logs(actor,action,employee_id,file_id,detail) VALUES(?,?,?,?,?)').run(actor || 'unknown', action, employeeId || null, fileId || null, detail || null); }

module.exports = { initDb, getDb, registerEmployee, registerSession, touchSession, closeSession, upsertLifecycleForFile, insertFile, getFileById, listEmployees, listSessions, listSegments, listSegmentsByTimeRange, deleteFileRow, listSessionsOrdered, totalBytesForEmployee, insertAudit };
