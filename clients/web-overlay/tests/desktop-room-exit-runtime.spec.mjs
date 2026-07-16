import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..', '..', '..', 'desktop', 'frontend');
const DEFAULT_CODE = '12345678';
const OTHER_CODE = '22222222';
const CURRENT_CODE = '33333333';

const MOCK_SOCKET_IO = `
  (() => {
    const defaultRoom = { name: '預設', roomCode: '${DEFAULT_CODE}', count: 1, capacity: 1000, visibility: 'public' };
    const rooms = {
      '${OTHER_CODE}': { name: '其他房', roomCode: '${OTHER_CODE}', count: 2, capacity: 20, visibility: 'public' },
      '${CURRENT_CODE}': { name: '目前房', roomCode: '${CURRENT_CODE}', count: 3, capacity: 20, visibility: 'public' },
    };
    window.__testOutgoing = [];
    window.__testState = { leaveMode: 'deferred', defaultJoinFails: false, defaultLookupFails: false, leaveCallback: null };
    window.__testResolveLeave = () => {
      const callback = window.__testState.leaveCallback;
      window.__testState.leaveCallback = null;
      callback?.(null, { ok: true });
    };
    window.io = () => {
      const handlers = new Map();
      const socket = {
        connected: true,
        on(eventName, callback) {
          const callbacks = handlers.get(eventName) || [];
          callbacks.push(callback);
          handlers.set(eventName, callbacks);
          if (eventName === 'connect') setTimeout(callback, 0);
          return socket;
        },
        timeout() {
          return { emit(eventName, payload, callback) {
            window.__testOutgoing.push({ event: eventName, payload });
            if (eventName === 'room-default') {
              if (window.__testState.defaultLookupFails) {
                callback(null, { ok: false, error: { code: 'DEFAULT_LOOKUP_FAILED', message: '預設房查詢失敗' } });
              } else {
                callback(null, { ok: true, room: defaultRoom });
              }
              return;
            }
            if (eventName === 'room-lookup') {
              const room = rooms[String(payload.roomCode || '')];
              callback(room ? null : { timeout: true }, room ? { ok: true, room } : { ok: false, error: { code: 'ROOM_NOT_FOUND', message: '找不到房間' } });
              return;
            }
            if (eventName === 'join-room') {
              if (String(payload.roomCode) === '${DEFAULT_CODE}' && window.__testState.defaultJoinFails) {
                callback(null, { ok: false, error: { code: 'JOIN_DEFAULT_FAILED', message: '預設房加入失敗' } });
                return;
              }
              const room = String(payload.roomCode) === '${DEFAULT_CODE}' ? defaultRoom : rooms[String(payload.roomCode)];
              callback(room ? null : { timeout: true }, room ? { ok: true, room, recentMessages: [] } : { ok: false, error: { code: 'ROOM_NOT_FOUND', message: '找不到房間' } });
              return;
            }
            if (eventName === 'leave-room') {
              if (window.__testState.leaveMode === 'failure') {
                callback(null, { ok: false, error: { code: 'LEAVE_FAILED', message: '伺服器拒絕退出' } });
              } else if (window.__testState.leaveMode === 'deferred') {
                window.__testState.leaveCallback = callback;
              } else {
                callback(null, { ok: true });
              }
              return;
            }
            callback(null, { ok: true, status: 'sent', messageId: 'test-message' });
          } };
        },
      };
      window.__testSocket = socket;
      return socket;
    };
  })();
`;

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (pathname === '/vendor/socket.io.min.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        response.end(MOCK_SOCKET_IO);
        return;
      }
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      const filePath = path.resolve(frontendRoot, relative);
      if (filePath !== frontendRoot && !filePath.startsWith(`${frontendRoot}${path.sep}`)) {
        response.writeHead(403);
        response.end('forbidden');
        return;
      }
      response.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-store' });
      response.end(await readFile(filePath));
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function openRuntime(browser) {
  const server = await startStaticServer();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pageErrors = [];
  const externalRequests = [];
  const serverOrigin = new URL(server.url).origin;
  context.on('request', (request) => {
    let requestUrl;
    try { requestUrl = new URL(request.url()); } catch { return; }
    if (['http:', 'https:', 'ws:', 'wss:'].includes(requestUrl.protocol) && requestUrl.origin !== serverOrigin) {
      externalRequests.push(request.url());
    }
  });
  try {
    await context.addInitScript(() => {
      localStorage.setItem('danmaku-overlay-settings', JSON.stringify({
        onboarded: true,
        currentRoomCode: '12345678',
        defaultRoomCode: '12345678',
        joinedRoomCodes: ['12345678'],
        ownerCredentialKeys: ['room-owner:22222222', 'room-owner:33333333'],
      }));
      localStorage.setItem('danmaku-overlay-joined-room-codes', JSON.stringify(['12345678', '22222222', '33333333']));
      window.__testTauriListeners = Object.create(null);
      window.__testInteractiveRegions = [];
      window.__testCredentialDeletes = [];
      window.__testCredentialStore = {
        'client-id': 'client-room-exit-test',
        'room-owner:22222222': '[REDACTED]',
        'room-owner:33333333': '[REDACTED]',
      };
      window.__TAURI__ = {
        core: {
          invoke: async (command, args = {}) => {
            if (command === 'credential_get') return window.__testCredentialStore[args.key] ?? null;
            if (command === 'credential_set') { window.__testCredentialStore[args.key] = args.value; return null; }
            if (command === 'credential_delete') { window.__testCredentialDeletes.push(args.key); delete window.__testCredentialStore[args.key]; return null; }
            if (command === 'set_interactive_regions') { window.__testInteractiveRegions.push(args.regions.map((region) => ({ ...region }))); return null; }
            return null;
          },
        },
        event: { listen: async (eventName, callback) => { window.__testTauriListeners[eventName] = callback; return () => delete window.__testTauriListeners[eventName]; } },
      };
    });
    await context.addInitScript({ content: MOCK_SOCKET_IO });
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`); });
    await page.goto(server.url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof window.__testSocket === 'object');
    await expect.poll(() => page.locator('#btn-send').getAttribute('aria-disabled')).toBe('false');
    return {
      page,
      pageErrors,
      externalRequests,
      close: async () => { await context.close().catch(() => {}); await server.close().catch(() => {}); },
    };
  } catch (error) {
    await context.close().catch(() => {});
    await server.close().catch(() => {});
    throw error;
  }
}

async function openManager(page) {
  await page.locator('#floating-ball').click();
  await expect(page.locator('#panel')).not.toHaveClass(/hidden/);
  await page.locator('#room-summary-button').click();
  await expect(page.locator('#room-manager-panel')).not.toHaveClass(/hidden/);
  await expect(page.locator('#joined-room-list .room-card')).toHaveCount(3);
}

async function currentRegions(page) {
  return page.evaluate(() => {
    const ids = ['floating-ball', 'panel', 'history-panel', 'settings-panel', 'room-manager-panel', 'hsv-picker-dialog', 'onboarding'];
    const visible = (element) => {
      if (!element || element.classList.contains('hidden')) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const inert = (element) => {
      for (let node = element; node; node = node.parentElement) if (node.inert || node.hasAttribute('inert')) return true;
      return false;
    };
    const expected = ids.flatMap((id) => {
      const element = document.getElementById(id);
      if (!visible(element) || inert(element)) return [];
      const rect = element.getBoundingClientRect();
      return [{ id, x: rect.left, y: rect.top, width: rect.width, height: rect.height }];
    });
    const actualRegions = window.__testInteractiveRegions.at(-1) || [];
    const actual = actualRegions.map((region) => expected.find((item) => ['x', 'y', 'width', 'height'].every((field) => Math.abs(region[field] - item[field]) < 0.01))?.id || null);
    return { expected: expected.map(({ id }) => id), actual, count: actualRegions.length };
  });
}

function snapshotRoomState(page) {
  return page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('danmaku-overlay-settings') || '{}');
    return {
      shortcuts: settings.joinedRoomCodes,
      legacyShortcuts: localStorage.getItem('danmaku-overlay-joined-room-codes'),
      ownerCredentialKeys: settings.ownerCredentialKeys,
      credentials: { ...window.__testCredentialStore },
      deletes: [...window.__testCredentialDeletes],
      outgoing: window.__testOutgoing.map(({ event, payload }) => ({ event, payload })),
    };
  });
}

test('Desktop joined custom rooms expose accessible exit semantics, preserve credentials, and maintain inert-aware Tauri regions', async ({ browser }) => {
  const runtime = await openRuntime(browser);
  const { page, pageErrors, externalRequests } = runtime;
  try {
    await openManager(page);
    const migrated = await snapshotRoomState(page);
    expect(migrated.shortcuts).toEqual(['12345678', '22222222', '33333333']);
    expect(migrated.legacyShortcuts).toBeNull();
    await expect(page.locator('#joined-room-list [data-room-code="12345678"] [data-room-action="exit"]')).toHaveCount(0);
    await expect(page.locator('#joined-room-list [data-room-action="exit"]')).toHaveCount(2);
    await expect(page.locator('#joined-room-list [data-room-code="22222222"] [data-room-action="exit"]')).toHaveAttribute('aria-label', /退出房間/);
    await expect(page.locator('#room-manager-panel')).toBeFocused();
    await expect.poll(() => page.evaluate(() => ({ ball: document.getElementById('floating-ball').inert, main: document.getElementById('panel').inert, manager: document.getElementById('room-manager-panel').inert }))).toEqual({ ball: true, main: true, manager: false });
    await expect.poll(() => currentRegions(page)).toMatchObject({ expected: ['room-manager-panel'], actual: ['room-manager-panel'], count: 1 });

    const beforeOther = await snapshotRoomState(page);
    const otherExit = page.locator('#joined-room-list [data-room-code="22222222"] [data-room-action="exit"]');
    await otherExit.focus();
    await expect(otherExit).toBeFocused();
    await otherExit.press('Enter');
    await expect(page.locator('#joined-room-list [data-room-code="22222222"]')).toHaveCount(0);
    const afterOther = await snapshotRoomState(page);
    expect(afterOther.shortcuts).toEqual(['12345678', '33333333']);
    expect(afterOther.ownerCredentialKeys).toEqual(beforeOther.ownerCredentialKeys);
    expect(afterOther.credentials).toEqual(beforeOther.credentials);
    expect(afterOther.deletes).toEqual([]);
    expect(afterOther.outgoing.slice(beforeOther.outgoing.length).map(({ event }) => event).filter((event) => ['leave-room', 'join-room'].includes(event))).toEqual([]);

    await page.locator('#joined-room-list [data-room-code="33333333"] [data-room-action="preview"]').click();
    await page.locator('#join-room-button').click();
    await expect(page.locator('#room-code')).toHaveText('#33333333');
    await expect(page.locator('#joined-room-list [data-room-code="33333333"] [data-room-action="exit"]')).toBeVisible();

    await page.evaluate(() => { window.__testState.leaveMode = 'deferred'; });
    const beforeCurrent = await snapshotRoomState(page);
    const currentExit = page.locator('#joined-room-list [data-room-code="33333333"] [data-room-action="exit"]');
    await currentExit.click();
    await expect(currentExit).toBeDisabled();
    await expect(currentExit).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => page.evaluate(() => window.__testOutgoing.filter(({ event }) => event === 'leave-room').length)).toBe(1);
    const deferredExitState = await currentExit.evaluate((button) => ({
      disabled: button.disabled,
      ariaBusy: button.getAttribute('aria-busy'),
    }));
    expect(deferredExitState).toEqual({ disabled: true, ariaBusy: 'true' });
    const pendingExitBox = await currentExit.boundingBox();
    expect(pendingExitBox).not.toBeNull();
    await page.mouse.click(
      pendingExitBox.x + pendingExitBox.width / 2,
      pendingExitBox.y + pendingExitBox.height / 2,
    );
    await expect.poll(() => page.evaluate(() => window.__testOutgoing.filter(({ event }) => event === 'leave-room').length)).toBe(1);
    await expect(currentExit).toBeDisabled();
    await expect(currentExit).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => currentExit.evaluate((button) => ({
      disabled: button.disabled,
      ariaBusy: button.getAttribute('aria-busy'),
    }))).toEqual(deferredExitState);
    await page.evaluate(() => window.__testResolveLeave());
    await expect(page.locator('#room-code')).toHaveText('#12345678');
    await expect(page.locator('#joined-room-list [data-room-code="33333333"]')).toHaveCount(0);
    await expect(page.locator('#btn-send')).toHaveAttribute('aria-disabled', 'false');
    const afterCurrent = await snapshotRoomState(page);
    expect(afterCurrent.shortcuts).toEqual(['12345678']);
    expect(afterCurrent.ownerCredentialKeys).toEqual(beforeCurrent.ownerCredentialKeys);
    expect(afterCurrent.credentials).toEqual(beforeCurrent.credentials);
    expect(afterCurrent.deletes).toEqual([]);
    expect(afterCurrent.outgoing.slice(beforeCurrent.outgoing.length).filter(({ event }) => ['leave-room', 'join-room'].includes(event)).map(({ event, payload }) => [event, payload?.roomCode || null])).toEqual([
      ['leave-room', null],
      ['join-room', '12345678'],
    ]);

    await page.evaluate(() => { window.__testState.leaveMode = 'failure'; window.__testState.defaultJoinFails = false; });
    await page.locator('#join-room-code').fill('33333333');
    await page.locator('#join-room-code').press('Enter');
    await expect(page.locator('#preview-name')).toHaveText('目前房');
    await page.locator('#join-room-button').click();
    await expect(page.locator('#room-code')).toHaveText('#33333333');
    await expect(page.locator('#joined-room-list [data-room-code="33333333"] [data-room-action="exit"]')).toBeVisible();
    const beforeLeaveFailure = await snapshotRoomState(page);
    await page.locator('#joined-room-list [data-room-code="33333333"] [data-room-action="exit"]').click();
    await expect(page.locator('#room-status')).toHaveText('伺服器拒絕退出');
    await expect(page.locator('#joined-room-list [data-room-code="33333333"] [data-room-action="exit"]')).toBeEnabled();
    await expect(page.locator('#room-code')).toHaveText('#33333333');
    const afterLeaveFailure = await snapshotRoomState(page);
    expect(afterLeaveFailure.shortcuts).toContain('33333333');
    expect(afterLeaveFailure.ownerCredentialKeys).toEqual(beforeLeaveFailure.ownerCredentialKeys);
    expect(afterLeaveFailure.credentials).toEqual(beforeLeaveFailure.credentials);
    expect(afterLeaveFailure.deletes).toEqual([]);
    expect(afterLeaveFailure.outgoing.slice(beforeLeaveFailure.outgoing.length).map(({ event }) => event)).toEqual(['leave-room']);

    await page.evaluate(() => { window.__testState.leaveMode = 'success'; window.__testState.defaultJoinFails = true; });
    const beforePartial = await snapshotRoomState(page);
    await page.locator('#joined-room-list [data-room-code="33333333"] [data-room-action="exit"]').click();
    await expect(page.locator('#room-status')).toContainText('已退出但回預設失敗');
    await expect(page.locator('#room-code')).toHaveText('#--------');
    await expect(page.locator('#joined-room-list [data-room-code="33333333"]')).toHaveCount(0);
    const afterPartial = await snapshotRoomState(page);
    expect(afterPartial.shortcuts).toEqual(['12345678']);
    expect(afterPartial.ownerCredentialKeys).toEqual(beforePartial.ownerCredentialKeys);
    expect(afterPartial.credentials).toEqual(beforePartial.credentials);
    expect(afterPartial.deletes).toEqual([]);
    expect(afterPartial.outgoing.slice(beforePartial.outgoing.length).filter(({ event }) => ['leave-room', 'join-room'].includes(event)).map(({ event, payload }) => [event, payload?.roomCode || null])).toEqual([
      ['leave-room', null],
      ['join-room', '12345678'],
    ]);

    await page.locator('#btn-close-room-manager').click();
    await expect(page.locator('#room-manager-panel')).toHaveClass(/hidden/);
    await expect.poll(() => page.evaluate(() => ({ ball: document.getElementById('floating-ball').inert, main: document.getElementById('panel').inert }))).toEqual({ ball: false, main: false });
    await expect(page.locator('#room-summary-button')).toBeFocused();
    await expect.poll(() => currentRegions(page)).toMatchObject({ expected: ['floating-ball', 'panel'], actual: ['floating-ball', 'panel'], count: 2 });

    await page.locator('#room-summary-button').click();
    await expect(page.locator('#room-manager-panel')).not.toHaveClass(/hidden/);
    await page.locator('#room-manager-panel').press('Escape');
    await expect(page.locator('#room-manager-panel')).toHaveClass(/hidden/);
    await expect(page.locator('#room-summary-button')).toBeFocused();
    await expect.poll(() => currentRegions(page)).toMatchObject({ expected: ['floating-ball', 'panel'], actual: ['floating-ball', 'panel'], count: 2 });
  } finally {
    await runtime.close();
  }
  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('Desktop default lookup failure hides every exit control and retries on the next render', async ({ browser }) => {
  const runtime = await openRuntime(browser);
  const { page, pageErrors, externalRequests } = runtime;
  try {
    await page.evaluate(() => { window.__testState.defaultLookupFails = true; });
    await openManager(page);
    await expect(page.locator('#room-status')).toHaveText('暫時無法確認預設房');
    await expect(page.locator('#room-code')).toHaveText('#12345678');
    await expect(page.locator('#joined-room-list [data-room-action="exit"]')).toHaveCount(0);
    await expect(page.locator('#joined-room-list [data-room-code="12345678"]')).toBeVisible();

    await page.evaluate(() => { window.__testState.defaultLookupFails = false; });
    await page.locator('#btn-close-room-manager').click();
    await page.locator('#room-summary-button').click();
    await expect(page.locator('#joined-room-list [data-room-action="exit"]')).toHaveCount(2);
    await expect(page.locator('#joined-room-list [data-room-code="12345678"] [data-room-action="exit"]')).toHaveCount(0);
  } finally {
    await runtime.close();
  }
  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
