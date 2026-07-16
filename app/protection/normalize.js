'use strict';

/**
 * 正規化模組
 * - 全形→半形（數字、英文字母、符號）
 * - 去零寬字符
 * - 去多餘空白（中間多個合併成一個，頭尾 trim）
 * - 英文字母統一轉小寫
 */

// 零寬字符集合
const ZERO_WIDTH_CHARS = /[\u200b\u200c\u200d\ufeff\u2060]/g;

/**
 * 將文字正規化
 * @param {string} text - 原始文字
 * @returns {string} 正規化後的文字
 */
function normalize(text) {
  if (typeof text !== 'string') return '';
  if (text.length === 0) return '';

  let result = text;

  // 1. 全形→半形：使用 NFKC 正規化
  // NFKC 會將全形數字（０-９）、全形英文字母（Ａ-Ｚ, ａ-ｚ）、全形符號轉為半形
  result = result.normalize('NFKC');

  // 2. 去零寬字符
  result = result.replace(ZERO_WIDTH_CHARS, '');

  // 3. 去多餘空白：中間多個空白合併成一個，頭尾 trim
  result = result.replace(/\s+/g, ' ').trim();

  // 4. 英文字母統一轉小寫
  result = result.toLowerCase();

  return result;
}

module.exports = { normalize };
