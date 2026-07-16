'use strict';

/**
 * 速率限制模組
 * 記憶體結構：Map<sessionId, { timestamps: [], violations: 0, mutedUntil: 0, connectedAt: number }>
 *
 * - 滑動窗口：每 session_id 最多 5 則 / 30 秒
 * - 超速 → 漸進懲罰（cooldown）
 * - 新連線保護：connectedAt 後 3 秒內首發 → 冷卻加倍
 * - mute 期間 → 回傳 cooldown + muteUntil
 */

// 常數設定
const WINDOW_MS = 30000;        // 滑動窗口 30 秒
const MAX_MESSAGES = 5;         // 窗口內最大訊息數
const NEW_CONN_PROTECT_MS = 3000; // 新連線保護期 3 秒

// 漸進懲罰
const PENALTIES = [
  3000,    // 第 1 次超速 → 3 秒
  10000,   // 第 2 次 → 10 秒
  30000,   // 第 3 次 → 30 秒
  300000,  // 再犯 → mute 5 分鐘
];

// 記憶體儲存
const sessions = new Map();
const MAX_TRACKED_CLIENTS = 10000;

/**
 * 取得或建立 session 記錄
 */
function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      timestamps: [],
      violations: 0,
      mutedUntil: 0,
      connectedAt: Date.now(),
    });
    while (sessions.size > MAX_TRACKED_CLIENTS) sessions.delete(sessions.keys().next().value);
  }
  return sessions.get(sessionId);
}

/**
 * 註冊連線（記錄連線時間）
 * @param {string} sessionId - 連線識別碼
 */
function registerConnection(sessionId) {
  const session = getSession(sessionId);
  session.connectedAt = Date.now();
  session.timestamps = [];
  session.violations = 0;
  session.mutedUntil = 0;
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
 * 檢查速率限制
 * @param {string} sessionId - 連線識別碼
 * @param {number} connectedAt - 連線時間戳
 * @returns {{ allowed: boolean, cooldownMs?: number, reason?: string }}
 */
function checkRate(sessionId, connectedAt) {
  const now = Date.now();
  const session = getSession(sessionId);

  // 更新連線時間（如果外部傳入）
  if (connectedAt) {
    session.connectedAt = connectedAt;
  }

  // 檢查是否在 mute 期間
  if (session.mutedUntil > now) {
    return {
      allowed: false,
      cooldownMs: session.mutedUntil - now,
      reason: '您已被靜音，請稍後再試',
    };
  }

  // 清理過期時間戳
  pruneTimestamps(session, now);

  // 檢查是否超過速率限制
  if (session.timestamps.length >= MAX_MESSAGES) {
    session.violations++;

    // 取得懲罰等級
    const penaltyIndex = Math.min(session.violations - 1, PENALTIES.length - 1);
    let cooldownMs = PENALTIES[penaltyIndex];

    // 新連線保護：connectedAt 後 3 秒內首發 → 冷卻加倍
    const timeSinceConnect = now - session.connectedAt;
    if (timeSinceConnect < NEW_CONN_PROTECT_MS) {
      cooldownMs *= 2;
    }

    // 第 4 次以上 → mute
    if (session.violations >= 4) {
      session.mutedUntil = now + cooldownMs;
      return {
        allowed: false,
        cooldownMs,
        reason: '發送過於頻繁，已靜音 5 分鐘',
      };
    }

    return {
      allowed: false,
      cooldownMs,
      reason: '發送過於頻繁，請稍後再試',
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

class StableRateLimiter {
  constructor({ now = Date.now, maxEntries = 10_000 } = {}) {
    this.now = now;
    this.maxEntries = maxEntries;
    this.clients = new Map();
  }

  _get(clientId) {
    let entry = this.clients.get(clientId);
    if (!entry) entry = { timestamps: [], violations: 0, cooldownUntil: 0, mutedUntil: 0, touchedAt: this.now() };
    entry.touchedAt = this.now();
    this.clients.delete(clientId);
    this.clients.set(clientId, entry);
    while (this.clients.size > this.maxEntries) this.clients.delete(this.clients.keys().next().value);
    return entry;
  }

  check(clientId) {
    const now = this.now();
    const entry = this._get(clientId);
    if (entry.mutedUntil > now) {
      return { allowed: false, code: 'MUTED', retryAfterMs: entry.mutedUntil - now };
    }
    if (entry.cooldownUntil > now) {
      return { allowed: false, code: 'RATE_LIMITED', retryAfterMs: entry.cooldownUntil - now };
    }
    if (entry.cooldownUntil) entry.cooldownUntil = 0;
    entry.timestamps = entry.timestamps.filter((timestamp) => now - timestamp < WINDOW_MS);
    if (entry.timestamps.length >= MAX_MESSAGES) {
      entry.violations += 1;
      const retryAfterMs = PENALTIES[Math.min(entry.violations - 1, PENALTIES.length - 1)];
      entry.timestamps = [];
      if (entry.violations >= 4) {
        entry.mutedUntil = now + retryAfterMs;
        return { allowed: false, code: 'MUTED', retryAfterMs };
      }
      entry.cooldownUntil = now + retryAfterMs;
      return { allowed: false, code: 'RATE_LIMITED', retryAfterMs };
    }
    entry.timestamps.push(now);
    return { allowed: true };
  }

  disconnect() {
    // Deliberately preserve state: reconnecting with the same stable clientId
    // must not reset rate limits or mute penalties.
  }

  cleanup(maxIdleMs = 600_000) {
    const now = this.now();
    for (const [key, entry] of this.clients) {
      if (entry.mutedUntil <= now && entry.cooldownUntil <= now && now - entry.touchedAt > maxIdleMs) this.clients.delete(key);
    }
  }

  get size() { return this.clients.size; }
}

module.exports = {
  checkRate,
  registerConnection,
  cleanup,
  reset,
  StableRateLimiter,
  // 暴露常數供測試
  WINDOW_MS,
  MAX_MESSAGES,
  NEW_CONN_PROTECT_MS,
  PENALTIES,
};
