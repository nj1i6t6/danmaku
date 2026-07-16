'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const protection = require('../protection');
const rateLimiter = require('../protection/rateLimiter');
const { reset: resetDedup } = require('../protection/dedup');
const { reset: resetReport } = require('../protection/reportLimiter');

test('index: 應 export 所有必要函數', () => {
  assert.strictEqual(typeof protection.normalize, 'function');
  assert.strictEqual(typeof protection.checkBarrage, 'function');
  assert.strictEqual(typeof protection.checkNickname, 'function');
  assert.strictEqual(typeof protection.checkReport, 'function');
  assert.strictEqual(typeof protection.validateColor, 'function');
});

test('index: normalize 正規化', () => {
  assert.strictEqual(protection.normalize('ＡＢＣ１２３'), 'abc123');
});

test('index: checkBarrage 正常放行', () => {
  rateLimiter.reset();
  resetDedup();
  const result = protection.checkBarrage({
    socket: { id: 'test-socket-1' },
    text: '今天大盤漲',
    nickname: '小明',
    color: '#ff6600',
    room: 'room1',
    sessionState: { sessionId: 'test-socket-1', connectedAt: Date.now() },
  });
  assert.strictEqual(result.action, 'pass');
  assert.strictEqual(result.cleanedText, '今天大盤漲');
});

test('index: checkBarrage URL shadow drop', () => {
  rateLimiter.reset();
  resetDedup();
  const result = protection.checkBarrage({
    socket: { id: 'test-socket-2' },
    text: '請看 http://example.com',
    nickname: '小明',
    color: '#ff6600',
    room: 'room1',
    sessionState: { sessionId: 'test-socket-2', connectedAt: Date.now() },
  });
  assert.strictEqual(result.action, 'shadow_drop');
});

test('index: checkBarrage 辱罵 reject', () => {
  rateLimiter.reset();
  resetDedup();
  const result = protection.checkBarrage({
    socket: { id: 'test-socket-3' },
    text: '白痴',
    nickname: '小明',
    color: '#ff6600',
    room: 'room1',
    sessionState: { sessionId: 'test-socket-3', connectedAt: Date.now() },
  });
  assert.strictEqual(result.action, 'reject');
  assert.strictEqual(result.reason, '這句可能不雅，請修改');
});

test('index: checkBarrage 超速 cooldown', () => {
  rateLimiter.reset();
  resetDedup();
  const sessionId = 'test-socket-4';
  const sessionState = { sessionId, connectedAt: Date.now() };

  // 發 5 則填滿窗口
  for (let i = 0; i < 5; i++) {
    protection.checkBarrage({
      socket: { id: sessionId },
      text: `測試${i}`,
      room: 'room1',
      sessionState,
    });
  }

  // 第 6 則超速
  const result = protection.checkBarrage({
    socket: { id: sessionId },
    text: '超速了',
    room: 'room1',
    sessionState,
  });
  assert.strictEqual(result.action, 'cooldown');
  assert.ok(result.cooldownMs > 0);
});

test('index: checkBarrage 聯繫方式 shadow drop', () => {
  rateLimiter.reset();
  resetDedup();
  const result = protection.checkBarrage({
    socket: { id: 'test-socket-5' },
    text: '加我 line abc123',
    nickname: '小明',
    color: '#ff6600',
    room: 'room1',
    sessionState: { sessionId: 'test-socket-5', connectedAt: Date.now() },
  });
  assert.strictEqual(result.action, 'shadow_drop');
});

test('index: checkBarrage 空文字 reject', () => {
  rateLimiter.reset();
  resetDedup();
  const result = protection.checkBarrage({
    socket: { id: 'test-socket-6' },
    text: '',
    room: 'room1',
    sessionState: { sessionId: 'test-socket-6', connectedAt: Date.now() },
  });
  assert.strictEqual(result.action, 'reject');
});

test('index: checkNickname 介面', () => {
  const result = protection.checkNickname('小明');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.cleaned, '小明');
});

test('index: checkReport 介面', () => {
  resetReport();
  const result = protection.checkReport('test-session');
  assert.strictEqual(result.allowed, true);
});

test('index: validateColor 介面', () => {
  assert.strictEqual(protection.validateColor('#ff6600'), '#ff6600');
  assert.strictEqual(protection.validateColor('invalid'), null);
});

test('index: checkBarrage 只回傳已驗證的顏色', () => {
  rateLimiter.reset();
  resetDedup();
  const result = protection.checkBarrage({
    socket: { id: 'test-color-sanitization' },
    text: '顏色驗證測試',
    nickname: '小明',
    color: 'red\" onmouseover=\"alert(1)',
    room: 'room-color',
    sessionState: { sessionId: 'test-color-sanitization', connectedAt: Date.now() },
  });

  assert.strictEqual(result.action, 'pass');
  assert.strictEqual(result.cleanedColor, '#e6edf3');
});

test('index: checkBarrage 拒絕不合規暱稱並回傳清理後暱稱', () => {
  rateLimiter.reset();
  resetDedup();
  const rejected = protection.checkBarrage({
    socket: { id: 'test-nickname-rejection' },
    text: '暱稱驗證測試',
    nickname: '超過六個字的暱稱',
    color: '#ff6600',
    room: 'room-nickname',
    sessionState: { sessionId: 'test-nickname-rejection', connectedAt: Date.now() },
  });
  assert.strictEqual(rejected.action, 'reject');
  assert.match(rejected.reason, /暱稱/);

  rateLimiter.reset();
  resetDedup();
  const accepted = protection.checkBarrage({
    socket: { id: 'test-nickname-cleaning' },
    text: '匿名驗證測試',
    nickname: '   ',
    color: '#ff6600',
    room: 'room-nickname',
    sessionState: { sessionId: 'test-nickname-cleaning', connectedAt: Date.now() },
  });
  assert.strictEqual(accepted.action, 'pass');
  assert.strictEqual(accepted.cleanedNickname, '匿名');
});
