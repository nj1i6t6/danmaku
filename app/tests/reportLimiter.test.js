'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkReport, reset } = require('../protection/reportLimiter');

test('reportLimiter: 3 次內允許', () => {
  reset();
  const sessionId = 'test-report-1';

  for (let i = 0; i < 3; i++) {
    const result = checkReport(sessionId);
    assert.strictEqual(result.allowed, true, `第 ${i + 1} 次應允許`);
  }
});

test('reportLimiter: 第 4 次冷卻 60 秒', () => {
  reset();
  const sessionId = 'test-report-2';

  for (let i = 0; i < 3; i++) {
    checkReport(sessionId);
  }

  const result = checkReport(sessionId);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.cooldownMs, 60000);
});

test('reportLimiter: 冷卻期間繼續拒絕', () => {
  reset();
  const sessionId = 'test-report-3';

  for (let i = 0; i < 3; i++) {
    checkReport(sessionId);
  }

  // 觸發冷卻
  checkReport(sessionId);
  // 冷卻期間再檢舉
  const result = checkReport(sessionId);
  assert.strictEqual(result.allowed, false);
  assert.ok(result.cooldownMs > 0);
});

test('reportLimiter: 不同 session 互不影響', () => {
  reset();
  const sessionA = 'test-report-a';
  const sessionB = 'test-report-b';

  for (let i = 0; i < 3; i++) {
    checkReport(sessionA);
  }

  // sessionB 不受 sessionA 影響
  const result = checkReport(sessionB);
  assert.strictEqual(result.allowed, true);
});

test('reportLimiter: cleanup 清除 session', () => {
  reset();
  const sessionId = 'test-report-cleanup';

  for (let i = 0; i < 3; i++) {
    checkReport(sessionId);
  }

  // 觸發冷卻
  checkReport(sessionId);

  // 清除後重新使用
  const { cleanup } = require('../protection/reportLimiter');
  cleanup(sessionId);
  const result = checkReport(sessionId);
  assert.strictEqual(result.allowed, true);
});
