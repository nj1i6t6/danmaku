'use strict';

const { RingBuffer } = require('./ring-buffer');
const { FairRoomQueue, DeliveryBudget } = require('./queue');
const { fail } = require('./errors');
const { removeRoom: removeDedupRoom } = require('../protection/dedup');

class RoomRuntime {
  constructor({ io, store, now = Date.now, timers = globalThis }) {
    this.io = io;
    this.store = store;
    this.now = now;
    this.timers = timers;
    this.rooms = new Map();
    this.socketRooms = new Map();
    this.pendingActivity = new Map();
    this.budget = new DeliveryBudget({ rate: 20_000, burst: 40_000, now });
    this.intervals = [];
  }

  start() {
    this.intervals.push(this.timers.setInterval(() => this.drain(), 50));
    this.intervals.push(this.timers.setInterval(() => this.flushActivity(), 30_000));
    this.intervals.push(this.timers.setInterval(() => this.expireRooms(), 3_600_000));
    this.intervals.push(this.timers.setInterval(() => this.pushCounts(), 5_000));
    for (const timer of this.intervals) timer.unref?.();
  }

  _room(roomCode) {
    let runtime = this.rooms.get(roomCode);
    if (runtime) return runtime;
    const row = this.store.internal(roomCode);
    if (!row || row.deleted_at != null) return null;
    const system = row.type === 'system';
    runtime = {
      roomCode,
      users: new Map(),
      history: new RingBuffer(200),
      queue: new FairRoomQueue({
        rate: system ? 10 : 5,
        burst: system ? 20 : 10,
        maxSize: system ? 50 : 25,
        ttlMs: 5000,
        now: this.now,
        budget: this.budget,
        deliver: (item) => this._deliver(runtime, item),
        status: (item, state) => this.io.to(item.socketId).emit('barrage-status', {
          messageId: item.messageId,
          status: state,
          ...(state === 'expired' ? { error: { code: 'QUEUE_EXPIRED', message: 'queued message expired' } } : {}),
        }),
      }),
    };
    this.rooms.set(roomCode, runtime);
    return runtime;
  }

  count(roomCode) { return this.rooms.get(roomCode)?.users.size || 0; }
  history(roomCode) { return this.rooms.get(roomCode)?.history.getAll() || []; }
  onlineCounts() { return new Map([...this.rooms].map(([code, room]) => [code, room.users.size])); }
  occupiedCodes() { return new Set([...this.rooms].filter(([, room]) => room.users.size).map(([code]) => code)); }

  _dropRuntime(roomCode, reason) {
    const runtime = this.rooms.get(roomCode);
    removeDedupRoom(roomCode);
    if (!runtime) {
      this.pendingActivity.delete(roomCode);
      return false;
    }
    this.io.to(roomCode).emit('room-deleted', { roomCode, reason });
    for (const socketId of runtime.users.keys()) {
      this.socketRooms.delete(socketId);
      this.io.sockets?.sockets?.get(socketId)?.leave(roomCode);
    }
    runtime.queue.clear();
    this.pendingActivity.delete(roomCode);
    this.rooms.delete(roomCode);
    return true;
  }

  join(socket, roomCode, clientId) {
    const row = this.store.internal(roomCode);
    if (!row || row.deleted_at != null || row.pending_delete_at != null) {
      fail('ROOM_NOT_FOUND', 'room not found');
    }
    const runtime = this._room(roomCode);
    if (!runtime) fail('ROOM_NOT_FOUND', 'room not found');
    const previous = this.socketRooms.get(socket.id);
    const alreadyMember = previous === roomCode && runtime.users.has(socket.id);
    if (!alreadyMember && runtime.users.size >= row.capacity) {
      fail('ROOM_FULL', 'room is full');
    }
    if (previous && previous !== roomCode) this.leave(socket);
    runtime.users.set(socket.id, clientId);
    this.socketRooms.set(socket.id, roomCode);
    socket.join(roomCode);
    this._pushCount(runtime);
    return { count: runtime.users.size, recentMessages: runtime.history.getAll() };
  }

  leave(socket) {
    const roomCode = this.socketRooms.get(socket.id);
    if (!roomCode) return null;
    const runtime = this.rooms.get(roomCode);
    this.socketRooms.delete(socket.id);
    socket.leave(roomCode);
    if (runtime) {
      runtime.users.delete(socket.id);
      runtime.queue.cancelSocket(socket.id);
      this._pushCount(runtime);
      if (runtime.users.size === 0 && this.store.isPending(roomCode)) {
        this.store.finalizePendingIfEmpty(roomCode);
        this._dropRuntime(roomCode, 'expired');
      }
    }
    return roomCode;
  }

  submit(socket, clientId, message) {
    const roomCode = this.socketRooms.get(socket.id);
    if (!roomCode) return null;
    const runtime = this.rooms.get(roomCode);
    message.roomCode = roomCode;
    if (message.message) message.message.roomCode = roomCode;
    return runtime.queue.submit({
      ...message,
      clientId,
      socketId: socket.id,
      recipientCount: () => runtime.users.size,
    });
  }

  _deliver(runtime, item) {
    const deliveredAt = this.now();
    const message = { ...item.message, timestamp: deliveredAt };
    runtime.history.push(message);
    for (const socketId of runtime.users.keys()) {
      this.io.to(socketId).emit('barrage', { ...message, mine: socketId === item.socketId });
    }
    if (this.store.isPending(runtime.roomCode)) this.store.recordDelivered(runtime.roomCode, deliveredAt);
    else this.pendingActivity.set(runtime.roomCode, deliveredAt);
  }

  drain() { for (const room of this.rooms.values()) room.queue.drain(); }

  flushActivityFor(roomCode) {
    if (!this.pendingActivity.has(roomCode)) return false;
    const at = this.pendingActivity.get(roomCode);
    const recorded = this.store.recordDelivered(roomCode, at);
    if (this.pendingActivity.get(roomCode) === at) this.pendingActivity.delete(roomCode);
    return recorded;
  }

  flushActivity() {
    if (!this.pendingActivity.size) return 0;
    const pending = [...this.pendingActivity];
    let flushed = 0;
    for (const [roomCode] of pending) if (this.flushActivityFor(roomCode)) flushed += 1;
    return flushed;
  }

  lazyExpire(roomCode) {
    this.flushActivityFor(roomCode);
    const occupied = this.count(roomCode) > 0;
    const available = this.store.lazyExpire(roomCode, occupied);
    if (!available && !occupied) this._dropRuntime(roomCode, 'expired');
    return available;
  }

  expireRooms() {
    this.flushActivity();
    const result = this.store.expireDueRooms(this.occupiedCodes());
    for (const code of result.deleted) this._dropRuntime(code, 'expired');
    return result;
  }

  delete(roomCode) {
    this._dropRuntime(roomCode, 'owner_deleted');
  }

  _pushCount(runtime) {
    this.io.to(runtime.roomCode).emit('room-count', { roomCode: runtime.roomCode, count: runtime.users.size, capacity: this.store.internal(runtime.roomCode)?.capacity || 0 });
  }
  pushCounts() { for (const room of this.rooms.values()) if (room.users.size) this._pushCount(room); }

  stop() {
    for (const timer of this.intervals) this.timers.clearInterval(timer);
    this.intervals = [];
    this.flushActivity();
    for (const room of this.rooms.values()) room.queue.clear();
    this.rooms.clear();
    this.socketRooms.clear();
  }
}

module.exports = { RoomRuntime };
