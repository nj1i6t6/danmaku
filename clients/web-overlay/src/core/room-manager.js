import { createJoinedRoomStore, normalizeRoom, normalizeRoomList, roomExitAction, roomExpiryHint, validRoomCode } from './room-model.js';
import { appendTextElement, renderRoomName } from './safe-render.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const inertRestoreByModal = new WeakMap();

function isInertElement(element) {
  for (let current = element; current; current = current.parentElement) {
    if (current.inert || current.hasAttribute?.('inert')) return true;
  }
  return false;
}

export function setBackgroundInert(document, modalRoot, active) {
  const parent = modalRoot?.parentElement;
  const sameParent = parent?.children && Array.from(parent.children).includes(modalRoot);
  const candidates = sameParent
    ? Array.from(parent.children)
    : Array.from(document.body.children).filter((element) => element !== modalRoot && !element.contains?.(modalRoot));
  if (active) {
    const previous = inertRestoreByModal.get(modalRoot) || new Map();
    for (const element of candidates) {
      if (element === modalRoot) continue;
      if (!previous.has(element)) previous.set(element, Boolean(element.inert));
      element.inert = true;
    }
    inertRestoreByModal.set(modalRoot, previous);
    return;
  }
  const previous = inertRestoreByModal.get(modalRoot);
  if (!previous) return;
  for (const [element, wasInert] of previous) element.inert = wasInert;
  inertRestoreByModal.delete(modalRoot);
}

function focusableElements(document, container) {
  return Array.from(container.querySelectorAll(FOCUSABLE))
    .filter((element) => !element.hidden && !element.closest('[hidden]') && !isInertElement(element));
}

export function createRoomExitCoordinator({
  getCurrentRoomCode,
  getDefaultRoom,
  leaveRoom,
  joinRoom,
  removeShortcut,
}) {
  for (const [name, method] of Object.entries({ getCurrentRoomCode, getDefaultRoom, leaveRoom, joinRoom, removeShortcut })) {
    if (typeof method !== 'function') throw new TypeError(`room exit coordinator.${name} must be a function`);
  }
  const defaultUnavailable = () => ({
    ok: false,
    action: 'default-room-unavailable',
    partial: false,
    error: { code: 'DEFAULT_ROOM_UNAVAILABLE', scope: 'room', message: '暫時無法確認預設房' },
  });
  const storageFailure = () => ({
    code: 'LOCAL_STORAGE_FAILURE',
    scope: 'storage',
    message: '已加入清單更新失敗',
  });
  const joinFailure = () => ({
    code: 'ROOM_JOIN_FAILED',
    scope: 'room',
    message: '回預設房失敗',
  });
  return {
    async exit(room) {
      const roomCode = String(room?.roomCode || '');
      let defaultRoom;
      try {
        defaultRoom = await getDefaultRoom();
      } catch {
        return defaultUnavailable();
      }
      const defaultRoomCode = String(defaultRoom?.roomCode || '');
      if (!validRoomCode(defaultRoomCode)) return defaultUnavailable();

      let currentRoomCode;
      try {
        currentRoomCode = getCurrentRoomCode();
      } catch {
        return {
          ok: false,
          action: 'room-state-unavailable',
          partial: false,
          error: { code: 'ROOM_STATE_UNAVAILABLE', scope: 'room', message: '暫時無法確認目前房間' },
        };
      }
      const action = roomExitAction(roomCode, currentRoomCode, defaultRoomCode);
      if (action === 'block-default') return { ok: false, action, partial: false };
      if (action === 'remove-shortcut') {
        try {
          await removeShortcut(roomCode);
          return { ok: true, action };
        } catch {
          return { ok: false, action, partial: false, error: storageFailure() };
        }
      }

      let left;
      try {
        left = await leaveRoom();
      } catch {
        return {
          ok: false,
          action,
          partial: false,
          error: { code: 'ROOM_EXIT_FAILED', scope: 'room', message: '退出失敗' },
        };
      }
      if (!left?.ok) return { ...(left && typeof left === 'object' ? left : {}), ok: false, action, partial: false };

      let shortcutRemovalError = null;
      try {
        await removeShortcut(roomCode);
      } catch {
        shortcutRemovalError = storageFailure();
      }

      let joined;
      try {
        joined = await joinRoom(defaultRoomCode);
      } catch {
        return {
          ok: false,
          action,
          partial: true,
          message: '已退出但回預設失敗',
          error: joinFailure(),
        };
      }
      if (!joined?.ok) {
        const detail = joined?.error?.message ? `：${joined.error.message}` : '';
        return {
          ...(joined && typeof joined === 'object' ? joined : {}),
          ok: false,
          action,
          partial: true,
          message: `已退出但回預設失敗${detail}`,
        };
      }
      if (shortcutRemovalError) {
        return {
          ...joined,
          ok: false,
          action,
          partial: true,
          message: '已回到預設房但無法更新已加入清單',
          error: shortcutRemovalError,
        };
      }
      return { ...joined, ok: true, action, room: joined.room };
    },
  };
}

export function trapFocus(document, container, event) {
  if (event.key !== 'Tab') return;
  const focusable = focusableElements(document, container);
  if (!focusable.length) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

const REQUIRED_ADAPTER_METHODS = [
  'emitAck',
  'secureGet',
  'secureSet',
  'secureDelete',
  'getCurrentRoom',
  'onRoomChanged',
  'joinRoom',
  'leaveRoom',
  'createRoom',
];

export function validateRoomManagerAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('room manager platform adapter is required');
  }
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new TypeError(`room manager platform adapter.${method} must be a function`);
    }
  }
  return adapter;
}

export function ownerCredentialKey(roomCode) {
  if (!validRoomCode(roomCode)) throw new TypeError('roomCode must be exactly 8 digits');
  return `room-owner:${roomCode}`;
}

export function canManageRoom(managerRoom, activeRoom, credential) {
  const managerCode = String(managerRoom?.roomCode || '');
  const activeCode = String(activeRoom?.roomCode || '');
  return Boolean(credential)
    && validRoomCode(managerCode)
    && managerCode === activeCode;
}

export function createOwnerCredentialVault(adapter) {
  for (const method of ['secureGet', 'secureSet', 'secureDelete']) {
    if (typeof adapter?.[method] !== 'function') {
      throw new TypeError(`owner credential vault adapter.${method} must be a function`);
    }
  }
  const volatile = new Map();

  return {
    async store(roomCode, credential) {
      const key = ownerCredentialKey(roomCode);
      if (typeof credential !== 'string' || !credential) throw new TypeError('owner credential must be a non-empty string');
      volatile.set(key, credential);
      try {
        await adapter.secureSet(key, credential);
        volatile.delete(key);
        return { durable: true };
      } catch {
        return { durable: false };
      }
    },
    async get(roomCode) {
      const key = ownerCredentialKey(roomCode);
      const fallback = volatile.get(key);
      if (fallback) {
        try {
          await adapter.secureSet(key, fallback);
          volatile.delete(key);
        } catch {
          // Keep the one-time credential only in memory for this process.
        }
        return fallback;
      }
      try {
        return await adapter.secureGet(key) || null;
      } catch {
        return null;
      }
    },
    async remove(roomCode) {
      const key = ownerCredentialKey(roomCode);
      volatile.delete(key);
      try {
        await adapter.secureDelete(key);
        return { durable: true };
      } catch {
        return { durable: false };
      }
    },
  };
}

let joinedStore;
let roomDocument;
let roomConfirm;
let client;
let ownerCredentials;
let currentRoom = null;
let defaultRoom = null;
let defaultRoomLookup = 'unknown';
let previewRoom = null;
let page = 1;
let pages = 1;
let query = '';
let restoreFocus = null;
let joinedRenderGeneration = 0;
let roomExitCoordinator;
const exitInFlight = new Set();
const messageFor = (result, fallback) => result?.error?.message || fallback;
function status(message, error = false) { const el = roomDocument.getElementById('room-status'); el.textContent = message || ''; el.classList.toggle('error', error); }

function joinedStorageError() {
  return { code: 'LOCAL_STORAGE_FAILURE', scope: 'storage', message: '已加入清單更新失敗' };
}

function safeJoinedStoreWrite(method, roomCode) {
  try {
    joinedStore[method](roomCode);
    return { ok: true };
  } catch {
    return { ok: false, error: joinedStorageError() };
  }
}

function safeJoinedStoreList() {
  try {
    const codes = joinedStore.list();
    if (!Array.isArray(codes)) throw new TypeError('joined room store list must return an array');
    return { ok: true, codes };
  } catch {
    return { ok: false, codes: [], error: joinedStorageError() };
  }
}

function setSummary(room) {
  currentRoom = room;
  renderRoomName(roomDocument.getElementById('room-name'), room?.name || '尚未加入房間');
  roomDocument.getElementById('room-code').textContent = room ? `#${room.roomCode}` : '#--------';
  roomDocument.getElementById('room-count').textContent = room ? `${room.count} / ${room.capacity} 人` : '0 / 0 人';
  const persistence = room ? safeJoinedStoreWrite('add', room.roomCode) : { ok: true };
  if (!persistence.ok) status('房間狀態已更新，但已加入清單暫時無法更新', true);
  renderOwner();
  return persistence;
}

function roomCard(room, caption = '', { showExit = false } = {}) {
  const card = roomDocument.createElement('article'); card.className = 'room-card'; card.dataset.roomCode = room.roomCode;
  const body = roomDocument.createElement('div');
  appendTextElement(body, 'strong', 'room-card-name', room.name);
  appendTextElement(body, 'span', 'room-card-meta', `#${room.roomCode} · ${room.count}/${room.capacity} 人${room.requiresPassword ? ' · 需要密碼' : ''}`);
  if (caption) appendTextElement(body, 'small', '', caption);
  const actions = roomDocument.createElement('div'); actions.className = 'room-card-actions';
  const button = roomDocument.createElement('button'); button.type = 'button'; button.dataset.roomAction = 'preview'; button.textContent = currentRoom?.roomCode === room.roomCode ? '目前房間' : '預覽加入';
  button.setAttribute('aria-label', `${button.textContent}：${room.name}`);
  button.addEventListener('click', () => { previewRoom = room; roomDocument.getElementById('join-room-code').value = room.roomCode; showPreview(room); });
  actions.appendChild(button);
  if (showExit) {
    const exitButton = roomDocument.createElement('button'); exitButton.type = 'button'; exitButton.dataset.roomAction = 'exit'; exitButton.textContent = '退出';
    exitButton.setAttribute('aria-label', `退出房間：${room.name}`);
    if (exitInFlight.has(room.roomCode)) { exitButton.disabled = true; exitButton.setAttribute('aria-busy', 'true'); }
    exitButton.addEventListener('click', () => handleRoomExit(room, exitButton));
    actions.appendChild(exitButton);
  }
  card.append(body, actions); return card;
}

async function renderJoined() {
  const generation = ++joinedRenderGeneration;
  const list = roomDocument.getElementById('joined-room-list'); list.replaceChildren();
  if (!defaultRoom) {
    defaultRoomLookup = 'loading';
    let defaultResult;
    try {
      defaultResult = await client.emitAck('room-default', {});
    } catch {
      defaultResult = { ok: false, error: { code: 'DEFAULT_ROOM_UNAVAILABLE', scope: 'room', message: '暫時無法確認預設房' } };
    }
    if (generation !== joinedRenderGeneration) return;
    defaultRoom = defaultResult?.ok ? normalizeRoom(defaultResult.room) : null;
    defaultRoomLookup = defaultRoom ? 'available' : 'unavailable';
    if (!defaultRoom) status('暫時無法確認預設房', true);
  }
  if (generation !== joinedRenderGeneration) return;
  const defaultRoomKnown = defaultRoomLookup === 'available' && Boolean(defaultRoom);
  if (defaultRoomKnown) {
    list.appendChild(roomCard(
      defaultRoom,
      currentRoom?.roomCode === defaultRoom.roomCode ? '預設房間 · 目前房間 · 固定置頂' : '預設房間 · 固定置頂',
    ));
  }
  if (currentRoom && (!defaultRoomKnown || currentRoom.roomCode !== defaultRoom.roomCode)) {
    list.appendChild(roomCard(currentRoom, '目前房間', { showExit: defaultRoomKnown }));
  }
  const stored = safeJoinedStoreList();
  if (!stored.ok) status('已加入清單暫時無法載入', true);
  const codes = stored.codes.filter((code) => code !== currentRoom?.roomCode && code !== defaultRoom?.roomCode);
  let results;
  try {
    results = await Promise.all(codes.map((roomCode) => client.emitAck('room-lookup', { roomCode })));
  } catch {
    if (generation !== joinedRenderGeneration) return;
    status('已加入房間載入失敗', true);
    results = [];
  }
  if (generation !== joinedRenderGeneration) return;
  results.filter((result) => result?.ok).map((result) => normalizeRoom(result.room)).filter(Boolean)
    .forEach((room) => list.appendChild(roomCard(room, '已加入', { showExit: defaultRoomKnown })));
  if (!list.children.length) appendTextElement(list, 'p', 'room-empty', '尚無已加入房間。');
}

async function handleRoomExit(room, button) {
  if (exitInFlight.has(room.roomCode)) return;
  exitInFlight.add(room.roomCode);
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    const result = await roomExitCoordinator.exit(room);
    if (result.ok) {
      status(result.action === 'remove-shortcut' ? `已退出 ${room.name}` : '已退出並回到預設房');
    } else if (result.partial) {
      status(result.message || '已退出但回預設失敗', true);
    } else {
      status(messageFor(result, '退出失敗'), true);
    }
    if (result.ok || result.partial) void renderJoined();
  } catch {
    status('退出失敗', true);
  } finally {
    exitInFlight.delete(room.roomCode);
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }
}

async function renderPublic() {
  const list = roomDocument.getElementById('public-room-list'); list.replaceChildren(); appendTextElement(list, 'p', 'room-empty', '載入中…');
  const result = await client.emitAck('room-list-public', { ...(query ? { query } : {}), page, pageSize: 20 });
  list.replaceChildren();
  if (!result.ok) { appendTextElement(list, 'p', 'room-empty', messageFor(result, '公開房載入失敗')); return; }
  const rooms = normalizeRoomList(result); rooms.forEach((room) => list.appendChild(roomCard(room)));
  if (!rooms.length) appendTextElement(list, 'p', 'room-empty', '找不到公開房間。');
  const pagination = result.pagination || {}; page = Math.max(1, Number(pagination.page ?? pagination.currentPage) || page); pages = Math.max(1, Number(pagination.totalPages) || 1);
  roomDocument.getElementById('public-page').textContent = `${page} / ${pages}`;
  roomDocument.getElementById('public-prev').setAttribute('aria-disabled', String(page <= 1)); roomDocument.getElementById('public-next').setAttribute('aria-disabled', String(page >= pages));
}

function showPreview(room) {
  roomDocument.getElementById('room-preview').hidden = false;
  renderRoomName(roomDocument.getElementById('preview-name'), room.name);
  roomDocument.getElementById('preview-meta').textContent = `#${room.roomCode} · ${room.count}/${room.capacity} 人`;
  const input = roomDocument.getElementById('join-password');
  input.hidden = !room.requiresPassword; input.required = room.requiresPassword;
  roomDocument.getElementById('join-password-label').hidden = !room.requiresPassword;
  if (!room.requiresPassword) input.value = '';
  roomDocument.getElementById('join-room-button').focus();
}

async function renderOwner() {
  const section = roomDocument.getElementById('owner-section');
  const credential = currentRoom ? await ownerCredentials.get(currentRoom.roomCode) : null;
  if (!canManageRoom(currentRoom, client.getCurrentRoom(), credential)) { section.hidden = true; return; }
  section.hidden = false;
  roomDocument.getElementById('owner-name').value = currentRoom.name;
  roomDocument.getElementById('owner-visibility').value = currentRoom.visibility;
  roomDocument.getElementById('owner-password-row').hidden = currentRoom.visibility !== 'unlisted';
}

function open() {
  const panel = roomDocument.getElementById('room-manager-panel'); restoreFocus = roomDocument.activeElement;
  panel.classList.remove('hidden'); setBackgroundInert(roomDocument, panel, true); panel.focus(); renderJoined(); renderPublic();
}
function close() {
  const panel = roomDocument.getElementById('room-manager-panel');
  panel.classList.add('hidden'); setBackgroundInert(roomDocument, panel, false); restoreFocus?.focus?.();
}

export function initRoomManager(api, environment = {}) {
  client = validateRoomManagerAdapter(api);
  ownerCredentials = createOwnerCredentialVault(client);
  roomDocument = environment.document ?? globalThis.document;
  const storage = environment.storage ?? globalThis.localStorage;
  roomConfirm = environment.confirm ?? globalThis.confirm;
  if (!roomDocument || typeof roomDocument.getElementById !== 'function') throw new TypeError('room manager document adapter is required');
  if (typeof roomConfirm !== 'function') throw new TypeError('room manager confirm adapter is required');
  const explicitJoinedStore = environment.joinedRoomStore;
  if (explicitJoinedStore !== undefined) {
    for (const method of ['list', 'add', 'remove']) {
      if (typeof explicitJoinedStore?.[method] !== 'function') throw new TypeError(`room manager joinedRoomStore.${method} must be a function`);
    }
    joinedStore = explicitJoinedStore;
  } else {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw new TypeError('room manager storage adapter is required');
    joinedStore = createJoinedRoomStore(storage, 'danmaku-overlay-joined-room-codes');
  }
  defaultRoom = null;
  defaultRoomLookup = 'unknown';
  roomExitCoordinator = createRoomExitCoordinator({
    getCurrentRoomCode: () => client.getCurrentRoom()?.roomCode || currentRoom?.roomCode || null,
    getDefaultRoom: () => defaultRoom,
    leaveRoom: () => client.leaveRoom(),
    joinRoom: (roomCode) => client.joinRoom(roomCode),
    removeShortcut: (roomCode) => joinedStore.remove(roomCode),
  });
  roomDocument.getElementById('room-summary-button').addEventListener('click', open);
  roomDocument.getElementById('btn-close-room-manager').addEventListener('click', close);
  roomDocument.getElementById('room-manager-panel').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    trapFocus(roomDocument, roomDocument.getElementById('room-manager-panel'), event);
  });
  client.onRoomChanged((room, reason) => { setSummary(room); if (reason) status(reason, true); if (!roomDocument.getElementById('room-manager-panel').classList.contains('hidden')) renderJoined(); });

  roomDocument.getElementById('public-room-search').addEventListener('submit', (event) => { event.preventDefault(); query = roomDocument.getElementById('public-room-query').value.trim(); page = 1; renderPublic(); });
  roomDocument.getElementById('public-prev').addEventListener('click', () => { if (page > 1) { page--; renderPublic(); } else status('已在第一頁'); });
  roomDocument.getElementById('public-next').addEventListener('click', () => { if (page < pages) { page++; renderPublic(); } else status('已在最後一頁'); });

  roomDocument.getElementById('room-lookup-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const roomCode = roomDocument.getElementById('join-room-code').value.trim();
    if (!validRoomCode(roomCode)) { status('房間碼必須是 8 位數字', true); return; }
    const result = await client.emitAck('room-lookup', { roomCode });
    previewRoom = result.ok ? normalizeRoom(result.room) : null;
    if (!previewRoom) { status(messageFor(result, '找不到房間'), true); return; }
    showPreview(previewRoom); status('請確認房名後加入');
  });
  roomDocument.getElementById('join-room-button').addEventListener('click', async () => {
    if (!previewRoom) return;
    const room = previewRoom;
    const password = roomDocument.getElementById('join-password');
    if (room.requiresPassword && !password.reportValidity()) return;
    const result = await client.joinRoom(room.roomCode, room.requiresPassword ? password.value : undefined); password.value = '';
    if (!result.ok) { status(messageFor(result, '加入失敗'), true); return; }
    const persistence = safeJoinedStoreWrite('add', room.roomCode);
    status(persistence.ok ? `已加入 ${room.name}` : `已加入 ${room.name}，但已加入清單暫時無法更新`, !persistence.ok);
    void renderJoined();
  });

  roomDocument.querySelectorAll('input[name="create-visibility"]').forEach((input) => input.addEventListener('change', () => {
    const unlisted = roomDocument.querySelector('input[name="create-visibility"]:checked').value === 'unlisted';
    roomDocument.getElementById('create-password-row').hidden = !unlisted;
    if (!unlisted) roomDocument.getElementById('create-password').value = '';
  }));
  roomDocument.getElementById('create-retention').addEventListener('change', (event) => { roomDocument.getElementById('expiry-hint').textContent = `最後有效活動後 ${event.target.value} 天到期。`; });
  roomDocument.getElementById('room-create-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return;
    const visibility = roomDocument.querySelector('input[name="create-visibility"]:checked').value; const password = roomDocument.getElementById('create-password').value;
    const payload = { name: roomDocument.getElementById('create-name').value.trim(), visibility, retentionDays: Number(roomDocument.getElementById('create-retention').value), ...(visibility === 'unlisted' && password ? { password } : {}) };
    const result = await client.createRoom(payload); const room = result.ok ? normalizeRoom(result.room) : null;
    if (!room) { status(messageFor(result, '建立失敗'), true); return; }
    if (typeof result.ownerCredential !== 'string' || !result.ownerCredential) { status('房間已建立，但安全房主憑證缺失', true); return; }
    const credentialStorage = await ownerCredentials.store(room.roomCode, result.ownerCredential);
    const summaryPersistence = result.roomTransitionApplied !== false ? setSummary(room) : { ok: true };
    const persistence = safeJoinedStoreWrite('add', room.roomCode);
    form.reset(); roomDocument.getElementById('create-password-row').hidden = true;
    const warnings = [];
    if (!credentialStorage.durable) warnings.push('安全儲存暫時失敗；僅本次執行可管理');
    if (!summaryPersistence.ok || !persistence.ok) warnings.push('已加入清單暫時無法更新');
    status(warnings.length
      ? `已建立 ${room.name}，${warnings.join('；')}`
      : `已建立 ${room.name}，${roomExpiryHint(room)}`, warnings.length > 0);
    void renderJoined();
  });

  roomDocument.getElementById('owner-visibility').addEventListener('change', (event) => { roomDocument.getElementById('owner-password-row').hidden = event.target.value !== 'unlisted'; });
  roomDocument.getElementById('owner-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (!currentRoom) return;
    const ownerCredential = await ownerCredentials.get(currentRoom.roomCode);
    if (!ownerCredential) { status('系統安全儲存中找不到房主憑證', true); return; }
    const visibility = roomDocument.getElementById('owner-visibility').value; const password = roomDocument.getElementById('owner-password').value; const remove = roomDocument.getElementById('owner-remove-password').checked;
    const payload = { roomCode: currentRoom.roomCode, ownerCredential, name: roomDocument.getElementById('owner-name').value.trim(), visibility };
    if (visibility === 'public' && currentRoom.requiresPassword) payload.passwordAction = { type: 'remove' };
    else if (visibility === 'unlisted' && remove) payload.passwordAction = { type: 'remove' }; else if (visibility === 'unlisted' && password) payload.passwordAction = { type: 'set', password };
    const result = await client.emitAck('room-update', payload);
    if (!result.ok) { status(messageFor(result, '更新失敗'), true); return; }
    const room = normalizeRoom(result.room); if (room) setSummary(room);
    roomDocument.getElementById('owner-password').value = ''; roomDocument.getElementById('owner-remove-password').checked = false; status('房間設定已更新');
  });
  roomDocument.getElementById('delete-room-button').addEventListener('click', async () => {
    if (!currentRoom || !roomConfirm(`確定關閉「${currentRoom.name}」？此操作無法復原。`)) return;
    const ownerCredential = await ownerCredentials.get(currentRoom.roomCode);
    if (!ownerCredential) { status('系統安全儲存中找不到房主憑證', true); return; }
    const code = currentRoom.roomCode; const result = await client.emitAck('room-delete', { roomCode: code, ownerCredential });
    if (!result.ok) { status(messageFor(result, '關房失敗'), true); return; }
    const credentialDeletion = await ownerCredentials.remove(code);
    const persistence = safeJoinedStoreWrite('remove', code);
    setSummary(null);
    const warnings = [];
    if (!credentialDeletion.durable) warnings.push('安全儲存清理失敗');
    if (!persistence.ok) warnings.push('已加入清單暫時無法更新');
    status(warnings.length ? `房間已關閉，但${warnings.join('；')}` : '房間已關閉', warnings.length > 0);
    void renderJoined();
  });

  setSummary(client.getCurrentRoom());
}