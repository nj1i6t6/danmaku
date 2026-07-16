'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalize } = require('../protection/normalize');

test('normalize: 全形數字轉半形', () => {
  assert.strictEqual(normalize('１２３４５'), '12345');
  assert.strictEqual(normalize('００９９'), '0099');
});

test('normalize: 全形英文字母轉半形並轉小寫', () => {
  assert.strictEqual(normalize('ＡＢＣ'), 'abc');
  assert.strictEqual(normalize('ＸＹＺ'), 'xyz');
});

test('normalize: 混合全形半形', () => {
  assert.strictEqual(normalize('ＡＢＣ１２３'), 'abc123');
});

test('normalize: 去零寬字符', () => {
  assert.strictEqual(normalize('hello\u200bworld'), 'helloworld');
  assert.strictEqual(normalize('test\u200c\u200d'), 'test');
  assert.strictEqual(normalize('\ufeffabc\u2060'), 'abc');
});

test('normalize: 去多餘空白', () => {
  assert.strictEqual(normalize('  hello  world  '), 'hello world');
  assert.strictEqual(normalize('a    b     c'), 'a b c');
  assert.strictEqual(normalize('  空白  測試  '), '空白 測試');
});

test('normalize: 英文字母統一轉小寫', () => {
  assert.strictEqual(normalize('HelloWorld'), 'helloworld');
  assert.strictEqual(normalize('ABCDEF'), 'abcdef');
});

test('normalize: 空字串', () => {
  assert.strictEqual(normalize(''), '');
});

test('normalize: 非字串輸入', () => {
  assert.strictEqual(normalize(null), '');
  assert.strictEqual(normalize(undefined), '');
  assert.strictEqual(normalize(123), '');
});

test('normalize: 保留中文字', () => {
  assert.strictEqual(normalize('台灣加權指數'), '台灣加權指數');
});

test('normalize: 綜合測試', () => {
  const input = 'Ａ\u200bＢＣ  １２３  ＷＷＷ.   ＣＯＭ';
  const result = normalize(input);
  assert.strictEqual(result, 'abc 123 www. com');
});
