import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createJoinedRoomStore,
  normalizeRoom,
  normalizeRoomList,
  roomExitAction,
  validRoomCode,
} from '../src/core/room-model.js';
import * as roomModel from '../src/core/room-model.js';

test('房間 metadata 正規化且只持久化合法 roomCode', () => {
  assert.equal(validRoomCode('12345678'), true);
  assert.equal(validRoomCode('AB12CD34'), false);
  assert.deepEqual(normalizeRoom({
    roomName: '<img onerror=1>',
    roomCode: '12345678',
    count: 4,
    capacity: 50,
    requiresPassword: true,
    visibility: 'unlisted',
    retentionDays: 7,
  }), {
    name: '<img onerror=1>',
    roomCode: '12345678',
    count: 4,
    capacity: 50,
    requiresPassword: true,
    visibility: 'unlisted',
    retentionDays: 7,
    expiresAt: null,
    ownedByClient: false,
  });
  assert.deepEqual(normalizeRoomList({ rooms: [{ name: '壞', roomCode: 'bad' }] }), []);

  let raw = null;
  const storage = { getItem: () => raw, setItem: (_key, value) => { raw = value; } };
  const joined = createJoinedRoomStore(storage, 'joined-test');
  joined.add({ roomCode: '12345678', name: '不得保存', password: '不得保存' });
  assert.equal(raw, '["12345678"]');
  assert.deepEqual(joined.list(), ['12345678']);
});

test('退出房間規則與 Android 基準一致且不會誤刪房主憑證', () => {
  assert.equal(roomExitAction('87654321', '87654321', '87654321'), 'block-default');
  assert.equal(roomExitAction('12345678', '12345678', '87654321'), 'switch-to-default');
  assert.equal(roomExitAction('12345678', '99999999', '87654321'), 'remove-shortcut');
});

test('較新的房間操作會讓較早 reconnect transition 失效', () => {
  assert.equal(typeof roomModel.createRoomTransitionGate, 'function');
  const gate = roomModel.createRoomTransitionGate();
  const reconnect = gate.begin();
  assert.equal(gate.isCurrent(reconnect), true);
  const explicitJoin = gate.begin();
  assert.equal(gate.isCurrent(reconnect), false);
  assert.equal(gate.isCurrent(explicitJoin), true);
});

test('同一 Socket 的房間 membership commands 依提交順序執行', async () => {
  assert.equal(typeof roomModel.createRoomCommandQueue, 'function');
  const queue = roomModel.createRoomCommandQueue();
  const order = [];
  let releaseFirst;
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });

  const first = queue.run(async () => {
    order.push('first:start');
    await blocked;
    order.push('first:end');
    return 'first';
  });
  const second = queue.run(async () => {
    order.push('second:start');
    return 'second';
  });

  await Promise.resolve();
  assert.deepEqual(order, ['first:start']);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
});
