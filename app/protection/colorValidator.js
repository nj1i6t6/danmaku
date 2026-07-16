'use strict';

/**
 * 顏色驗證模組
 * - 驗證合法 hex：/^#[0-9a-fA-F]{6}$/
 * - 非法 → return null（前端用隨機色）
 * - 最低亮度檢查：相對亮度 < 0.15 → 自動提亮到 0.15
 */

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;
const MIN_BRIGHTNESS = 0.15;

/**
 * 計算相對亮度
 * 公式：(0.299*R + 0.587*G + 0.114*B) / 255
 * @param {number} r - 紅色 0~255
 * @param {number} g - 綠色 0~255
 * @param {number} b - 藍色 0~255
 * @returns {number} 0~1
 */
function relativeBrightness(r, g, b) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * 將顏色提亮到最低亮度
 * 等比例放大 RGB 值，直到亮度達到 MIN_BRIGHTNESS
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {{ r: number, g: number, b: number }}
 */
function brighten(r, g, b) {
  const brightness = relativeBrightness(r, g, b);
  if (brightness >= MIN_BRIGHTNESS) {
    return { r, g, b };
  }

  // 計算需要放大的比例
  // 目標亮度 = MIN_BRIGHTNESS * 255
  // 當前亮度 = (0.299*r + 0.587*g + 0.114*b)
  // 放大比例 = 目標亮度 / 當前亮度
  const currentLuma = 0.299 * r + 0.587 * g + 0.114 * b;
  const targetLuma = MIN_BRIGHTNESS * 255;

  if (currentLuma === 0) {
    // 全黑 → 用最小亮度的灰色
    const minVal = Math.round(targetLuma / (0.299 + 0.587 + 0.114));
    return { r: minVal, g: minVal, b: minVal };
  }

  const scale = targetLuma / currentLuma;
  return {
    r: Math.min(255, Math.round(r * scale)),
    g: Math.min(255, Math.round(g * scale)),
    b: Math.min(255, Math.round(b * scale)),
  };
}

/**
 * 驗證顏色
 * @param {string} hex - hex 色碼（如 "#ff6600"）
 * @returns {string|null} 驗證後的 hex 或 null
 */
function validateColor(hex) {
  if (!hex || typeof hex !== 'string') return null;

  // 驗證 hex 格式
  if (!HEX_PATTERN.test(hex)) return null;

  // 解析 RGB 值
  const r = parseInt(hex.substring(1, 3), 16);
  const g = parseInt(hex.substring(3, 5), 16);
  const b = parseInt(hex.substring(5, 7), 16);

  // 亮度檢查
  const brightness = relativeBrightness(r, g, b);
  if (brightness < MIN_BRIGHTNESS) {
    // 自動提亮
    const adjusted = brighten(r, g, b);
    const toHex = (v) => v.toString(16).padStart(2, '0');
    return '#' + toHex(adjusted.r) + toHex(adjusted.g) + toHex(adjusted.b);
  }

  // 回傳小寫 hex
  return hex.toLowerCase();
}

module.exports = {
  validateColor,
  relativeBrightness,
  brighten,
  MIN_BRIGHTNESS,
};
