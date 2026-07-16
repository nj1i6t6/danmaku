'use strict';

const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const { normalizeRoomInput, normalizeRoomUpdate } = require('./validation');
const { hashSecret, issueCredential, passwordDigest, safeEqual, verifyPassword } = require('./credentials');
const { fail } = require('./errors');

const DAY_MS = 86_400_000;
const DEFAULT_CAPACITY = 1000;
const CUSTOM_CAPACITY = 100;

function nullableBuffer(value) {
  return value == null ? null : value;
}

async function boundedPasswordOperation(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error?.code === 'KDF_BUSY') fail('ROOM_BUSY', 'password processing is busy');
    throw error;
  }
}

class RoomStore {
  constructor({ filename, database, now = Date.now, codeFactory, uuidFactory = crypto.randomUUID } = {}) {
    if (!database && !filename) throw new TypeError('RoomStore requires filename or database');
    this.db = database || new Database(filename);
    this.ownsDatabase = !database;
    this.now = now;
    this.codeFactory = codeFactory || (() => String(crypto.randomInt(0, 100_000_000)).padStart(8, '0'));
    this.uuidFactory = uuidFactory;
    this.db.pragma('foreign_keys = ON');
    if (!database) this.db.pragma('journal_mode = WAL');
    this._migrate();
    this._seedDefault();
    this._loadOwnerIndex();
  }

  _loadOwnerIndex() {
    this.ownerHashes = new Map();
    this.pendingOwnerHashes = new Map();
    const rows = this.db.prepare(`
      SELECT room_code, owner_hash, pending_delete_at FROM rooms
      WHERE type='custom' AND owner_hash IS NOT NULL AND deleted_at IS NULL
    `).all();
    for (const row of rows) {
      const index = row.pending_delete_at == null ? this.ownerHashes : this.pendingOwnerHashes;
      index.set(row.room_code, row.owner_hash);
    }
  }

  _markOwnerPending(roomCode) {
    const ownerHash = this.ownerHashes.get(roomCode);
    if (!ownerHash) return;
    this.ownerHashes.delete(roomCode);
    this.pendingOwnerHashes.set(roomCode, ownerHash);
  }

  _restorePendingOwner(roomCode) {
    const ownerHash = this.pendingOwnerHashes.get(roomCode);
    if (!ownerHash) return;
    this.pendingOwnerHashes.delete(roomCode);
    this.ownerHashes.set(roomCode, ownerHash);
  }

  _forgetOwner(roomCode) {
    this.ownerHashes.delete(roomCode);
    this.pendingOwnerHashes.delete(roomCode);
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        room_code TEXT NOT NULL UNIQUE CHECK(length(room_code)=8),
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('system','custom')),
        visibility TEXT NOT NULL CHECK(visibility IN ('public','unlisted')),
        capacity INTEGER NOT NULL,
        retention_days INTEGER CHECK(retention_days IN (1,3,7) OR retention_days IS NULL),
        password_salt BLOB,
        password_hash BLOB,
        owner_hash BLOB,
        creator_client_hash BLOB,
        creator_ip_hash BLOB,
        created_at INTEGER NOT NULL,
        last_message_at INTEGER,
        pending_delete_at INTEGER,
        deleted_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS room_code_tombstones (
        room_code TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rooms_active ON rooms(deleted_at, pending_delete_at, visibility);
      CREATE INDEX IF NOT EXISTS idx_rooms_creator_client ON rooms(creator_client_hash, created_at);
      CREATE INDEX IF NOT EXISTS idx_rooms_creator_ip ON rooms(creator_ip_hash, created_at);
    `);
  }

  _allocateCode() {
    for (let attempts = 0; attempts < 1000; attempts += 1) {
      const code = this.codeFactory();
      if (!/^\d{8}$/.test(code)) throw new TypeError('codeFactory must return eight digits');
      const used = this.db.prepare('SELECT 1 FROM room_code_tombstones WHERE room_code=?').get(code);
      if (!used) return code;
    }
    fail('ROOM_BUSY', 'unable to allocate a room code');
  }

  _seedDefault() {
    const existingId = this.db.prepare("SELECT value FROM room_metadata WHERE key='default_room_id'").get();
    if (existingId && this.db.prepare('SELECT 1 FROM rooms WHERE room_id=?').get(existingId.value)) return;
    const roomId = this.uuidFactory();
    const roomCode = this._allocateCode();
    const now = this.now();
    const seed = this.db.transaction(() => {
      this.db.prepare('INSERT INTO room_code_tombstones(room_code,created_at) VALUES (?,?)').run(roomCode, now);
      this.db.prepare(`INSERT INTO rooms
        (room_id,room_code,name,type,visibility,capacity,retention_days,created_at)
        VALUES (?,?,?,'system','public',?,NULL,?)`).run(roomId, roomCode, '預設', DEFAULT_CAPACITY, now);
      this.db.prepare("INSERT OR REPLACE INTO room_metadata(key,value) VALUES ('default_room_id',?)").run(roomId);
    });
    seed();
  }

  _row(code, { includeUnavailable = false } = {}) {
    const suffix = includeUnavailable ? '' : ' AND deleted_at IS NULL AND pending_delete_at IS NULL';
    return this.db.prepare(`SELECT * FROM rooms WHERE room_code=?${suffix}`).get(code);
  }

  _public(row, onlineCount = 0, { includeId = false } = {}) {
    if (!row) return null;
    const expiresAt = row.retention_days == null
      ? null
      : new Date((row.last_message_at == null ? row.created_at : row.last_message_at) + row.retention_days * DAY_MS).toISOString();
    const result = {
      roomCode: row.room_code,
      name: row.name,
      visibility: row.visibility,
      capacity: row.capacity,
      retentionDays: row.retention_days,
      passwordRequired: Boolean(row.password_hash),
      requiresPassword: Boolean(row.password_hash),
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
      expiresAt,
      onlineCount,
      count: onlineCount,
    };
    if (includeId) {
      result.roomId = row.room_id;
      result.isSystem = row.type === 'system';
    }
    return result;
  }

  getDefaultRoom() {
    const meta = this.db.prepare("SELECT value FROM room_metadata WHERE key='default_room_id'").get();
    return this._public(this.db.prepare('SELECT * FROM rooms WHERE room_id=?').get(meta.value), 0, { includeId: true });
  }

  _assertCreateQuota(actor, at = this.now()) {
    const since = at - DAY_MS;
    const clientHash = hashSecret(actor.clientId.trim());
    const ipHash = hashSecret(actor.ip);
    const recentClient = this.db.prepare('SELECT count(*) n FROM rooms WHERE type=\'custom\' AND creator_client_hash=? AND created_at>?').get(clientHash, since).n;
    const recentIp = this.db.prepare('SELECT count(*) n FROM rooms WHERE type=\'custom\' AND creator_ip_hash=? AND created_at>?').get(ipHash, since).n;
    const activeClient = this.db.prepare('SELECT count(*) n FROM rooms WHERE type=\'custom\' AND creator_client_hash=? AND deleted_at IS NULL').get(clientHash).n;
    const activeGlobal = this.db.prepare("SELECT count(*) n FROM rooms WHERE type='custom' AND deleted_at IS NULL").get().n;
    if (recentClient >= 3) fail('CREATE_LIMITED', 'client may create three rooms per 24 hours');
    if (recentIp >= 20) fail('CREATE_LIMITED', 'IP may create twenty rooms per 24 hours');
    if (activeClient >= 10) fail('CREATE_LIMITED', 'client may own ten active rooms');
    if (activeGlobal >= 1000) fail('CREATE_LIMITED', 'site room limit reached');
    return { clientHash, ipHash };
  }

  async createRoom(input, actor) {
    const normalized = normalizeRoomInput(input);
    if (!actor || typeof actor.clientId !== 'string' || !actor.clientId.trim() || typeof actor.ip !== 'string' || !actor.ip) {
      fail('VALIDATION_ERROR', 'stable clientId and IP are required');
    }
    this._assertCreateQuota(actor);
    const ownerCredential = actor.ownerCredential === undefined ? issueCredential() : actor.ownerCredential;
    if (typeof ownerCredential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ownerCredential)) {
      fail('VALIDATION_ERROR', 'invalid owner credential');
    }
    const ownerHash = hashSecret(ownerCredential);
    const password = normalized.password ? await boundedPasswordOperation(() => passwordDigest(normalized.password)) : { salt: null, hash: null };
    let created;
    this.db.transaction(() => {
      const now = this.now();
      const { clientHash, ipHash } = this._assertCreateQuota(actor, now);
      const roomId = this.uuidFactory();
      const roomCode = this._allocateCode();
      this.db.prepare('INSERT INTO room_code_tombstones(room_code,created_at) VALUES (?,?)').run(roomCode, now);
      this.db.prepare(`INSERT INTO rooms
       (room_id,room_code,name,type,visibility,capacity,retention_days,password_salt,password_hash,owner_hash,creator_client_hash,creator_ip_hash,created_at)
       VALUES (?,?,?,'custom',?,?,?,?,?,?,?,?,?)`).run(
        roomId, roomCode, normalized.name, normalized.visibility, CUSTOM_CAPACITY, normalized.retentionDays,
        nullableBuffer(password.salt), nullableBuffer(password.hash), ownerHash, clientHash, ipHash, now,
      );
      created = { room: this._public(this._row(roomCode), 0, { includeId: true }), ownerCredential };
    })();
    this.ownerHashes.set(created.room.roomCode, ownerHash);
    return created;
  }

  lookup(roomCode, onlineCount = 0) {
    if (typeof roomCode !== 'string' || !/^\d{8}$/.test(roomCode)) return null;
    return this._public(this._row(roomCode), onlineCount);
  }

  async verifyPassword(roomCode, password) {
    const row = this._row(roomCode);
    if (!row) return false;
    if (!row.password_hash) return true;
    return boundedPasswordOperation(() => verifyPassword(password, row.password_salt, row.password_hash));
  }

  isOwner(roomCode, credential) {
    const expectedHash = this.ownerHashes.get(roomCode);
    if (!expectedHash || typeof credential !== 'string') return false;
    return safeEqual(hashSecret(credential), expectedHash);
  }

  _assertOwnerHash(row, providedHash) {
    if (!row) fail('ROOM_NOT_FOUND', 'room not found');
    if (row.type === 'system') fail('FORBIDDEN', 'system room cannot be managed');
    if (!providedHash || !safeEqual(providedHash, row.owner_hash)) fail('FORBIDDEN', 'invalid owner credential');
  }

  _assertOwner(row, credential) {
    this._assertOwnerHash(row, typeof credential === 'string' ? hashSecret(credential) : null);
  }

  async _updateRoom(row, changes) {
    const current = { name: row.name, visibility: row.visibility, password: row.password_hash ? '__existing__' : null };
    const next = normalizeRoomUpdate(changes, current);
    let salt = row.password_salt;
    let hash = row.password_hash;
    if (Object.hasOwn(changes, 'password')) {
      if (next.password === null) {
        salt = null; hash = null;
      } else {
        const digest = await boundedPasswordOperation(() => passwordDigest(next.password));
        salt = digest.salt; hash = digest.hash;
      }
    }
    this.db.prepare('UPDATE rooms SET name=?,visibility=?,password_salt=?,password_hash=? WHERE room_code=?').run(next.name, next.visibility, salt, hash, row.room_code);
    return this._public(this._row(row.room_code));
  }

  async updateRoom(roomCode, changes, credential) {
    const row = this._row(roomCode);
    this._assertOwner(row, credential);
    return this._updateRoom(row, changes);
  }

  async updateRoomByOwnerHash(roomCode, changes, ownerHash) {
    const row = this._row(roomCode);
    this._assertOwnerHash(row, ownerHash);
    return this._updateRoom(row, changes);
  }

  deleteRoom(roomCode, credential) {
    const row = this._row(roomCode, { includeUnavailable: true });
    this._assertOwner(row, credential);
    return this._deleteRow(row);
  }

  deleteRoomByOwnerHash(roomCode, ownerHash) {
    const row = this._row(roomCode, { includeUnavailable: true });
    this._assertOwnerHash(row, ownerHash);
    return this._deleteRow(row);
  }

  _deleteRow(row) {
    if (row.deleted_at == null) this.db.prepare('UPDATE rooms SET deleted_at=?,pending_delete_at=NULL WHERE room_code=?').run(this.now(), row.room_code);
    this._forgetOwner(row.room_code);
    return true;
  }

  listPublic({ query = '', page = 1, pageSize = 20, onlineCounts = new Map() } = {}) {
    page = Number.isInteger(page) && page > 0 ? page : 1;
    pageSize = Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 20) : 20;
    const q = typeof query === 'string' ? query.normalize('NFKC').trim() : '';
    let rows = this.db.prepare("SELECT * FROM rooms WHERE visibility='public' AND deleted_at IS NULL AND pending_delete_at IS NULL").all();
    if (q) {
      const lower = q.toLocaleLowerCase();
      rows = rows.filter((row) => row.room_code === q || row.name.toLocaleLowerCase().includes(lower));
    }
    rows.sort((a, b) => {
      const online = (onlineCounts.get(b.room_code) || 0) - (onlineCounts.get(a.room_code) || 0);
      if (online) return online;
      return (b.last_message_at || b.created_at) - (a.last_message_at || a.created_at);
    });
    const total = rows.length;
    const start = (page - 1) * pageSize;
    return { items: rows.slice(start, start + pageSize).map((row) => this._public(row, onlineCounts.get(row.room_code) || 0)), page, pageSize, total };
  }

  activityAt(row) {
    return row.last_message_at == null ? row.created_at : row.last_message_at;
  }

  isExpired(row, now = this.now()) {
    return row && row.type === 'custom' && row.retention_days != null && now - this.activityAt(row) >= row.retention_days * DAY_MS;
  }

  lazyExpire(roomCode, occupied = false) {
    const row = this._row(roomCode, { includeUnavailable: true });
    if (!row || row.deleted_at != null || !this.isExpired(row)) return row?.deleted_at == null;
    if (occupied) {
      this.db.prepare('UPDATE rooms SET pending_delete_at=COALESCE(pending_delete_at,?) WHERE room_code=?').run(this.now(), roomCode);
      this._markOwnerPending(roomCode);
    } else {
      this.db.prepare('UPDATE rooms SET deleted_at=?,pending_delete_at=NULL WHERE room_code=?').run(this.now(), roomCode);
      this._forgetOwner(roomCode);
    }
    return false;
  }

  expireDueRooms(occupiedCodes = new Set()) {
    const result = { deleted: [], pending: [] };
    const rows = this.db.prepare("SELECT * FROM rooms WHERE type='custom' AND deleted_at IS NULL").all();
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        if (!this.isExpired(row)) continue;
        if (occupiedCodes.has(row.room_code)) {
          this.db.prepare('UPDATE rooms SET pending_delete_at=COALESCE(pending_delete_at,?) WHERE room_code=?').run(this.now(), row.room_code);
          result.pending.push(row.room_code);
        } else {
          this.db.prepare('UPDATE rooms SET deleted_at=?,pending_delete_at=NULL WHERE room_code=?').run(this.now(), row.room_code);
          result.deleted.push(row.room_code);
        }
      }
    });
    tx();
    for (const roomCode of result.pending) this._markOwnerPending(roomCode);
    for (const roomCode of result.deleted) this._forgetOwner(roomCode);
    return result;
  }

  recordDelivered(roomCode, at = this.now()) {
    const result = this.db.prepare('UPDATE rooms SET last_message_at=?,pending_delete_at=NULL WHERE room_code=? AND deleted_at IS NULL').run(at, roomCode);
    if (result.changes === 1) this._restorePendingOwner(roomCode);
    return result.changes === 1;
  }

  finalizePendingIfEmpty(roomCode) {
    const result = this.db.prepare('UPDATE rooms SET deleted_at=?,pending_delete_at=NULL WHERE room_code=? AND pending_delete_at IS NOT NULL AND deleted_at IS NULL').run(this.now(), roomCode);
    if (result.changes === 1) this._forgetOwner(roomCode);
    return result.changes === 1;
  }

  isPending(roomCode) {
    const row = this._row(roomCode, { includeUnavailable: true });
    return Boolean(row && row.deleted_at == null && row.pending_delete_at != null);
  }

  internal(roomCode) {
    return this._row(roomCode, { includeUnavailable: true });
  }

  close() {
    if (this.ownsDatabase && this.db.open) this.db.close();
  }
}

module.exports = { RoomStore, DAY_MS, DEFAULT_CAPACITY, CUSTOM_CAPACITY };
