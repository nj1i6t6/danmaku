'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { respond, acknowledgeShadowDrop } = require('../socket-response');

test('socket response: callback client only receives ack', () => {
  const events = [];
  const acks = [];
  const socket = { emit: (...args) => events.push(args) };

  respond(socket, (payload) => acks.push(payload), 'report-result', { success: true });

  assert.deepStrictEqual(acks, [{ success: true }]);
  assert.deepStrictEqual(events, []);
});

test('socket response: legacy client without callback receives fallback event', () => {
  const events = [];
  const socket = { emit: (...args) => events.push(args) };

  respond(socket, undefined, 'barrage-rejected', { reason: '被拒絕' });

  assert.deepStrictEqual(events, [['barrage-rejected', { reason: '被拒絕' }]]);
});

test('socket response: shadow drop acknowledges callback client without broadcasting', () => {
  const acks = [];
  acknowledgeShadowDrop((payload) => acks.push(payload));
  assert.deepStrictEqual(acks, [{ success: true }]);
  assert.doesNotThrow(() => acknowledgeShadowDrop(undefined));
});
