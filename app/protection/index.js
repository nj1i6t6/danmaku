'use strict';

/**
 * 彈幕防護規則模組 - 統一 export
 * 組合所有子模組，按處理流程順序執行檢查
 *
 * 處理流程：
 * 1. normalize(text) — 正規化文字
 * 2. checkNickname() / validateColor() — 清理使用者可控的顯示屬性
 * 3. rateLimiter.checkRate() — 速率限制檢查，超速就 return cooldown
 * 4. dedup.checkDuplicate() — 查重，相同就 return shadow_drop，相似就 return cooldown
 * 5. contentFilter.checkContent() — 內容過濾，URL/聯繫方式 shadow_drop，辱罵 reject
 * 6. 新連線保護（從 sessionState.connectedAt 判斷）
 * 7. 回傳結果
 */

const { normalize } = require('./normalize');
const rateLimiter = require('./rateLimiter');
const { checkDuplicate, addToBuffer } = require('./dedup');
const { checkContent } = require('./contentFilter');
const { checkNickname } = require('./nickname');
const { checkReport } = require('./reportLimiter');
const { validateColor } = require('./colorValidator');

/**
 * 檢查彈幕
 * @param {object} params
 * @param {object} params.socket - socket 物件（含 id）
 * @param {string} params.text - 彈幕文字
 * @param {string} params.nickname - 暱稱
 * @param {string} params.color - 顏色 hex
 * @param {string} params.room - 房間
 * @param {object} params.sessionState - 連線狀態 { sessionId, connectedAt }
 * @returns {{ action: 'pass'|'shadow_drop'|'reject'|'cooldown', reason?: string, cooldownMs?: number, cleanedText?: string }}
 */
function checkBarrage({ socket, text, nickname, color, room, sessionState, skipRateLimit = false }) {
  const sessionId = (sessionState && (sessionState.clientId || sessionState.sessionId)) || (socket && socket.id) || 'unknown';
  const connectedAt = (sessionState && sessionState.connectedAt) || Date.now();

  // 1. 正規化文字
  const normalizedText = normalize(text);

  // 空文字直接拒絕
  if (normalizedText.length === 0) {
    return { action: 'reject', reason: '內容為空' };
  }

  // 2. 清理顯示屬性。顏色不合法時使用安全預設值；暱稱不合法則拒絕。
  const nickResult = checkNickname(typeof nickname === 'string' ? nickname : '');
  if (!nickResult.valid) {
    return { action: 'reject', reason: nickResult.reason || '暱稱不符合規範' };
  }
  const cleanedNickname = nickResult.cleaned || '匿名';
  const cleanedColor = validateColor(color) || '#e6edf3';

  // 3. 速率限制檢查（新房間服務可注入 stable clientId limiter 並略過舊 singleton）
  if (!skipRateLimit) {
    const rateResult = rateLimiter.checkRate(sessionId, connectedAt);
    if (!rateResult.allowed) {
      return {
        action: 'cooldown',
        reason: rateResult.reason || '發送過於頻繁，請稍後再試',
        cooldownMs: rateResult.cooldownMs,
      };
    }
  }

  // 3. 查重
  const dedupResult = checkDuplicate(sessionId, normalizedText, room);
  if (dedupResult.action === 'shadow_drop') {
    return { action: 'shadow_drop', reason: '重複內容' };
  }
  if (dedupResult.action === 'cooldown') {
    // 相似內容 → cooldown 加倍
    // 取得基本冷卻時間
    const baseCooldown = 3000; // 基本冷卻 3 秒
    return {
      action: 'cooldown',
      reason: '內容過於相似，請稍後再試',
      cooldownMs: baseCooldown * 2,
    };
  }

  // 4. 內容過濾
  const contentResult = checkContent(normalizedText);
  if (contentResult.action === 'shadow_drop') {
    // shadow drop 時也加入 buffer（讓其他 session 查重能命中）
    addToBuffer(sessionId, normalizedText, room);
    return { action: 'shadow_drop', reason: contentResult.reason };
  }
  if (contentResult.action === 'reject') {
    return { action: 'reject', reason: contentResult.reason };
  }

  // 5. 通過所有檢查 → 加入 buffer 並回傳 pass
  const cleanedText = contentResult.cleanedText || normalizedText;
  addToBuffer(sessionId, cleanedText, room);

  return { action: 'pass', cleanedText, cleanedNickname, cleanedColor };
}

module.exports = {
  normalize,
  checkBarrage,
  checkNickname,
  checkReport,
  validateColor,
  // 子模組直接暴露（方便測試與外部使用）
  rateLimiter,
  contentFilter: require('./contentFilter'),
  dedup: require('./dedup'),
  reportLimiter: require('./reportLimiter'),
  colorValidator: require('./colorValidator'),
};
