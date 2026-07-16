import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsStore } from '../src/core/settings-store.js';

test('storage adapter 載入時 clamp，儲存時只寫正規化設定', async () => {
  let raw = { ball: { size: 500 }, input: { opacity: -1 }, nickname: '小夜' };
  const adapter = {
    async get(key) { assert.equal(key, 'settings'); return raw; },
    async set(key, value) { assert.equal(key, 'settings'); raw = value; },
  };
  const store = createSettingsStore(adapter, 'settings');
  const loaded = await store.load();
  assert.equal(loaded.ball.size, 96);
  assert.equal(loaded.input.opacity, 0.1);
  assert.equal(loaded.nickname, '小夜');

  loaded.ball.size = -100;
  const saved = await store.save(loaded);
  assert.equal(saved.ball.size, 32);
  assert.deepEqual(raw, saved);
});

test('恢復外觀不會清除 clientId、暱稱、房間或 credential index', async () => {
  let raw = {
    clientId: '50a5a7bb-1e62-44f6-84ca-6e7b31e5fb62',
    nickname: '小夜',
    currentRoomCode: '12345678',
    joinedRoomCodes: ['12345678'],
    ownerCredentialKeys: ['room-owner:12345678'],
    ball: { size: 90 },
  };
  const store = createSettingsStore({
    async get() { return raw; },
    async set(_key, value) { raw = value; },
  });
  const reset = await store.resetAppearance();
  assert.equal(reset.ball.size, 56);
  assert.equal(reset.clientId, raw.clientId);
  assert.equal(reset.nickname, '小夜');
  assert.equal(reset.currentRoomCode, '12345678');
  assert.deepEqual(reset.ownerCredentialKeys, ['room-owner:12345678']);
});
