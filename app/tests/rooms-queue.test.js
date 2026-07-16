'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { FairRoomQueue, DeliveryBudget } = require('../rooms/queue');
const { AccessGuard } = require('../rooms/access-guard');
const { StableRateLimiter } = require('../protection/rateLimiter');

function expectCode(fn, code) {
  assert.throws(fn, (error) => error && error.code === code);
}

describe('fair bounded queue', () => {
  test('bounds per-client/room queue and drains round-robin only on real delivery', () => {
    let now = 0;
    const delivered = [];
    const statuses = [];
    const queue = new FairRoomQueue({
      rate: 1, burst: 1, maxSize: 3, now: () => now,
      deliver: (item) => delivered.push(item.clientId),
      status: (item, state) => statuses.push([item.clientId, state]),
    });
    assert.equal(queue.submit({ clientId: 'warm', messageId: 'm0', recipients: 1 }).state, 'sent');
    assert.equal(queue.submit({ clientId: 'a', messageId: 'm1', recipients: 1 }).state, 'queued');
    expectCode(() => queue.submit({ clientId: 'a', messageId: 'm2', recipients: 1 }), 'ROOM_BUSY');
    queue.submit({ clientId: 'b', messageId: 'm3', recipients: 1 });
    queue.submit({ clientId: 'c', messageId: 'm4', recipients: 1 });
    expectCode(() => queue.submit({ clientId: 'd', messageId: 'm5', recipients: 1 }), 'QUEUE_FULL');
    now = 1000; queue.drain();
    now = 2000; queue.drain();
    now = 3000; queue.drain();
    assert.deepEqual(delivered, ['warm', 'a', 'b', 'c']);
    assert.deepEqual(statuses.filter((x) => x[1] === 'delivered').map((x) => x[0]), ['a', 'b', 'c']);
    assert.equal(queue.size, 0);
  });

  test('rejects >5s estimated wait, expires TTL, cancels disconnect, and charges recipient delivery budget', () => {
    let now = 0;
    const statuses = [];
    const budget = new DeliveryBudget({ rate: 0.1, burst: 2, now: () => now });
    const queue = new FairRoomQueue({ rate: 1, burst: 1, maxSize: 25, ttlMs: 5000, now: () => now, budget,
      deliver: () => {}, status: (item, state) => statuses.push([item.clientId, state]) });
    assert.equal(queue.submit({ clientId: 'x', messageId: 'x', recipients: 2 }).state, 'sent');
    queue.submit({ clientId: 'a', messageId: 'a', recipients: 2 });
    now = 1000; assert.equal(queue.drain(), 0, 'global budget blocks delivery by recipient cost');
    now = 20_001; queue.drain();
    assert.deepEqual(statuses.at(-1), ['a', 'expired']);
    assert.equal(queue.submit({ clientId: 'b', messageId: 'b', recipients: 1 }).state, 'sent');
    queue.submit({ clientId: 'c', messageId: 'c', recipients: 1 });
    assert.equal(queue.cancelClient('c'), 1);
    assert.equal(queue.size, 0);

    const sameClient = new FairRoomQueue({ rate: 1, burst: 0, maxSize: 2, now: () => now, deliver: () => {} });
    sameClient.submit({ clientId: 'same-install', socketId: 'socket-a', messageId: 'same-a', recipients: 1 });
    assert.equal(sameClient.cancelSocket('socket-b'), 0, 'a second socket must not cancel the first socket queue item');
    assert.equal(sameClient.size, 1);
    assert.equal(sameClient.cancelSocket('socket-a'), 1);
    assert.equal(sameClient.size, 0);

    const slow = new FairRoomQueue({ rate: 0.1, burst: 0, maxSize: 25, ttlMs: 5000, now: () => now, deliver: () => {} });
    expectCode(() => slow.submit({ clientId: 'z', messageId: 'z', recipients: 1 }), 'ROOM_BUSY');
  });
});

describe('bounded access abuse controls', () => {
  test('lookup limit can be injected only by an explicit server/test caller', () => {
    const guard = new AccessGuard({ now: () => 0, maxEntries: 100, lookupLimit: 2 });
    assert.equal(guard.allowLookup('client-1', 'ip').allowed, true);
    assert.equal(guard.allowLookup('client-2', 'ip').allowed, true);
    assert.equal(guard.allowLookup('client-3', 'ip').code, 'RATE_LIMITED');
  });

  test('lookup/join has combined client and IP 30/min and password lockout is scoped', () => {
    let now = 0;
    const guard = new AccessGuard({ now: () => now, maxEntries: 100 });
    for (let i = 0; i < 30; i++) assert.equal(guard.allowLookup('client', 'ip').allowed, true);
    assert.equal(guard.allowLookup('client', 'ip').code, 'RATE_LIMITED');
    for (let i = 0; i < 4; i++) assert.equal(guard.recordPasswordFailure('client', 'ip', '12345678').allowed, true);
    const locked = guard.recordPasswordFailure('client', 'ip', '12345678');
    assert.equal(locked.code, 'RATE_LIMITED');
    assert.equal(locked.retryAfterMs, 900000);
    assert.equal(guard.passwordAllowed('client', 'ip', '12345678').code, 'RATE_LIMITED');
    assert.equal(guard.passwordAllowed('other', 'ip2', '12345678').allowed, true);
    now += 900001;
    assert.equal(guard.passwordAllowed('client', 'ip', '12345678').allowed, true);
  });

  test('personal limiter keys stable clientId, preserves penalties across disconnect, and stays bounded', () => {
    let now = 10_000;
    const limiter = new StableRateLimiter({ now: () => now, maxEntries: 2 });
    for (let i = 0; i < 5; i++) assert.equal(limiter.check('stable-a').allowed, true);
    assert.deepEqual(limiter.check('stable-a'), { allowed: false, code: 'RATE_LIMITED', retryAfterMs: 3000 });
    assert.deepEqual(limiter.check('stable-a'), { allowed: false, code: 'RATE_LIMITED', retryAfterMs: 3000 });
    now += 3001;
    assert.equal(limiter.check('stable-a').allowed, true, 'advertised cooldown must actually end');
    for (let i = 0; i < 4; i++) assert.equal(limiter.check('stable-a').allowed, true);
    assert.equal(limiter.check('stable-a').retryAfterMs, 10000);
    now += 10001;
    assert.equal(limiter.check('stable-a').allowed, true);
    for (let i = 0; i < 4; i++) assert.equal(limiter.check('stable-a').allowed, true);
    assert.equal(limiter.check('stable-a').retryAfterMs, 30000);
    now += 30001;
    assert.equal(limiter.check('stable-a').allowed, true);
    for (let i = 0; i < 4; i++) assert.equal(limiter.check('stable-a').allowed, true);
    const muted = limiter.check('stable-a');
    assert.equal(muted.code, 'MUTED');
    assert.equal(muted.retryAfterMs, 300000);
    limiter.disconnect('stable-a');
    assert.equal(limiter.check('stable-a').code, 'MUTED');
    limiter.check('b'); limiter.check('c');
    assert.ok(limiter.size <= 2);
  });
});
