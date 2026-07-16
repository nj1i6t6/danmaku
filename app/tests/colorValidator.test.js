'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateColor, relativeBrightness, brighten, MIN_BRIGHTNESS } = require('../protection/colorValidator');

test('colorValidator: 合法 hex 回傳小寫', () => {
  const result = validateColor('#FF6600');
  assert.strictEqual(result, '#ff6600');
});

test('colorValidator: 合法 hex 小寫輸入', () => {
  const result = validateColor('#aabbcc');
  assert.strictEqual(result, '#aabbcc');
});

test('colorValidator: 非法格式回傳 null', () => {
  assert.strictEqual(validateColor('ff6600'), null);   // 缺 #
  assert.strictEqual(validateColor('#ff660'), null);    // 太短
  assert.strictEqual(validateColor('#ff66000'), null);  // 太長
  assert.strictEqual(validateColor('#gg6600'), null);   // 非法字元
});

test('colorValidator: null 輸入回傳 null', () => {
  assert.strictEqual(validateColor(null), null);
  assert.strictEqual(validateColor(undefined), null);
});

test('colorValidator: 空字串回傳 null', () => {
  assert.strictEqual(validateColor(''), null);
});

test('colorValidator: 太暗的顏色自動提亮', () => {
  // #000000 純黑 → 應提亮
  const result = validateColor('#000000');
  assert.ok(result !== null, '不應為 null');
  assert.ok(result.startsWith('#'), '應為 hex 格式');

  // 驗證提亮後的亮度 >= MIN_BRIGHTNESS
  const r = parseInt(result.substring(1, 3), 16);
  const g = parseInt(result.substring(3, 5), 16);
  const b = parseInt(result.substring(5, 7), 16);
  const brightness = relativeBrightness(r, g, b);
  assert.ok(brightness >= MIN_BRIGHTNESS - 0.01, `亮度應 >= ${MIN_BRIGHTNESS}，實際: ${brightness}`);
});

test('colorValidator: 暗灰色自動提亮', () => {
  // #111111 非常暗
  const result = validateColor('#111111');
  assert.ok(result !== null);
  const r = parseInt(result.substring(1, 3), 16);
  const g = parseInt(result.substring(3, 5), 16);
  const b = parseInt(result.substring(5, 7), 16);
  const brightness = relativeBrightness(r, g, b);
  assert.ok(brightness >= MIN_BRIGHTNESS - 0.01, `提亮後亮度應 >= ${MIN_BRIGHTNESS}，實際: ${brightness}`);
});

test('colorValidator: 亮色不需提亮', () => {
  // #FFFFFF 純白 → 不需提亮
  const result = validateColor('#ffffff');
  assert.strictEqual(result, '#ffffff');
});

test('colorValidator: 中等亮度顏色不需提亮', () => {
  // #808080 中灰 → 亮度 0.502 > 0.15
  const result = validateColor('#808080');
  assert.strictEqual(result, '#808080');
});

test('colorValidator: relativeBrightness 函數', () => {
  // 純白 → 1.0
  assert.ok(Math.abs(relativeBrightness(255, 255, 255) - 1.0) < 0.001);
  // 純黑 → 0.0
  assert.ok(Math.abs(relativeBrightness(0, 0, 0) - 0.0) < 0.001);
});

test('colorValidator: brighten 函數', () => {
  // 已足夠亮 → 不變
  const bright = brighten(255, 255, 255);
  assert.strictEqual(bright.r, 255);
  assert.strictEqual(bright.g, 255);
  assert.strictEqual(bright.b, 255);

  // 全黑 → 提亮
  const dark = brighten(0, 0, 0);
  assert.ok(dark.r > 0);
  assert.ok(dark.g > 0);
  assert.ok(dark.b > 0);
});
