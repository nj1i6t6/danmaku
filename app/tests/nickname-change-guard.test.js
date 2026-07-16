'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  NicknameChangeGuard,
  taipeiDate,
  msUntilNextTaipeiDay,
} = require('../nickname-change-guard');

test('Taipei calendar helpers reset at Asia/Taipei midnight', () => {
  const before = Date.parse('2026-07-14T15:59:59.500Z');
  const after = Date.parse('2026-07-14T16:00:00.000Z');
  assert.equal(taipeiDate(before), '2026-07-14');
  assert.equal(taipeiDate(after), '2026-07-15');
  assert.equal(msUntilNextTaipeiDay(before), 500);
  assert.equal(msUntilNextTaipeiDay(after), 86_400_000);
});

test('first barrage observation establishes a free baseline and mismatch is rejected', () => {
  const guard = new NicknameChangeGuard({ now: () => Date.parse('2026-07-14T08:00:00Z') });
  assert.deepEqual(guard.observe('client-a', '舊名'), { allowed: true, initialized: true, nickname: '舊名' });
  assert.deepEqual(guard.observe('client-a', '舊名'), { allowed: true, initialized: false, nickname: '舊名' });
  assert.deepEqual(guard.observe('client-a', '偷改'), { allowed: false, initialized: false, nickname: '舊名' });
});

test('explicit nickname change is idempotent and limited to once per Taipei day', () => {
  let now = Date.parse('2026-07-14T08:00:00Z');
  const guard = new NicknameChangeGuard({ now: () => now });
  const first = guard.change('client-a', '名字一');
  assert.equal(first.allowed, true);
  assert.equal(first.changed, true);
  assert.equal(first.changeDate, '2026-07-14');

  const same = guard.change('client-a', '名字一');
  assert.equal(same.allowed, true);
  assert.equal(same.changed, false);

  const blocked = guard.change('client-a', '名字二');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.changeDate, '2026-07-14');
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 86_400_000);

  now = Date.parse('2026-07-14T16:00:00Z');
  const nextDay = guard.change('client-a', '名字二');
  assert.equal(nextDay.allowed, true);
  assert.equal(nextDay.changed, true);
  assert.equal(nextDay.changeDate, '2026-07-15');
});

test('stable clients are isolated and the guard evicts least-recently-used entries at capacity', () => {
  let now = 1;
  const guard = new NicknameChangeGuard({ now: () => now, maxEntries: 2 });
  guard.observe('client-a', '甲');
  now += 1;
  guard.observe('client-b', '乙');
  now += 1;
  guard.observe('client-a', '甲');
  now += 1;
  guard.observe('client-c', '丙');

  assert.equal(guard.size, 2);
  assert.equal(guard.has('client-a'), true);
  assert.equal(guard.has('client-b'), false);
  assert.equal(guard.has('client-c'), true);
});
