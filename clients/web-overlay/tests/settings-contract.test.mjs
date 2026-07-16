import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPEARANCE_DEFAULTS,
  APPEARANCE_LIMITS,
  normalizeSettings,
  resetAppearance,
} from '../src/core/settings-contract.js';

test('設定預設值與 Android 基準完全一致', () => {
  assert.deepEqual(APPEARANCE_DEFAULTS, {
    ball: { color: '#58A6FF', size: 56, opacity: 0.9 },
    danmaku: { color: '#E6EDF3', size: 20, opacity: 0.9 },
    input: { color: '#1A1A2E', size: 16, opacity: 0.8 },
    panel: { width: 320, height: 0 },
    ballPosition: { x: null, y: 100 },
    danmakuVisible: true,
    onboarded: false,
  });
  assert.deepEqual(APPEARANCE_LIMITS, {
    ballSize: [32, 96],
    danmakuSize: [12, 48],
    inputSize: [12, 32],
    opacity: [0.1, 1],
    panelWidth: [280, 800],
    panelHeight: [0, 800],
  });
});

test('損壞或越界 storage 逐欄正規化而不讓啟動失敗', () => {
  assert.deepEqual(normalizeSettings({
    ball: { color: 'red', size: 999, opacity: -5 },
    danmaku: { color: '#abcDEF', size: '11', opacity: 4 },
    input: { color: '#000000', size: 28, opacity: '0.45' },
    panel: { width: 10, height: 9999 },
    ballPosition: { x: 'bad', y: 42 },
    danmakuVisible: 'yes',
    onboarded: 1,
  }), {
    ball: { color: '#58A6FF', size: 96, opacity: 0.1 },
    danmaku: { color: '#ABCDEF', size: 12, opacity: 1 },
    input: { color: '#000000', size: 28, opacity: 0.45 },
    panel: { width: 280, height: 800 },
    ballPosition: { x: null, y: 42 },
    danmakuVisible: true,
    onboarded: true,
    nickname: '匿名',
    joinedRoomCodes: [],
    ownerCredentialKeys: [],
  });
});

test('恢復外觀預設保留身分、暱稱、房間與房主憑證索引', () => {
  const current = normalizeSettings({
    clientId: '50a5a7bb-1e62-44f6-84ca-6e7b31e5fb62',
    nickname: '小夜',
    nicknameChangeDate: '2026-07-15',
    currentRoomCode: '12345678',
    defaultRoomCode: '87654321',
    joinedRoomCodes: ['12345678'],
    ownerCredentialKeys: ['room-owner:12345678'],
    ball: { size: 90 },
  });
  const reset = resetAppearance(current);
  assert.equal(reset.ball.size, 56);
  assert.equal(reset.clientId, current.clientId);
  assert.equal(reset.nickname, '小夜');
  assert.equal(reset.currentRoomCode, '12345678');
  assert.deepEqual(reset.joinedRoomCodes, ['12345678']);
  assert.deepEqual(reset.ownerCredentialKeys, ['room-owner:12345678']);
});
