'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { normalizeRoomInput } = require('../rooms/validation');
const { RoomStore } = require('../rooms/store');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-rooms-'));
  return { dir, file: path.join(dir, 'rooms.db') };
}

describe('room validation', () => {
  test('normalizes Unicode/whitespace and accepts only the room contract', () => {
    assert.deepEqual(normalizeRoomInput({ name: '  測試　Room  1-_ ', visibility: 'public' }), {
      name: '測試 Room 1-_', visibility: 'public', retentionDays: 7, password: null,
    });
    assert.throws(() => normalizeRoomInput({ name: '<script>', visibility: 'public' }), /VALIDATION_ERROR/);
    assert.throws(() => normalizeRoomInput({ name: '合法房名', visibility: 'public', password: 'secret1' }), /VALIDATION_ERROR/);
    assert.throws(() => normalizeRoomInput({ name: '合法房名', visibility: 'unlisted', password: '12345' }), /VALIDATION_ERROR/);
    assert.throws(() => normalizeRoomInput({ name: '合法房名', visibility: 'public', retentionDays: 'permanent' }), /VALIDATION_ERROR/);
    assert.throws(() => normalizeRoomInput({ name: '合法房名', visibility: 'public', legacyField: 'unsupported' }), /VALIDATION_ERROR/);
  });
});

describe('SQLite room store', () => {
  test('seeds a permanent undeletable default and persists metadata/tombstones', async () => {
    const tmp = tempDb();
    const store = new RoomStore({ filename: tmp.file, now: () => 1_000 });
    const room = store.getDefaultRoom();
    assert.equal(room.name, '預設');
    assert.equal(room.capacity, 1000);
    assert.equal(room.retentionDays, null);
    assert.equal(room.isSystem, true);
    assert.throws(() => store.deleteRoom(room.roomCode, 'anything'), /FORBIDDEN/);
    const created = await store.createRoom({ name: '測試 Room', visibility: 'unlisted', password: 'secret1', retentionDays: 3 }, { clientId: 'c1', ip: '1.2.3.4' });
    assert.match(created.room.roomId, /^[0-9a-f-]{36}$/i);
    assert.match(created.room.roomCode, /^\d{8}$/);
    assert.ok(created.ownerCredential.length >= 43);
    const raw = store.db.prepare('SELECT * FROM rooms WHERE room_code = ?').get(created.room.roomCode);
    assert.notEqual(raw.password_hash.toString('hex'), 'secret1');
    assert.notEqual(raw.owner_hash.toString('hex'), created.ownerCredential);
    assert.equal(await store.verifyPassword(created.room.roomCode, 'secret1'), true);
    assert.equal(await store.verifyPassword(created.room.roomCode, 'wrongxx'), false);
    store.deleteRoom(created.room.roomCode, created.ownerCredential);
    assert.equal(store.lookup(created.room.roomCode), null);
    assert.equal(store.db.prepare('SELECT count(*) n FROM room_code_tombstones WHERE room_code=?').get(created.room.roomCode).n, 1);
    store.close();
    const reopened = new RoomStore({ filename: tmp.file, now: () => 2_000 });
    assert.equal(reopened.lookup(created.room.roomCode), null);
    assert.equal(reopened.getDefaultRoom().roomCode, room.roomCode);
    reopened.close();
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });

  test('owner authorization reloads a bounded in-memory hash index without room-row queries', async (t) => {
    const tmp = tempDb();
    let store = new RoomStore({ filename: tmp.file, now: () => 1_000 });
    let reopened;
    t.after(() => {
      store?.close();
      reopened?.close();
      fs.rmSync(tmp.dir, { recursive: true, force: true });
    });
    const credential = 'A'.repeat(43);
    const created = await store.createRoom(
      { name: '房主索引房', visibility: 'public' },
      { clientId: 'owner-index-client', ip: '1.2.3.4', ownerCredential: credential },
    );
    store.close();
    store = null;

    reopened = new RoomStore({ filename: tmp.file, now: () => 2_000 });
    let rowLookups = 0;
    reopened._row = () => {
      rowLookups += 1;
      throw new Error('owner authorization must not query a room row');
    };
    assert.equal(reopened.isOwner(created.room.roomCode, credential), true);
    assert.equal(reopened.isOwner(created.room.roomCode, 'B'.repeat(43)), false);
    assert.equal(reopened.isOwner('99999999', credential), false);
    assert.equal(rowLookups, 0);
  });

  test('owner index follows pending revival and deletion lifecycle', async (t) => {
    const tmp = tempDb();
    let now = 10_000;
    const store = new RoomStore({ filename: tmp.file, now: () => now });
    t.after(() => {
      store.close();
      fs.rmSync(tmp.dir, { recursive: true, force: true });
    });
    const created = await store.createRoom(
      { name: '房主索引生命週期', visibility: 'public', retentionDays: 1 },
      { clientId: 'owner-index-lifecycle', ip: '1.2.3.5' },
    );
    const { roomCode } = created.room;
    assert.equal(store.isOwner(roomCode, created.ownerCredential), true);

    now += 86_400_001;
    assert.deepEqual(store.expireDueRooms(new Set([roomCode])).pending, [roomCode]);
    assert.equal(store.isOwner(roomCode, created.ownerCredential), false);

    assert.equal(store.recordDelivered(roomCode, now), true);
    assert.equal(store.isOwner(roomCode, created.ownerCredential), true);

    store.deleteRoom(roomCode, created.ownerCredential);
    assert.equal(store.isOwner(roomCode, created.ownerCredential), false);
    assert.equal(store.ownerHashes.has(roomCode), false);
  });

  test('enforces create quotas, owner updates, safe listing and expiry lifecycle', async () => {
    const tmp = tempDb();
    let now = 10_000;
    const store = new RoomStore({ filename: tmp.file, now: () => now });
    await assert.rejects(
      store.createRoom({ name: 'fuck Room', visibility: 'public' }, { clientId: 'client-a', ip: '10.0.0.1' }),
      /VALIDATION_ERROR/,
    );
    await assert.rejects(
      store.createRoom({ name: 'line abc123', visibility: 'public' }, { clientId: 'client-a', ip: '10.0.0.1' }),
      /VALIDATION_ERROR/,
    );
    const a = await store.createRoom({ name: '同名 房', visibility: 'public', retentionDays: 1 }, { clientId: 'client-a', ip: '10.0.0.1' });
    const b = await store.createRoom({ name: '同名 房', visibility: 'unlisted', retentionDays: 7 }, { clientId: 'client-a', ip: '10.0.0.1' });
    assert.notEqual(a.room.roomCode, b.room.roomCode);
    await assert.rejects(store.updateRoom(a.room.roomCode, { visibility: 'unlisted', password: 'secret2' }, 'bad'), /FORBIDDEN/);
    await assert.rejects(store.updateRoom(a.room.roomCode, { name: 'fuck Room' }, a.ownerCredential), /VALIDATION_ERROR/);
    await assert.rejects(store.updateRoom(a.room.roomCode, { name: 'line abc123' }, a.ownerCredential), /VALIDATION_ERROR/);
    const updated = await store.updateRoom(a.room.roomCode, { name: '新 房名', visibility: 'unlisted', password: 'secret2' }, a.ownerCredential);
    assert.equal(updated.name, '新 房名');
    assert.equal(updated.passwordRequired, true);
    await assert.rejects(store.updateRoom(a.room.roomCode, { visibility: 'public' }, a.ownerCredential), /VALIDATION_ERROR/);
    await store.updateRoom(a.room.roomCode, { password: null }, a.ownerCredential);
    await store.updateRoom(a.room.roomCode, { visibility: 'public' }, a.ownerCredential);
    const listed = store.listPublic({ query: '新', onlineCounts: new Map([[a.room.roomCode, 9]]) });
    assert.equal(listed.items.length, 1);
    for (const forbidden of ['roomId', 'ownerHash', 'passwordHash', 'passwordSalt']) {
      assert.equal(Object.hasOwn(listed.items[0], forbidden), false);
    }
    await store.createRoom({ name: '第三間', visibility: 'public' }, { clientId: 'client-a', ip: '10.0.0.1' });
    await assert.rejects(store.createRoom({ name: '第四間', visibility: 'public' }, { clientId: 'client-a', ip: '10.0.0.1' }), /CREATE_LIMITED/);
    now += 86_400_001;
    assert.equal(store.expireDueRooms(new Set([a.room.roomCode])).pending.includes(a.room.roomCode), true);
    assert.equal(store.lookup(a.room.roomCode), null, 'pending rooms are hidden');
    store.recordDelivered(a.room.roomCode, now);
    assert.equal(store.lookup(a.room.roomCode).roomCode, a.room.roomCode, 'delivery revives pending room');
    now += 86_400_001;
    store.expireDueRooms(new Set([a.room.roomCode]));
    assert.equal(store.finalizePendingIfEmpty(a.room.roomCode), true);
    assert.equal(store.lookup(a.room.roomCode), null);
    store.close();
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });
});
