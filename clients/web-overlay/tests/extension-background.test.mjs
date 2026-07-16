import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionBackground, installExtensionBackground } from '../src/extension/background.js';

class EventHook {
  listeners = new Set();
  addListener(listener) { this.listeners.add(listener); }
  removeListener(listener) { this.listeners.delete(listener); }
  hasListener(listener) { return this.listeners.has(listener); }
  dispatch(...args) { for (const listener of [...this.listeners]) listener(...args); }
}

function createFakeChrome({ failCredentialWrites = false } = {}) {
  const runtimeMessages = new EventHook();
  const installed = new EventHook();
  const values = {};
  const sent = [];
  const chromeApi = {
    runtime: {
      onMessage: runtimeMessages,
      onInstalled: installed,
      lastError: null,
    },
    storage: {
      local: {
        async setAccessLevel() {},
        async get(keys) {
          if (typeof keys === 'string') return { [keys]: structuredClone(values[keys]) };
          return structuredClone(values);
        },
        async set(items) {
          if (failCredentialWrites && Object.hasOwn(items, 'danmaku.extension.credentials.v1')) {
            throw new Error('credential write failed with owner-secret');
          }
          Object.assign(values, structuredClone(items));
        },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
      },
    },
    tabs: {
      async sendMessage(tabId, message) { sent.push({ tabId, message: structuredClone(message) }); },
    },
  };
  async function request(message, { tabId = 1, frameId = 0, url = 'http://site.test/' } = {}) {
    const listener = [...runtimeMessages.listeners][0];
    assert.ok(listener, 'runtime listener is installed');
    return new Promise((resolve) => {
      const keepAlive = listener(message, { tab: { id: tabId, url }, frameId, url }, resolve);
      assert.equal(keepAlive, true);
    });
  }
  return { chromeApi, runtimeMessages, values, sent, request };
}

class FakeSocket {
  constructor(options) {
    this.options = options;
    this.connected = false;
    this.handlers = new Map();
    this.emits = [];
    this.pending = [];
    this.disconnectCalls = 0;
  }
  on(event, handler) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }
  off() { this.handlers.clear(); return this; }
  connect() { this.connected = true; this.fire('connect'); return this; }
  disconnect() { this.connected = false; this.disconnectCalls += 1; this.fire('disconnect', 'client disconnect'); return this; }
  emit(event, payload, callback) {
    this.emits.push({ event, payload: structuredClone(payload) });
    if (typeof callback === 'function') this.pending.push({ event, callback });
    return this;
  }
  ack(event, response, index = 0) {
    const matches = this.pending.filter((entry) => entry.event === event);
    const entry = matches[index];
    assert.ok(entry, `pending ${event} acknowledgement exists`);
    this.pending.splice(this.pending.indexOf(entry), 1);
    entry.callback(structuredClone(response));
  }
  async fire(event, payload) { await Promise.all((this.handlers.get(event) || []).map((handler) => handler(structuredClone(payload)))); }
}

function createSocketHarness() {
  const sockets = [];
  const createSocket = (url, options) => {
    const socket = new FakeSocket({ url, ...structuredClone(options) });
    sockets.push(socket);
    return socket;
  };
  return { sockets, createSocket };
}

async function waitFor(predicate, message = 'condition') {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function registerTabs(fake, count, visibilityState = 'visible') {
  const replies = [];
  for (let index = 1; index <= count; index += 1) {
    replies.push(await fake.request({
      action: 'overlay/register', payload: { instanceId: `page-${index}`, visibilityState },
    }, { tabId: index }));
  }
  return replies;
}

test('twenty top-level tabs share exactly one socket with stable extension authentication', async () => {
  const fake = createFakeChrome();
  const harness = createSocketHarness();
  const controller = await installExtensionBackground({
    chromeApi: fake.chromeApi, createSocket: harness.createSocket, serverUrl: 'http://127.0.0.1:3999',
  });
  await registerTabs(fake, 20);

  assert.equal(harness.sockets.length, 1);
  const options = harness.sockets[0].options;
  assert.equal(options.auth.platform, 'extension');
  assert.match(options.auth.clientId, /^[A-Za-z0-9._:-]+$/);
  assert.deepEqual(options.transports, ['websocket']);
  assert.ok(options.reconnectionDelayMax <= 10_000);
  assert.equal(new Set((await registerTabs(fake, 2)).map((reply) => reply.state.clientId)).size, 1);
  await controller.stop();
});

test('reinstall simulates service-worker restart without duplicate listener or socket', async () => {
  const fake = createFakeChrome();
  const harness = createSocketHarness();
  const first = await installExtensionBackground({ chromeApi: fake.chromeApi, createSocket: harness.createSocket, serverUrl: 'http://127.0.0.1:3999' });
  const originalClientId = (await fake.request({ action: 'state/get', payload: {} })).state.clientId;
  const second = await installExtensionBackground({ chromeApi: fake.chromeApi, createSocket: harness.createSocket, serverUrl: 'http://127.0.0.1:3999' });

  assert.equal(fake.runtimeMessages.listeners.size, 1);
  assert.equal(harness.sockets.length, 2);
  assert.equal(harness.sockets[0].disconnectCalls, 1);
  assert.equal((await fake.request({ action: 'state/get', payload: {} })).state.clientId, originalClientId);
  await first.stop();
  await second.stop();
});



test('starting one controller twice is idempotent and does not duplicate listeners or sockets', async () => {
  const fake = createFakeChrome();
  const harness = createSocketHarness();
  const controller = createExtensionBackground({
    chromeApi: fake.chromeApi, createSocket: harness.createSocket, serverUrl: 'http://127.0.0.1:3999',
  });
  await Promise.all([controller.start(), controller.start()]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fake.runtimeMessages.listeners.size, 1);
  assert.equal(harness.sockets.length, 1);
  await controller.stop();
});

test('room exit clears stale local membership when joining the default room fails after leave', async () => {
  const fake = createFakeChrome();
  const harness = createSocketHarness();
  const controller = await installExtensionBackground({
    chromeApi: fake.chromeApi, createSocket: harness.createSocket, serverUrl: 'http://127.0.0.1:3999',
  });
  const socket = harness.sockets[0];
  socket.connected = true;

  const initialJoin = fake.request({ action: 'room/join', payload: { roomCode: '99999999' } });
  await waitFor(() => socket.pending.some((entry) => entry.event === 'join-room'), 'initial join emit');
  socket.ack('join-room', { ok: true, room: { roomCode: '99999999', name: 'old room', count: 1, capacity: 200 }, recentMessages: [] });
  assert.equal((await initialJoin).ok, true);

  const exit = fake.request({ action: 'room/exit', payload: {} });
  await waitFor(() => socket.pending.some((entry) => entry.event === 'room-default'), 'default room emit');
  socket.ack('room-default', { ok: true, room: { roomCode: '12345678', name: 'default', count: 1, capacity: 200 } });
  await waitFor(() => socket.pending.some((entry) => entry.event === 'leave-room'), 'leave room emit');
  socket.ack('leave-room', { ok: true });
  await waitFor(() => socket.pending.some((entry) => entry.event === 'join-room'), 'default join emit');
  socket.ack('join-room', { ok: false, error: { code: 'JOIN_FAILED', scope: 'room', message: 'cannot join default' } });

  const response = await exit;
  assert.equal(response.ok, false);
  assert.equal(response.partial, true);
  assert.equal(response.left, true);
  const state = (await fake.request({ action: 'state/get', payload: {} })).state;
  assert.equal(state.currentRoom, null);
  assert.equal(state.currentRoomCode, null);
  assert.deepEqual(state.history, []);
  await controller.stop();
});

test('registration is top-frame-only and malformed actions receive typed errors', async () => {
  const fake = createFakeChrome();
  const harness = createSocketHarness();
  const controller = await installExtensionBackground({ chromeApi: fake.chromeApi, createSocket: harness.createSocket, serverUrl: 'http://127.0.0.1:3999' });
  const subframe = await fake.request({ action: 'overlay/register', payload: { instanceId: 'nested', visibilityState: 'visible' } }, { tabId: 1, frameId: 2 });
  const malformed = await fake.request({ action: 'room/join', payload: { roomCode: 'bad' } });
  assert.equal(subframe.ok, false);
  assert.equal(subframe.error.code, 'TOP_FRAME_REQUIRED');
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error.code, 'INVALID_MESSAGE');
  await controller.stop();
});

test('visible tabs receive barrage events while hidden tabs receive only bounded state history', async () => {
  const fake = createFakeChrome();
  const harness = createSocketHarness();
  const controller = await installExtensionBackground({ chromeApi: fake.chromeApi, createSocket: harness.createSocket, serverUrl: 'http://127.0.0.1:3999' });
  await fake.request({ action: 'overlay/register', payload: { instanceId: 'visible', visibilityState: 'visible' } }, { tabId: 1 });
  await fake.request({ action: 'overlay/register', payload: { instanceId: 'hidden', visibilityState: 'hidden' } }, { tabId: 2 });

  for (let index = 0; index < 205; index += 1) {
    await harness.sockets[0].fire('barrage', { messageId: `m-${index}`, roomCode: '12345678', text: `text-${index}`, nickname: '匿名', color: '#FFFFFF', timestamp: index });
  }
  const visibleEvents = fake.sent.filter((entry) => entry.tabId === 1 && entry.message.type === 'DANMAKU_BARRAGE');
  const hiddenEvents = fake.sent.filter((entry) => entry.tabId === 2 && entry.message.type === 'DANMAKU_BARRAGE');
  const hiddenStates = fake.sent.filter((entry) => entry.tabId === 2 && entry.message.type === 'DANMAKU_STATE');
  assert.equal(visibleEvents.length, 205);
  assert.equal(hiddenEvents.length, 0);
  assert.ok(hiddenStates.length >= 205);
  const state = (await fake.request({ action: 'state/get', payload: {} })).state;
  assert.equal(state.history.length, 200);
  assert.equal(state.history[0].messageId, 'm-5');
  await controller.stop();
});

test('room creation returns owner capability only after durable background credential write', async () => {
  const fake = createFakeChrome();
  const harness = createSocketHarness();
  const controller = await installExtensionBackground({ chromeApi: fake.chromeApi, createSocket: harness.createSocket, serverUrl: 'http://127.0.0.1:3999' });
  harness.sockets[0].connected = true;
  const pending = fake.request({ action: 'room/create', payload: { name: 'room', visibility: 'public', retentionDays: 7 } });
  await waitFor(() => harness.sockets[0].pending.some((entry) => entry.event === 'room-create'), 'room-create emit');
  harness.sockets[0].ack('room-create', { ok: true, room: { roomCode: '12345678', name: 'room', count: 1, capacity: 200 }, recentMessages: [], ownerCredential: 'owner-secret' });
  const response = await pending;
  assert.equal(response.ok, true);
  assert.equal(response.ownerCapabilitySaved, true);
  assert.equal(response.canManageRoom, true);
  assert.doesNotMatch(JSON.stringify(response), /owner-secret/);
  assert.doesNotMatch(JSON.stringify(fake.sent), /owner-secret/);
  await controller.stop();
});

test('credential write failure is explicit and never leaks the credential through response, broadcast or errors', async () => {
  const fake = createFakeChrome({ failCredentialWrites: true });
  const harness = createSocketHarness();
  const controller = await installExtensionBackground({ chromeApi: fake.chromeApi, createSocket: harness.createSocket, serverUrl: 'http://127.0.0.1:3999' });
  harness.sockets[0].connected = true;
  const pending = fake.request({ action: 'room/create', payload: { name: 'room', visibility: 'public', retentionDays: 7 } });
  await waitFor(() => harness.sockets[0].pending.some((entry) => entry.event === 'room-create'), 'room-create emit');
  harness.sockets[0].ack('room-create', { ok: true, room: { roomCode: '12345678', name: 'room', count: 1, capacity: 200 }, recentMessages: [], ownerCredential: 'owner-secret' });
  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.partial, true);
  assert.equal(response.error.code, 'CREDENTIAL_PERSIST_FAILED');
  assert.doesNotMatch(JSON.stringify({ response, sent: fake.sent }), /owner-secret|disk exploded/i);
  await controller.stop();
});

test('late membership acknowledgement cannot overwrite a newer room generation', async () => {
  const fake = createFakeChrome();
  const harness = createSocketHarness();
  const controller = await installExtensionBackground({ chromeApi: fake.chromeApi, createSocket: harness.createSocket, serverUrl: 'http://127.0.0.1:3999', ackTimeoutMs: 2000 });
  harness.sockets[0].connected = true;
  const first = fake.request({ action: 'room/join', payload: { roomCode: '11111111' } }, { tabId: 1 });
  const second = fake.request({ action: 'room/join', payload: { roomCode: '22222222' } }, { tabId: 1 });
  await waitFor(() => harness.sockets[0].pending.filter((entry) => entry.event === 'join-room').length === 2, 'two join-room emits');
  harness.sockets[0].ack('join-room', { ok: true, room: { roomCode: '22222222', name: 'new', count: 1, capacity: 200 }, recentMessages: [] }, 1);
  harness.sockets[0].ack('join-room', { ok: true, room: { roomCode: '11111111', name: 'old', count: 1, capacity: 200 }, recentMessages: [] }, 0);
  const [oldResponse, newResponse] = await Promise.all([first, second]);
  assert.equal(newResponse.ok, true);
  assert.equal(oldResponse.stale, true);
  assert.equal((await fake.request({ action: 'state/get', payload: {} })).state.currentRoom.roomCode, '22222222');
  await controller.stop();
});

test('public sanitization preserves passwordRequired metadata while removing actual secrets', async () => {
  const fake = createFakeChrome();
  const harness = createSocketHarness();
  const controller = await installExtensionBackground({ chromeApi: fake.chromeApi, createSocket: harness.createSocket, serverUrl: 'http://127.0.0.1:3999' });
  harness.sockets[0].connected = true;
  const pending = fake.request({ action: 'room/lookup', payload: { roomCode: '12345678' } });
  await waitFor(() => harness.sockets[0].pending.some((entry) => entry.event === 'room-lookup'), 'room lookup emit');
  harness.sockets[0].ack('room-lookup', { ok: true, room: { roomCode: '12345678', name: 'private', count: 1, capacity: 200, passwordRequired: true }, password: 'never-public', ownerCredential: 'never-public' });
  const response = await pending;
  assert.equal(response.ok, true);
  assert.equal(response.room.passwordRequired, true);
  assert.equal(Object.hasOwn(response, 'password'), false);
  assert.equal(Object.hasOwn(response, 'ownerCredential'), false);
  await controller.stop();
});
