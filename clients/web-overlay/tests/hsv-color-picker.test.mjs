import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createColorDraft,
  hexToHsv,
  hsvToHex,
  hsvToRgb,
  rgbToHsv,
} from '../src/core/hsv-color-picker.js';

test('HSV、RGB 與 HEX 在邊界值可穩定往返', () => {
  assert.deepEqual(hsvToRgb({ h: 0, s: 1, v: 1 }), { r: 255, g: 0, b: 0 });
  assert.deepEqual(hsvToRgb({ h: 120, s: 1, v: 1 }), { r: 0, g: 255, b: 0 });
  assert.deepEqual(hsvToRgb({ h: 240, s: 1, v: 1 }), { r: 0, g: 0, b: 255 });
  assert.equal(hsvToHex({ h: 360, s: 1, v: 1 }), '#FF0000');
  assert.deepEqual(hexToHsv('#808080'), { h: 0, s: 0, v: 0.502 });
  assert.deepEqual(rgbToHsv({ r: 88, g: 166, b: 255 }), { h: 212, s: 0.655, v: 1 });
  assert.equal(hsvToHex(hexToHsv('#58A6FF')), '#58A6FF');
});

test('預覽不持久化，取消回復 committed 值，套用才 commit', () => {
  const committed = [];
  const draft = createColorDraft('#58A6FF', (value) => committed.push(value));
  assert.equal(draft.preview({ h: 0, s: 1, v: 1 }), '#FF0000');
  assert.deepEqual(committed, []);
  assert.equal(draft.cancel(), '#58A6FF');
  assert.deepEqual(committed, []);
  draft.preview({ h: 120, s: 1, v: 1 });
  assert.equal(draft.apply(), '#00FF00');
  assert.deepEqual(committed, ['#00FF00']);
  assert.equal(draft.cancel(), '#00FF00');
});
