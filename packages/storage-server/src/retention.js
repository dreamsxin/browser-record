'use strict';

const fs = require('fs');
const path = require('path');
const {
  listSessionsOrdered,
  deleteFileRow,
  totalBytesForEmployee,
} = require('./db');

/**
 * 循环覆盖清理：为每位员工保留最近 N 个会话；同时总大小不超过字节配额。
 * 超出配额时，按最旧会话优先删除，直到满足配额。
 *
 * @param {object} config
 * @param {string|null} employeeId  指定员工；为 null 则扫描全部员工
 * @returns {{ deletedFiles: number, freedBytes: number }}
 */
function runRetention(config, employeeId = null) {
  const { maxSessionsPerEmployee, maxBytesPerEmployee } = config.retention;
  let deletedFiles = 0;
  let freedBytes = 0;

  const db = require('./db').getDb();
  const employees = employeeId
    ? [{ employee_id: employeeId }]
    : db.prepare('SELECT DISTINCT employee_id AS employee_id FROM files').all();

  for (const { employee_id } of employees) {
    const sessions = listSessionsOrdered(employee_id); // 按 lastEnd DESC
    const toDelete = new Set();

    // 1) 超过会话数上限：删除最旧的会话
    if (maxSessionsPerEmployee && sessions.length > maxSessionsPerEmployee) {
      for (let i = maxSessionsPerEmployee; i < sessions.length; i++) {
        toDelete.add(sessions[i].sessionId);
      }
    }

    // 2) 总大小超配额：从最旧会话开始整会话删除，直到满足配额
    let total = totalBytesForEmployee(employee_id);
    if (maxBytesPerEmployee && total > maxBytesPerEmployee) {
      const oldest = [...sessions].reverse(); // 按 lastEnd ASC
      for (const s of oldest) {
        if (total <= maxBytesPerEmployee) break;
        if (toDelete.has(s.sessionId)) continue; // 已计划删除
        total -= Number(s.totalBytes || 0);
        toDelete.add(s.sessionId);
      }
    }

    if (toDelete.size === 0) continue;

    const segments = db.prepare(`
      SELECT id, file_path FROM files
      WHERE employee_id = ? AND session_id IN (${Array(toDelete.size).fill('?').join(',')})
    `).all(employee_id, ...toDelete);

    for (const seg of segments) {
      const absPath = path.join(config.recordingsDir, seg.file_path);
      try {
        if (fs.existsSync(absPath)) {
          const stat = fs.statSync(absPath);
          freedBytes += stat.size;
          fs.unlinkSync(absPath);
        }
      } catch (e) {
        console.error(`[retention] 删除文件失败 ${absPath}: ${e.message}`);
      }
      deleteFileRow(seg.id);
      deletedFiles += 1;
    }
  }

  if (deletedFiles > 0) {
    console.log(`[retention] 清理完成: 删除 ${deletedFiles} 个分段, 释放 ${(freedBytes / 1024 / 1024).toFixed(2)} MB`);
  }
  return { deletedFiles, freedBytes };
}

function startDailyCleanup(config) {
  const { dailyCleanupHour, dailyCleanupMinute } = config.retention;
  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(dailyCleanupHour || 3, dailyCleanupMinute || 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next - now;
    setTimeout(() => {
      try {
        console.log('[retention] 执行每日全量清理...');
        runRetention(config, null);
      } catch (err) {
        console.error('[retention] 每日清理异常:', err);
      }
      scheduleNext();
    }, delay);
    console.log(`[retention] 下次全量清理: ${next.toISOString()}`);
  };
  scheduleNext();
}

module.exports = { runRetention, startDailyCleanup };
