'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { defaultRoomFromResponse } = require('./matrix-gates');
const { assertNoSecrets, cleanupCreatedRooms } = require('./staging-contract');

const appRequire = createRequire(path.resolve(__dirname, '../app/package.json'));
const { io } = appRequire('socket.io-client');

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4399';
const sockets = [];
const createdRooms = [];
const summary = {
  baseUrl,
  defaultRoom: false,
  legacyPayloadRejected: false,
  creatorAutoJoined: false,
  passwordRoom: false,
  publicListing: false,
  browserExplicitOwnerCredential: false,
  queue: { clients: 0, sent: 0, queued: 0, delivered: 0 },
};

function emitAck(socket, event, payload = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (error, response) => {
      if (error) reject(new Error(`${event} acknowledgement timeout: ${error.message || error}`));
      else resolve(response);
    });
  });
}

function connect({ clientId = randomUUID(), platform, origin, userAgent } = {}) {
  return new Promise((resolve, reject) => {
    const extraHeaders = {};
    if (origin) extraHeaders.Origin = origin;
    if (userAgent) extraHeaders['User-Agent'] = userAgent;
    const socket = io(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      timeout: 10_000,
      auth: { clientId, ...(platform ? { platform } : {}) },
      query: { clientId },
      ...(Object.keys(extraHeaders).length ? { extraHeaders } : {}),
    });
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 12_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      sockets.push(socket);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function connectBrowserOrigin({ clientId, platform = 'android' }) {
  return connect({
    clientId,
    platform,
    origin: baseUrl,
    userAgent: 'Mozilla/5.0 Chrome/126',
  });
}

function roomCodeOf(response) {
  return String(response?.room?.roomCode || response?.room?.code || '');
}


async function waitForStatuses(expected, observed, timeoutMs = 8_000) {
  if (expected.size === 0) return 0;
  let alreadyDelivered = 0;
  for (const messageId of [...expected.keys()]) {
    const status = observed.get(messageId);
    if (status?.status === 'expired') throw new Error(`queued message expired unexpectedly: ${messageId}`);
    if (status?.status === 'delivered') {
      expected.delete(messageId);
      alreadyDelivered += 1;
    }
  }
  if (expected.size === 0) return alreadyDelivered;
  return new Promise((resolve, reject) => {
    let delivered = alreadyDelivered;
    const timer = setTimeout(() => reject(new Error(`queued delivery timeout: ${expected.size} still pending`)), timeoutMs);
    for (const [messageId, socket] of expected) {
      const listener = (status) => {
        if (status?.messageId !== messageId) return;
        if (status.status === 'expired') {
          clearTimeout(timer);
          reject(new Error(`queued message expired unexpectedly: ${messageId}`));
          return;
        }
        if (status.status === 'delivered' && expected.delete(messageId)) {
          delivered += 1;
          socket.off('barrage-status', listener);
          if (expected.size === 0) {
            clearTimeout(timer);
            resolve(delivered);
          }
        }
      };
      socket.on('barrage-status', listener);
    }
  });
}

async function main() {
  const health = await fetch(`${baseUrl}/`);
  assert.equal(health.status, 200);

  const owner = await connect({ clientId: `integration-owner-${randomUUID()}`, platform: 'android' });
  const peer = await connect({ clientId: `integration-peer-${randomUUID()}`, platform: 'windows' });

  const defaultRoom = defaultRoomFromResponse(await emitAck(owner, 'room-default', {}));
  assert.equal((await emitAck(owner, 'join-room', { roomCode: defaultRoom.roomCode })).ok, true);
  summary.defaultRoom = true;

  const legacy = await emitAck(owner, 'join-room', { symbol: 'TWSE:2330' });
  assert.equal(legacy?.ok, false);
  assert.equal(legacy?.error?.code, 'VALIDATION_ERROR');
  summary.legacyPayloadRejected = true;

  const createdPublic = await emitAck(owner, 'room-create', {
    name: `整合公開房 ${randomUUID().slice(0, 6)}`,
    visibility: 'public',
    retentionDays: 7,
  });
  assert.equal(createdPublic?.ok, true);
  assert.match(roomCodeOf(createdPublic), /^\d{8}$/);
  assert.equal(typeof createdPublic.ownerCredential, 'string');
  assertNoSecrets(createdPublic, { allowTopLevelOwnerCredential: true });
  createdRooms.push({ socket: owner, roomCode: roomCodeOf(createdPublic), ownerCredential: createdPublic.ownerCredential });
  const immediate = await emitAck(owner, 'barrage', { text: `建立後立即發送${Date.now()}`, nickname: '房主', color: '#E6EDF3' });
  assert.equal(immediate?.ok, true);
  assert.equal(immediate?.status, 'sent');
  summary.creatorAutoJoined = true;

  const publicList = await emitAck(peer, 'room-list-public', { query: roomCodeOf(createdPublic), page: 1, pageSize: 999 });
  assert.equal(publicList?.ok, true);
  assert.equal(publicList.pagination.pageSize, 20);
  assert.equal(publicList.data.some((room) => room.roomCode === roomCodeOf(createdPublic)), true);
  assertNoSecrets(publicList);
  const injectionQuery = await emitAck(peer, 'room-list-public', { query: "' OR 1=1 --", page: 1, pageSize: 20 });
  assert.equal(injectionQuery?.ok, true);
  assertNoSecrets(injectionQuery);
  summary.publicListing = true;

  const password = `pw-${randomUUID().slice(0, 12)}`;
  const createdPrivate = await emitAck(owner, 'room-create', {
    name: `整合密碼房 ${randomUUID().slice(0, 6)}`,
    visibility: 'unlisted',
    password,
    retentionDays: 3,
  });
  assert.equal(createdPrivate?.ok, true);
  assertNoSecrets(createdPrivate, { allowTopLevelOwnerCredential: true });
  const privateCode = roomCodeOf(createdPrivate);
  createdRooms.push({ socket: owner, roomCode: privateCode, ownerCredential: createdPrivate.ownerCredential });
  const privateList = await emitAck(peer, 'room-list-public', { query: privateCode, page: 1, pageSize: 20 });
  assert.equal(privateList.data.some((room) => room.roomCode === privateCode), false);
  const lookup = await emitAck(peer, 'room-lookup', { roomCode: privateCode });
  assert.equal(lookup?.ok, true);
  assert.equal(Boolean(lookup.room.requiresPassword ?? lookup.room.passwordRequired), true);
  assert.equal((await emitAck(peer, 'join-room', { roomCode: privateCode }))?.error?.code, 'PASSWORD_REQUIRED');
  assert.equal((await emitAck(peer, 'join-room', { roomCode: privateCode, password: 'definitely-wrong' }))?.error?.code, 'INVALID_PASSWORD');
  assert.equal((await emitAck(peer, 'join-room', { roomCode: privateCode, password }))?.ok, true);
  summary.passwordRoom = true;

  const browser = await connectBrowserOrigin({ clientId: `integration-browser-${randomUUID()}` });
  const browserCreate = await emitAck(browser, 'room-create', {
    name: `瀏覽器來源 ${randomUUID().slice(0, 6)}`,
    visibility: 'public',
    retentionDays: 1,
  });
  assert.equal(browserCreate?.ok, true);
  assertNoSecrets(browserCreate, { allowTopLevelOwnerCredential: true });
  const browserRoomCode = roomCodeOf(browserCreate);
  createdRooms.push({ socket: browser, roomCode: browserRoomCode, ownerCredential: browserCreate.ownerCredential });
  const missingCredential = await emitAck(browser, 'room-update', {
    roomCode: browserRoomCode,
    changes: { name: `缺少憑證 ${randomUUID().slice(0, 6)}` },
  });
  assert.equal(missingCredential?.error?.code, 'FORBIDDEN');
  assert.equal((await emitAck(browser, 'room-update', {
    roomCode: browserRoomCode,
    changes: { name: `明確憑證 ${randomUUID().slice(0, 6)}` },
    ownerCredential: browserCreate.ownerCredential,
  }))?.ok, true);
  summary.browserExplicitOwnerCredential = true;

  const queueSockets = [];
  const observedStatuses = new Map();
  for (let index = 0; index < 21; index += 1) {
    queueSockets.push(await connect({ clientId: `integration-queue-${index}-${randomUUID()}`, platform: 'windows' }));
  }
  queueSockets.forEach((socket) => socket.on('barrage-status', (status) => {
    if (status?.messageId) observedStatuses.set(status.messageId, status);
  }));
  await Promise.all(queueSockets.map(async (socket) => {
    const joined = await emitAck(socket, 'join-room', { roomCode: defaultRoom.roomCode });
    assert.equal(joined?.ok, true);
  }));
  const acks = await Promise.all(queueSockets.map((socket, index) => emitAck(socket, 'barrage', {
    text: `壓測訊息第${String(index + 1).padStart(4, '0')}號`,
    nickname: `Q${index}`.slice(0, 6),
    color: '#E6EDF3',
  })));
  const queued = new Map();
  acks.forEach((acknowledgement, index) => {
    assert.equal(acknowledgement?.ok, true, JSON.stringify(acknowledgement));
    assert.match(String(acknowledgement.messageId || ''), /.+/);
    if (acknowledgement.status === 'sent') summary.queue.sent += 1;
    else if (acknowledgement.status === 'queued') {
      assert.equal(Number.isInteger(acknowledgement.position) && acknowledgement.position >= 1, true);
      assert.equal(Number.isFinite(acknowledgement.estimatedWaitMs) && acknowledgement.estimatedWaitMs >= 0, true);
      summary.queue.queued += 1;
      queued.set(acknowledgement.messageId, queueSockets[index]);
    } else assert.fail(`unexpected barrage status: ${JSON.stringify(acknowledgement)}`);
  });
  assert.equal(summary.queue.sent + summary.queue.queued, 21);
  assert.equal(summary.queue.queued > 0, true, 'burst must exercise the bounded queue');
  summary.queue.delivered = await waitForStatuses(queued, observedStatuses);
  summary.queue.clients = queueSockets.length;

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  const cleanupFailures = await cleanupCreatedRooms(createdRooms, emitAck);
  if (cleanupFailures.length) {
    console.error(`staging cleanup failed: ${JSON.stringify(cleanupFailures)}`);
    process.exitCode = 1;
  }
  for (const socket of sockets) socket.disconnect();
});
