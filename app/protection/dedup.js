'use strict';

/**
 * 跨 session 查重模組
 * - Ring buffer 存最近 50 則彈幕
 * - 跨 session：10 秒內不同 session 發一模一樣的正規化文字 → shadow drop
 * - 同 session：30 秒內相似度過高（Jaccard similarity > 0.8）→ cooldown
 * - 每個 room 獨立的 buffer
 */

const BUFFER_SIZE = 50;           // Ring buffer 大小
const MAX_ROOM_BUFFERS = 2000;    // process-wide LRU cap
const CROSS_SESSION_MS = 10000;   // 跨 session 查重時間窗口 10 秒
const SAME_SESSION_MS = 30000;    // 同 session 查重時間窗口 30 秒
const SIMILARITY_THRESHOLD = 0.8; // Jaccard 相似度閾值

// 每個 room 獨立的 buffer
// Map<room, Array<{ sessionId, text, hash, timestamp }>>
const roomBuffers = new Map();

/**
 * 簡易字串 hash 函數
 * @param {string} str
 * @returns {number}
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // 轉為 32bit 整數
  }
  return hash;
}

/**
 * 取得指定 room 的 buffer
 * @param {string} room
 * @returns {Array}
 */
function getBuffer(room) {
  const current = roomBuffers.get(room);
  if (current) {
    roomBuffers.delete(room);
    roomBuffers.set(room, current);
    return current;
  }
  const buffer = [];
  roomBuffers.set(room, buffer);
  while (roomBuffers.size > MAX_ROOM_BUFFERS) roomBuffers.delete(roomBuffers.keys().next().value);
  return buffer;
}

function removeRoom(room) {
  return roomBuffers.delete(room);
}

function roomBufferCount() {
  return roomBuffers.size;
}

/**
 * 計算 Jaccard 相似度
 * 使用 bigram 集合計算交集/聯集比例
 * @param {string} a
 * @param {string} b
 * @returns {number} 0~1
 */
function jaccardSimilarity(a, b) {
  if (a === b) return 1.0;
  if (a.length < 2 || b.length < 2) {
    // 字串太短時直接比較是否相同
    return a === b ? 1.0 : 0.0;
  }

  // 建立 bigram 集合
  const setA = new Set();
  for (let i = 0; i < a.length - 1; i++) {
    setA.add(a.substring(i, i + 2));
  }

  const setB = new Set();
  for (let i = 0; i < b.length - 1; i++) {
    setB.add(b.substring(i, i + 2));
  }

  // 計算交集
  let intersection = 0;
  for (const bigram of setA) {
    if (setB.has(bigram)) intersection++;
  }

  // 聯集 = |A| + |B| - |A∩B|
  const union = setA.size + setB.size - intersection;

  if (union === 0) return 1.0;
  return intersection / union;
}

/**
 * 檢查重複
 * @param {string} sessionId - 連線識別碼
 * @param {string} normalizedText - 正規化後的文字
 * @param {string} room - 房間
 * @returns {{ action: 'pass'|'shadow_drop'|'cooldown' }}
 */
function checkDuplicate(sessionId, normalizedText, room) {
  const buffer = getBuffer(room);
  const now = Date.now();
  const textHash = simpleHash(normalizedText);

  // 跨 session 查重：10 秒內不同 session 發一模一樣的文字
  for (const entry of buffer) {
    const age = now - entry.timestamp;
    if (age > CROSS_SESSION_MS) continue;

    if (entry.sessionId !== sessionId && entry.hash === textHash && entry.text === normalizedText) {
      return { action: 'shadow_drop' };
    }
  }

  // 同 session 查重：30 秒內相似度過高
  for (const entry of buffer) {
    const age = now - entry.timestamp;
    if (age > SAME_SESSION_MS) continue;

    if (entry.sessionId === sessionId) {
      const similarity = jaccardSimilarity(normalizedText, entry.text);
      if (similarity > SIMILARITY_THRESHOLD) {
        return { action: 'cooldown' };
      }
    }
  }

  return { action: 'pass' };
}

/**
 * 將彈幕加入 buffer
 * @param {string} sessionId - 連線識別碼
 * @param {string} normalizedText - 正規化後的文字
 * @param {string} room - 房間
 */
function addToBuffer(sessionId, normalizedText, room) {
  const buffer = getBuffer(room);
  const entry = {
    sessionId,
    text: normalizedText,
    hash: simpleHash(normalizedText),
    timestamp: Date.now(),
  };

  buffer.push(entry);

  // 維持 ring buffer 大小
  if (buffer.length > BUFFER_SIZE) {
    buffer.shift();
  }
}

/**
 * 重設所有資料（測試用）
 */
function reset() {
  roomBuffers.clear();
}

module.exports = {
  checkDuplicate,
  addToBuffer,
  jaccardSimilarity,
  simpleHash,
  removeRoom,
  roomBufferCount,
  reset,
  BUFFER_SIZE,
  MAX_ROOM_BUFFERS,
  CROSS_SESSION_MS,
  SAME_SESSION_MS,
  SIMILARITY_THRESHOLD,
};
