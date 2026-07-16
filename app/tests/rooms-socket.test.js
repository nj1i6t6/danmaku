'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io: clientIo } = require('socket.io-client');
const { createServer } = require('../server');
const { reset: resetDedup, roomBufferCount } = require('../protection/dedup');

function ack(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 2000);
    socket.emit(event, payload, (value) => { clearTimeout(timer); resolve(value); });
  });
}
function connect(url, auth, extraHeaders, { transports = ['websocket'], timeoutMs = 2_000 } = {}) {
  const socket = clientIo(url, { transports, forceNew: true, auth, extraHeaders, reconnection: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`connect timeout: ${auth?.clientId || 'unknown client'}`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(error);
    });
  });
}

test('live Socket.IO rejects a disallowed browser Origin before connection', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-origin-'));
  const service = createServer({ dbPath: path.join(dir, 'test.db'), port: 0, logger: { log() {}, warn() {}, error() {} } });
  const address = await service.listen();
  const socket = clientIo(`http://127.0.0.1:${address.port}`, {
    transports: ['websocket'], forceNew: true, reconnection: false,
    auth: { clientId: 'evil-origin', platform: 'web' },
    extraHeaders: { Origin: 'https://evil.example' },
  });
  t.after(async () => {
    socket.disconnect();
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const connected = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('origin admission timeout')), 2_000);
    socket.once('connect', () => { clearTimeout(timer); resolve(true); });
    socket.once('connect_error', () => { clearTimeout(timer); resolve(false); });
  });
  assert.equal(connected, false);
});

test('live Socket.IO accepts an injected extension origin as the extension platform', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-extension-origin-'));
  const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
  const service = createServer({
    dbPath: path.join(dir, 'test.db'),
    port: 0,
    extensionOrigins: new Set([extensionOrigin]),
    logger: { log() {}, warn() {}, error() {} },
  });
  const address = await service.listen();
  let socket;
  t.after(async () => {
    socket?.disconnect();
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  socket = await connect(
    `http://127.0.0.1:${address.port}`,
    { clientId: 'extension-origin-client', platform: 'extension' },
    { Origin: extensionOrigin },
  );

  const serverSocket = [...service.io.sockets.sockets.values()][0];
  assert.equal(serverSocket.data.platform, 'extension');
  const created = await ack(socket, 'room-create', { name: '擴充功能房間', visibility: 'unlisted' });
  assert.equal(created.ok, true);
  assert.match(created.ownerCredential, /^[A-Za-z0-9_-]{43}$/);
});

test('live Socket.IO rejects extension platform and Origin mismatches before connection', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-extension-platform-'));
  const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
  const service = createServer({
    dbPath: path.join(dir, 'test.db'),
    port: 0,
    extensionOrigins: new Set([extensionOrigin]),
    logger: { log() {}, warn() {}, error() {} },
  });
  const address = await service.listen();
  const sockets = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const attempts = [
    {
      auth: { clientId: 'extension-origin-windows-claim', platform: 'windows' },
      extraHeaders: { Origin: extensionOrigin },
    },
    {
      auth: { clientId: 'native-origin-extension-claim', platform: 'extension' },
      extraHeaders: undefined,
    },
  ];
  for (const options of attempts) {
    const socket = clientIo(`http://127.0.0.1:${address.port}`, {
      transports: ['websocket'], forceNew: true, reconnection: false, ...options,
    });
    sockets.push(socket);
    const connected = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('platform admission timeout')), 2_000);
      socket.once('connect', () => { clearTimeout(timer); resolve(true); });
      socket.once('connect_error', () => { clearTimeout(timer); resolve(false); });
    });
    assert.equal(connected, false);
  }
});

test('live Socket.IO accepts every Tauri Origin and normalizes the platform to windows', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-tauri-origin-'));
  const service = createServer({
    dbPath: path.join(dir, 'test.db'), port: 0,
    logger: { log() {}, warn() {}, error() {} },
  });
  const address = await service.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const sockets = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const [index, origin] of ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'].entries()) {
    const clientId = `tauri-origin-${index}`;
    const socket = await connect(url, { clientId, platform: 'android' }, { Origin: origin });
    sockets.push(socket);
    const serverSocket = [...service.io.sockets.sockets.values()]
      .find((candidate) => candidate.handshake.auth.clientId === clientId);
    assert.equal(serverSocket?.data.platform, 'windows');
  }
});

test('concurrent connection cap rejects one source without consuming global capacity forever', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-connection-cap-'));
  const service = createServer({
    dbPath: path.join(dir, 'test.db'),
    port: 0,
    trustCloudflareProxy: true,
    maxConnectionsPerIp: 2,
    logger: { log() {}, warn() {}, error() {} },
  });
  const address = await service.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const sockets = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const clientId of ['cap-a', 'cap-b']) {
    const socket = await connect(url, { clientId, platform: 'android' }, { 'CF-Connecting-IP': '198.51.100.10' });
    sockets.push(socket);
  }

  const blocked = clientIo(url, {
    transports: ['websocket'], forceNew: true, reconnection: false,
    auth: { clientId: 'cap-c', platform: 'android' },
    extraHeaders: { 'CF-Connecting-IP': '198.51.100.10' },
  });
  sockets.push(blocked);
  const blockedConnected = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connection cap timeout')), 2_000);
    blocked.once('connect', () => { clearTimeout(timer); resolve(true); });
    blocked.once('connect_error', () => { clearTimeout(timer); resolve(false); });
  });
  assert.equal(blockedConnected, false);

  const firstServerSocket = [...service.io.sockets.sockets.values()]
    .find((socket) => socket.handshake.auth.clientId === 'cap-a');
  const serverDisconnected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server disconnect timeout')), 2_000);
    firstServerSocket.once('disconnect', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  sockets[0].disconnect();
  await serverDisconnected;
  const replacement = await connect(
    url,
    { clientId: 'cap-d', platform: 'android' },
    { 'CF-Connecting-IP': '198.51.100.10' },
  );
  sockets.push(replacement);
  assert.equal(replacement.connected, true);
});

test('forged X-Forwarded-For rotation cannot bypass the live create quota', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-forwarded-ip-'));
  const service = createServer({ dbPath: path.join(dir, 'test.db'), port: 0, logger: { log() {}, warn() {}, error() {} } });
  const address = await service.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const sockets = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 21; i++) {
    const socket = await connect(url, { clientId: `spoofed-ip-${i}`, platform: 'android' }, { 'X-Forwarded-For': `198.51.100.${i + 1}` });
    sockets.push(socket);
    const created = await ack(socket, 'room-create', { name: `來源限制房${String(i).padStart(2, '0')}`, visibility: 'public' });
    if (i < 20) assert.equal(created.ok, true);
    else {
      assert.equal(created.ok, false);
      assert.equal(created.error.code, 'CREATE_LIMITED');
    }
  }
});

test('reports deduplicate each trusted source and hide only after three distinct sources', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-report-sources-'));
  const service = createServer({
    dbPath: path.join(dir, 'test.db'), port: 0, trustCloudflareProxy: true,
    logger: { log() {}, warn() {}, error() {} },
  });
  const address = await service.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const sockets = [];
  const open = async (clientId, ip) => {
    const socket = await connect(url, { clientId, platform: 'android' }, { 'CF-Connecting-IP': ip });
    sockets.push(socket);
    return socket;
  };
  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const owner = await open('report-owner', '198.51.100.10');
  const created = await ack(owner, 'room-create', { name: '可信檢舉房', visibility: 'public' });
  const roomCode = created.room.roomCode;
  const [first, sameSource, second, third] = await Promise.all([
    open('report-a', '198.51.100.11'), open('report-a-rotated', '198.51.100.11'),
    open('report-b', '198.51.100.12'), open('report-c', '198.51.100.13'),
  ]);
  for (const socket of [first, sameSource, second, third]) assert.equal((await ack(socket, 'join-room', { roomCode })).ok, true);
  const sent = await ack(owner, 'barrage', { text: '可被檢舉的內容' });
  assert.equal(sent.status, 'sent');
  assert.equal((await ack(first, 'report', { messageId: sent.messageId })).ok, true);
  const duplicate = await ack(sameSource, 'report', { messageId: sent.messageId });
  assert.equal(duplicate.error.code, 'REPORT_DUPLICATE');
  assert.equal((await ack(second, 'report', { messageId: sent.messageId })).ok, true);
  const hidden = new Promise((resolve) => owner.once('hide-message', resolve));
  assert.equal((await ack(third, 'report', { messageId: sent.messageId })).ok, true);
  assert.deepEqual(await hidden, { roomCode, messageId: sent.messageId, reason: 'multiple reports' });
});

test('successful delivery refreshes lazy expiry and public listing cleans expired runtime', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-expiry-runtime-'));
  let now = 1_000;
  const service = createServer({
    dbPath: path.join(dir, 'test.db'),
    port: 0,
    now: () => now,
    logger: { log() {}, warn() {}, error() {} },
  });
  const address = await service.listen();
  const socket = await connect(`http://127.0.0.1:${address.port}`, { clientId: 'expiry-owner', platform: 'android' });
  t.after(async () => {
    socket.disconnect();
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const active = await ack(socket, 'room-create', { name: '期限更新房', visibility: 'public', retentionDays: 1 });
  const activeCode = active.room.roomCode;
  now += 86_400_001;
  assert.equal((await ack(socket, 'barrage', { text: '到期邊界成功送達' })).status, 'sent');
  assert.equal((await ack(socket, 'leave-room')).ok, true);
  assert.equal((await ack(socket, 'room-lookup', { roomCode: activeCode })).ok, true,
    'pending in-memory activity must be flushed before lazy expiry');
  assert.equal(service.store.internal(activeCode).last_message_at, now);

  const expired = await ack(socket, 'room-create', { name: '應消失公開房', visibility: 'public', retentionDays: 1 });
  const expiredCode = expired.room.roomCode;
  assert.equal((await ack(socket, 'leave-room')).ok, true);
  assert.equal(service.runtime.rooms.has(expiredCode), true, 'create allocates runtime state');
  now += 86_400_001;
  const listed = await ack(socket, 'room-list-public', { page: 1, pageSize: 20 });
  assert.equal(listed.data.some((room) => room.roomCode === expiredCode), false);
  assert.equal(service.runtime.rooms.has(expiredCode), false, 'list expiry sweep must release queue/history runtime');
});

test('queued barrage uses delivery time in broadcast and ring buffer', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-queued-time-'));
  let now = 1_000;
  const service = createServer({
    dbPath: path.join(dir, 'test.db'), port: 0, now: () => now,
    logger: { log() {}, warn() {}, error() {} },
  });
  const address = await service.listen();
  const socket = await connect(`http://127.0.0.1:${address.port}`, { clientId: 'queued-time', platform: 'android' });
  t.after(async () => {
    socket.disconnect();
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const created = await ack(socket, 'room-create', { name: '排隊時間房', visibility: 'public' });
  const roomCode = created.room.roomCode;
  const runtimeRoom = service.runtime.rooms.get(roomCode);
  runtimeRoom.queue.bucket.tokens = 0;
  runtimeRoom.queue.bucket.updatedAt = now;
  const delivery = new Promise((resolve) => socket.once('barrage', resolve));
  const queued = await ack(socket, 'barrage', { text: '稍後送達' });
  assert.equal(queued.status, 'queued');
  now = 2_000;
  service.runtime.drain();
  const message = await delivery;
  assert.equal(message.timestamp, 2_000);
  assert.equal(service.runtime.history(roomCode).at(-1).timestamp, 2_000);
});

test('password joins recheck capacity atomically after asynchronous verification', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-join-capacity-'));
  const service = createServer({ dbPath: path.join(dir, 'test.db'), port: 0, logger: { log() {}, warn() {}, error() {} } });
  const address = await service.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const sockets = [];
  const open = async (clientId) => {
    const socket = await connect(url, { clientId, platform: 'android' });
    sockets.push(socket);
    return socket;
  };
  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const owner = await open('join-capacity-owner');
  const created = await ack(owner, 'room-create', {
    name: '並發容量房', visibility: 'unlisted', password: 'secret1',
  });
  const roomCode = created.room.roomCode;
  const runtimeRoom = service.runtime.rooms.get(roomCode);
  for (let i = 0; i < 98; i += 1) runtimeRoom.users.set(`seed-${i}`, `seed-client-${i}`);
  assert.equal(runtimeRoom.users.size, 99);

  const joiners = await Promise.all(Array.from({ length: 8 }, (_, i) => open(`join-capacity-${i}`)));
  const results = await Promise.all(joiners.map((socket) => ack(socket, 'join-room', { roomCode, password: 'secret1' })));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.error?.code === 'ROOM_FULL').length, 7);
  assert.equal(service.runtime.count(roomCode), 100);
});

test('password join rejects a room that becomes pending while KDF is running', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-join-expiry-'));
  let now = 1_000;
  const service = createServer({
    dbPath: path.join(dir, 'test.db'), port: 0, now: () => now,
    logger: { log() {}, warn() {}, error() {} },
  });
  const address = await service.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const owner = await connect(url, { clientId: 'join-expiry-owner', platform: 'android' });
  const joiner = await connect(url, { clientId: 'join-expiry-peer', platform: 'android' });
  t.after(async () => {
    owner.disconnect();
    joiner.disconnect();
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const created = await ack(owner, 'room-create', {
    name: '驗證途中到期房', visibility: 'unlisted', password: 'secret1', retentionDays: 1,
  });
  const roomCode = created.room.roomCode;
  const originalVerify = service.store.verifyPassword.bind(service.store);
  let releaseVerification;
  let verificationStarted;
  const started = new Promise((resolve) => { verificationStarted = resolve; });
  const release = new Promise((resolve) => { releaseVerification = resolve; });
  service.store.verifyPassword = async (...args) => {
    verificationStarted();
    await release;
    return originalVerify(...args);
  };

  const pendingJoin = ack(joiner, 'join-room', { roomCode, password: 'secret1' });
  await started;
  now += 86_400_001;
  const expiry = service.runtime.expireRooms();
  assert.equal(expiry.pending.includes(roomCode), true);
  releaseVerification();
  const result = await pendingJoin;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ROOM_NOT_FOUND');
  assert.equal(service.runtime.count(roomCode), 1);
});

test('graceful close drains an in-flight password command before closing SQLite', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-close-kdf-'));
  const loggerErrors = [];
  const service = createServer({
    dbPath: path.join(dir, 'test.db'), port: 0,
    logger: { log() {}, warn() {}, error(...args) { loggerErrors.push(args.map(String).join(' ')); } },
  });
  const address = await service.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const owner = await connect(url, { clientId: 'close-kdf-owner', platform: 'android' });
  const joiner = await connect(url, { clientId: 'close-kdf-peer', platform: 'android' });
  let closed = false;
  t.after(async () => {
    owner.disconnect();
    joiner.disconnect();
    if (!closed) await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const created = await ack(owner, 'room-create', {
    name: '關閉驗證房', visibility: 'unlisted', password: 'secret1',
  });
  const originalVerify = service.store.verifyPassword.bind(service.store);
  let releaseVerification;
  let verificationStarted;
  const started = new Promise((resolve) => { verificationStarted = resolve; });
  const release = new Promise((resolve) => { releaseVerification = resolve; });
  service.store.verifyPassword = async (...args) => {
    verificationStarted();
    await release;
    return originalVerify(...args);
  };

  joiner.emit('join-room', { roomCode: created.room.roomCode, password: 'secret1' }, () => {});
  await started;
  const closing = service.close().then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const closedBeforeRelease = closed;
  releaseVerification();
  await closing;
  assert.equal(closedBeforeRelease, false, 'close must wait for the active command');
  assert.deepEqual(loggerErrors, []);
});

test('canonical Socket.IO room contract uses temporary DB/port and ack authority', async (t) => {
  resetDedup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-server-'));
  const service = createServer({ dbPath: path.join(dir, 'test.db'), port: 0, logger: { log() {}, warn() {}, error() {} } });
  const address = await service.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const owner = await connect(url, { clientId: 'native-owner', platform: 'android' });
  const peer = await connect(url, { clientId: 'native-peer', platform: 'windows' });
  t.after(async () => {
    owner.disconnect(); peer.disconnect();
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const defaultRoom = await ack(peer, 'room-default');
  assert.equal(defaultRoom.ok, true);
  assert.equal(defaultRoom.room.name, '預設');
  assert.equal(defaultRoom.room.capacity, 1000);
  assert.equal(defaultRoom.room.retentionDays, null);

  const invalidLegacy = await ack(owner, 'join-room', { symbol: 'TWSE:2330' });
  assert.equal(invalidLegacy.ok, false);
  assert.equal(invalidLegacy.error.code, 'VALIDATION_ERROR');
  assert.equal(invalidLegacy.error.scope, 'user');
  assert.equal((await ack(owner, 'barrage', { text: 'hi' })).error.code, 'NOT_IN_ROOM');

  const created = await ack(owner, 'room-create', { name: '整合 房間', visibility: 'unlisted', password: 'secret1', retentionDays: 3 });
  assert.equal(created.ok, true);
  assert.match(created.room.roomCode, /^\d{8}$/);
  assert.ok(created.ownerCredential);
  const roomCode = created.room.roomCode;
  const credential = created.ownerCredential;
  assert.equal(JSON.stringify(created).includes('password_hash'), false);
  const immediate = await ack(owner, 'barrage', { text: '建立後立即發送', nickname: '房主', color: '#ff6600' });
  assert.equal(immediate.ok, true, 'room-create must automatically join the creator');
  assert.equal(immediate.status, 'sent');
  const expanded = await ack(owner, 'barrage', { text: '\uFDFA'.repeat(100) });
  assert.equal(expanded.ok, false);
  assert.equal(expanded.error.code, 'VALIDATION_ERROR');

  assert.equal((await ack(peer, 'room-lookup', { roomCode })).room.passwordRequired, true);
  assert.equal((await ack(peer, 'join-room', { roomCode })).error.code, 'PASSWORD_REQUIRED');
  assert.equal((await ack(peer, 'join-room', { roomCode, password: 'wrongxx' })).error.code, 'INVALID_PASSWORD');
  assert.equal((await ack(peer, 'join-room', { roomCode, password: 'secret1' })).ok, true);
  assert.equal((await ack(owner, 'join-room', { roomCode, password: 'secret1' })).ok, true);
  const nicknameChange = await ack(owner, 'nickname-change', { nickname: '小明' });
  assert.equal(nicknameChange.ok, true);
  assert.equal(nicknameChange.nickname, '小明');

  const received = new Promise((resolve) => peer.once('barrage', resolve));
  const echoed = new Promise((resolve) => owner.once('barrage', resolve));
  const sent = await ack(owner, 'barrage', { text: '<b>安全文字</b>', nickname: '小明', color: '#ff6600' });
  assert.equal(sent.ok, true);
  assert.equal(sent.status, 'sent');
  const [message, mine] = await Promise.all([received, echoed]);
  assert.equal(message.mine, false);
  assert.equal(mine.mine, true);
  assert.equal(message.text.includes('<'), true, 'transport sends text, never rendered server-side HTML');
  assert.ok(message.messageId);

  const shadow = await ack(owner, 'barrage', { text: '請看 http://example.com', nickname: '小明', color: '#ff6600' });
  assert.equal(shadow.ok, true);
  assert.equal(shadow.status, 'sent');
  assert.match(shadow.messageId, /^[0-9a-f-]{36}$/i);

  const report = await ack(peer, 'report', { messageId: message.messageId, reason: '測試檢舉' });
  assert.equal(report.ok, true);
  assert.ok(report.reportId > 0);
  const duplicateReport = await ack(peer, 'report', { messageId: message.messageId, reason: '重複檢舉' });
  assert.equal(duplicateReport.ok, false);
  assert.equal(duplicateReport.error.code, 'REPORT_DUPLICATE');

  assert.equal((await ack(owner, 'room-update', { roomCode, changes: { name: '改名 房間' }, ownerCredential: 'bad' })).error.code, 'FORBIDDEN');
  assert.equal((await ack(owner, 'room-update', { roomCode, changes: { name: '改名 房間', password: null }, ownerCredential: credential })).ok, true);
  assert.equal((await ack(owner, 'room-update', { roomCode, changes: { visibility: 'public' }, ownerCredential: credential })).ok, true);
  const list = await ack(peer, 'room-list-public', { query: roomCode, page: 1, pageSize: 99 });
  assert.equal(list.pagination.pageSize, 20);
  assert.equal(list.data[0].name, '改名 房間');
  assert.equal(JSON.stringify(list).includes('roomId'), false);
  assert.equal(JSON.stringify(list).includes('hash'), false);

  assert.equal((await ack(peer, 'leave-room')).ok, true);
  assert.equal(roomBufferCount(), 1, 'accepted custom-room message must have one dedup buffer');
  const deletedPush = new Promise((resolve) => owner.once('room-deleted', resolve));
  assert.equal((await ack(owner, 'room-delete', { roomCode, ownerCredential: credential })).ok, true);
  const deletion = await deletedPush;
  assert.deepEqual(deletion, { roomCode, reason: 'owner_deleted' });
  assert.equal(roomBufferCount(), 0, 'room deletion must release dedup state');
  assert.equal(service.io.sockets.adapter.rooms.has(roomCode), false,
    'manual deletion must remove stale Socket.IO adapter membership');
  assert.equal((await ack(peer, 'room-lookup', { roomCode })).error.code, 'ROOM_NOT_FOUND');
});

test('room-update rejects malformed or ambiguous password actions without mutating the room', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-password-action-'));
  const service = createServer({
    dbPath: path.join(dir, 'test.db'), port: 0,
    logger: { log() {}, warn() {}, error() {} },
  });
  const address = await service.listen();
  let owner;
  t.after(async () => {
    owner?.disconnect();
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  owner = await connect(`http://127.0.0.1:${address.port}`, {
    clientId: 'password-action-owner', platform: 'android',
  });
  const created = await ack(owner, 'room-create', {
    name: '密碼動作驗證房', visibility: 'unlisted', password: 'initial-secret',
  });
  assert.equal(created.ok, true);

  const malformedUpdates = [
    { passwordAction: { type: 'set' } },
    { passwordAction: { type: 'set', password: null } },
    { password: 'next-secret', passwordAction: { type: 'remove' } },
    { passwordAction: { type: 'remove', password: 'ignored-secret' } },
  ];
  for (const fields of malformedUpdates) {
    const result = await ack(owner, 'room-update', {
      roomCode: created.room.roomCode,
      ownerCredential: created.ownerCredential,
      ...fields,
    });
    assert.equal(result.error?.code, 'VALIDATION_ERROR');
  }

  const lookup = await ack(owner, 'room-lookup', { roomCode: created.room.roomCode });
  assert.equal(lookup.ok, true);
  assert.equal(lookup.room.passwordRequired, true);
});

test('owner management attempts are rate limited without blocking a valid owner on the same IP', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-owner-rate-'));
  const service = createServer({
    dbPath: path.join(dir, 'test.db'), port: 0,
    logger: { log() {}, warn() {}, error() {} },
  });
  const address = await service.listen();
  const url = `http://127.0.0.1:${address.port}`;
  let owner;
  let attacker;
  t.after(async () => {
    owner?.disconnect();
    attacker?.disconnect();
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  owner = await connect(url, { clientId: 'owner-rate-owner', platform: 'android' });
  attacker = await connect(url, { clientId: 'owner-rate-attacker', platform: 'android' });
  const created = await ack(owner, 'room-create', { name: '房主管理限流房', visibility: 'public' });
  assert.equal(created.ok, true);

  const failedAttempts = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const event = attempt % 2 === 0 ? 'room-update' : 'room-delete';
    const suppliedCredential = attempt % 3 === 0
      ? {}
      : { ownerCredential: attempt % 3 === 1 ? null : 'invalid-owner-credential' };
    const payload = {
      roomCode: String(90_000_000 + attempt),
      ...suppliedCredential,
      ...(event === 'room-update' ? { changes: { name: `錯誤憑證嘗試 ${attempt}` } } : {}),
    };
    failedAttempts.push(await ack(attacker, event, payload));
  }
  assert.deepEqual(failedAttempts.map((result) => result.error?.code), Array(20).fill('FORBIDDEN'));

  const blockedAttacker = await ack(attacker, 'room-delete', {
    roomCode: '99999999',
  });
  assert.equal(blockedAttacker.error?.code, 'RATE_LIMITED');

  const firstValidUpdate = await ack(owner, 'room-update', {
    roomCode: created.room.roomCode,
    changes: { name: '合法房主不被攻擊者鎖住' },
    ownerCredential: created.ownerCredential,
  });
  assert.equal(firstValidUpdate.ok, true);
  for (let operation = 2; operation <= 20; operation += 1) {
    const result = await ack(owner, 'room-update', {
      roomCode: created.room.roomCode,
      changes: { name: `驗證房間 ${String(operation).padStart(2, '0')}` },
      ownerCredential: created.ownerCredential,
    });
    assert.equal(result.ok, true, `operation ${operation} failed: ${JSON.stringify(result.error)}`);
  }
  const ownerRateLimited = await ack(owner, 'room-update', {
    roomCode: created.room.roomCode,
    changes: { name: '合法房主操作超限' },
    ownerCredential: created.ownerCredential,
  });
  assert.equal(ownerRateLimited.error?.code, 'RATE_LIMITED');

  const secondRoom = await ack(owner, 'room-create', { name: '另一間限流隔離房', visibility: 'public' });
  assert.equal(secondRoom.ok, true);
  const isolatedOperation = await ack(owner, 'room-update', {
    roomCode: secondRoom.room.roomCode,
    changes: { name: '第二房間改名' },
    ownerCredential: secondRoom.ownerCredential,
  });
  assert.equal(isolatedOperation.ok, true, JSON.stringify(isolatedOperation.error));
});

test('browser-origin clients receive owner credentials and cookies grant no owner authority', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-browser-owner-retired-'));
  const service = createServer({
    dbPath: path.join(dir, 'test.db'),
    port: 0,
    allowDevelopmentOrigins: true,
    logger: { log() {}, warn() {}, error() {} },
  });
  const address = await service.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const sockets = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const staleCookie = `__Host-stock_owner=${'a'.repeat(43)}`;
  const browser = await connect(
    url,
    { clientId: 'retired-web-owner', platform: 'web' },
    { Cookie: staleCookie, Origin: url, 'User-Agent': 'Mozilla/5.0 Chrome/126' },
  );
  sockets.push(browser);

  const created = await ack(browser, 'room-create', { name: '瀏覽器來源房間', visibility: 'public' });
  assert.equal(created.ok, true);
  assert.match(created.ownerCredential, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.hasOwn(created.room, 'ownedByClient'), false);
  assert.equal((await ack(browser, 'room-update', {
    roomCode: created.room.roomCode,
    changes: { name: '缺少憑證不可改名' },
  })).error.code, 'FORBIDDEN');
  assert.equal((await ack(browser, 'room-update', {
    roomCode: created.room.roomCode,
    changes: { name: '明確憑證可改名' },
    ownerCredential: created.ownerCredential,
  })).ok, true);

  const cookieReuser = await connect(
    url,
    { clientId: 'retired-cookie-reuser', platform: 'android' },
    { Cookie: staleCookie, Origin: url, 'User-Agent': 'Mozilla/5.0 Chrome/126' },
  );
  sockets.push(cookieReuser);
  assert.equal((await ack(cookieReuser, 'room-delete', {
    roomCode: created.room.roomCode,
  })).error.code, 'FORBIDDEN');
});

test('polling clients receive the same explicit owner credential contract', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-polling-owner-'));
  const service = createServer({ dbPath: path.join(dir, 'test.db'), port: 0, logger: { log() {}, warn() {}, error() {} } });
  const address = await service.listen();
  const url = `http://127.0.0.1:${address.port}`;
  let polling;
  t.after(async () => {
    polling?.disconnect();
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  polling = await connect(
    url,
    { clientId: 'polling-owner', platform: 'windows' },
    { Cookie: `__Host-stock_owner=${'b'.repeat(43)}` },
    { transports: ['polling'] },
  );

  const created = await ack(polling, 'room-create', { name: 'Polling 房間', visibility: 'public' });
  assert.equal(created.ok, true);
  assert.match(created.ownerCredential, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await ack(polling, 'room-update', {
    roomCode: created.room.roomCode,
    changes: { name: 'Polling 缺憑證' },
  })).error.code, 'FORBIDDEN');
});

test('supplied owner credential survives restart without Web-only ownership metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-owner-restart-'));
  const dbPath = path.join(dir, 'test.db');
  let service;
  let owner;
  try {
    service = createServer({ dbPath, port: 0, logger: { log() {}, warn() {}, error() {} } });
    let address = await service.listen();
    let url = `http://127.0.0.1:${address.port}`;
    owner = await connect(url, { clientId: 'restart-owner', platform: 'android' });
    const created = await ack(owner, 'room-create', { name: '重啟持久房間', visibility: 'public', retentionDays: 7 });
    assert.equal(created.ok, true);
    const { ownerCredential } = created;
    const roomCode = created.room.roomCode;
    owner.disconnect();
    owner = null;
    await service.close();
    service = null;

    service = createServer({ dbPath, port: 0, logger: { log() {}, warn() {}, error() {} } });
    address = await service.listen();
    url = `http://127.0.0.1:${address.port}`;
    owner = await connect(url, { clientId: 'restart-owner', platform: 'android' });
    const joined = await ack(owner, 'join-room', { roomCode });
    assert.equal(joined.ok, true);
    assert.equal(Object.hasOwn(joined.room, 'ownedByClient'), false);
    assert.equal((await ack(owner, 'room-update', {
      roomCode,
      changes: { name: '缺少憑證不可管理' },
    })).error.code, 'FORBIDDEN');
    const updated = await ack(owner, 'room-update', {
      roomCode,
      changes: { name: '重啟後明確授權' },
      ownerCredential,
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.room.name, '重啟後明確授權');
  } finally {
    owner?.disconnect();
    if (service) await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nickname change is typed, daily-limited by stable client, and barrage cannot bypass it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-nickname-'));
  let now = Date.parse('2026-07-14T08:00:00Z');
  const service = createServer({ dbPath: path.join(dir, 'test.db'), port: 0, now: () => now, logger: { log() {}, warn() {}, error() {} } });
  const address = await service.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const sockets = [];
  const open = async (clientId) => {
    const socket = await connect(url, { clientId, platform: 'android' });
    sockets.push(socket);
    return socket;
  };
  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let owner = await open('nickname-owner');
  const created = await ack(owner, 'room-create', { name: '暱稱驗證房', visibility: 'public' });
  const roomCode = created.room.roomCode;
  assert.equal((await ack(owner, 'barrage', { text: '建立舊名基準', nickname: '舊名' })).status, 'sent');

  now += 10_000;
  const changed = await ack(owner, 'nickname-change', { nickname: '新名' });
  assert.deepEqual({ ok: changed.ok, nickname: changed.nickname, changeDate: changed.changeDate },
    { ok: true, nickname: '新名', changeDate: '2026-07-14' });
  assert.equal((await ack(owner, 'nickname-change', { nickname: '新名' })).ok, true, 'same value is idempotent');

  const blocked = await ack(owner, 'nickname-change', { nickname: '第二名' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'RATE_LIMITED');
  assert.equal(blocked.error.scope, 'nickname');
  assert.ok(blocked.error.retryAfterMs > 0);

  const bypass = await ack(owner, 'barrage', { text: '不可繞過改名', nickname: '偷改' });
  assert.equal(bypass.ok, false);
  assert.equal(bypass.error.code, 'VALIDATION_ERROR');
  assert.equal(bypass.error.scope, 'nickname');

  owner.disconnect();
  now += 10_000;
  owner = await open('nickname-owner');
  assert.equal((await ack(owner, 'join-room', { roomCode })).ok, true);
  assert.equal((await ack(owner, 'barrage', { text: '重連維持新名', nickname: '新名' })).status, 'sent');

  const peer = await open('nickname-peer');
  assert.equal((await ack(peer, 'join-room', { roomCode })).ok, true);
  const peerChange = await ack(peer, 'nickname-change', { nickname: '別人' });
  assert.equal(peerChange.ok, true, 'another stable client has an independent daily allowance');
});
