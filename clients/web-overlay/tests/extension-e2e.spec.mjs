import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..', '..', '..');
const dist = path.join(repositoryRoot, 'extension', 'dist');
const contentBundle = path.join(dist, 'content.js');
const popupBundle = path.join(dist, 'popup.js');
const optionsBundle = path.join(dist, 'options.js');
const popupHtml = fs.readFileSync(path.join(dist, 'popup.html'), 'utf8').replace(/<script[^>]*>.*?<\/script>/gs, '');
const optionsHtml = fs.readFileSync(path.join(dist, 'options.html'), 'utf8').replace(/<script[^>]*>.*?<\/script>/gs, '');
let browser;

const HOSTILE_PAGE = `<!doctype html><html><head><style>
* { all: unset !important; color: magenta !important; font-size: 2px !important; z-index: 2147483647 !important; }
html, body { display: block !important; width: 100% !important; height: 100% !important; }
#host-button { display: block !important; position: fixed !important; left: 8px !important; bottom: 8px !important; padding: 20px !important; background: red !important; }
#danmaku-overlay-extension-host { opacity: .01 !important; pointer-events: auto !important; }
</style></head><body><button id="host-button">宿主按鈕</button><form><input value="private-form-value"></form><main>${'惡意超長宿主文字'.repeat(300)}</main><script>window.hostClicks=0;window.__attack=0;document.querySelector('#host-button').addEventListener('click',()=>window.hostClicks++);</script></body></html>`;

function mockChromeScript() {
  return ({ mode = 'connected', permission = true, tabUrl = 'http://fixture.test/' } = {}) => {
    const listeners = [];
    const actionLog = [];
    const defaults = {
      ball: { color: '#58A6FF', size: 56, opacity: 0.9 },
      danmaku: { color: '#E6EDF3', size: 20, opacity: 0.9 },
      input: { color: '#1A1A2E', size: 16, opacity: 0.8 },
      panel: { width: 320, height: 0 },
      ballPosition: { x: null, y: 100 },
      danmakuVisible: true,
      onboarded: true,
      nickname: '匿名',
    };
    const state = {
      clientId: 'fixture-client', settings: structuredClone(defaults),
      currentRoom: { roomCode: '12345678', name: '預設房', count: 2, capacity: 200, visibility: 'public', retentionDays: 7 },
      currentRoomCode: '12345678', joinedRoomCodes: ['12345678'], history: [], overlayEnabled: true,
      connection: { status: mode === 'connected' ? 'connected' : 'reconnecting' }, canManageRoom: false,
    };
    const emit = (message) => listeners.forEach((listener) => listener(structuredClone(message), {}, () => {}));
    const deepMerge = (target, patch) => {
      for (const [key, value] of Object.entries(patch || {})) {
        target[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...(target[key] || {}), ...value } : value;
      }
    };
    const respond = async ({ action, payload = {} }) => {
      actionLog.push({ action, payload: structuredClone(payload) });
      if (action === 'overlay/register' || action === 'state/get') return { ok: true, state: structuredClone(state) };
      if (action === 'overlay/unregister' || action === 'overlay/visibility') return { ok: true, state: structuredClone(state) };
      if (action === 'popup/status') return { ok: true, registered: true, state: structuredClone(state) };
      if (action === 'overlay/toggle') { emit({ type: 'DANMAKU_CONTROL', action: 'toggle' }); return { ok: true }; }
      if (action === 'settings/update') { deepMerge(state.settings, payload.settings); emit({ type: 'DANMAKU_STATE', state }); return { ok: true, settings: structuredClone(state.settings) }; }
      if (action === 'settings/reset') {
        const preserved = { nickname: state.settings.nickname, nicknameChangeDate: state.settings.nicknameChangeDate };
        state.settings = { ...structuredClone(defaults), ...preserved };
        emit({ type: 'DANMAKU_STATE', state }); return { ok: true, settings: structuredClone(state.settings) };
      }
      if (action === 'nickname/change') { state.settings.nickname = payload.nickname; state.settings.nicknameChangeDate = '2026-07-16'; emit({ type: 'DANMAKU_STATE', state }); return { ok: true, nickname: payload.nickname, changeDate: '2026-07-16' }; }
      if (action === 'barrage/send') {
        const message = { messageId: `m-${state.history.length + 1}`, roomCode: state.currentRoomCode, text: payload.text, nickname: state.settings.nickname, color: state.settings.danmaku.color, timestamp: Date.now() };
        state.history.push(message); emit({ type: 'DANMAKU_BARRAGE', payload: message }); emit({ type: 'DANMAKU_STATE', state }); return { ok: true, queued: false, messageId: message.messageId };
      }
      if (action === 'report/create') return { ok: true };
      if (action === 'room/list') return { ok: true, rooms: [{ roomCode: '87654321', name: '<img src=x onerror=window.__attack=1>', count: 3, capacity: 200, visibility: 'public', retentionDays: 7 }], pagination: { page: 1, pageCount: 1 } };
      if (action === 'room/lookup') return { ok: true, room: { roomCode: payload.roomCode, name: '<svg onload=window.__attack=2>', count: 4, capacity: 200, visibility: 'unlisted', retentionDays: 7, passwordRequired: true } };
      if (action === 'room/join') {
        state.currentRoom = { roomCode: payload.roomCode, name: '已加入房間', count: 4, capacity: 200, visibility: 'unlisted', retentionDays: 7 };
        state.currentRoomCode = payload.roomCode; state.joinedRoomCodes = [...new Set([...state.joinedRoomCodes, payload.roomCode])]; state.canManageRoom = false; state.history = [];
        emit({ type: 'DANMAKU_STATE', state }); return { ok: true, room: structuredClone(state.currentRoom), recentMessages: [] };
      }
      if (action === 'room/create') {
        state.currentRoom = { roomCode: '22222222', name: payload.name, count: 1, capacity: 200, visibility: payload.visibility, retentionDays: payload.retentionDays };
        state.currentRoomCode = '22222222'; state.joinedRoomCodes.push('22222222'); state.canManageRoom = true; state.history = [];
        emit({ type: 'DANMAKU_STATE', state }); return { ok: true, room: structuredClone(state.currentRoom), ownerCapabilitySaved: true, canManageRoom: true };
      }
      if (action === 'room/update') { deepMerge(state.currentRoom, payload); delete state.currentRoom.passwordAction; emit({ type: 'DANMAKU_STATE', state }); return { ok: true, room: structuredClone(state.currentRoom) }; }
      if (action === 'room/delete') { state.currentRoom = null; state.currentRoomCode = null; state.canManageRoom = false; emit({ type: 'DANMAKU_STATE', state }); return { ok: true }; }
      if (action === 'room/exit') {
        state.currentRoom = { roomCode: '12345678', name: '預設房', count: 2, capacity: 200, visibility: 'public', retentionDays: 7 }; state.currentRoomCode = '12345678'; state.canManageRoom = false;
        emit({ type: 'DANMAKU_STATE', state }); return { ok: true, room: structuredClone(state.currentRoom) };
      }
      return { ok: false, error: { code: 'UNKNOWN', message: 'fixture 不支援' } };
    };
    window.__fixtureState = state;
    window.__extensionActionLog = actionLog;
    window.__emitExtension = emit;
    window.__runtimeListenerCount = () => listeners.length;
    window.__fixtureVisibility = 'visible';
    try { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__fixtureVisibility }); } catch {}
    window.confirm = () => true;
    window.chrome = {
      runtime: {
        lastError: null,
        onMessage: { addListener(listener) { listeners.push(listener); }, removeListener(listener) { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); } },
        sendMessage(message, callback) { Promise.resolve(respond(message)).then((response) => setTimeout(() => callback?.(structuredClone(response)), 0)); },
        openOptionsPage() { window.__optionsOpened = true; },
      },
      tabs: { async query() { return [{ id: 7, url: tabUrl }]; } },
      permissions: { async contains() { return permission; } },
    };
  };
}

async function contentPage(options = {}) {
  const page = await browser.newPage();
  await page.setContent(HOSTILE_PAGE);
  await page.evaluate(mockChromeScript(), options);
  await page.addScriptTag({ path: contentBundle });
  await page.locator('#danmaku-overlay-extension-host').waitFor({ state: 'attached' });
  await expect.poll(() => page.evaluate(() => Boolean(document.getElementById('danmaku-overlay-extension-host')?.shadowRoot?.getElementById('floating-ball')))).toBe(true);
  return page;
}

async function shadowText(page, selector) {
  return page.locator(`#danmaku-overlay-extension-host >> ${selector}`).textContent();
}

async function shadowClick(page, selector) {
  await page.locator(`#danmaku-overlay-extension-host >> ${selector}`).click();
}

test.beforeAll(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
test.afterAll(async () => browser?.close());



test('content controller cleanup removes global listeners before safe reinjection', async () => {
  const page = await contentPage();
  expect(await page.evaluate(() => window.__runtimeListenerCount())).toBe(1);
  await page.evaluate(async () => {
    const controller = document.getElementById('danmaku-overlay-extension-host').__danmakuController;
    await controller.stop();
  });
  expect(await page.locator('#danmaku-overlay-extension-host').count()).toBe(0);
  expect(await page.evaluate(() => window.__runtimeListenerCount())).toBe(0);
  const before = await page.evaluate(() => window.__extensionActionLog.length);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(await page.evaluate(() => window.__extensionActionLog.length)).toBe(before);

  await page.addScriptTag({ path: contentBundle });
  await page.locator('#danmaku-overlay-extension-host').waitFor({ state: 'attached' });
  expect(await page.evaluate(() => window.__runtimeListenerCount())).toBe(1);
  await page.close();
});

test('Shadow DOM survives hostile CSS and leaves the host page clickable', async () => {
  const page = await contentPage();
  await expect(page.locator('#danmaku-overlay-extension-host')).toHaveCount(1);
  const metrics = await page.evaluate(() => {
    const host = document.getElementById('danmaku-overlay-extension-host');
    const ball = host.shadowRoot.getElementById('floating-ball');
    return { hostPointer: getComputedStyle(host).pointerEvents, hostOpacity: getComputedStyle(host).opacity, ballPointer: getComputedStyle(ball).pointerEvents, ballWidth: ball.getBoundingClientRect().width, ballFont: getComputedStyle(ball).fontSize };
  });
  expect(metrics.hostPointer).toBe('none');
  expect(metrics.hostOpacity).toBe('1');
  expect(metrics.ballPointer).toBe('auto');
  expect(metrics.ballWidth).toBeGreaterThanOrEqual(50);
  expect(Number.parseFloat(metrics.ballFont)).toBeGreaterThan(2);
  await page.locator('#host-button').click();
  await expect.poll(() => page.evaluate(() => window.hostClicks)).toBe(1);
  await page.close();
});

test('send/history/report and unsafe payloads remain text while hidden pages do not animate', async () => {
  const page = await contentPage();
  await shadowClick(page, '#floating-ball');
  const input = page.locator('#danmaku-overlay-extension-host >> #msg-input');
  await input.fill('<img src=x onerror=window.__attack=3>');
  await shadowClick(page, '#btn-send');
  await expect.poll(() => page.evaluate(() => window.__fixtureState.history.length)).toBe(1);
  await shadowClick(page, '#btn-history');
  await expect(page.locator('#danmaku-overlay-extension-host >> .history-text')).toHaveText('<img src=x onerror=window.__attack=3>');
  await shadowClick(page, '.history-report');
  expect(await page.evaluate(() => window.__extensionActionLog.some((entry) => entry.action === 'report/create'))).toBe(true);
  expect(await page.evaluate(() => window.__attack)).toBe(0);

  await page.evaluate(() => { window.__fixtureVisibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); window.__emitExtension({ type: 'DANMAKU_BARRAGE', payload: { messageId: 'hidden', text: '<svg onload=window.__attack=4>', nickname: '惡意', color: '#FFFFFF' } }); });
  await expect(page.locator('#danmaku-overlay-extension-host >> .danmaku[data-message-id="hidden"]')).toHaveCount(0);
  await page.evaluate(() => { window.__fixtureVisibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); window.__emitExtension({ type: 'DANMAKU_BARRAGE', payload: { messageId: 'visible', text: '<svg onload=window.__attack=5>', nickname: '惡意', color: '#FFFFFF' } }); });
  await expect(page.locator('#danmaku-overlay-extension-host >> .danmaku[data-message-id="visible"]')).toHaveCount(1);
  await expect(page.locator('#danmaku-overlay-extension-host >> .danmaku[data-message-id="visible"] .danmaku-text')).toHaveText('<svg onload=window.__attack=5>');
  expect(await page.evaluate(() => window.__attack)).toBe(0);
  await page.close();
});

test('HSV/ranges/reset synchronize and preserve nickname and room state', async () => {
  const page = await contentPage();
  await shadowClick(page, '#floating-ball');
  await shadowClick(page, '#btn-settings');
  await shadowClick(page, '#ball-color-trigger');
  await page.locator('#danmaku-overlay-extension-host >> #hsv-hue').fill('180');
  await page.locator('#danmaku-overlay-extension-host >> #hsv-saturation').fill('100');
  await page.locator('#danmaku-overlay-extension-host >> #hsv-value').fill('50');
  await shadowClick(page, '#hsv-picker-apply');
  await expect.poll(() => page.evaluate(() => window.__fixtureState.settings.ball.color)).toBe('#008080');
  await page.locator('#danmaku-overlay-extension-host >> #ball-opacity').fill('10');
  await page.locator('#danmaku-overlay-extension-host >> #ball-opacity').dispatchEvent('change');
  await expect.poll(() => page.evaluate(() => window.__fixtureState.settings.ball.opacity)).toBe(0.1);
  await page.locator('#danmaku-overlay-extension-host >> #nickname-input').fill('新暱稱');
  await shadowClick(page, '#nickname-save');
  await expect.poll(() => page.evaluate(() => window.__fixtureState.settings.nickname)).toBe('新暱稱');
  await shadowClick(page, '#btn-reset-settings');
  const preserved = await page.evaluate(() => ({ nickname: window.__fixtureState.settings.nickname, room: window.__fixtureState.currentRoomCode, ball: window.__fixtureState.settings.ball }));
  expect(preserved.nickname).toBe('新暱稱'); expect(preserved.room).toBe('12345678'); expect(preserved.ball).toEqual({ color: '#58A6FF', size: 56, opacity: 0.9 });
  await page.close();
});

test('join/create/update/delete/exit room flow uses background commands without exposing credentials', async () => {
  const page = await contentPage();
  await shadowClick(page, '#floating-ball');
  await shadowClick(page, '#room-summary-button');
  await expect(page.locator('#danmaku-overlay-extension-host >> #public-room-list .room-card-name')).toHaveText('<img src=x onerror=window.__attack=1>');
  await page.locator('#danmaku-overlay-extension-host >> #join-room-code').fill('87654321');
  await page.locator('#danmaku-overlay-extension-host >> #room-lookup-form').evaluate((form) => form.requestSubmit());
  await expect(page.locator('#danmaku-overlay-extension-host >> #preview-name')).toHaveText('<svg onload=window.__attack=2>');
  await expect(page.locator('#danmaku-overlay-extension-host >> #join-password')).toBeVisible();
  await page.locator('#danmaku-overlay-extension-host >> #join-password').fill('secret1');
  await shadowClick(page, '#join-room-button');
  await expect.poll(() => page.evaluate(() => window.__fixtureState.currentRoomCode)).toBe('87654321');

  await page.locator('#danmaku-overlay-extension-host >> #create-name').fill('房主房間');
  await page.locator('#danmaku-overlay-extension-host >> #room-create-form').evaluate((form) => form.requestSubmit());
  await expect.poll(() => page.evaluate(() => window.__fixtureState.canManageRoom)).toBe(true);
  await expect(page.locator('#danmaku-overlay-extension-host >> #owner-section')).toBeVisible();
  await page.locator('#danmaku-overlay-extension-host >> #owner-name').fill('房主更新');
  await page.locator('#danmaku-overlay-extension-host >> #owner-form').evaluate((form) => form.requestSubmit());
  await expect.poll(() => page.evaluate(() => window.__fixtureState.currentRoom.name)).toBe('房主更新');
  await shadowClick(page, '#delete-room-button');
  await expect.poll(() => page.evaluate(() => window.__fixtureState.currentRoomCode)).toBe(null);

  await page.evaluate(() => window.__emitExtension({ type: 'DANMAKU_STATE', state: { ...window.__fixtureState, currentRoom: { roomCode: '87654321', name: '再次加入', count: 1, capacity: 200, visibility: 'public', retentionDays: 7 }, currentRoomCode: '87654321' } }));
  await shadowClick(page, '#room-summary-button');
  const exitButton = page.locator('#danmaku-overlay-extension-host >> #joined-room-list button', { hasText: '退出' });
  await exitButton.click();
  expect(await page.evaluate(() => window.__extensionActionLog.some((entry) => entry.action === 'room/exit'))).toBe(true);
  const serialized = JSON.stringify(await page.evaluate(() => window.__extensionActionLog));
  expect(serialized).not.toMatch(/ownerCredential|owner-secret/i);
  expect(await page.evaluate(() => window.__attack)).toBe(0);
  await page.close();
});

test('popup distinguishes connected, protected, permission-revoked and backend-disconnected states', async () => {
  async function popup(options) {
    const page = await browser.newPage();
    await page.setContent(popupHtml);
    await page.evaluate(mockChromeScript(), options);
    await page.addScriptTag({ path: popupBundle });
    await expect.poll(() => page.locator('#status').textContent()).not.toBe('檢查中…');
    return page;
  }
  const connected = await popup({ mode: 'connected' }); expect(await connected.locator('#status').textContent()).toBe('Overlay 已就緒'); await connected.close();
  const backend = await popup({ mode: 'backend' }); expect(await backend.locator('#status').textContent()).toBe('後端連線中斷'); await backend.close();
  const protectedPage = await popup({ tabUrl: 'chrome://extensions/' }); expect(await protectedPage.locator('#status').textContent()).toBe('受保護頁面'); await protectedPage.close();
  const permissionPage = await popup({ permission: false }); expect(await permissionPage.locator('#status').textContent()).toBe('網站權限已關閉'); await permissionPage.close();
});

test('options page saves and resets shared settings', async () => {
  const page = await browser.newPage();
  await page.setContent(optionsHtml);
  await page.evaluate(mockChromeScript(), {});
  await page.addScriptTag({ path: optionsBundle });
  await expect(page.locator('#ball-size')).toHaveValue('56');
  await page.locator('#ball-size').fill('72');
  await page.locator('#appearance-form').evaluate((form) => form.requestSubmit());
  await expect.poll(() => page.evaluate(() => window.__fixtureState.settings.ball.size)).toBe(72);
  await page.locator('#reset').click();
  await expect.poll(() => page.evaluate(() => window.__fixtureState.settings.ball.size)).toBe(56);
  await page.close();
});
