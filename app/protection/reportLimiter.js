'use strict';

/**
 * 檢舉限速模組
 * - 記憶體 Map<sessionId, { timestamps: [], cooldownUntil: 0 }>
 * - 60 秒滑動窗口
 * - ≤ 3 次 → allowed
 * - > 3 次 → 冷卻 60 秒
 * - 冷卻結束 → 窗口清空
 */

const WINDOW_MS = 60000;    // 滑動窗口 60 秒
const MAX_REPORTS = 3;      // 窗口內最大檢舉數
const COOLDOWN_MS = 60000;  // 冷卻時間 60 秒

// 記憶體儲存
const sessions = new Map();

/**
 * 取得或建立 session 記錄
 */
function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      timestamps: [],
      cooldownUntil: 0,
    });
  }
  return sessions.get(sessionId);
}

/**
 * 清理過期的時間戳
 */
function pruneTimestamps(session, now) {
  const cutoff = now - WINDOW_MS;
  while (session.timestamps.length > 0 && session.timestamps[0] < cutoff) {
    session.timestamps.shift();
  }
}

/**
 * 檢查檢舉速率
 * @param {string} sessionId - 連線識別碼
 * @returns {{ allowed: boolean, cooldownMs?: number }}
 */
function checkReport(sessionId) {
  const now = Date.now();
  const session = getSession(sessionId);

  // 檢查是否在冷卻期間
  if (session.cooldownUntil > now) {
    return {
      allowed: false,
      cooldownMs: session.cooldownUntil - now,
    };
  }

  // 冷卻結束 → 窗口清空
  if (session.cooldownUntil > 0 && session.cooldownUntil <= now) {
    session.timestamps = [];
    session.cooldownUntil = 0;
  }

  // 清理過期時間戳
  pruneTimestamps(session, now);

  // 檢查是否超過限制
  if (session.timestamps.length >= MAX_REPORTS) {
    session.cooldownUntil = now + COOLDOWN_MS;
    return {
      allowed: false,
      cooldownMs: COOLDOWN_MS,
    };
  }

  // 通過檢查，記錄時間戳
  session.timestamps.push(now);

  return { allowed: true };
}

/**
 * 斷線時清除 session 記錄
 * @param {string} sessionId - 連線識別碼
 */
function cleanup(sessionId) {
  sessions.delete(sessionId);
}

/**
 * 重設所有資料（測試用）
 */
function reset() {
  sessions.clear();
}

module.exports = {
  checkReport,
  cleanup,
  reset,
  WINDOW_MS,
  MAX_REPORTS,
  COOLDOWN_MS,
};
