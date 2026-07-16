import { io } from 'socket.io-client';
import { normalizeSettings, resetAppearance, TEXT_LIMITS } from '../core/settings-contract.js';
import { normalizeRoom, normalizeRoomList } from '../core/room-model.js';
import { parseExtensionMessage } from './message-schema.js';
import { createExtensionStorage, normalizeHistory } from './storage.js';

const DEFAULT_ACK_TIMEOUT_MS = 8_000;
const installedControllers = new WeakMap();
const SENSITIVE_KEY = /^(?:password|apiKey|privateKey)$|(?:credential|secret|token)$/i;

function typedError(code, scope, message) {
  return { ok: false, error: { code, scope, message } };
}

function sanitizePublic(value) {
  if (Array.isArray(value)) return value.map(sanitizePublic);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SENSITIVE_KEY.test(key))
    .map(([key, child]) => [key, sanitizePublic(child)]));
}

function sanitizeAck(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return typedError('INVALID_ACK', 'connection', '伺服器回應格式錯誤');
  }
  const sanitized = sanitizePublic(value);
  if (sanitized.ok === true) return sanitized;
  if (sanitized.ok === false && sanitized.error && typeof sanitized.error === 'object') {
    return {
      ...sanitized,
      error: {
        code: typeof sanitized.error.code === 'string' ? sanitized.error.code : 'UNKNOWN',
        scope: typeof sanitized.error.scope === 'string' ? sanitized.error.scope : 'server',
        message: typeof sanitized.error.message === 'string' ? sanitized.error.message : '操作失敗',
        ...(Number.isFinite(Number(sanitized.error.retryAfterMs)) ? { retryAfterMs: Number(sanitized.error.retryAfterMs) } : {}),
      },
    };
  }
  return typedError('INVALID_ACK', 'connection', '伺服器回應格式錯誤');
}

function mergeSettings(current, patch) {
  const next = structuredClone(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) next[key] = { ...(next[key] || {}), ...value };
    else next[key] = value;
  }
  return normalizeSettings(next);
}

function defaultSocketFactory(serverUrl, options) {
  return io(serverUrl, options);
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `extension-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function validTabId(value) {
  return Number.isInteger(value) && value > 0;
}

export function createExtensionBackground({
  chromeApi,
  createSocket = defaultSocketFactory,
  serverUrl,
  ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
  timers = globalThis,
} = {}) {
  if (!chromeApi?.runtime?.onMessage) throw new TypeError('chrome runtime messaging is required');
  if (typeof createSocket !== 'function') throw new TypeError('createSocket must be a function');
  if (typeof serverUrl !== 'string' || !serverUrl) throw new TypeError('serverUrl is required');
  const storage = createExtensionStorage(chromeApi);
  const instances = new Map();
  const generations = new Map();
  let socket = null;
  let stopped = false;
  let started = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let state = {
    privacyConsent: false,
    settings: normalizeSettings(),
    joinedRoomCodes: [],
    history: [],
    overlayEnabled: true,
    connection: { status: 'consent-required' },
    currentRoom: null,
    currentRoomCode: null,
    canManageRoom: false,
  };

  function durableState() {
    return {
      privacyConsent: state.privacyConsent === true,
      settings: state.settings,
      ...(state.clientId ? { clientId: state.clientId } : {}),
      ...(state.currentRoomCode ? { currentRoomCode: state.currentRoomCode } : {}),
      ...(state.currentRoom ? { currentRoom: state.currentRoom } : {}),
      joinedRoomCodes: state.joinedRoomCodes,
      history: state.history,
      overlayEnabled: state.overlayEnabled,
    };
  }

  async function persist() {
    await storage.saveState(durableState());
  }

  function publicState() {
    const consented = state.privacyConsent === true;
    return sanitizePublic({
      privacyConsent: consented,
      settings: state.settings,
      overlayEnabled: state.overlayEnabled,
      connection: state.connection,
      ...(consented ? {
        ...(state.clientId ? { clientId: state.clientId } : {}),
        currentRoom: state.currentRoom,
        currentRoomCode: state.currentRoomCode,
        joinedRoomCodes: state.joinedRoomCodes,
        history: state.history,
        canManageRoom: state.canManageRoom,
      } : {
        currentRoom: null,
        currentRoomCode: null,
        joinedRoomCodes: [],
        history: [],
        canManageRoom: false,
      }),
    });
  }

  async function sendTab(tabId, message) {
    if (!validTabId(tabId)) return false;
    try {
      await chromeApi.tabs?.sendMessage?.(tabId, sanitizePublic(message));
      return true;
    } catch {
      return false;
    }
  }

  async function broadcastState() {
    const message = { type: 'DANMAKU_STATE', state: publicState() };
    await Promise.all([...instances.keys()].map((tabId) => sendTab(tabId, message)));
  }

  async function broadcastEvent(type, payload, predicate = () => true) {
    await Promise.all([...instances.entries()]
      .filter(([, instance]) => predicate(instance))
      .map(([tabId]) => sendTab(tabId, { type, payload: sanitizePublic(payload) })));
  }

  async function applyRoom(roomSource, recentMessages) {
    const room = normalizeRoom(roomSource);
    if (!room) throw new TypeError('invalid room acknowledgement');
    state.currentRoom = room;
    state.currentRoomCode = room.roomCode;
    state.history = normalizeHistory(recentMessages);
    state.joinedRoomCodes = [...new Set([...state.joinedRoomCodes, room.roomCode])];
    state.canManageRoom = await storage.hasOwnerCredential(room.roomCode);
    await persist();
    await broadcastState();
    return room;
  }

  async function clearRoom() {
    state.currentRoom = null;
    state.currentRoomCode = null;
    state.history = [];
    state.canManageRoom = false;
    await persist();
    await broadcastState();
  }

  function nextGeneration(scope) {
    const next = (generations.get(scope) || 0) + 1;
    generations.set(scope, next);
    return next;
  }

  function emitAck(event, payload, { scope = event, apply } = {}) {
    if (!state.privacyConsent) return Promise.resolve(typedError('CONSENT_REQUIRED', 'privacy', '請先閱讀隱私說明並同意後再開始使用'));
    if (!socket?.connected) return Promise.resolve(typedError('NOT_CONNECTED', 'connection', '尚未連線'));
    const generation = nextGeneration(scope);
    return new Promise((resolve) => {
      let settled = false;
      const timer = timers.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(typedError('ACK_TIMEOUT', 'connection', '伺服器回應逾時'));
      }, ackTimeoutMs);
      timer?.unref?.();

      const finish = async (rawAck) => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(timer);
        if (generations.get(scope) !== generation) {
          resolve({ ...typedError('STALE_ACK', 'connection', '較新的操作已取代此回應'), stale: true });
          return;
        }
        const ack = sanitizeAck(rawAck);
        if (ack.ok !== true || typeof apply !== 'function') {
          resolve(ack);
          return;
        }
        try {
          resolve(await apply(rawAck, ack));
        } catch {
          resolve(typedError('LOCAL_STATE_FAILURE', 'storage', '伺服器已回應，但本機狀態更新失敗'));
        }
      };

      try {
        socket.emit(event, payload, finish);
      } catch {
        timers.clearTimeout(timer);
        settled = true;
        resolve(typedError('TRANSPORT_ERROR', 'connection', '無法送出操作'));
      }
    });
  }

  async function restoreMembership() {
    if (!socket?.connected) return;
    if (state.currentRoomCode) {
      const restored = await emitAck('join-room', { roomCode: state.currentRoomCode }, {
        scope: 'membership',
        apply: async (raw, ack) => {
          await applyRoom(raw.room, raw.recentMessages);
          return ack;
        },
      });
      if (restored.ok) return;
    }
    const found = await emitAck('room-default', {}, { scope: 'default-room' });
    if (!found.ok || !found.room) return;
    await emitAck('join-room', { roomCode: found.room.roomCode }, {
      scope: 'membership',
      apply: async (raw, ack) => {
        await applyRoom(raw.room, raw.recentMessages);
        return ack;
      },
    });
  }

  function attachSocketHandlers() {
    socket.on('connect', async () => {
      state.connection = { status: 'connected' };
      await broadcastState();
      await restoreMembership();
    });
    socket.on('disconnect', async () => {
      state.connection = { status: 'reconnecting' };
      await broadcastState();
    });
    socket.on('connect_error', async () => {
      state.connection = { status: 'reconnecting', error: { code: 'CONNECT_FAILED', message: '無法連線，正在重試' } };
      await broadcastState();
    });
    socket.on('connection-refused', async (payload) => {
      state.connection = { status: 'disconnected', error: sanitizeAck({ ok: false, ...(payload || {}) }).error };
      await broadcastState();
    });
    socket.on('barrage', async (payload) => {
      const [message] = normalizeHistory([payload]);
      if (!message) return;
      state.history = normalizeHistory([...state.history, message]);
      await persist();
      await broadcastEvent('DANMAKU_BARRAGE', message, (instance) => instance.visibilityState === 'visible');
      await broadcastState();
    });
    socket.on('barrage-status', (payload) => broadcastEvent('DANMAKU_SEND_STATUS', payload));
    socket.on('room-count', async (payload) => {
      if (!state.currentRoom || payload?.roomCode !== state.currentRoom.roomCode) return;
      state.currentRoom = normalizeRoom({ ...state.currentRoom, count: payload.count, capacity: payload.capacity }) || state.currentRoom;
      await persist();
      await broadcastState();
    });
    socket.on('room-deleted', async (payload) => {
      if (payload?.roomCode === state.currentRoomCode) await clearRoom();
      await broadcastEvent('DANMAKU_ROOM_DELETED', payload);
    });
    socket.on('hide-message', async (payload) => {
      if (typeof payload?.messageId !== 'string') return;
      state.history = state.history.filter((entry) => entry.messageId !== payload.messageId);
      await persist();
      await broadcastEvent('DANMAKU_HIDE_MESSAGE', payload);
      await broadcastState();
    });
  }

  async function connectWithConsent() {
    if (!state.privacyConsent || socket) return false;
    if (!state.clientId) {
      state.clientId = uuid();
      await persist();
    }
    state.connection = { status: 'connecting' };
    socket = createSocket(serverUrl, {
      auth: { platform: 'extension', clientId: state.clientId },
      query: { clientId: state.clientId },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 8_000,
      randomizationFactor: 0.5,
      timeout: 10_000,
    });
    attachSocketHandlers();
    return true;
  }

  async function initialize() {
    await storage.initialize();
    const stored = await storage.loadState();
    state = {
      ...state,
      ...stored,
      currentRoom: stored.currentRoom || null,
      currentRoomCode: stored.currentRoomCode || stored.currentRoom?.roomCode || null,
      history: normalizeHistory(stored.history),
      connection: stored.privacyConsent === true ? { status: 'connecting' } : { status: 'consent-required' },
      canManageRoom: stored.currentRoomCode ? await storage.hasOwnerCredential(stored.currentRoomCode) : false,
    };
    if (state.privacyConsent) await connectWithConsent();
  }

  async function command(action, payload, sender) {
    if (action === 'state/get') return { ok: true, state: publicState() };
    if (action === 'privacy/consent') {
      state.privacyConsent = true;
      state.connection = { status: 'connecting' };
      await persist();
      await connectWithConsent();
      await broadcastState();
      return { ok: true, state: publicState() };
    }
    if (action === 'privacy/revoke') {
      const activeSocket = socket;
      socket = null;
      try { activeSocket?.off?.(); } catch { /* no-op */ }
      try { activeSocket?.disconnect?.(); } catch { /* no-op */ }
      state.privacyConsent = false;
      delete state.clientId;
      state.connection = { status: 'consent-required' };
      await persist();
      await broadcastState();
      return { ok: true, state: publicState() };
    }
    if (action === 'overlay/register') {
      if (sender?.frameId !== undefined && sender.frameId !== 0) return typedError('TOP_FRAME_REQUIRED', 'page', 'Overlay 只在最上層頁面執行');
      const tabId = sender?.tab?.id;
      if (!validTabId(tabId)) return typedError('TAB_REQUIRED', 'page', '找不到頁面分頁');
      instances.set(tabId, { instanceId: payload.instanceId, visibilityState: payload.visibilityState });
      return { ok: true, state: publicState() };
    }
    if (action === 'overlay/unregister') {
      const tabId = sender?.tab?.id;
      const current = instances.get(tabId);
      if (current?.instanceId === payload.instanceId) instances.delete(tabId);
      return { ok: true };
    }
    if (action === 'overlay/visibility') {
      const tabId = sender?.tab?.id;
      const current = instances.get(tabId);
      if (!current || current.instanceId !== payload.instanceId) return typedError('INSTANCE_NOT_REGISTERED', 'page', '頁面 Overlay 尚未註冊');
      current.visibilityState = payload.visibilityState;
      return { ok: true, state: publicState() };
    }
    if (action === 'popup/status') {
      return { ok: true, registered: instances.has(payload.tabId), state: publicState() };
    }
    if (action === 'overlay/toggle') {
      if (!instances.has(payload.tabId)) return typedError('PAGE_UNAVAILABLE', 'page', '此頁面無法使用 Overlay');
      const sent = await sendTab(payload.tabId, { type: 'DANMAKU_CONTROL', action: 'toggle' });
      return sent ? { ok: true } : typedError('PAGE_UNAVAILABLE', 'page', '無法控制此頁面的 Overlay');
    }
    if (action === 'overlay/set-visible') {
      state.overlayEnabled = payload.visible;
      await persist();
      await broadcastState();
      return { ok: true, state: publicState() };
    }
    if (action === 'settings/update') {
      state.settings = mergeSettings(state.settings, payload.settings);
      await persist();
      await broadcastState();
      return { ok: true, settings: state.settings };
    }
    if (action === 'settings/reset') {
      state.settings = resetAppearance(state.settings);
      await persist();
      await broadcastState();
      return { ok: true, settings: state.settings };
    }
    if (action === 'nickname/change') {
      return emitAck('nickname-change', { nickname: payload.nickname }, {
        scope: 'nickname',
        apply: async (raw, ack) => {
          if (typeof raw.nickname !== 'string' || Array.from(raw.nickname).length > TEXT_LIMITS.nickname || typeof raw.changeDate !== 'string') {
            return typedError('INVALID_ACK', 'nickname', '伺服器暱稱回應格式錯誤');
          }
          state.settings = normalizeSettings({ ...state.settings, nickname: raw.nickname, nicknameChangeDate: raw.changeDate });
          await persist();
          await broadcastState();
          return { ...ack, applied: true, durable: true };
        },
      });
    }
    if (action === 'barrage/send') {
      return emitAck('barrage', {
        text: payload.text,
        nickname: state.settings.nickname,
        color: state.settings.danmaku.color,
      }, { scope: `barrage:${sender?.tab?.id || 'extension'}` });
    }
    if (action === 'room/default') return emitAck('room-default', {}, { scope: 'room-default' });
    if (action === 'room/lookup') return emitAck('room-lookup', payload, { scope: `room-lookup:${payload.roomCode}` });
    if (action === 'room/list') {
      return emitAck('room-list-public', { ...payload, pageSize: 20 }, {
        scope: 'room-list',
        apply: async (raw, ack) => ({ ...ack, rooms: normalizeRoomList(raw.rooms || raw.data), pagination: sanitizePublic(raw.pagination || {}) }),
      });
    }
    if (action === 'room/join') {
      return emitAck('join-room', payload, {
        scope: 'membership',
        apply: async (raw, ack) => {
          await applyRoom(raw.room, raw.recentMessages);
          return ack;
        },
      });
    }
    if (action === 'room/leave') {
      return emitAck('leave-room', {}, {
        scope: 'membership',
        apply: async (_raw, ack) => { await clearRoom(); return ack; },
      });
    }
    if (action === 'room/exit') {
      const found = await emitAck('room-default', {}, { scope: 'room-exit-default' });
      if (!found.ok || !found.room) return found;
      const left = await emitAck('leave-room', {}, {
        scope: 'membership',
        apply: async (_raw, ack) => {
          await clearRoom();
          return { ...ack, left: true };
        },
      });
      if (!left.ok) {
        return left.error?.code === 'LOCAL_STATE_FAILURE' ? { ...left, partial: true, left: true } : left;
      }
      const joined = await emitAck('join-room', { roomCode: found.room.roomCode }, {
        scope: 'membership',
        apply: async (raw, ack) => { await applyRoom(raw.room, raw.recentMessages); return ack; },
      });
      return joined.ok ? joined : { ...joined, partial: true, left: true };
    }
    if (action === 'room/create') {
      return emitAck('room-create', payload, {
        scope: 'membership',
        apply: async (raw, ack) => {
          const room = normalizeRoom(raw.room);
          if (!room || typeof raw.ownerCredential !== 'string' || !raw.ownerCredential) {
            return typedError('INVALID_ACK', 'room', '伺服器建立房間回應格式錯誤');
          }
          await applyRoom(room, raw.recentMessages);
          try {
            await storage.setOwnerCredential(room.roomCode, raw.ownerCredential);
            state.canManageRoom = true;
            await broadcastState();
            return { ...ack, ownerCapabilitySaved: true, canManageRoom: true };
          } catch {
            state.canManageRoom = false;
            await broadcastState();
            return {
              ...typedError('CREDENTIAL_PERSIST_FAILED', 'storage', '房間已建立，但房主憑證無法安全保存'),
              partial: true,
              room,
              ownerCapabilitySaved: false,
              canManageRoom: false,
            };
          }
        },
      });
    }
    if (action === 'room/update' || action === 'room/delete') {
      const credential = await storage.getOwnerCredential(payload.roomCode);
      if (!credential) return typedError('OWNER_CREDENTIAL_MISSING', 'room', '此裝置沒有該房間的房主管理憑證');
      const event = action === 'room/update' ? 'room-update' : 'room-delete';
      return emitAck(event, { ...payload, ownerCredential: credential }, {
        scope: `owner:${payload.roomCode}`,
        apply: async (raw, ack) => {
          if (action === 'room/update' && raw.room) {
            const room = normalizeRoom(raw.room);
            if (room && state.currentRoomCode === room.roomCode) {
              state.currentRoom = room;
              await persist();
              await broadcastState();
            }
          }
          if (action === 'room/delete') {
            await storage.deleteOwnerCredential(payload.roomCode);
            if (state.currentRoomCode === payload.roomCode) await clearRoom();
          }
          return ack;
        },
      });
    }
    if (action === 'report/create') return emitAck('report', payload, { scope: `report:${payload.messageId}` });
    return typedError('UNKNOWN_ACTION', 'message', '不支援的操作');
  }

  const messageListener = (rawMessage, sender, sendResponse) => {
    (async () => {
      try {
        await ready;
        if (stopped) return typedError('SERVICE_STOPPED', 'connection', '背景服務已停止');
        const parsed = parseExtensionMessage(rawMessage);
        return await command(parsed.action, parsed.payload, sender);
      } catch (error) {
        if (error instanceof TypeError) return typedError('INVALID_MESSAGE', 'message', error.message);
        return typedError('INTERNAL_ERROR', 'connection', '背景服務處理失敗');
      }
    })().then((response) => sendResponse(sanitizePublic(response)));
    return true;
  };

  const installedListener = (details) => {
    if (details?.reason !== 'install' || typeof chromeApi.runtime.openOptionsPage !== 'function') return;
    Promise.resolve(chromeApi.runtime.openOptionsPage()).catch(() => {});
  };

  function start() {
    if (started) return ready;
    if (stopped) return Promise.reject(new Error('background controller has stopped'));
    started = true;
    chromeApi.runtime.onMessage.addListener(messageListener);
    chromeApi.runtime.onInstalled?.addListener?.(installedListener);
    initialize().then(readyResolve, readyReject);
    return ready;
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    chromeApi.runtime.onMessage.removeListener?.(messageListener);
    chromeApi.runtime.onInstalled?.removeListener?.(installedListener);
    instances.clear();
    generations.clear();
    try { socket?.off?.(); } catch { /* no-op */ }
    try { socket?.disconnect?.(); } catch { /* no-op */ }
    socket = null;
  }

  return { start, stop, ready, publicState };
}

export async function installExtensionBackground(options) {
  const chromeApi = options?.chromeApi;
  const previous = installedControllers.get(chromeApi);
  if (previous) await previous.stop();
  const controller = createExtensionBackground(options);
  installedControllers.set(chromeApi, controller);
  await controller.start();
  return controller;
}

if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) {
  installExtensionBackground({
    chromeApi: chrome,
    serverUrl: __DANMAKU_SERVER_URL__,
  }).catch(() => {
    // Deliberately silent: diagnostics must not expose connection or credential details.
  });
}
