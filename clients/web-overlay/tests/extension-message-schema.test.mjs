import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExtensionMessage } from '../src/extension/message-schema.js';

function valid(action, payload = {}) {
  return parseExtensionMessage({ action, payload });
}

test('extension message schema accepts the explicit command allowlist', () => {
  assert.deepEqual(valid('overlay/register', { instanceId: 'page-1', visibilityState: 'visible' }), {
    action: 'overlay/register', payload: { instanceId: 'page-1', visibilityState: 'visible' },
  });
  assert.equal(valid('barrage/send', { text: 'hello' }).payload.text, 'hello');
  assert.equal(valid('room/join', { roomCode: '12345678', password: 'secret1' }).payload.roomCode, '12345678');
  assert.equal(valid('room/create', { name: 'room', visibility: 'public', retentionDays: 7 }).payload.retentionDays, 7);
});

test('extension message schema rejects unknown actions, extra fields and malformed envelopes', () => {
  assert.throws(() => parseExtensionMessage(null), /message/i);
  assert.throws(() => parseExtensionMessage({ action: 'unknown', payload: {} }), /unknown/i);
  assert.throws(() => parseExtensionMessage({ action: 'state/get', payload: {}, extra: true }), /extra/i);
  assert.throws(() => parseExtensionMessage({ action: 'state/get', payload: { extra: true } }), /extra/i);
});

test('extension message schema enforces room, text, nickname and settings contracts', () => {
  assert.throws(() => valid('room/join', { roomCode: '123' }), /room/i);
  assert.throws(() => valid('barrage/send', { text: '' }), /text/i);
  assert.throws(() => valid('barrage/send', { text: 'x'.repeat(101) }), /text/i);
  assert.throws(() => valid('nickname/change', { nickname: 'abcdefg' }), /nickname/i);
  assert.throws(() => valid('settings/update', { settings: { ball: { size: 56, surprise: true } } }), /extra/i);
  assert.throws(() => valid('settings/update', { settings: { input: { opacity: 0 } } }), /opacity/i);
});

test('content commands cannot supply or request owner credentials', () => {
  assert.throws(() => valid('room/update', {
    roomCode: '12345678', name: 'new', ownerCredential: 'secret',
  }), /extra|credential/i);
  assert.throws(() => valid('room/delete', {
    roomCode: '12345678', ownerCredential: 'secret',
  }), /extra|credential/i);
});
