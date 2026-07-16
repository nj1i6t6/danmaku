'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const rateLimiter = require('../protection/rateLimiter');

test('rateLimiter: 正常速率放行', () => {
  rateLimiter.reset();
  const sessionId = 'test-normal-1';

  // 5 則以內應該都放行
  for (let i = 0; i < 5; i++) {
    const result = rateLimiter.checkRate(sessionId, Date.now());
    assert.strictEqual(result.allowed, true, `第 ${i + 1} 則應放行`);
  }
});

test('rateLimiter: 超速第 1 次冷卻 3000ms', () => {
  rateLimiter.reset();
  const sessionId = 'test-over1';
  // 用較早的 connectedAt 避開新連線保護加倍
  const connectedAt = Date.now() - 10000;

  // 發 5 則填滿窗口
  for (let i = 0; i < 5; i++) {
    rateLimiter.checkRate(sessionId, connectedAt);
  }

  // 第 6 則超速
  const result = rateLimiter.checkRate(sessionId, connectedAt);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.cooldownMs, 3000);
});

test('rateLimiter: 超速第 2 次冷卻 10000ms', () => {
  rateLimiter.reset();
  const sessionId = 'test-over2';
  const connectedAt = Date.now() - 10000;

  for (let i = 0; i < 5; i++) {
    rateLimiter.checkRate(sessionId, connectedAt);
  }

  // 第 1 次超速
  rateLimiter.checkRate(sessionId, connectedAt);
  // 第 2 次超速
  const result = rateLimiter.checkRate(sessionId, connectedAt);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.cooldownMs, 10000);
});

test('rateLimiter: 超速第 3 次冷卻 30000ms', () => {
  rateLimiter.reset();
  const sessionId = 'test-over3';
  const connectedAt = Date.now() - 10000;

  for (let i = 0; i < 5; i++) {
    rateLimiter.checkRate(sessionId, connectedAt);
  }

  rateLimiter.checkRate(sessionId, connectedAt);
  rateLimiter.checkRate(sessionId, connectedAt);
  const result = rateLimiter.checkRate(sessionId, connectedAt);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.cooldownMs, 30000);
});

test('rateLimiter: 超速第 4 次 mute 300000ms', () => {
  rateLimiter.reset();
  const sessionId = 'test-over4';
  const connectedAt = Date.now() - 10000;

  for (let i = 0; i < 5; i++) {
    rateLimiter.checkRate(sessionId, connectedAt);
  }

  rateLimiter.checkRate(sessionId, connectedAt);
  rateLimiter.checkRate(sessionId, connectedAt);
  rateLimiter.checkRate(sessionId, connectedAt);
  const result = rateLimiter.checkRate(sessionId, connectedAt);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.cooldownMs, 300000);
});

test('rateLimiter: 新連線保護 — 3 秒內首發冷卻加倍', () => {
  rateLimiter.reset();
  const sessionId = 'test-newconn';
  const connectedAt = Date.now();

  // 發 5 則填滿窗口（都在新連線保護期內）
  for (let i = 0; i < 5; i++) {
    rateLimiter.checkRate(sessionId, connectedAt);
  }

  // 第 6 則超速，在新連線保護期內 → 冷卻加倍 (3000*2=6000)
  const result = rateLimiter.checkRate(sessionId, connectedAt);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.cooldownMs, 6000);
});

test('rateLimiter: registerConnection 記錄連線時間', () => {
  rateLimiter.reset();
  const sessionId = 'test-register';

  rateLimiter.registerConnection(sessionId);
  // 應該能正常發送
  const result = rateLimiter.checkRate(sessionId, Date.now());
  assert.strictEqual(result.allowed, true);
});

test('rateLimiter: cleanup 清除 session', () => {
  rateLimiter.reset();
  const sessionId = 'test-cleanup';

  rateLimiter.registerConnection(sessionId);
  rateLimiter.cleanup(sessionId);

  // 清除後重新使用應該重置
  const result = rateLimiter.checkRate(sessionId, Date.now());
  assert.strictEqual(result.allowed, true);
});

test('rateLimiter: 不同 session 互不影響', () => {
  rateLimiter.reset();
  const sessionA = 'test-a';
  const sessionB = 'test-b';

  for (let i = 0; i < 5; i++) {
    rateLimiter.checkRate(sessionA, Date.now());
  }

  // sessionB 不受 sessionA 超速影響
  const result = rateLimiter.checkRate(sessionB, Date.now());
  assert.strictEqual(result.allowed, true);
});
