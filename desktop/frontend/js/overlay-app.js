/**
 * 彈幕 Overlay — 桌面版主程式
 * 處理：懸浮球手勢、面板展開/收起、click-through、設定、彈幕渲染、Socket.IO
 */

// ============================================================
// 設定管理
// ============================================================
import {
  APPEARANCE_DEFAULTS,
  APPEARANCE_LIMITS,
  DANMAKU_SERVER_URL,
  canSubmit,
  createClientIdProvider,
  createDesktopJoinedRoomStore,
  createDesktopSettingsAdapter,
  createColorDraft,
  createOverlayController,
  createRoomCommandQueue,
  createRoomTransitionGate,
  describeSendButton,
  describeSendState,
  hexToHsv,
  hsvToHex,
  initRoomManager,
  mountOverlay,
  normalizeRoom,
  positionAdjacentOverlay,
  settleExpiredDraft,
} from '../generated/shared-core.js';

const settingsAdapter = createDesktopSettingsAdapter(localStorage);
const overlayController = createOverlayController({
  sendBarrage: (payload) => emitAck('barrage', payload),
  changeNickname: (nickname) => emitAck('nickname-change', { nickname }),
  settingsAdapter,
  now: () => performance.now(),
  initialSendKind: 'disconnected',
});
let settings = overlayController.getSettings();
let nicknameUiPending = false;
let nicknameUiGeneration = 0;

function saveSettings(value) {
  settings = overlayController.saveSettings(value);
  return settings;
}

const joinedRoomStore = createDesktopJoinedRoomStore({
  getSettings: () => settings,
  saveSettings,
  legacyStorage: localStorage,
});

// ============================================================
// Tauri IPC (click-through + OS credential vault)
// ============================================================
let tauriAvailable = false;
async function initTauri() {
  try {
    // 純靜態前端透過 app.withGlobalTauri 使用官方全域 API。
    if (window.__TAURI__?.core && window.__TAURI__?.event) {
      tauriAvailable = true;
      console.log('[Tauri] IPC available');
    } else {
      console.log('[Tauri] Not in Tauri context (browser dev mode)');
    }
  } catch (e) {
    console.warn('[Tauri] init failed:', e);
  }
}

let browserSessionClientId = null;
async function secureGet(key) {
  if (!tauriAvailable) return key === 'client-id' ? browserSessionClientId : null;
  return window.__TAURI__.core.invoke('credential_get', { key });
}
async function secureSet(key, value) {
  if (!tauriAvailable) {
    if (key === 'client-id') {
      browserSessionClientId = value;
      return;
    }
    throw new Error('OS credential vault is unavailable');
  }
  await window.__TAURI__.core.invoke('credential_set', { key, value });
}
async function secureDelete(key) {
  if (!tauriAvailable) {
    if (key === 'client-id') {
      browserSessionClientId = null;
      return;
    }
    throw new Error('OS credential vault is unavailable');
  }
  await window.__TAURI__.core.invoke('credential_delete', { key });
}
const clientIdProvider = createClientIdProvider({
  load: () => secureGet('client-id'),
  save: (value) => secureSet('client-id', value),
  generate: () => crypto.randomUUID(),
});
async function getStableClientId() {
  return clientIdProvider.get();
}

const INTERACTIVE_IDS = ['floating-ball', 'panel', 'history-panel', 'settings-panel', 'room-manager-panel', 'hsv-picker-dialog', 'onboarding'];
let interactiveMutationObserver = null;
let interactiveResizeObserver = null;
let interactiveRegionFrame = null;

function isElementInert(element) {
  for (let current = element; current; current = current.parentElement) {
    if (current.inert || current.hasAttribute?.('inert')) return true;
  }
  return false;
}

async function syncInteractiveRegions() {
  interactiveRegionFrame = null;
  if (!tauriAvailable) return;

  const regions = INTERACTIVE_IDS.flatMap((id) => {
    const element = document.getElementById(id);
    if (!element || element.classList.contains('hidden') || isElementInert(element)) return [];
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return [];
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return [];
    return [{ x: rect.left, y: rect.top, width: rect.width, height: rect.height }];
  });

  try {
    await window.__TAURI__.core.invoke('set_interactive_regions', { regions });
  } catch (e) {
    console.warn('[Tauri] interactive region sync failed:', e);
  }
}

function scheduleInteractiveRegionSync() {
  if (interactiveRegionFrame !== null) return;
  interactiveRegionFrame = window.requestAnimationFrame(syncInteractiveRegions);
}

function initInteractiveRegionTracking() {
  const elements = INTERACTIVE_IDS
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  interactiveMutationObserver = new MutationObserver(scheduleInteractiveRegionSync);
  interactiveResizeObserver = new ResizeObserver(() => {
    repositionVisiblePanels();
    scheduleInteractiveRegionSync();
  });
  interactiveMutationObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'style', 'inert'],
    subtree: true,
  });
  elements.forEach((element) => interactiveResizeObserver.observe(element));
  window.addEventListener('resize', () => {
    repositionVisiblePanels();
    scheduleInteractiveRegionSync();
  });
  scheduleInteractiveRegionSync();
}

// ============================================================
// Socket.IO 連線
// ============================================================
let socket = null;
let currentRoomInfo = null;
let danmakuVisible = true;
let retryText = null;
let announcedKind = null;
const roomChangedListeners = new Set();
const roomCommands = createRoomCommandQueue();
const roomTransitions = createRoomTransitionGate();

function emitAck(event, payload = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!socket?.connected) {
      resolve({ ok: false, error: { code: 'NOT_CONNECTED', scope: 'connection', message: '尚未連線' } });
      return;
    }
    socket.timeout(timeoutMs).emit(event, payload, (error, response) => {
      if (error) resolve({ ok: false, error: { code: 'ACK_TIMEOUT', scope: 'connection', message: '伺服器回應逾時' } });
      else resolve(response && typeof response === 'object' ? response : { ok: false, error: { code: 'INVALID_ACK', scope: 'connection', message: '伺服器回應格式錯誤' } });
    });
  });
}

function emitRoomCommand(event, payload = {}) {
  return roomCommands.run(() => emitAck(event, payload));
}

function publishRoom(source, recentMessages) {
  const room = normalizeRoom(source);
  if (!room) return null;
  if (currentRoomInfo && currentRoomInfo.roomCode !== room.roomCode) handleRoomChange();
  currentRoomInfo = room;
  overlayController.connect();
  renderSendState();
  document.getElementById('ball-count').textContent = room.count;
  clearDanmaku();
  if (Array.isArray(recentMessages) && recentMessages.length) loadHistory(recentMessages);
  else clearHistory();
  roomChangedListeners.forEach((listener) => listener(room));
  return room;
}

async function joinDefaultRoom(reason = '', transition = roomTransitions.begin()) {
  const found = await emitAck('room-default', {});
  if (!roomTransitions.isCurrent(transition)) return { ok: false, stale: true };
  if (!found.ok || !found.room) return found;
  const joined = await emitRoomCommand('join-room', { roomCode: found.room.roomCode });
  if (!roomTransitions.isCurrent(transition)) return { ok: false, stale: true };
  if (joined.ok) {
    publishRoom(joined.room, joined.recentMessages);
    if (reason) roomChangedListeners.forEach((listener) => listener(currentRoomInfo, reason));
  }
  return joined;
}

async function createRoom(payload) {
  cancelDefaultRoomRetry();
  const transition = roomTransitions.begin();
  const result = await emitRoomCommand('room-create', payload);
  const roomTransitionApplied = roomTransitions.isCurrent(transition);
  if (result.ok && roomTransitionApplied) publishRoom(result.room, result.recentMessages);
  return { ...result, roomTransitionApplied };
}

let defaultRoomRetryTimer = null;
function cancelDefaultRoomRetry() {
  if (defaultRoomRetryTimer === null) return;
  clearTimeout(defaultRoomRetryTimer);
  defaultRoomRetryTimer = null;
}

function scheduleDefaultRoomRetry(result) {
  if (result?.error?.code !== 'ACK_TIMEOUT' || defaultRoomRetryTimer !== null) return;
  defaultRoomRetryTimer = setTimeout(async () => {
    defaultRoomRetryTimer = null;
    if (!socket?.connected || currentRoomInfo) return;
    const transition = roomTransitions.begin();
    const retried = await joinDefaultRoom('', transition);
    scheduleDefaultRoomRetry(retried);
  }, 1000);
}

async function initSocket() {
  const clientId = await getStableClientId();
  socket = io(DANMAKU_SERVER_URL, {
    auth: { platform: 'windows', clientId },
    query: { clientId },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });
  socket.on('connect', async () => {
    const transition = roomTransitions.begin();
    document.getElementById('ball-status').classList.remove('disconnected');
    if (currentRoomInfo) {
      const roomCode = currentRoomInfo.roomCode;
      const result = await emitRoomCommand('join-room', { roomCode });
      if (!roomTransitions.isCurrent(transition)) return;
      if (result.ok) { publishRoom(result.room, result.recentMessages); return; }
      currentRoomInfo = null;
      const fallback = await joinDefaultRoom('原房間需要重新驗證或已失效，已回到預設房', transition);
      scheduleDefaultRoomRetry(fallback);
      return;
    }
    const joined = await joinDefaultRoom('', transition);
    scheduleDefaultRoomRetry(joined);
  });
  socket.on('disconnect', () => {
    roomTransitions.begin();
    document.getElementById('ball-status').classList.add('disconnected');
    const disconnectedState = overlayController.disconnect();
    if (disconnectedState.canceledSnapshot) restoreCanceledSnapshot(disconnectedState.canceledSnapshot);
    renderSendState();
  });
  socket.on('joined', (data) => publishRoom(data.room || data, data.recentMessages));
  socket.on('room-count', (data) => {
    if (!currentRoomInfo || String(data.roomCode || '').toUpperCase() !== currentRoomInfo.roomCode) return;
    const room = normalizeRoom({ ...currentRoomInfo, ...data });
    if (!room) return;
    currentRoomInfo = room;
    document.getElementById('ball-count').textContent = room.count;
    roomChangedListeners.forEach((listener) => listener(room));
  });
  socket.on('room-deleted', (data) => {
    if (!currentRoomInfo || String(data.roomCode || '').toUpperCase() !== currentRoomInfo.roomCode) return;
    roomTransitions.begin();
    handleRoomChange();
    overlayController.disconnect();
    renderSendState();
    currentRoomInfo = null;
    document.getElementById('ball-count').textContent = '0';
    clearDanmaku(); clearHistory();
    roomChangedListeners.forEach((listener) => listener(null, data.reason || '房間已關閉'));
  });
  socket.on('barrage', (msg) => { spawnDanmaku(msg); addHistoryItem(msg); });
  socket.on('barrage-status', handleBarrageStatus);
  socket.on('hide-message', (data) => removeHistoryItem(data.messageId));
  if (tauriAvailable) listenTauriEvents();
}

async function listenTauriEvents() {
  try {
    const { listen } = window.__TAURI__.event;
    await listen('reset-ball-position', () => {
      resetBallPosition();
    });
    await listen('toggle-danmaku', () => {
      toggleDanmaku();
    });
    await listen('reset-settings', () => {
      resetSettings();
    });
  } catch (e) {
    console.warn('[Tauri] listen failed:', e);
  }
}

async function joinRoom(roomCode, password) {
  cancelDefaultRoomRetry();
  const transition = roomTransitions.begin();
  const result = await emitRoomCommand('join-room', { roomCode, ...(password ? { password } : {}) });
  if (!roomTransitions.isCurrent(transition)) {
    return { ok: false, error: { code: 'STALE_ROOM_TRANSITION', scope: 'room', message: '已切換到其他房間' } };
  }
  if (result.ok) publishRoom(result.room, result.recentMessages);
  return result;
}

async function leaveRoom() {
  const transition = roomTransitions.begin();
  const result = await emitRoomCommand('leave-room', {});
  if (!roomTransitions.isCurrent(transition)) {
    return { ok: false, error: { code: 'STALE_ROOM_TRANSITION', scope: 'room', message: '房間狀態已變更' } };
  }
  if (result.ok) {
    handleRoomChange();
    overlayController.disconnect();
    renderSendState();
    currentRoomInfo = null;
    clearDanmaku(); clearHistory();
    roomChangedListeners.forEach((listener) => listener(null));
  }
  return result;
}

function restoreCanceledSnapshot(snapshot) {
  if (!snapshot) return;
  const input = document.getElementById('msg-input');
  const settled = settleExpiredDraft(input.value, snapshot);
  input.value = settled.draft;
  retryText = settled.retryText;
  document.getElementById('retry-send').hidden = !retryText;
}

function handleRoomChange() {
  const state = overlayController.changeRoom();
  if (state.canceledSnapshot) restoreCanceledSnapshot(state.canceledSnapshot);
  renderSendState();
}

async function sendBarrage() {
  await submitSnapshot(document.getElementById('msg-input').value);
}

async function submitSnapshot(rawSnapshot, { preserveComposer = false } = {}) {
  const input = document.getElementById('msg-input');
  const submission = overlayController.submit(rawSnapshot, {
    currentDraft: input.value,
    preserveComposer,
  });
  renderSendState();
  const result = await submission;
  if (!result.accepted) {
    if (result.reason === 'BLOCKED') renderSendState(true);
    return null;
  }
  if (result.appliesToCurrentSubmission) {
    input.value = result.draft;
    if (result.retryText) retryText = result.retryText;
    document.getElementById('retry-send').hidden = !retryText;
  }
  renderSendState();
  return result.ack;
}

function handleBarrageStatus(data) {
  const input = document.getElementById('msg-input');
  const result = overlayController.handleBarrageStatus(data, input.value);
  input.value = result.draft;
  if (result.retryText) retryText = result.retryText;
  document.getElementById('retry-send').hidden = !retryText;
  renderSendState();
}

function renderSendState(forceAnnounce = false) {
  const button = document.getElementById('btn-send');
  if (!button) return;
  const sendState = overlayController.getSendState();
  const now = performance.now();
  const description = describeSendState(sendState, now);
  button.setAttribute('aria-disabled', String(!canSubmit(sendState)));
  button.setAttribute('aria-description', description);
  button.dataset.state = sendState.kind;
  button.textContent = describeSendButton(sendState, now);
  const status = document.getElementById('send-status');
  if (status && (forceAnnounce || announcedKind !== sendState.kind)) {
    status.textContent = description;
    announcedKind = sendState.kind;
  }
}

// ============================================================
// 懸浮球手勢（拖曳 / 單擊 / 雙擊）
// ============================================================
const DRAG_THRESHOLD = 8;
const DOUBLE_CLICK_MS = 250;

let ballState = {
  dragging: false,
  startX: 0,
  startY: 0,
  lastTap: 0,
  panelOpen: false,
};

function initBall() {
  const ball = document.getElementById('floating-ball');

  // Restore position
  if (settings.ballPosition.x !== null && settings.ballPosition.y !== null) {
    ball.style.left = settings.ballPosition.x + 'px';
    ball.style.top = settings.ballPosition.y + 'px';
    ball.style.right = 'auto';
  }

  // Apply settings
  applyBallSettings();

  ball.addEventListener('mousedown', onBallMouseDown);
  ball.addEventListener('click', (event) => {
    if (event.detail === 0) togglePanel();
  });
}

let ballDragFrame = null;
let ballDragGeneration = 0;

function scheduleDragPanelReposition() {
  if (ballDragFrame !== null) return;
  const generation = ballDragGeneration;
  ballDragFrame = window.requestAnimationFrame(() => {
    ballDragFrame = null;
    if (generation !== ballDragGeneration || !ballState.dragging) return;
    repositionVisiblePanels();
  });
}

function onBallMouseDown(e) {
  e.preventDefault();
  const ball = document.getElementById('floating-ball');
  ballDragGeneration += 1;
  ballState.dragging = false;
  ballState.startX = e.clientX;
  ballState.startY = e.clientY;

  const onMove = (ev) => {
    const dx = ev.clientX - ballState.startX;
    const dy = ev.clientY - ballState.startY;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
      ballState.dragging = true;
      ball.style.left = (ev.clientX - 28) + 'px';
      ball.style.top = (ev.clientY - 28) + 'px';
      ball.style.right = 'auto';
      scheduleDragPanelReposition();
    }
  };

  const onUp = (ev) => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);

    if (ballDragFrame !== null) {
      window.cancelAnimationFrame(ballDragFrame);
      ballDragFrame = null;
    }
    if (ballState.dragging) {
      // Invalidate any frame already queued for this drag before the one
      // deterministic final layout pass. ResizeObserver may still re-enter
      // repositionVisiblePanels, so its anchor must be transform-independent.
      ballDragGeneration += 1;
      // Re-anchor every visible panel once at the final ball position, then save once.
      repositionVisiblePanels();
      const rect = anchorLayoutRect(ball);
      settings.ballPosition = { x: rect.left, y: rect.top };
      saveSettings(settings);
    } else {
      // Not a drag → check for click/double-click
      const now = Date.now();
      if (now - ballState.lastTap < DOUBLE_CLICK_MS) {
        // Double click → toggle danmaku
        ballState.lastTap = 0;
        toggleDanmaku();
      } else {
        ballState.lastTap = now;
        // Wait to see if a second click comes
        setTimeout(() => {
          if (ballState.lastTap === now) {
            // Single click → toggle panel
            togglePanel();
          }
        }, DOUBLE_CLICK_MS);
      }
    }
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function anchorLayoutRect(element) {
  const rect = element.getBoundingClientRect();
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const computedStyle = getComputedStyle(element);
  const inlineLeft = Number.parseFloat(element.style.left);
  const inlineTop = Number.parseFloat(element.style.top);
  const computedRight = Number.parseFloat(computedStyle.right);
  const computedTop = Number.parseFloat(computedStyle.top);
  const left = Number.isFinite(inlineLeft)
    ? inlineLeft
    : Number.isFinite(computedRight)
      ? window.innerWidth - computedRight - width
      : rect.left + (rect.width - width) / 2;
  const top = Number.isFinite(inlineTop)
    ? inlineTop
    : Number.isFinite(computedTop)
      ? computedTop
      : rect.top + (rect.height - height) / 2;
  return {
    left,
    right: left + width,
    top,
    bottom: top + height,
    width,
    height,
  };
}

function showAdjacentPanel(panel, anchor = document.getElementById('floating-ball')) {
  panel.classList.remove('hidden');
  panel.style.maxWidth = '';
  panel.style.maxHeight = '';
  panel.style.overflowY = '';
  const placement = positionAdjacentOverlay(
    anchorLayoutRect(anchor),
    panel.getBoundingClientRect(),
    { width: window.innerWidth, height: window.innerHeight },
  );
  panel.style.left = placement.left + 'px';
  panel.style.top = placement.top + 'px';
  panel.style.right = 'auto';
}

function repositionVisiblePanels() {
  const panel = document.getElementById('panel');
  const ball = document.getElementById('floating-ball');
  if (!panel || !ball) return;
  if (!panel.classList.contains('hidden')) showAdjacentPanel(panel, ball);
  const adjacent = [document.getElementById('history-panel'), document.getElementById('settings-panel')]
    .find((candidate) => candidate && !candidate.classList.contains('hidden'));
  if (adjacent && !panel.classList.contains('hidden')) showAdjacentPanel(adjacent, panel);
}

function togglePanel() {
  const panel = document.getElementById('panel');
  const ball = document.getElementById('floating-ball');

  if (panel.classList.contains('hidden')) {
    showAdjacentPanel(panel);
    ball.setAttribute('aria-expanded', 'true');
    ball.setAttribute('aria-label', '關閉彈幕面板');
    ballState.panelOpen = true;
  } else {
    panel.classList.add('hidden');
    ball.setAttribute('aria-expanded', 'false');
    ball.setAttribute('aria-label', '開啟彈幕面板');
    // Also close sub-panels
    document.getElementById('history-panel').classList.add('hidden');
    document.getElementById('settings-panel').classList.add('hidden');
    document.getElementById('room-manager-panel').classList.add('hidden');
    ballState.panelOpen = false;
  }
}

function toggleDanmaku() {
  danmakuVisible = !danmakuVisible;
  const stage = document.getElementById('danmaku-stage');
  if (danmakuVisible) {
    stage.style.display = '';
    showToast('彈幕已顯示');
  } else {
    stage.style.display = 'none';
    clearDanmaku();
    showToast('彈幕已隱藏');
  }
}

function resetBallPosition() {
  const ball = document.getElementById('floating-ball');
  ball.style.left = '';
  ball.style.top = '100px';
  ball.style.right = '20px';
  repositionVisiblePanels();
  settings.ballPosition = { x: null, y: 100 };
  saveSettings(settings);
  showToast('球位置已重置');
}

// ============================================================
// Click-through is controlled by the native cursor monitor using the DOM
// regions reported by initInteractiveRegionTracking().
// ============================================================
// 彈幕渲染
// ============================================================
const MAX_ON_SCREEN = 120;
const PALETTE = ['#f6465d','#2ebd85','#f0b90b','#58a6ff','#d2a8ff','#ff9f43','#e6edf3','#7ee787'];
const V_MARGIN = 10;
let historyMessages = [];

function spawnDanmaku(msg) {
  if (!danmakuVisible) return;
  const stage = document.getElementById('danmaku-stage');

  const existing = stage.getElementsByClassName('danmaku');
  if (existing.length >= MAX_ON_SCREEN) {
    existing[0].remove();
  }

  const el = document.createElement('div');
  el.className = msg.mine ? 'danmaku mine' : 'danmaku';
  el.style.fontSize = settings.danmaku.size + 'px';
  el.style.opacity = settings.danmaku.opacity;

  const nickSpan = document.createElement('span');
  nickSpan.className = 'danmaku-nick';
  nickSpan.textContent = msg.nickname || '匿名';
  el.appendChild(nickSpan);

  const textSpan = document.createElement('span');
  textSpan.className = 'danmaku-text';
  textSpan.textContent = msg.text;
  textSpan.style.color = msg.color || PALETTE[Math.floor(Math.random() * PALETTE.length)];
  el.appendChild(textSpan);

  stage.appendChild(el);

  const maxTop = Math.max(V_MARGIN, window.innerHeight - V_MARGIN - el.offsetHeight);
  el.style.top = (V_MARGIN + Math.random() * (maxTop - V_MARGIN)) + 'px';

  const distance = window.innerWidth + el.offsetWidth + 40;
  const duration = 7000 + Math.random() * 4000;
  el.style.setProperty('--fly-distance', `-${distance}px`);
  el.style.animationDuration = duration + 'ms';

  el.addEventListener('animationend', () => el.remove());
}

function clearDanmaku() {
  document.getElementById('danmaku-stage').innerHTML = '';
}

// ============================================================
// 歷史彈幕
// ============================================================
function loadHistory(messages) {
  historyMessages = messages.slice(-200);
  renderHistory();
}

function addHistoryItem(msg) {
  historyMessages.push({
    messageId: msg.messageId,
    text: msg.text,
    nickname: msg.nickname,
    color: msg.color,
    timestamp: msg.timestamp || Date.now(),
    sessionId: msg.sessionId,
  });
  if (historyMessages.length > 200) historyMessages.shift();
  renderHistory();
}

function removeHistoryItem(messageId) {
  historyMessages = historyMessages.filter(m => m.messageId !== messageId);
  renderHistory();
}

function clearHistory() {
  historyMessages = [];
  renderHistory();
}

function renderHistory() {
  const list = document.getElementById('history-list');
  list.innerHTML = '';
  for (const msg of historyMessages) {
    const item = document.createElement('div');
    item.className = 'history-item';

    const nickname = document.createElement('span');
    nickname.className = 'history-nick';
    nickname.textContent = msg.nickname || '匿名';

    const text = document.createElement('span');
    text.className = 'history-text';
    text.textContent = msg.text || '';
    text.style.color = /^#[0-9a-f]{6}$/i.test(msg.color || '') ? msg.color : '#e6edf3';

    const report = document.createElement('button');
    report.className = 'history-report';
    report.type = 'button';
    report.dataset.messageId = msg.messageId || '';
    report.dataset.session = msg.sessionId || '';
    report.dataset.text = msg.text || '';
    report.textContent = '檢舉';

    item.append(nickname, text, report);
    list.appendChild(item);
  }
  // Bind report buttons
  list.querySelectorAll('.history-report').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const result = await emitAck('report', {
        messageId: btn.dataset.messageId,
        targetSessionId: btn.dataset.session,
        messageText: btn.dataset.text,
      });
      if (result.ok) showToast('已送出檢舉');
      else showToast(result?.error?.message || '檢舉送出失敗');
    });
  });
  // Scroll to bottom
  list.scrollTop = list.scrollHeight;
}

const COLOR_TARGETS = Object.freeze({
  ball: Object.freeze({ settingsKey: 'ball', triggerId: 'ball-color-trigger', swatchId: 'ball-color-swatch', valueId: 'ball-color-value' }),
  danmaku: Object.freeze({ settingsKey: 'danmaku', triggerId: 'dm-color-trigger', swatchId: 'dm-color-swatch', valueId: 'dm-color-value' }),
  input: Object.freeze({ settingsKey: 'input', triggerId: 'input-color-trigger', swatchId: 'input-color-swatch', valueId: 'input-color-value' }),
});
const colorDrafts = new Map();
let activeColorTarget = null;
let activeColorTrigger = null;
let colorPickerInertSiblings = [];

function setColorPickerBackgroundInert(inert) {
  if (inert) {
    if (colorPickerInertSiblings.length) return;
    const dialog = document.getElementById('hsv-picker-dialog');
    const parent = dialog?.parentElement;
    if (!parent) return;
    colorPickerInertSiblings = [...parent.children]
      .filter((element) => element !== dialog)
      .map((element) => ({ element, wasInert: element.inert }));
    colorPickerInertSiblings.forEach(({ element }) => {
      element.inert = true;
    });
    return;
  }

  const previousSiblings = colorPickerInertSiblings;
  colorPickerInertSiblings = [];
  previousSiblings.forEach(({ element, wasInert }) => {
    element.inert = wasInert;
  });
}

function colorPickerFocusables() {
  const dialog = document.getElementById('hsv-picker-dialog');
  if (!dialog) return [];
  return [...dialog.querySelectorAll(
    'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => {
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

function syncColorControl(target) {
  const config = COLOR_TARGETS[target];
  if (!config) return;
  const color = String(settings[config.settingsKey].color).toUpperCase();
  const swatch = document.getElementById(config.swatchId);
  const value = document.getElementById(config.valueId);
  if (swatch) swatch.style.backgroundColor = color;
  if (value) value.textContent = color;
}

function syncColorControls() {
  Object.keys(COLOR_TARGETS).forEach(syncColorControl);
}

function applyColorAppearance(target) {
  if (target === 'ball') applyBallSettings();
  if (target === 'input') applyInputSettings();
}

function renderColorPreview(hex) {
  const preview = document.getElementById('hsv-picker-preview');
  const output = document.getElementById('hsv-picker-hex');
  if (preview) preview.style.backgroundColor = hex;
  if (output) output.textContent = hex;
}

function setHsvControls(hsv) {
  document.getElementById('hsv-hue').value = Math.round(hsv.h);
  document.getElementById('hsv-saturation').value = Math.round(hsv.s * 100);
  document.getElementById('hsv-value').value = Math.round(hsv.v * 100);
  document.getElementById('hsv-hue-value').textContent = `${Math.round(hsv.h)}°`;
  document.getElementById('hsv-saturation-value').textContent = `${Math.round(hsv.s * 100)}%`;
  document.getElementById('hsv-value-value').textContent = `${Math.round(hsv.v * 100)}%`;
}

function readHsvControls() {
  return {
    h: Number(document.getElementById('hsv-hue').value),
    s: Number(document.getElementById('hsv-saturation').value) / 100,
    v: Number(document.getElementById('hsv-value').value) / 100,
  };
}

function updateColorPreview(hsv) {
  if (!activeColorTarget) return;
  const draft = colorDrafts.get(activeColorTarget);
  if (!draft) return;
  const hex = hsvToHex(hsv);
  draft.preview(hsv);
  renderColorPreview(hex);
}

function closeColorPicker({ apply = false } = {}) {
  const target = activeColorTarget;
  const config = COLOR_TARGETS[target];
  const draft = colorDrafts.get(target);
  if (draft && config) {
    if (apply) {
      const color = draft.apply();
      settings[config.settingsKey].color = color;
      saveSettings(settings);
      applyColorAppearance(target);
    } else {
      const color = draft.cancel();
      setHsvControls(hexToHsv(color));
      renderColorPreview(color);
    }
  }
  colorDrafts.delete(target);
  activeColorTarget = null;
  const dialog = document.getElementById('hsv-picker-dialog');
  dialog.classList.add('hidden');
  activeColorTrigger?.setAttribute('aria-expanded', 'false');
  syncColorControls();
  const trigger = activeColorTrigger;
  activeColorTrigger = null;
  setColorPickerBackgroundInert(false);
  trigger?.focus();
}

function openColorPicker(target, trigger) {
  const config = COLOR_TARGETS[target];
  if (!config) return;
  if (activeColorTarget) closeColorPicker();
  activeColorTarget = target;
  activeColorTrigger = trigger;
  const color = settings[config.settingsKey].color;
  colorDrafts.set(target, createColorDraft(color, () => {}));
  setHsvControls(hexToHsv(color));
  renderColorPreview(color);
  const dialog = document.getElementById('hsv-picker-dialog');
  dialog.classList.remove('hidden');
  trigger.setAttribute('aria-expanded', 'true');
  setColorPickerBackgroundInert(true);
  document.getElementById('hsv-hue').focus();
}

function initColorPicker() {
  Object.entries(COLOR_TARGETS).forEach(([target, config]) => {
    const trigger = document.getElementById(config.triggerId);
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', () => openColorPicker(target, trigger));
  });
  ['hsv-hue', 'hsv-saturation', 'hsv-value'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      const hsv = readHsvControls();
      setHsvControls(hsv);
      updateColorPreview(hsv);
    });
  });
  document.getElementById('hsv-picker-apply').addEventListener('click', () => closeColorPicker({ apply: true }));
  document.getElementById('hsv-picker-cancel').addEventListener('click', () => closeColorPicker());
  document.getElementById('hsv-picker-close').addEventListener('click', () => closeColorPicker());
  document.getElementById('hsv-picker-dialog').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeColorPicker();
      return;
    }
    if (event.key === 'Tab') {
      const focusables = colorPickerFocusables();
      if (!focusables.length) {
        event.preventDefault();
        document.getElementById('hsv-picker-dialog').focus();
        return;
      }
      const currentIndex = focusables.indexOf(document.activeElement);
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? focusables.length - 1 : currentIndex - 1)
        : (currentIndex === -1 || currentIndex === focusables.length - 1 ? 0 : currentIndex + 1);
      event.preventDefault();
      focusables[nextIndex].focus();
    }
  });
  syncColorControls();
}

// ============================================================
// 設定 UI
// ============================================================
function applyBallSettings() {
  const ball = document.getElementById('floating-ball');
  ball.style.background = settings.ball.color;
  ball.style.width = settings.ball.size + 'px';
  ball.style.height = settings.ball.size + 'px';
  ball.style.opacity = settings.ball.opacity;
}

function colorWithOpacity(color, opacity) {
  const safeColor = /^#[0-9a-f]{6}$/i.test(color || '') ? color : APPEARANCE_DEFAULTS.input.color;
  const alpha = Math.min(1, Math.max(0.1, Number(opacity) || APPEARANCE_DEFAULTS.input.opacity));
  const value = Number.parseInt(safeColor.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function applyInputSettings() {
  const input = document.getElementById('msg-input');
  const send = document.getElementById('btn-send');
  const [minimumSize, maximumSize] = APPEARANCE_LIMITS.inputSize;
  const size = Math.min(maximumSize, Math.max(minimumSize, Number(settings.input.size) || APPEARANCE_DEFAULTS.input.size));
  input.style.backgroundColor = colorWithOpacity(settings.input.color, settings.input.opacity);
  input.style.fontSize = `${size}px`;
  send.style.fontSize = `${Math.max(12, size - 2)}px`;
  send.style.opacity = Math.min(1, Math.max(0.1, Number(settings.input.opacity) || APPEARANCE_DEFAULTS.input.opacity));
}

const PANEL_SURFACE_IDS = ['panel', 'history-panel', 'settings-panel'];

function panelDimension(value, limits, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(limits[1], Math.max(limits[0], numeric));
}

function panelHeightLabel(height) {
  return height === 0 ? '自動' : `${height}px`;
}

function panelHeightValue(height) {
  return height === 0 ? 'auto' : `${height}px`;
}

function applyPanelSettings() {
  const width = panelDimension(settings.panel.width, APPEARANCE_LIMITS.panelWidth, APPEARANCE_DEFAULTS.panel.width);
  const height = panelDimension(settings.panel.height, APPEARANCE_LIMITS.panelHeight, APPEARANCE_DEFAULTS.panel.height);
  const widthValue = `${width}px`;
  const heightValue = panelHeightValue(height);
  PANEL_SURFACE_IDS.forEach((id) => {
    const panel = document.getElementById(id);
    if (!panel) return;
    panel.style.setProperty('--panel-width', widthValue);
    panel.style.setProperty('--panel-height', heightValue);
  });
  repositionVisiblePanels();
}

function syncPanelControls() {
  const width = panelDimension(settings.panel.width, APPEARANCE_LIMITS.panelWidth, APPEARANCE_DEFAULTS.panel.width);
  const height = panelDimension(settings.panel.height, APPEARANCE_LIMITS.panelHeight, APPEARANCE_DEFAULTS.panel.height);
  const widthControl = document.getElementById('panel-width');
  const heightControl = document.getElementById('panel-height');
  const widthOutput = document.getElementById('panel-width-value');
  const heightOutput = document.getElementById('panel-height-value');
  if (widthControl) widthControl.value = String(width);
  if (heightControl) heightControl.value = String(height);
  if (widthOutput) widthOutput.textContent = `${width}px`;
  if (heightOutput) heightOutput.textContent = panelHeightLabel(height);
}

function updatePanelSetting(key, value) {
  settings.panel[key] = value;
  settings = saveSettings(settings);
  syncPanelControls();
  applyPanelSettings();
}

function applyAllSettings() {
  applyBallSettings();
  applyInputSettings();
  applyPanelSettings();
}

function resetSettings() {
  closeColorPicker();
  settings = overlayController.resetAppearance();
  applyAllSettings();
  syncSettingsUi();
  resetBallPosition();
  showToast('設定已恢復預設');
}

function setNicknameStatus(message = '', kind = '') {
  const status = document.getElementById('nickname-status');
  if (!status) return;
  status.textContent = message;
  status.className = `nickname-status${kind ? ` ${kind}` : ''}`;
}

function setNicknameControlsPending(pending) {
  const nicknameInput = document.getElementById('nickname-input');
  const nicknameSave = document.getElementById('nickname-save');
  const form = document.getElementById('nickname-form');
  if (nicknameInput) nicknameInput.disabled = pending;
  if (nicknameSave) nicknameSave.disabled = pending;
  if (form) form.setAttribute('aria-busy', String(pending));
}

function syncNicknameUi({ force = false } = {}) {
  const nicknameInput = document.getElementById('nickname-input');
  if (!nicknameInput || (nicknameUiPending && !force)) return;
  nicknameInput.value = String(settings.nickname || '匿名');
  setNicknameControlsPending(nicknameUiPending);
}

async function submitNickname(event) {
  event.preventDefault();
  if (nicknameUiPending) return;
  const nicknameInput = document.getElementById('nickname-input');
  if (!nicknameInput) return;
  const generation = ++nicknameUiGeneration;
  nicknameUiPending = true;
  setNicknameControlsPending(true);
  setNicknameStatus('暱稱保存中…');
  try {
    const result = await overlayController.changeNickname(nicknameInput.value);
    if (generation !== nicknameUiGeneration) return;
    settings = overlayController.getSettings();
    if (result.stale) {
      syncNicknameUi({ force: true });
      setNicknameStatus('已忽略過期的暱稱回應', 'error');
      return;
    }
    if (result.ok) {
      syncNicknameUi({ force: true });
      if (result.durable === false) setNicknameStatus(result.warning, 'warning');
      else setNicknameStatus(`伺服器已接受暱稱：${result.nickname}`);
      return;
    }
    syncNicknameUi({ force: true });
    setNicknameStatus(result.error?.message || '暱稱變更失敗', 'error');
  } finally {
    if (generation === nicknameUiGeneration) {
      nicknameUiPending = false;
      setNicknameControlsPending(false);
    }
  }
}

function syncSettingsUi() {
  syncColorControls();
  document.getElementById('ball-size').value = settings.ball.size;
  document.getElementById('ball-opacity').value = Math.round(settings.ball.opacity * 100);
  document.getElementById('dm-size').value = settings.danmaku.size;
  document.getElementById('dm-opacity').value = Math.round(settings.danmaku.opacity * 100);
  document.getElementById('input-size').value = settings.input.size;
  document.getElementById('input-opacity').value = Math.round(settings.input.opacity * 100);
  syncPanelControls();
  syncNicknameUi();
}

function initSettings() {
  initColorPicker();

  document.getElementById('ball-size').addEventListener('input', (event) => {
    settings.ball.size = Number.parseInt(event.target.value, 10);
    saveSettings(settings);
    applyBallSettings();
  });
  document.getElementById('ball-opacity').addEventListener('input', (event) => {
    settings.ball.opacity = Number.parseInt(event.target.value, 10) / 100;
    saveSettings(settings);
    applyBallSettings();
  });

  ['dm-size', 'dm-opacity'].forEach((id) => {
    document.getElementById(id).addEventListener('input', (event) => {
      if (id === 'dm-size') settings.danmaku.size = Number.parseInt(event.target.value, 10);
      if (id === 'dm-opacity') settings.danmaku.opacity = Number.parseInt(event.target.value, 10) / 100;
      saveSettings(settings);
    });
  });

  ['input-size', 'input-opacity'].forEach((id) => {
    document.getElementById(id).addEventListener('input', (event) => {
      if (id === 'input-size') settings.input.size = Number.parseInt(event.target.value, 10);
      if (id === 'input-opacity') settings.input.opacity = Number.parseInt(event.target.value, 10) / 100;
      saveSettings(settings);
      applyInputSettings();
    });
  });

  document.getElementById('panel-width').addEventListener('input', (event) => {
    updatePanelSetting('width', Number.parseInt(event.target.value, 10));
  });
  document.getElementById('panel-height').addEventListener('input', (event) => {
    updatePanelSetting('height', Number.parseInt(event.target.value, 10));
  });

  document.getElementById('nickname-form').addEventListener('submit', submitNickname);
  syncSettingsUi();

  document.getElementById('btn-reset-settings').addEventListener('click', () => {
    resetSettings();
  });

  document.getElementById('btn-show-help').addEventListener('click', () => {
    document.getElementById('onboarding').classList.remove('hidden');
  });
}

// ============================================================
// 面板按鈕
// ============================================================
function initPanelButtons() {
  // History button
  document.getElementById('btn-history').addEventListener('click', () => {
    const hist = document.getElementById('history-panel');
    const sett = document.getElementById('settings-panel');
    sett.classList.add('hidden');
    if (hist.classList.contains('hidden')) showAdjacentPanel(hist, document.getElementById('panel'));
    else hist.classList.add('hidden');
  });

  // Settings button
  document.getElementById('btn-settings').addEventListener('click', () => {
    const sett = document.getElementById('settings-panel');
    const hist = document.getElementById('history-panel');
    hist.classList.add('hidden');
    if (sett.classList.contains('hidden')) showAdjacentPanel(sett, document.getElementById('panel'));
    else sett.classList.add('hidden');
  });

  // Close buttons
  document.getElementById('btn-close-history').addEventListener('click', () => {
    document.getElementById('history-panel').classList.add('hidden');
  });
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('settings-panel').classList.add('hidden');
  });

  // Send button + Enter key
  document.getElementById('btn-send').addEventListener('click', sendBarrage);
  document.getElementById('msg-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendBarrage();
    }
  });
  document.getElementById('retry-send').addEventListener('click', async () => {
    if (!retryText) return;
    const snapshot = retryText;
    const ack = await submitSnapshot(snapshot, { preserveComposer: true });
    if (ack?.ok && ['sent', 'queued'].includes(ack.status)) {
      if (retryText === snapshot) retryText = null;
      document.getElementById('retry-send').hidden = !retryText;
    }
    document.getElementById('msg-input').focus();
  });

  // Onboarding OK
  document.getElementById('btn-onboarding-ok').addEventListener('click', () => {
    document.getElementById('onboarding').classList.add('hidden');
    settings.onboarded = true;
    saveSettings(settings);
  });
}

// ============================================================
// Toast
// ============================================================
let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 2500);
}

// ============================================================
// 啟動
// ============================================================
async function main() {
  mountOverlay(document, document.getElementById('overlay-root'));
  await initTauri();
  initBall();
  initInteractiveRegionTracking();
  initSettings();
  initPanelButtons();
  initRoomManager({
    emitAck,
    createRoom,
    joinRoom,
    leaveRoom,
    secureGet,
    secureSet,
    secureDelete,
    getCurrentRoom: () => currentRoomInfo,
    onRoomChanged(listener) {
      roomChangedListeners.add(listener);
      if (currentRoomInfo) listener(currentRoomInfo);
      return () => roomChangedListeners.delete(listener);
    },
  }, { joinedRoomStore });
  applyAllSettings();
  renderSendState();
  await initSocket();
  setInterval(() => {
    overlayController.tick();
    renderSendState();
  }, 1000);

  // Show onboarding if first time
  if (!settings.onboarded) {
    document.getElementById('onboarding').classList.remove('hidden');
  }

  console.log('[App] initialized');
}

main();
