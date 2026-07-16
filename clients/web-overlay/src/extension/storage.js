import { normalizeSettings } from '../core/settings-contract.js';
import { normalizeRoom } from '../core/room-model.js';

export const EXTENSION_STATE_KEY = 'danmaku.extension.state.v1';
export const EXTENSION_CREDENTIALS_KEY = 'danmaku.extension.credentials.v1';
const ROOM_CODE = /^\d{8}$/;
const MAX_HISTORY = 200;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_HISTORY).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const messageId = typeof entry.messageId === 'string' ? entry.messageId.slice(0, 128) : '';
    const text = typeof entry.text === 'string' ? entry.text.slice(0, 100) : '';
    if (!messageId || !text) return [];
    return [{
      messageId,
      roomCode: ROOM_CODE.test(String(entry.roomCode || '')) ? String(entry.roomCode) : '',
      text,
      nickname: typeof entry.nickname === 'string' ? entry.nickname.slice(0, 6) : '匿名',
      color: /^#[0-9a-f]{6}$/i.test(String(entry.color || '')) ? String(entry.color).toUpperCase() : '#E6EDF3',
      timestamp: Number.isFinite(Number(entry.timestamp)) ? Number(entry.timestamp) : 0,
      ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId.slice(0, 128) } : {}),
      mine: Boolean(entry.mine),
    }];
  });
}

function normalizeDurableState(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const currentRoom = normalizeRoom(source.currentRoom);
  const currentRoomCode = ROOM_CODE.test(String(source.currentRoomCode || ''))
    ? String(source.currentRoomCode)
    : currentRoom?.roomCode;
  return {
    settings: normalizeSettings(source.settings),
    ...(typeof source.clientId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(source.clientId) ? { clientId: source.clientId } : {}),
    ...(currentRoomCode ? { currentRoomCode } : {}),
    ...(currentRoom ? { currentRoom } : {}),
    joinedRoomCodes: Array.isArray(source.joinedRoomCodes)
      ? [...new Set(source.joinedRoomCodes.map(String).filter((code) => ROOM_CODE.test(code)))]
      : [],
    history: normalizeHistory(source.history),
    overlayEnabled: source.overlayEnabled === undefined ? true : Boolean(source.overlayEnabled),
  };
}

function credentialsRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([code, credential]) => (
    ROOM_CODE.test(code) && typeof credential === 'string' && credential.length > 0 && credential.length <= 512
  )));
}

export function createExtensionStorage(chromeApi) {
  const area = chromeApi?.storage?.local;
  if (!area || typeof area.get !== 'function' || typeof area.set !== 'function') {
    throw new TypeError('chrome.storage.local is required');
  }
  let initialized = false;

  async function initialize() {
    if (initialized) return;
    if (typeof area.setAccessLevel === 'function') {
      await area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    }
    initialized = true;
  }

  async function read(key) {
    await initialize();
    const result = await area.get(key);
    return clone(result?.[key]);
  }

  return {
    initialize,
    async loadState() {
      return normalizeDurableState(await read(EXTENSION_STATE_KEY));
    },
    async saveState(value) {
      await initialize();
      const normalized = normalizeDurableState(value);
      await area.set({ [EXTENSION_STATE_KEY]: normalized });
      return clone(normalized);
    },
    async getOwnerCredential(roomCode) {
      if (!ROOM_CODE.test(String(roomCode || ''))) return null;
      const record = credentialsRecord(await read(EXTENSION_CREDENTIALS_KEY));
      return record[roomCode] || null;
    },
    async hasOwnerCredential(roomCode) {
      return Boolean(await this.getOwnerCredential(roomCode));
    },
    async setOwnerCredential(roomCode, credential) {
      if (!ROOM_CODE.test(String(roomCode || ''))) throw new TypeError('roomCode must be exactly 8 digits');
      if (typeof credential !== 'string' || !credential || credential.length > 512) throw new TypeError('owner credential is invalid');
      const record = credentialsRecord(await read(EXTENSION_CREDENTIALS_KEY));
      const next = { ...record, [roomCode]: credential };
      await area.set({ [EXTENSION_CREDENTIALS_KEY]: next });
      return true;
    },
    async deleteOwnerCredential(roomCode) {
      if (!ROOM_CODE.test(String(roomCode || ''))) return false;
      const record = credentialsRecord(await read(EXTENSION_CREDENTIALS_KEY));
      if (!Object.hasOwn(record, roomCode)) return false;
      delete record[roomCode];
      await area.set({ [EXTENSION_CREDENTIALS_KEY]: record });
      return true;
    },
  };
}

export { normalizeDurableState, normalizeHistory };
