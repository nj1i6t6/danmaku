import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopSettingsAdapter } from '../src/desktop/settings-adapter.js';

function memoryStorage(initialValue) {
  let raw = initialValue;
  return {
    getItem(key) {
      assert.equal(key, 'danmaku-overlay-settings');
      return raw;
    },
    setItem(key, value) {
      assert.equal(key, 'danmaku-overlay-settings');
      raw = value;
    },
    read() { return raw; },
  };
}

test('Desktop settings adapter migrates legacy position and delegates clamp/reset to shared contract', () => {
  const storage = memoryStorage(JSON.stringify({
    nickname: '小夜',
    currentRoomCode: '12345678',
    joinedRoomCodes: ['12345678'],
    ownerCredentialKeys: ['room-owner:12345678'],
    ball: { size: 500 },
    ballPos: { x: 24, y: 48 },
  }));
  const adapter = createDesktopSettingsAdapter(storage);

  const loaded = adapter.load();
  assert.equal(loaded.ball.size, 96);
  assert.deepEqual(loaded.ballPosition, { x: 24, y: 48 });

  loaded.input.size = -100;
  const saved = adapter.save(loaded);
  assert.equal(saved.input.size, 12);
  assert.deepEqual(JSON.parse(storage.read()), saved);

  const reset = adapter.resetAppearance(saved);
  assert.equal(reset.ball.size, 56);
  assert.equal(reset.nickname, '小夜');
  assert.equal(reset.currentRoomCode, '12345678');
  assert.deepEqual(reset.joinedRoomCodes, ['12345678']);
  assert.deepEqual(reset.ownerCredentialKeys, ['room-owner:12345678']);
});
