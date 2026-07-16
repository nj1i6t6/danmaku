import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRoom } from '../src/core/room-model.js';
import * as roomManager from '../src/core/room-manager.js';
import { createDesktopJoinedRoomStore } from '../src/desktop/settings-adapter.js';
import {
  ownerCredentialKey,
  setBackgroundInert,
  trapFocus,
  validateRoomManagerAdapter,
} from '../src/core/room-manager.js';

const validAdapter = {
  emitAck() {},
  secureGet() {},
  secureSet() {},
  secureDelete() {},
  getCurrentRoom() {},
  onRoomChanged() {},
  joinRoom() {},
  leaveRoom() {},
  createRoom() {},
};

test('room manager accepts only an explicit complete platform adapter', () => {
  assert.equal(validateRoomManagerAdapter(validAdapter), validAdapter);
  assert.throws(
    () => validateRoomManagerAdapter({ ...validAdapter, secureGet: undefined }),
    /secureGet/,
  );
  assert.throws(() => validateRoomManagerAdapter(null), /platform adapter/i);
  assert.throws(
    () => validateRoomManagerAdapter({ ...validAdapter, leaveRoom: undefined }),
    /leaveRoom/,
  );
});

test('room owner credential key is scoped only by a canonical room code', () => {
  assert.equal(ownerCredentialKey('12345678'), 'room-owner:12345678');
  assert.throws(() => ownerCredentialKey('1234'), /roomCode/);
  assert.throws(() => ownerCredentialKey('12345678:other'), /roomCode/);
});

test('owner controls use canonical room identity instead of object identity', () => {
  assert.equal(typeof roomManager.canManageRoom, 'function');
  const metadata = {
    roomCode: '12345678',
    name: '測試房',
    visibility: 'public',
    count: 1,
    capacity: 20,
  };
  const managerRoom = normalizeRoom(metadata);
  const activeRoom = normalizeRoom(metadata);
  assert.notEqual(managerRoom, activeRoom);
  assert.equal(roomManager.canManageRoom(managerRoom, activeRoom, 'owner-token'), true);
  assert.equal(roomManager.canManageRoom(managerRoom, { ...activeRoom, roomCode: '87654321' }, 'owner-token'), false);
  assert.equal(roomManager.canManageRoom(managerRoom, activeRoom, ''), false);
});

test('owner credential vault preserves a keyring write failure only in memory and retries persistence', async () => {
  assert.equal(typeof roomManager.createOwnerCredentialVault, 'function');
  const durable = new Map();
  let setAttempts = 0;
  const vault = roomManager.createOwnerCredentialVault({
    async secureGet(key) { return durable.get(key) || null; },
    async secureSet(key, value) {
      setAttempts += 1;
      if (setAttempts === 1) throw new Error('keyring unavailable');
      durable.set(key, value);
    },
    async secureDelete(key) { durable.delete(key); },
  });

  const stored = await vault.store('12345678', 'owner-token');
  assert.deepEqual(stored, { durable: false });
  const recovered = await vault.get('12345678');
  assert.equal(recovered, 'owner-token');
  assert.equal(setAttempts, 2);
  assert.equal(durable.get(ownerCredentialKey('12345678')), 'owner-token');
});

test('owner credential vault reports keyring deletion failure and clears volatile recovery', async () => {
  const vault = roomManager.createOwnerCredentialVault({
    async secureGet() { return null; },
    async secureSet() { throw new Error('keyring unavailable'); },
    async secureDelete() { throw new Error('keyring unavailable'); },
  });
  await vault.store('12345678', 'owner-token');
  assert.equal(typeof vault.remove, 'function');
  assert.deepEqual(await vault.remove('12345678'), { durable: false });
  assert.equal(await vault.get('12345678'), null);
});

test('room manager routes owner credential lifecycle through recoverable vault status', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(here, '../src/core/room-manager.js'), 'utf8');
  assert.match(source, /ownerCredentials = createOwnerCredentialVault\(client\)/);
  assert.match(source, /ownerCredentials\.store\(room\.roomCode, result\.ownerCredential\)/);
  assert.match(source, /result\.roomTransitionApplied !== false[\s\S]{0,80}setSummary\(room\)/);
  assert.match(source, /ownerCredentials\.get\(currentRoom\.roomCode\)/);
  assert.match(source, /ownerCredentials\.remove\(code\)/);
  assert.match(source, /僅本次執行可管理/);
  assert.match(source, /安全儲存清理失敗/);
});

test('room manager modal makes real same-parent background siblings inert and restores wasInert', () => {
  const modal = {};
  const alreadyInert = { contains: () => false, inert: true };
  const sibling = { contains: () => false, inert: false };
  const parent = { children: [alreadyInert, sibling, modal] };
  modal.parentElement = parent;
  const document = { body: { children: [parent] } };
  setBackgroundInert(document, modal, true);
  assert.equal(alreadyInert.inert, true);
  assert.equal(sibling.inert, true);
  assert.equal(parent.inert, undefined);
  assert.equal(modal.inert, undefined);
  setBackgroundInert(document, modal, false);
  assert.equal(alreadyInert.inert, true);
  assert.equal(sibling.inert, false);
});

test('room exit coordinator blocks default, removes other locally, and leaves current before joining default', async () => {
  assert.equal(typeof roomManager.createRoomExitCoordinator, 'function');
  const removed = [];
  const outgoing = [];
  let currentCode = '22222222';
  let leaveResult = { ok: true };
  let joinResult = { ok: true, room: { roomCode: '12345678' } };
  const coordinator = roomManager.createRoomExitCoordinator({
    getCurrentRoomCode: () => currentCode,
    getDefaultRoom: async () => ({ roomCode: '12345678' }),
    leaveRoom: async () => { outgoing.push('leave-room'); if (leaveResult.ok) currentCode = null; return leaveResult; },
    joinRoom: async (roomCode) => { outgoing.push(`join-room:${roomCode}`); if (joinResult.ok) currentCode = roomCode; return joinResult; },
    removeShortcut: (roomCode) => removed.push(roomCode),
  });

  assert.deepEqual(await coordinator.exit({ roomCode: '12345678', name: '預設' }), { ok: false, action: 'block-default', partial: false });
  assert.deepEqual(await coordinator.exit({ roomCode: '33333333', name: '其他' }), { ok: true, action: 'remove-shortcut' });
  assert.deepEqual(await coordinator.exit({ roomCode: '22222222', name: '目前' }), { ok: true, action: 'switch-to-default', room: joinResult.room });
  assert.deepEqual(removed, ['33333333', '22222222']);
  assert.deepEqual(outgoing, ['leave-room', 'join-room:12345678']);
});

test('room exit coordinator keeps state on leave failure and reports partial default join failure without deletion', async () => {
  const removed = [];
  let currentCode = '22222222';
  let calls = 0;
  let leaveShouldFail = true;
  const coordinator = roomManager.createRoomExitCoordinator({
    getCurrentRoomCode: () => currentCode,
    getDefaultRoom: async () => ({ roomCode: '12345678' }),
    leaveRoom: async () => { calls += 1; if (leaveShouldFail) return { ok: false, error: { message: 'typed leave failure' } }; currentCode = null; return { ok: true }; },
    joinRoom: async () => { calls += 1; return { ok: false, error: { message: 'typed join failure' } }; },
    removeShortcut: (roomCode) => { removed.push(roomCode); },
  });
  const failedLeave = await coordinator.exit({ roomCode: '22222222' });
  assert.equal(failedLeave.ok, false);
  assert.equal(failedLeave.partial, false);
  assert.equal(failedLeave.error.message, 'typed leave failure');
  assert.equal(currentCode, '22222222');
  assert.deepEqual(removed, []);
  assert.equal(calls, 1);

  leaveShouldFail = false;
  const failedJoin = await coordinator.exit({ roomCode: '22222222' });
  assert.equal(failedJoin.ok, false);
  assert.equal(failedJoin.partial, true);
  assert.match(failedJoin.message, /已退出但回預設失敗/);
  assert.deepEqual(removed, ['22222222']);
  assert.equal(calls, 3);
});

test('room exit coordinator fails closed when the default room is unavailable', async () => {
  const calls = [];
  const coordinator = roomManager.createRoomExitCoordinator({
    getCurrentRoomCode: () => '22222222',
    getDefaultRoom: async () => null,
    leaveRoom: async () => { calls.push('leave'); return { ok: true }; },
    joinRoom: async () => { calls.push('join'); return { ok: true }; },
    removeShortcut: async () => { calls.push('remove'); },
  });

  for (const roomCode of ['12345678', '22222222', '33333333']) {
    const result = await coordinator.exit({ roomCode });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'DEFAULT_ROOM_UNAVAILABLE');
    assert.equal(result.partial, false);
  }
  assert.deepEqual(calls, []);
});

test('room exit coordinator converts storage and adapter exceptions into typed state transitions', async () => {
  const calls = [];
  const storageFailure = roomManager.createRoomExitCoordinator({
    getCurrentRoomCode: () => '22222222',
    getDefaultRoom: async () => ({ roomCode: '12345678' }),
    leaveRoom: async () => { calls.push('leave'); return { ok: true }; },
    joinRoom: async () => { calls.push('join'); return { ok: true, room: { roomCode: '12345678' } }; },
    removeShortcut: async () => { calls.push('remove'); throw new Error('secret storage path'); },
  });
  const other = await storageFailure.exit({ roomCode: '33333333' });
  assert.deepEqual(other, {
    ok: false,
    action: 'remove-shortcut',
    partial: false,
    error: { code: 'LOCAL_STORAGE_FAILURE', scope: 'storage', message: '已加入清單更新失敗' },
  });
  assert.deepEqual(calls, ['remove']);

  calls.length = 0;
  const leaveFailure = roomManager.createRoomExitCoordinator({
    getCurrentRoomCode: () => '22222222',
    getDefaultRoom: async () => ({ roomCode: '12345678' }),
    leaveRoom: async () => { calls.push('leave'); throw new Error('owner-token-secret'); },
    joinRoom: async () => { calls.push('join'); return { ok: true }; },
    removeShortcut: async () => { calls.push('remove'); },
  });
  const leave = await leaveFailure.exit({ roomCode: '22222222' });
  assert.deepEqual(leave, {
    ok: false,
    action: 'switch-to-default',
    partial: false,
    error: { code: 'ROOM_EXIT_FAILED', scope: 'room', message: '退出失敗' },
  });
  assert.deepEqual(calls, ['leave']);

  calls.length = 0;
  const coordinator = roomManager.createRoomExitCoordinator({
    getCurrentRoomCode: () => '22222222',
    getDefaultRoom: async () => ({ roomCode: '12345678' }),
    leaveRoom: async () => { calls.push('leave'); return { ok: true }; },
    joinRoom: async () => { calls.push('join'); return { ok: true, room: { roomCode: '12345678' } }; },
    removeShortcut: async () => { calls.push('remove'); throw new Error('secret storage path'); },
  });
  const joined = await coordinator.exit({ roomCode: '22222222' });
  assert.equal(joined.ok, false);
  assert.equal(joined.partial, true);
  assert.equal(joined.message, '已回到預設房但無法更新已加入清單');
  assert.equal(joined.error.code, 'LOCAL_STORAGE_FAILURE');
  assert.deepEqual(calls, ['leave', 'remove', 'join']);

  calls.length = 0;
  const joinFailure = roomManager.createRoomExitCoordinator({
    getCurrentRoomCode: () => '22222222',
    getDefaultRoom: async () => ({ roomCode: '12345678' }),
    leaveRoom: async () => { calls.push('leave'); return { ok: true }; },
    joinRoom: async () => { calls.push('join'); throw new Error('credential-secret'); },
    removeShortcut: async () => { calls.push('remove'); },
  });
  const failedJoin = await joinFailure.exit({ roomCode: '22222222' });
  assert.equal(failedJoin.ok, false);
  assert.equal(failedJoin.partial, true);
  assert.equal(failedJoin.message, '已退出但回預設失敗');
  assert.equal(failedJoin.error.message, '回預設房失敗');
  assert.deepEqual(calls, ['leave', 'remove', 'join']);
});

test('Desktop joined room store migrates the dedicated legacy key into settings authority', () => {
  let settings = { joinedRoomCodes: ['12345678'] };
  const legacy = new Map([['danmaku-overlay-joined-room-codes', JSON.stringify(['22222222', 'bad', '22222222'])]]);
  const saved = [];
  const store = createDesktopJoinedRoomStore({
    getSettings: () => settings,
    saveSettings(value) { settings = { ...value }; saved.push(settings); return settings; },
    legacyStorage: {
      getItem(key) { return legacy.get(key) ?? null; },
      removeItem(key) { legacy.delete(key); },
    },
  });

  assert.deepEqual(store.list(), ['12345678', '22222222']);
  assert.deepEqual(settings.joinedRoomCodes, ['12345678', '22222222']);
  assert.equal(legacy.get('danmaku-overlay-joined-room-codes'), undefined);
  assert.equal(saved.length, 1);
  store.remove('12345678');
  assert.deepEqual(settings.joinedRoomCodes, ['22222222']);
  assert.deepEqual(store.list(), ['22222222']);
  assert.equal(saved.length, 2);
});

test('Desktop joined room migration keeps saved settings when legacy cleanup fails', () => {
  let settings = { joinedRoomCodes: ['12345678'] };
  let writes = 0;
  let legacyRaw = JSON.stringify(['22222222']);
  const store = createDesktopJoinedRoomStore({
    getSettings: () => settings,
    saveSettings(value) { writes += 1; settings = { ...value }; return settings; },
    legacyStorage: {
      getItem() { return legacyRaw; },
      removeItem() { throw new Error('cleanup denied'); },
      setItem(_key, value) { legacyRaw = value; },
    },
  });
  assert.deepEqual(store.list(), ['12345678', '22222222']);
  assert.deepEqual(settings.joinedRoomCodes, ['12345678', '22222222']);
  assert.deepEqual(JSON.parse(legacyRaw), ['12345678', '22222222']);
  assert.equal(writes, 1);

  store.remove('22222222');
  assert.deepEqual(settings.joinedRoomCodes, ['12345678']);
  assert.deepEqual(JSON.parse(legacyRaw), ['12345678']);

  const restarted = createDesktopJoinedRoomStore({
    getSettings: () => settings,
    saveSettings(value) { writes += 1; settings = { ...value }; return settings; },
    legacyStorage: {
      getItem() { return legacyRaw; },
      removeItem() { throw new Error('cleanup denied'); },
      setItem(_key, value) { legacyRaw = value; },
    },
  });
  assert.deepEqual(restarted.list(), ['12345678']);
  assert.deepEqual(settings.joinedRoomCodes, ['12345678']);
  assert.deepEqual(JSON.parse(legacyRaw), ['12345678']);
});

test('room manager focus trap wraps Tab at both modal edges', () => {
  const document = { activeElement: null };
  const first = { hidden: false, closest: () => null, focus: () => { document.activeElement = first; } };
  const last = { hidden: false, closest: () => null, focus: () => { document.activeElement = last; } };
  const container = {
    contains: (element) => element === first || element === last,
    querySelectorAll: () => [first, last],
    focus() { document.activeElement = container; },
  };
  document.activeElement = last;
  const forward = { key: 'Tab', shiftKey: false, preventDefault() { this.prevented = true; } };
  trapFocus(document, container, forward);
  assert.equal(forward.prevented, true);
  assert.equal(document.activeElement, first);

  const backward = { key: 'Tab', shiftKey: true, preventDefault() { this.prevented = true; } };
  trapFocus(document, container, backward);
  assert.equal(backward.prevented, true);
  assert.equal(document.activeElement, last);
});

test('room manager joins and persists the preview snapshot captured before await', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(here, '../src/core/room-manager.js'), 'utf8');
  assert.match(source, /const room = previewRoom;[\s\S]{0,300}client\.joinRoom\(room\.roomCode/);
  assert.match(source, /safeJoinedStoreWrite\('add', room\.roomCode\)/);
  assert.match(source, /`已加入 \$\{room\.name\}`/);
});
