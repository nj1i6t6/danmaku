'use strict';

/**
 * 暱稱驗證模組
 * - 最多 6 字（中文算 1 字）
 * - 過 contentFilter（辱罵、URL、聯繫方式）
 * - 空字串或全空白 → 退回「匿名」
 * - 正規化後檢查
 */

const { normalize } = require('./normalize');
const { checkContent } = require('./contentFilter');

const MAX_NICKNAME_LENGTH = 6;
const DEFAULT_NICKNAME = '匿名';

/**
 * 驗證暱稱
 * @param {string} text - 原始暱稱文字
 * @returns {{ valid: boolean, reason?: string, cleaned?: string }}
 */
function checkNickname(text) {
  // 空字串或全空白 → 退回「匿名」
  if (!text || text.trim().length === 0) {
    return { valid: true, cleaned: DEFAULT_NICKNAME };
  }

  // 正規化
  const normalized = normalize(text);

  // 正規化後空字串 → 退回「匿名」
  if (normalized.length === 0) {
    return { valid: true, cleaned: DEFAULT_NICKNAME };
  }

  // 顯示名稱只當純文字使用；拒絕可形成 HTML/XML 標記或控制序列的字元。
  if (/[<>&\u0000-\u001F\u007F]/u.test(normalized)) {
    return { valid: false, reason: '暱稱包含不允許的字元' };
  }

  // 長度檢查：最多 6 字
  if (normalized.length > MAX_NICKNAME_LENGTH) {
    return { valid: false, reason: '暱稱過長，最多 6 字' };
  }

  // 內容過濾檢查（辱罵、URL、聯繫方式）
  const contentResult = checkContent(normalized);
  if (contentResult.action === 'shadow_drop') {
    return { valid: false, reason: '暱稱包含不當內容' };
  }
  if (contentResult.action === 'reject') {
    return { valid: false, reason: contentResult.reason };
  }

  return { valid: true, cleaned: contentResult.cleanedText || normalized };
}

module.exports = {
  checkNickname,
  MAX_NICKNAME_LENGTH,
  DEFAULT_NICKNAME,
};
