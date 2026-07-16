'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkNickname } = require('../protection/nickname');

test('nickname: 正常暱稱通過', () => {
  const result = checkNickname('小明');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.cleaned, '小明');
});

test('nickname: 6 字以內通過', () => {
  const result = checkNickname('六個字暱稱');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.cleaned, '六個字暱稱');
});

test('nickname: 超過 6 字不通過', () => {
  const result = checkNickname('這是一個超過六個字的暱稱');
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason);
});

test('nickname: 空字串退回匿名', () => {
  const result = checkNickname('');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.cleaned, '匿名');
});

test('nickname: 全空白退回匿名', () => {
  const result = checkNickname('   ');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.cleaned, '匿名');
});

test('nickname: null 退回匿名', () => {
  const result = checkNickname(null);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.cleaned, '匿名');
});

test('nickname: 含 URL 不通過', () => {
  const result = checkNickname('http://test.com');
  assert.strictEqual(result.valid, false);
});

test('nickname: 含辱罵不通過', () => {
  const result = checkNickname('白痴');
  assert.strictEqual(result.valid, false);
});

test('nickname: 含聯繫方式不通過', () => {
  const result = checkNickname('加我line123');
  assert.strictEqual(result.valid, false);
});

test('nickname: 正規化後檢查（全形轉半形）', () => {
  const result = checkNickname('ＡＢＣ');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.cleaned, 'abc');
});

test('nickname: 拒絕 HTML/XSS 標記字元', () => {
  const result = checkNickname('<img>');
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /字元|暱稱/);
});
