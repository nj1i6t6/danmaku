import { OVERLAY_TEMPLATE } from '../core/overlay-template.js';
import overlayCss from '../core/overlay.css';
import { APPEARANCE_DEFAULTS, normalizeSettings } from '../core/settings-contract.js';
import { createColorDraft, hexToHsv, hsvToHex } from '../core/hsv-color-picker.js';
import { normalizeRoom } from '../core/room-model.js';

const HOST_ID = 'danmaku-overlay-extension-host';
const MESSAGE_LIMIT = 100;
const HISTORY_LIMIT = 200;
const INSTANCE_PREFIX = 'danmaku-page-';
const EXTENSION_STYLE = `
:host {
  all: initial !important;
  position: fixed !important;
  inset: 0 !important;
  width: 0 !important;
  height: 0 !important;
  z-index: 2147483647 !important;
  pointer-events: none !important;
  color-scheme: dark;
  font-family: -apple-system, BlinkMacSystemFont, "Noto Sans TC", "Microsoft JhengHei", sans-serif;
  --panel-width: 320px;
  --panel-height: auto;
}
:host([hidden]) { display: none !important; }
#danmaku-overlay-root { all: initial; font-family: inherit; pointer-events: none; }
#danmaku-overlay-root, #danmaku-overlay-root * { box-sizing: border-box; }
#danmaku-overlay-root button, #danmaku-overlay-root input, #danmaku-overlay-root select { font: inherit; }
#danmaku-overlay-root .floating-ball,
#danmaku-overlay-root .panel,
#danmaku-overlay-root .history-panel,
#danmaku-overlay-root .settings-panel,
#danmaku-overlay-root .room-manager-panel,
#danmaku-overlay-root .hsv-picker-dialog,
#danmaku-overlay-root .onboarding { pointer-events: auto; }
#danmaku-overlay-root .permission-state { padding: 8px 10px; border-radius: 8px; background: rgba(20,20,30,.94); color: #e6edf3; }
@media (prefers-reduced-motion: reduce) { #danmaku-overlay-root .danmaku { animation-duration: .01ms !important; } }
`;

function safeMessage(error, fallback = '操作失敗') {
  return typeof error?.message === 'string' && error.message ? error.message : fallback;
}

function send(action, payload = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action, payload }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          resolve({ ok: false, error: { code: 'BACKGROUND_UNAVAILABLE', scope: 'extension', message: '背景服務暫時無法使用' } });
          return;
        }
        resolve(response && typeof response === 'object'
          ? response
          : { ok: false, error: { code: 'INVALID_RESPONSE', scope: 'extension', message: '背景服務回應格式錯誤' } });
      });
    } catch {
      resolve({ ok: false, error: { code: 'BACKGROUND_UNAVAILABLE', scope: 'extension', message: '背景服務暫時無法使用' } });
    }
  });
}

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function clamp(value, [minimum, maximum]) {
  return Math.min(maximum, Math.max(minimum, Number(value)));
}

function rgba(hex, opacity) {
  const value = String(hex).replace('#', '');
  const number = Number.parseInt(value, 16);
  return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${opacity})`;
}

function validRoomCode(value) {
  return /^\d{8}$/.test(String(value || ''));
}

function createInstanceId() {
  if (globalThis.crypto?.randomUUID) return `${INSTANCE_PREFIX}${globalThis.crypto.randomUUID()}`;
  const entropy = globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint32Array(2)).join('-') : `${Date.now()}-${Math.random()}`;
  return `${INSTANCE_PREFIX}${entropy}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120);
}

function displayError(response, fallback = '操作失敗') {
  return response?.ok === false ? safeMessage(response.error, fallback) : fallback;
}

export function installContentOverlay({ documentRef = document, windowRef = window } = {}) {
  if (windowRef.top !== windowRef) return null;
  const existing = documentRef.getElementById(HOST_ID);
  if (existing?.__danmakuController) return existing.__danmakuController;
  if (existing) existing.remove();

  const host = documentRef.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-danmaku-extension', 'true');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = documentRef.createElement('style');
  style.textContent = `${overlayCss}\n${EXTENSION_STYLE}`;
  const root = documentRef.createElement('div');
  root.id = 'danmaku-overlay-root';
  root.innerHTML = OVERLAY_TEMPLATE;
  shadow.append(style, root);
  (documentRef.documentElement || documentRef.body).append(host);

  const $ = (id) => shadow.getElementById(id);
  const instanceId = createInstanceId();
  let state = null;
  let stopped = false;
  let eventsInitialized = false;
  let startPromise = null;
  let drag = null;
  let toastTimer = null;
  let retryText = '';
  let currentLookup = null;
  let publicPage = 1;
  let publicQuery = '';
  let currentColorTarget = null;
  let colorDraft = null;
  let lastFocused = null;
  const barrageNodes = new Map();

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = String(message || '');
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 2400);
  }

  function setRoomStatus(message, error = false) {
    const node = $('room-status');
    node.textContent = String(message || '');
    node.classList.toggle('error', error);
  }

  function connectionLabel() {
    const status = state?.connection?.status;
    if (status === 'connected') return '已連線';
    if (status === 'reconnecting') return '重新連線中';
    if (status === 'disconnected') return '連線已拒絕';
    return '連線中';
  }

  function applyAppearance() {
    if (!state) return;
    const settings = normalizeSettings(state.settings);
    const ball = $('floating-ball');
    ball.style.width = `${settings.ball.size}px`;
    ball.style.height = `${settings.ball.size}px`;
    ball.style.background = rgba(settings.ball.color, settings.ball.opacity);
    const x = settings.ballPosition.x;
    const y = settings.ballPosition.y;
    ball.style.left = x === null ? '' : `${Math.max(0, x)}px`;
    ball.style.right = x === null ? '20px' : 'auto';
    ball.style.top = `${Math.max(0, y)}px`;
    root.style.setProperty('--panel-width', `${settings.panel.width}px`);
    root.style.setProperty('--panel-height', settings.panel.height ? `${settings.panel.height}px` : 'auto');
    $('msg-input').style.background = rgba(settings.input.color, settings.input.opacity);
    $('msg-input').style.fontSize = `${settings.input.size}px`;
    host.hidden = state.overlayEnabled === false;
    $('danmaku-stage').hidden = settings.danmakuVisible === false;

    $('ball-color-swatch').style.background = settings.ball.color;
    $('ball-color-value').textContent = settings.ball.color;
    $('dm-color-swatch').style.background = settings.danmaku.color;
    $('dm-color-value').textContent = settings.danmaku.color;
    $('input-color-swatch').style.background = settings.input.color;
    $('input-color-value').textContent = settings.input.color;
    $('ball-size').value = String(settings.ball.size);
    $('ball-opacity').value = String(Math.round(settings.ball.opacity * 100));
    $('dm-size').value = String(settings.danmaku.size);
    $('dm-opacity').value = String(Math.round(settings.danmaku.opacity * 100));
    $('input-size').value = String(settings.input.size);
    $('input-opacity').value = String(Math.round(settings.input.opacity * 100));
    $('panel-width').value = String(settings.panel.width);
    $('panel-height').value = String(settings.panel.height);
    $('panel-width-value').textContent = `${settings.panel.width}px`;
    $('panel-height-value').textContent = settings.panel.height ? `${settings.panel.height}px` : '自動';
    $('nickname-input').value = settings.nickname;
    if (!settings.onboarded) $('onboarding').classList.remove('hidden');
  }

  function renderRoom() {
    const room = normalizeRoom(state?.currentRoom || {});
    $('room-name').textContent = room?.name || '尚未加入房間';
    $('room-code').textContent = room ? `#${room.roomCode}` : '#--------';
    $('room-count').textContent = room ? `${room.count} / ${room.capacity} 人` : '0 / 0 人';
    $('ball-count').textContent = room?.count ?? 0;
    $('ball-status').classList.toggle('disconnected', state?.connection?.status !== 'connected');
    $('send-status').textContent = room ? connectionLabel() : '請先加入房間';
    const canSend = Boolean(room && state?.connection?.status === 'connected');
    $('btn-send').setAttribute('aria-disabled', String(!canSend));
    $('msg-input').disabled = !canSend;
    renderJoinedRooms();
    renderOwnerForm();
  }

  function renderHistory() {
    const list = $('history-list');
    list.replaceChildren();
    const history = Array.isArray(state?.history) ? state.history.slice(-HISTORY_LIMIT) : [];
    for (const message of history) {
      const row = createElement('div', 'history-item');
      row.dataset.messageId = String(message.messageId || '');
      row.append(
        createElement('span', 'history-nick', message.nickname || '匿名'),
        createElement('span', 'history-text', message.text || ''),
      );
      if (message.messageId) {
        const report = createElement('button', 'history-report', '檢舉');
        report.type = 'button';
        report.addEventListener('click', async () => {
          const response = await send('report/create', { messageId: String(message.messageId), reason: '使用者檢舉' });
          showToast(response.ok ? '已送出檢舉' : displayError(response));
        });
        row.append(report);
      }
      list.append(row);
    }
    if (!history.length) list.append(createElement('p', 'room-empty', '尚無歷史彈幕'));
  }

  function renderJoinedRooms() {
    const list = $('joined-room-list');
    list.replaceChildren();
    const current = normalizeRoom(state?.currentRoom || {});
    const codes = [...new Set([...(state?.joinedRoomCodes || []), ...(current ? [current.roomCode] : [])])];
    if (!codes.length) {
      list.append(createElement('p', 'room-empty', '尚未加入任何房間'));
      return;
    }
    for (const code of codes) {
      const room = current?.roomCode === code ? current : { roomCode: code, name: `房間 #${code}`, count: 0, capacity: 200 };
      const card = createElement('div', 'room-card');
      const details = createElement('div');
      details.append(createElement('strong', 'room-card-name', room.name), createElement('small', 'room-card-meta', `#${code}${current?.roomCode === code ? '・目前房間' : ''}`));
      const actions = createElement('div', 'room-card-actions');
      if (current?.roomCode !== code) {
        const join = createElement('button', '', '加入');
        join.type = 'button';
        join.addEventListener('click', () => joinRoom(code));
        actions.append(join);
      } else {
        const exit = createElement('button', '', '退出');
        exit.type = 'button';
        exit.addEventListener('click', exitRoom);
        actions.append(exit);
      }
      card.append(details, actions);
      list.append(card);
    }
  }

  function renderOwnerForm() {
    const room = normalizeRoom(state?.currentRoom || {});
    const section = $('owner-section');
    section.hidden = !(room && state?.canManageRoom);
    if (section.hidden) return;
    $('owner-name').value = room.name;
    $('owner-visibility').value = room.visibility || 'public';
    const unlisted = (room.visibility || 'public') === 'unlisted';
    $('owner-password-row').hidden = !unlisted;
    $('owner-remove-password').checked = false;
    $('owner-password').value = '';
  }

  function applyState(nextState) {
    if (!nextState || typeof nextState !== 'object') return;
    state = nextState;
    applyAppearance();
    renderRoom();
    renderHistory();
  }

  function spawnBarrage(message) {
    if (documentRef.visibilityState !== 'visible' || state?.settings?.danmakuVisible === false || !state?.overlayEnabled) return;
    const stage = $('danmaku-stage');
    const row = createElement('div', 'danmaku');
    const nick = createElement('span', 'danmaku-nick', message.nickname || '匿名');
    const text = createElement('span', 'danmaku-text', message.text || '');
    row.append(nick, text);
    const size = state?.settings?.danmaku?.size || APPEARANCE_DEFAULTS.danmaku.size;
    const color = message.color || state?.settings?.danmaku?.color || APPEARANCE_DEFAULTS.danmaku.color;
    row.style.fontSize = `${size}px`;
    row.style.color = rgba(color, state?.settings?.danmaku?.opacity ?? APPEARANCE_DEFAULTS.danmaku.opacity);
    row.style.top = `${8 + Math.floor(Math.random() * Math.max(1, windowRef.innerHeight - 80))}px`;
    row.style.setProperty('--fly-distance', `-${windowRef.innerWidth + 900}px`);
    row.style.animationDuration = `${Math.max(5, Math.min(14, 8 + String(message.text || '').length / 12))}s`;
    row.dataset.messageId = String(message.messageId || '');
    stage.append(row);
    if (message.messageId) barrageNodes.set(String(message.messageId), row);
    row.addEventListener('animationend', () => {
      barrageNodes.delete(String(message.messageId || ''));
      row.remove();
    }, { once: true });
  }

  async function updateSettings(patch) {
    const response = await send('settings/update', { settings: patch });
    if (!response.ok) showToast(displayError(response));
    return response;
  }

  function togglePanel() {
    const panel = $('panel');
    panel.classList.toggle('hidden');
    $('floating-ball').setAttribute('aria-expanded', String(!panel.classList.contains('hidden')));
    if (!panel.classList.contains('hidden')) $('msg-input').focus();
  }

  async function toggleDanmaku() {
    const visible = !(state?.settings?.danmakuVisible !== false);
    await updateSettings({ danmakuVisible: !visible });
    showToast(visible ? '已隱藏彈幕' : '已顯示彈幕');
  }

  async function submitBarrage() {
    const input = $('msg-input');
    const snapshot = input.value.trim().slice(0, MESSAGE_LIMIT);
    if (!snapshot || $('btn-send').getAttribute('aria-disabled') === 'true') return;
    $('btn-send').setAttribute('aria-disabled', 'true');
    $('send-status').textContent = '發送中';
    const response = await send('barrage/send', { text: snapshot });
    if (response.ok) {
      if (input.value.trim() === snapshot) input.value = '';
      retryText = '';
      $('retry-send').hidden = true;
      $('send-status').textContent = response.queued ? '已排入佇列' : '已送出';
    } else {
      retryText = snapshot;
      $('retry-send').hidden = false;
      $('send-status').textContent = displayError(response, '發送失敗');
    }
    renderRoom();
  }

  async function joinRoom(roomCode, password = undefined) {
    if (!validRoomCode(roomCode)) { setRoomStatus('房間碼必須為 8 位數字', true); return; }
    const payload = { roomCode, ...(password ? { password } : {}) };
    setRoomStatus('加入中…');
    const response = await send('room/join', payload);
    setRoomStatus(response.ok ? '已加入房間' : displayError(response), !response.ok);
    if (response.ok) currentLookup = null;
  }

  async function exitRoom() {
    setRoomStatus('退出中…');
    const response = await send('room/exit', {});
    setRoomStatus(response.ok ? '已回到預設房間' : displayError(response), !response.ok);
  }

  function renderPublicRooms(response) {
    const list = $('public-room-list');
    list.replaceChildren();
    const rooms = Array.isArray(response?.rooms) ? response.rooms : [];
    for (const raw of rooms) {
      const room = normalizeRoom(raw);
      if (!room) continue;
      const card = createElement('div', 'room-card');
      const details = createElement('div');
      details.append(createElement('strong', 'room-card-name', room.name), createElement('small', 'room-card-meta', `#${room.roomCode}・${room.count}/${room.capacity} 人`));
      const join = createElement('button', '', '加入');
      join.type = 'button';
      join.addEventListener('click', () => joinRoom(room.roomCode));
      card.append(details, join);
      list.append(card);
    }
    if (!list.children.length) list.append(createElement('p', 'room-empty', '找不到公開房間'));
    const pageCount = Math.max(1, Number(response?.pagination?.pageCount || response?.pagination?.totalPages || 1));
    publicPage = Math.min(pageCount, Number(response?.pagination?.page || publicPage));
    $('public-page').textContent = `${publicPage} / ${pageCount}`;
    $('public-prev').setAttribute('aria-disabled', String(publicPage <= 1));
    $('public-next').setAttribute('aria-disabled', String(publicPage >= pageCount));
  }

  async function loadPublicRooms() {
    const response = await send('room/list', { query: publicQuery, page: publicPage });
    if (response.ok) renderPublicRooms(response);
    else setRoomStatus(displayError(response), true);
  }

  function openRoomManager() {
    $('room-manager-panel').classList.remove('hidden');
    setRoomStatus('');
    loadPublicRooms();
    $('room-manager-panel').focus();
  }

  function closeRoomManager() { $('room-manager-panel').classList.add('hidden'); }

  function syncColorPicker(hsv) {
    $('hsv-hue').value = String(Math.round(hsv.h));
    $('hsv-saturation').value = String(Math.round(hsv.s * 100));
    $('hsv-value').value = String(Math.round(hsv.v * 100));
    $('hsv-hue-value').textContent = `${Math.round(hsv.h)}°`;
    $('hsv-saturation-value').textContent = `${Math.round(hsv.s * 100)}%`;
    $('hsv-value-value').textContent = `${Math.round(hsv.v * 100)}%`;
    const hex = hsvToHex(hsv);
    $('hsv-picker-preview').style.background = hex;
    $('hsv-picker-hex').textContent = hex;
  }

  function readColorPicker() {
    return { h: Number($('hsv-hue').value), s: Number($('hsv-saturation').value) / 100, v: Number($('hsv-value').value) / 100 };
  }

  function openColorPicker(target, trigger) {
    currentColorTarget = target;
    lastFocused = trigger;
    const hex = state?.settings?.[target]?.color || APPEARANCE_DEFAULTS[target].color;
    colorDraft = createColorDraft(hex, async (next) => updateSettings({ [target]: { color: next } }));
    syncColorPicker(hexToHsv(hex));
    $('hsv-picker-dialog').classList.remove('hidden');
    $('hsv-picker-dialog').focus();
  }

  async function closeColorPicker(apply) {
    if (apply && colorDraft && currentColorTarget) { colorDraft.preview(readColorPicker()); await colorDraft.apply(); }
    else colorDraft?.cancel?.();
    $('hsv-picker-dialog').classList.add('hidden');
    currentColorTarget = null;
    colorDraft = null;
    lastFocused?.focus?.();
  }

  function handleVisibilityChange() {
    if (!stopped) send('overlay/visibility', { instanceId, visibilityState: documentRef.visibilityState });
  }

  function handlePageHide() {
    if (!stopped) send('overlay/unregister', { instanceId });
  }

  function handleRuntimeMessage(message) {
    if (stopped) return false;
    if (message?.type === 'DANMAKU_STATE') applyState(message.state);
    else if (message?.type === 'DANMAKU_BARRAGE') spawnBarrage(message.payload || {});
    else if (message?.type === 'DANMAKU_HIDE_MESSAGE') {
      const id = String(message.payload?.messageId || '');
      barrageNodes.get(id)?.remove(); barrageNodes.delete(id); renderHistory();
    } else if (message?.type === 'DANMAKU_SEND_STATUS') {
      $('send-status').textContent = message.payload?.status === 'delivered' ? '已送達' : message.payload?.status === 'expired' ? '傳送失敗，可重試' : connectionLabel();
    } else if (message?.type === 'DANMAKU_ROOM_DELETED') showToast('目前房間已被刪除');
    else if (message?.type === 'DANMAKU_CONTROL' && message.action === 'toggle') togglePanel();
    return false;
  }

  function initializeEvents() {
    if (eventsInitialized) return;
    eventsInitialized = true;
    const ball = $('floating-ball');
    let clickTimer = null;
    ball.addEventListener('click', () => {
      if (drag?.moved) return;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(togglePanel, 220);
    });
    ball.addEventListener('dblclick', () => { clearTimeout(clickTimer); toggleDanmaku(); });
    ball.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const rect = ball.getBoundingClientRect();
      drag = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, moved: false };
      ball.setPointerCapture(event.pointerId);
    });
    ball.addEventListener('pointermove', (event) => {
      if (!drag || !ball.hasPointerCapture(event.pointerId)) return;
      const x = clamp(event.clientX - drag.offsetX, [0, Math.max(0, windowRef.innerWidth - ball.offsetWidth)]);
      const y = clamp(event.clientY - drag.offsetY, [0, Math.max(0, windowRef.innerHeight - ball.offsetHeight)]);
      drag.moved ||= Math.abs(x - ball.offsetLeft) > 2 || Math.abs(y - ball.offsetTop) > 2;
      ball.style.left = `${x}px`; ball.style.right = 'auto'; ball.style.top = `${y}px`;
    });
    ball.addEventListener('pointerup', async (event) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = { ...drag, moved };
      ball.releasePointerCapture(event.pointerId);
      if (moved) await updateSettings({ ballPosition: { x: ball.offsetLeft, y: ball.offsetTop } });
      setTimeout(() => { drag = null; }, 0);
    });

    $('btn-send').addEventListener('click', submitBarrage);
    $('msg-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submitBarrage(); } });
    $('retry-send').addEventListener('click', () => { $('msg-input').value = retryText; submitBarrage(); });
    $('btn-history').addEventListener('click', () => { $('history-panel').classList.toggle('hidden'); renderHistory(); });
    $('btn-close-history').addEventListener('click', () => $('history-panel').classList.add('hidden'));
    $('btn-settings').addEventListener('click', () => $('settings-panel').classList.toggle('hidden'));
    $('btn-close-settings').addEventListener('click', () => $('settings-panel').classList.add('hidden'));
    $('room-summary-button').addEventListener('click', openRoomManager);
    $('btn-close-room-manager').addEventListener('click', closeRoomManager);

    for (const [id, target] of [['ball-color-trigger', 'ball'], ['dm-color-trigger', 'danmaku'], ['input-color-trigger', 'input']]) {
      $(id).addEventListener('click', (event) => openColorPicker(target, event.currentTarget));
    }
    for (const id of ['hsv-hue', 'hsv-saturation', 'hsv-value']) $(id).addEventListener('input', () => syncColorPicker(readColorPicker()));
    $('hsv-picker-apply').addEventListener('click', () => closeColorPicker(true));
    $('hsv-picker-cancel').addEventListener('click', () => closeColorPicker(false));
    $('hsv-picker-close').addEventListener('click', () => closeColorPicker(false));

    const rangeBindings = [
      ['ball-size', (v) => ({ ball: { size: Number(v) } })],
      ['ball-opacity', (v) => ({ ball: { opacity: Number(v) / 100 } })],
      ['dm-size', (v) => ({ danmaku: { size: Number(v) } })],
      ['dm-opacity', (v) => ({ danmaku: { opacity: Number(v) / 100 } })],
      ['input-size', (v) => ({ input: { size: Number(v) } })],
      ['input-opacity', (v) => ({ input: { opacity: Number(v) / 100 } })],
      ['panel-width', (v) => ({ panel: { width: Number(v) } })],
      ['panel-height', (v) => ({ panel: { height: Number(v) } })],
    ];
    for (const [id, patch] of rangeBindings) $(id).addEventListener('change', (event) => updateSettings(patch(event.target.value)));

    $('btn-reset-settings').addEventListener('click', async () => {
      const response = await send('settings/reset', {});
      showToast(response.ok ? '外觀已恢復預設' : displayError(response));
    });
    $('btn-show-help').addEventListener('click', () => $('onboarding').classList.remove('hidden'));
    $('btn-onboarding-ok').addEventListener('click', async () => { $('onboarding').classList.add('hidden'); await updateSettings({ onboarded: true }); });
    $('nickname-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const nickname = $('nickname-input').value.trim();
      $('nickname-save').disabled = true;
      const response = await send('nickname/change', { nickname });
      $('nickname-save').disabled = false;
      $('nickname-status').textContent = response.ok ? '暱稱已更新' : displayError(response);
      $('nickname-status').className = `nickname-status${response.ok ? '' : ' error'}`;
    });

    $('public-room-search').addEventListener('submit', (event) => { event.preventDefault(); publicQuery = $('public-room-query').value.trim(); publicPage = 1; loadPublicRooms(); });
    $('public-prev').addEventListener('click', () => { if (publicPage > 1) { publicPage -= 1; loadPublicRooms(); } });
    $('public-next').addEventListener('click', () => { if ($('public-next').getAttribute('aria-disabled') !== 'true') { publicPage += 1; loadPublicRooms(); } });
    $('room-lookup-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const roomCode = $('join-room-code').value.trim();
      if (!validRoomCode(roomCode)) { setRoomStatus('房間碼必須為 8 位數字', true); return; }
      const response = await send('room/lookup', { roomCode });
      if (!response.ok || !response.room) { setRoomStatus(displayError(response), true); return; }
      currentLookup = normalizeRoom(response.room);
      if (!currentLookup) { setRoomStatus('房間資料格式錯誤', true); return; }
      $('room-preview').hidden = false;
      $('preview-name').textContent = currentLookup.name;
      $('preview-meta').textContent = `#${currentLookup.roomCode}・${currentLookup.count}/${currentLookup.capacity} 人`;
      const passwordRequired = Boolean(response.room.passwordRequired);
      $('join-password-label').hidden = !passwordRequired;
      $('join-password').hidden = !passwordRequired;
      $('join-password').value = '';
    });
    $('join-room-button').addEventListener('click', () => currentLookup && joinRoom(currentLookup.roomCode, $('join-password').hidden ? undefined : $('join-password').value));
    root.querySelectorAll('input[name="create-visibility"]').forEach((input) => input.addEventListener('change', () => { $('create-password-row').hidden = input.value !== 'unlisted' || !input.checked; }));
    $('create-retention').addEventListener('change', () => { $('expiry-hint').textContent = `最後有效活動後 ${$('create-retention').value} 天到期。`; });
    $('room-create-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const visibility = root.querySelector('input[name="create-visibility"]:checked')?.value || 'public';
      const password = $('create-password').value;
      const payload = { name: $('create-name').value.trim(), visibility, retentionDays: Number($('create-retention').value), ...(password ? { password } : {}) };
      const response = await send('room/create', payload);
      setRoomStatus(response.ok ? '房間已建立，房主管理能力已安全保存' : displayError(response), !response.ok);
      if (response.ok) $('room-create-form').reset();
    });
    $('owner-visibility').addEventListener('change', () => { $('owner-password-row').hidden = $('owner-visibility').value !== 'unlisted'; });
    $('owner-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const room = normalizeRoom(state?.currentRoom || {});
      if (!room) return;
      const password = $('owner-password').value;
      const remove = $('owner-remove-password').checked;
      const payload = { roomCode: room.roomCode, name: $('owner-name').value.trim(), visibility: $('owner-visibility').value, ...(remove ? { passwordAction: { type: 'remove' } } : password ? { passwordAction: { type: 'set', password } } : {}) };
      const response = await send('room/update', payload);
      setRoomStatus(response.ok ? '房間設定已儲存' : displayError(response), !response.ok);
    });
    $('delete-room-button').addEventListener('click', async () => {
      const room = normalizeRoom(state?.currentRoom || {});
      if (!room || !windowRef.confirm(`確定刪除「${room.name}」？`)) return;
      const response = await send('room/delete', { roomCode: room.roomCode });
      setRoomStatus(response.ok ? '房間已刪除' : displayError(response), !response.ok);
    });

    documentRef.addEventListener('visibilitychange', handleVisibilityChange);
    windowRef.addEventListener('pagehide', handlePageHide, { once: true });
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  }

  function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      initializeEvents();
      const response = await send('overlay/register', { instanceId, visibilityState: documentRef.visibilityState });
      if (response.ok) applyState(response.state);
      else {
        host.hidden = false;
        $('ball-status').classList.add('disconnected');
        $('send-status').textContent = displayError(response, 'Overlay 無法註冊');
      }
    })();
    return startPromise;
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    documentRef.removeEventListener('visibilitychange', handleVisibilityChange);
    windowRef.removeEventListener('pagehide', handlePageHide);
    chrome.runtime.onMessage.removeListener?.(handleRuntimeMessage);
    clearTimeout(toastTimer);
    host.remove();
    await send('overlay/unregister', { instanceId });
  }

  const controller = { host, shadow, start, stop, applyState, spawnBarrage, instanceId };
  Object.defineProperty(host, '__danmakuController', { value: controller, configurable: true });
  start();
  return controller;
}

if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage && typeof document !== 'undefined') {
  installContentOverlay();
}
