'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkContent, detectURL, detectContact, detectProfanity, collapseRepeatedChars } = require('../protection/contentFilter');

test('contentFilter: 一般數字訊息放行', () => {
  const result = checkContent('2330 救我');
  assert.strictEqual(result.action, 'pass');
});

test('contentFilter: 文字加數字放行', () => {
  const result = checkContent('活動編號 18000');
  assert.strictEqual(result.action, 'pass');
});

test('contentFilter: 數量描述放行', () => {
  const result = checkContent('還有 120 位');
  assert.strictEqual(result.action, 'pass');
});

test('contentFilter: 一般文字放行', () => {
  const result = checkContent('今天活動氣氛很好');
  assert.strictEqual(result.action, 'pass');
});

test('contentFilter: URL shadow drop — http', () => {
  const result = checkContent('請看 http://example.com');
  assert.strictEqual(result.action, 'shadow_drop');
  assert.strictEqual(result.reason, '包含連結');
});

test('contentFilter: URL shadow drop — https', () => {
  const result = checkContent('https://example.com 賺錢');
  assert.strictEqual(result.action, 'shadow_drop');
});

test('contentFilter: URL shadow drop — www', () => {
  const result = checkContent('請看 www.example.com');
  assert.strictEqual(result.action, 'shadow_drop');
});

test('contentFilter: URL shadow drop — 短網址 bit.ly', () => {
  const result = checkContent('bit.ly/abc123');
  assert.strictEqual(result.action, 'shadow_drop');
});

test('contentFilter: URL shadow drop — 短網址 tinyurl', () => {
  const result = checkContent('tinyurl.com/test');
  assert.strictEqual(result.action, 'shadow_drop');
});

test('contentFilter: 聯繫方式 shadow drop — 加我 LINE + ID', () => {
  const result = checkContent('加我 line abc123');
  assert.strictEqual(result.action, 'shadow_drop');
  assert.strictEqual(result.reason, '包含聯繫方式');
});

test('contentFilter: 聯繫方式 shadow drop — 賴 + @帳號', () => {
  const result = checkContent('賴 @abc123');
  assert.strictEqual(result.action, 'shadow_drop');
});

test('contentFilter: 聯繫方式 shadow drop — 手機號碼 + 加我', () => {
  const result = checkContent('0988776666 加我');
  assert.strictEqual(result.action, 'shadow_drop');
});

test('contentFilter: 聯繫方式 shadow drop — tg + @帳號', () => {
  const result = checkContent('tg @123ado');
  assert.strictEqual(result.action, 'shadow_drop');
});

test('contentFilter: 聯繫方式 shadow drop — 加賴 + 手機號碼', () => {
  const result = checkContent('加賴 0988776666');
  assert.strictEqual(result.action, 'shadow_drop');
});

test('contentFilter: 聯繫方式 shadow drop — email + 上下文', () => {
  const result = checkContent('私訊 test@example.com');
  assert.strictEqual(result.action, 'shadow_drop');
});

test('contentFilter: 辱罵 reject', () => {
  const result = checkContent('你這個白痴');
  assert.strictEqual(result.action, 'reject');
  assert.strictEqual(result.reason, '這句可能不雅，請修改');
});

test('contentFilter: 辱罵 reject — 幹', () => {
  const result = checkContent('幹');
  assert.strictEqual(result.action, 'reject');
});

test('contentFilter: 辱罵 reject — fuck', () => {
  const result = checkContent('fuck you');
  assert.strictEqual(result.action, 'reject');
});

test('contentFilter: 辱罵 reject — 廢物', () => {
  const result = checkContent('你是廢物嗎');
  assert.strictEqual(result.action, 'reject');
});

test('contentFilter: 重複字元灌水縮短到 10 個', () => {
  const result = checkContent('啊啊啊啊啊啊啊啊啊啊啊啊啊啊');
  assert.strictEqual(result.action, 'pass');
  assert.strictEqual(result.cleanedText, '啊'.repeat(10));
});

test('contentFilter: 重複字元不超過 10 不縮短', () => {
  const result = checkContent('哈哈哈哈哈哈哈哈哈哈');
  assert.strictEqual(result.action, 'pass');
  assert.strictEqual(result.cleanedText, '哈哈哈哈哈哈哈哈哈哈');
});

test('contentFilter: detectURL 函數', () => {
  assert.strictEqual(detectURL('http://test.com'), true);
  assert.strictEqual(detectURL('https://test.com'), true);
  assert.strictEqual(detectURL('www.test.com'), true);
  assert.strictEqual(detectURL('bit.ly/test'), true);
  assert.strictEqual(detectURL('普通文字'), false);
});

test('contentFilter: detectContact 函數', () => {
  assert.strictEqual(detectContact('加我 line abc123'), true);
  assert.strictEqual(detectContact('0988776666 加我'), true);
  assert.strictEqual(detectContact('2330 救我'), false);
  assert.strictEqual(detectContact('大盤 18000'), false);
});

test('contentFilter: detectProfanity 函數', () => {
  assert.strictEqual(detectProfanity('白痴'), true);
  assert.strictEqual(detectProfanity('正常文字'), false);
});

test('contentFilter: collapseRepeatedChars 函數', () => {
  assert.strictEqual(collapseRepeatedChars('啊啊啊啊啊啊啊啊啊啊啊啊啊'), '啊'.repeat(10));
  assert.strictEqual(collapseRepeatedChars('哈哈哈'), '哈哈哈');
});
