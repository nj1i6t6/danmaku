import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..', '..', '..', 'desktop', 'frontend');

const MOCK_SOCKET_IO = `
  (() => {
    window.__testOutgoing = [];
    window.io = () => {
      const handlers = new Map();
      const room = { name: '預設', roomCode: '12345678', count: 1, capacity: 1000, visibility: 'public' };
      const socket = {
        connected: true,
        on(eventName, callback) {
          const callbacks = handlers.get(eventName) || [];
          callbacks.push(callback);
          handlers.set(eventName, callbacks);
          if (eventName === 'connect') setTimeout(callback, 0);
          return socket;
        },
        emitFromServer(eventName, payload) {
          for (const callback of handlers.get(eventName) || []) callback(payload);
        },
        timeout() {
          return { emit(eventName, payload, callback) {
            window.__testOutgoing.push({ event: eventName, payload });
            if (eventName === 'room-default') {
              callback(null, { ok: true, room });
              return;
            }
            if (eventName === 'join-room') {
              callback(null, { ok: true, room, recentMessages: [] });
              return;
            }
            if (eventName === 'barrage') {
              callback(null, { ok: true, status: 'sent', messageId: 'barrage-1' });
              return;
            }
            callback(null, { ok: true });
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
      const body = await readFile(filePath);
      response.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-store' });
      response.end(body);
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

async function openDesktopRuntime(browser) {
  const server = await startStaticServer();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pageErrors = [];
  const externalRequests = [];
  const serverOrigin = new URL(server.url).origin;
  context.on('request', (request) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url());
    } catch {
      return;
    }
    if (['http:', 'https:', 'ws:', 'wss:'].includes(requestUrl.protocol) && requestUrl.origin !== serverOrigin) {
      externalRequests.push(request.url());
    }
  });
  try {
    await context.addInitScript(() => {
      const originalSetItem = Storage.prototype.setItem;
      window.__testSettingsWriteCount = 0;
      Storage.prototype.setItem = function setItem(key, value) {
        if (key === 'danmaku-overlay-settings') window.__testSettingsWriteCount += 1;
        return originalSetItem.call(this, key, value);
      };
      const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
      const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
      const frameState = { scheduled: 0, executed: 0, cancelled: 0, pending: new Set() };
      window.__testAnimationFrameState = frameState;
      window.requestAnimationFrame = (callback) => {
        frameState.scheduled += 1;
        let frameId;
        frameId = nativeRequestAnimationFrame((timestamp) => {
          frameState.pending.delete(frameId);
          frameState.executed += 1;
          return callback(timestamp);
        });
        frameState.pending.add(frameId);
        return frameId;
      };
      window.cancelAnimationFrame = (frameId) => {
        if (frameState.pending.delete(frameId)) frameState.cancelled += 1;
        return nativeCancelAnimationFrame(frameId);
      };
      localStorage.setItem('danmaku-overlay-settings', JSON.stringify({
        onboarded: true,
        clientId: 'client-panel-test',
        nickname: '保留暱稱',
        nicknameChangeDate: '2026-07-15',
        currentRoomCode: '12345678',
        defaultRoomCode: '87654321',
        joinedRoomCodes: ['12345678', '87654321'],
        ownerCredentialKeys: ['room-owner:12345678'],
        panel: { width: 360, height: 240 },
      }));
      window.__testTauriListeners = Object.create(null);
      window.__testInteractiveRegions = [];
      window.__testCredentialStore = { 'client-id': 'client-panel-test' };
      window.__TAURI__ = {
        core: {
          invoke: async (command, args = {}) => {
            if (command === 'credential_get') return window.__testCredentialStore[args.key] ?? null;
            if (command === 'credential_set') {
              window.__testCredentialStore[args.key] = args.value;
              return null;
            }
            if (command === 'credential_delete') {
              delete window.__testCredentialStore[args.key];
              return null;
            }
            if (command === 'set_interactive_regions') {
              window.__testInteractiveRegions.push(args.regions.map((region) => ({ ...region })));
              return null;
            }
            return null;
          },
        },
        event: {
          listen: async (eventName, callback) => {
            window.__testTauriListeners[eventName] = callback;
            return () => { delete window.__testTauriListeners[eventName]; };
          },
        },
      };
    });
    await context.addInitScript({ content: MOCK_SOCKET_IO });
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
    });
    await page.goto(server.url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof window.__testSocket === 'object');
    await page.waitForFunction(() => typeof window.__testTauriListeners['reset-settings'] === 'function');
    await expect(page.locator('#floating-ball')).toBeAttached();
    await expect.poll(() => page.locator('#btn-send').getAttribute('aria-disabled')).toBe('false');
    await page.evaluate(() => { window.__testSettingsWriteCount = 0; });
    return {
      page,
      pageErrors,
      externalRequests,
      close: async () => {
        await context.close();
        await server.close();
      },
    };
  } catch (error) {
    await context.close().catch(() => {});
    await server.close().catch(() => {});
    throw error;
  }
}

async function openMain(page) {
  await page.locator('#floating-ball').click();
  await expect(page.locator('#panel')).not.toHaveClass(/hidden/);
}

async function openSettings(page) {
  await openMain(page);
  await page.locator('#btn-settings').click();
  await expect(page.locator('#settings-panel')).not.toHaveClass(/hidden/);
}

function localSettings(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('danmaku-overlay-settings')));
}

async function panelSnapshot(page) {
  return page.evaluate(() => Object.fromEntries(['panel', 'history-panel', 'settings-panel'].map((id) => {
    const element = document.getElementById(id);
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return [id, {
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
      panelWidth: style.getPropertyValue('--panel-width').trim(),
      panelHeight: style.getPropertyValue('--panel-height').trim(),
    }];
  })));
}

const INTERACTIVE_IDS = ['floating-ball', 'panel', 'history-panel', 'settings-panel', 'room-manager-panel', 'hsv-picker-dialog', 'onboarding'];

async function interactiveRegionSnapshot(page) {
  return page.evaluate((ids) => {
    const expected = ids.flatMap((id) => {
      const element = document.getElementById(id);
      if (!element || element.classList.contains('hidden')) return [];
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return [];
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return [];
      return [{ id, x: rect.left, y: rect.top, width: rect.width, height: rect.height }];
    });
    const actual = window.__testInteractiveRegions.at(-1) || [];
    const fields = ['x', 'y', 'width', 'height'];
    const matches = actual.length === expected.length && actual.every((region, index) => fields.every((field) => (
      Number.isFinite(region[field]) && Math.abs(region[field] - expected[index][field]) < 0.01
    )));
    return { expected, actual, matches };
  }, INTERACTIVE_IDS);
}

async function anchoredPanelSnapshot(page) {
  return page.evaluate(() => {
    const rectFor = (id) => {
      const rect = document.getElementById(id).getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const layoutRectFor = (id) => {
      const element = document.getElementById(id);
      const rect = element.getBoundingClientRect();
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const style = getComputedStyle(element);
      const inlineLeft = Number.parseFloat(element.style.left);
      const inlineTop = Number.parseFloat(element.style.top);
      const computedRight = Number.parseFloat(style.right);
      const computedTop = Number.parseFloat(style.top);
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
      return { left, right: left + width, top, bottom: top + height, width, height };
    };
    const placementFor = (anchor, panel) => {
      const margin = 8;
      const gap = 8;
      const maxWidth = Math.max(0, window.innerWidth - margin * 2);
      const maxHeight = Math.max(0, window.innerHeight - margin * 2);
      const width = Math.min(panel.width, maxWidth);
      const height = Math.min(panel.height, maxHeight);
      const rightCandidate = anchor.right + gap;
      const leftCandidate = anchor.left - gap - width;
      const maximumLeft = Math.max(margin, window.innerWidth - margin - width);
      const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);
      const left = rightCandidate + width <= window.innerWidth - margin
        ? rightCandidate
        : leftCandidate >= margin
          ? leftCandidate
          : clamp(rightCandidate, margin, maximumLeft);
      const maximumTop = Math.max(margin, window.innerHeight - margin - height);
      return { left: clamp(left, margin, maximumLeft), top: clamp(anchor.top, margin, maximumTop) };
    };
    const ball = rectFor('floating-ball');
    const ballLayout = layoutRectFor('floating-ball');
    const main = rectFor('panel');
    const settings = rectFor('settings-panel');
    const expectedMain = placementFor(ballLayout, main);
    const expectedSettings = placementFor(layoutRectFor('panel'), settings);
    const closeEnough = (actual, expected) => Math.abs(actual.left - expected.left) < 0.01 && Math.abs(actual.top - expected.top) < 0.01;
    const inViewport = (rect) => rect.left >= 8 && rect.top >= 8
      && rect.right <= window.innerWidth - 8 && rect.bottom <= window.innerHeight - 8;
    return {
      ball,
      ballLayout,
      main,
      settings,
      expectedMain,
      expectedSettings,
      mainAnchoredToBall: closeEnough(main, expectedMain),
      settingsAnchoredToMain: closeEnough(settings, expectedSettings),
      allInViewport: [main, settings].every(inViewport),
    };
  });
}

async function dragRaceDiagnostic(page) {
  return page.evaluate(() => {
    const detailsFor = (id) => {
      const element = document.getElementById(id);
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
        style: { left: element.style.left, top: element.style.top, right: element.style.right, transform: style.transform, transition: style.transition },
        offset: { width: element.offsetWidth, height: element.offsetHeight },
        active: element.matches(':active'),
      };
    };
    return {
      ball: detailsFor('floating-ball'),
      main: detailsFor('panel'),
      settings: detailsFor('settings-panel'),
      activeElement: document.activeElement?.id || null,
      raf: {
        pendingCount: window.__testAnimationFrameState?.pending.size ?? null,
        scheduled: window.__testAnimationFrameState?.scheduled ?? null,
        executed: window.__testAnimationFrameState?.executed ?? null,
        cancelled: window.__testAnimationFrameState?.cancelled ?? null,
      },
    };
  });
}

test('large overlapping subpanels stay above main and remain pointer-operable at 1280px', async ({ browser }) => {
  const runtime = await openDesktopRuntime(browser);
  const { page, pageErrors, externalRequests } = runtime;
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openSettings(page);
    await page.locator('#panel-width').fill('800');
    await page.locator('#panel-height').fill('300');
    await expect.poll(() => page.evaluate(() => {
      const main = document.getElementById('panel').getBoundingClientRect();
      const settings = document.getElementById('settings-panel').getBoundingClientRect();
      return {
        viewport: [window.innerWidth, window.innerHeight],
        panel: [main.width, main.height],
        overlap: main.left < settings.right && settings.left < main.right
          && main.top < settings.bottom && settings.top < main.bottom,
      };
    })).toEqual({ viewport: [1280, 720], panel: [800, 300], overlap: true });

    const settingsTop = await page.evaluate(() => {
      const target = document.getElementById('btn-reset-settings').getBoundingClientRect();
      const element = document.elementFromPoint(target.left + target.width / 2, target.top + target.height / 2);
      return element?.closest('#settings-panel')?.id || element?.closest('#panel')?.id || null;
    });
    expect(settingsTop).toBe('settings-panel');
    await page.locator('#btn-reset-settings').click({ timeout: 3000 });
    await expect(page.locator('#panel-width')).toHaveValue('320');
    await expect.poll(async () => (await localSettings(page)).ballPosition).toEqual({ x: null, y: 100 });

    // Recreate the legal overlap after the real settings control click.
    await page.locator('#panel-width').fill('800');
    await page.locator('#panel-height').fill('300');
    await page.locator('#btn-close-settings').click({ timeout: 3000 });
    await page.locator('#btn-history').click({ timeout: 3000 });
    const historyTop = await page.evaluate(() => {
      const target = document.getElementById('btn-close-history').getBoundingClientRect();
      const element = document.elementFromPoint(target.left + target.width / 2, target.top + target.height / 2);
      return element?.closest('#history-panel')?.id || element?.closest('#panel')?.id || null;
    });
    expect(historyTop).toBe('history-panel');
    await page.locator('#btn-close-history').click({ timeout: 3000 });
  } finally {
    await runtime.close();
  }
  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('drag and reset re-anchor every visible panel without stale coordinates', async ({ browser }) => {
  const runtime = await openDesktopRuntime(browser);
  const { page, pageErrors, externalRequests } = runtime;
  try {
    await openSettings(page);
    await page.locator('#panel-width').fill('420');
    await page.locator('#panel-height').fill('300');
    await page.evaluate(() => { window.__testSettingsWriteCount = 0; });
    const before = await anchoredPanelSnapshot(page);
    const target = { x: 600, y: 300 };
    await page.mouse.move(before.ball.left + before.ball.width / 2, before.ball.top + before.ball.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 4 });
    await page.mouse.up();
    const afterMouseUp = await anchoredPanelSnapshot(page);
    if (!afterMouseUp.mainAnchoredToBall || !afterMouseUp.settingsAnchoredToMain) {
      console.log(`[drag-race-diagnostic] ${JSON.stringify({ snapshot: afterMouseUp, details: await dragRaceDiagnostic(page) })}`);
    }
    const dragSamples = [afterMouseUp];
    for (let frame = 0; frame < 4; frame += 1) {
      await page.evaluate(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));
      dragSamples.push(await anchoredPanelSnapshot(page));
    }
    dragSamples.forEach((sample, index) => {
      expect(sample, `drag layout sample ${index}`).toMatchObject({
        mainAnchoredToBall: true,
        settingsAnchoredToMain: true,
        allInViewport: true,
      });
    });
    const afterDrag = dragSamples.at(-1);
    expect(afterDrag.main).not.toMatchObject({ left: before.main.left, top: before.main.top });
    expect(afterDrag.settings).not.toMatchObject({ left: before.settings.left, top: before.settings.top });
    expect(await page.evaluate(() => window.__testSettingsWriteCount)).toBe(1);
    const savedAfterDrag = await localSettings(page);
    expect(savedAfterDrag.ballPosition).toMatchObject({
      x: afterDrag.ballLayout.left,
      y: afterDrag.ballLayout.top,
    });

    await page.evaluate(() => window.__testTauriListeners['reset-ball-position']());
    const afterResetImmediate = await anchoredPanelSnapshot(page);
    const resetSamples = [afterResetImmediate];
    for (let frame = 0; frame < 3; frame += 1) {
      await page.evaluate(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));
      resetSamples.push(await anchoredPanelSnapshot(page));
    }
    resetSamples.forEach((sample, index) => {
      expect(sample, `reset layout sample ${index}`).toMatchObject({
        ballLayout: { left: 1204, top: 100 },
        mainAnchoredToBall: true,
        settingsAnchoredToMain: true,
        allInViewport: true,
      });
    });
    const afterReset = resetSamples.at(-1);
    expect(afterReset.main).not.toMatchObject({ left: afterDrag.main.left, top: afterDrag.main.top });
    expect(afterReset.settings).not.toMatchObject({ left: afterDrag.settings.left, top: afterDrag.settings.top });
  } finally {
    await runtime.close();
  }
  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('resizing visible main and settings panels reclamps layout and syncs Tauri interactive regions', async ({ browser }) => {
  const runtime = await openDesktopRuntime(browser);
  const { page, pageErrors, externalRequests } = runtime;
  try {
    await openSettings(page);
    await expect.poll(() => page.evaluate(() => ({
      main: (() => {
        const rect = document.getElementById('panel').getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      })(),
      settings: (() => {
        const rect = document.getElementById('settings-panel').getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      })(),
    }))).toMatchObject({
      main: { left: 836, right: 1196, width: 360 },
      settings: { left: 468, right: 828, width: 360 },
    });

    await page.evaluate(() => { window.__testSettingsWriteCount = 0; });
    await page.locator('#panel-width').fill('800');
    await expect(page.locator('#panel-width-value')).toHaveText('800px');
    await expect.poll(() => localSettings(page)).toMatchObject({ panel: { width: 800 } });
    await expect.poll(() => page.evaluate(() => {
      const visible = ['panel', 'settings-panel']
        .filter((id) => !document.getElementById(id).classList.contains('hidden'))
        .map((id) => {
          const rect = document.getElementById(id).getBoundingClientRect();
          return { id, left: rect.left, right: rect.right, width: rect.width };
        });
      return {
        visible,
        inBounds: visible.length === 2 && visible.every(({ left, right }) => left >= 8 && right <= window.innerWidth - 8),
      };
    })).toMatchObject({ inBounds: true });

    await expect.poll(() => interactiveRegionSnapshot(page)).toMatchObject({ matches: true });
    await expect.poll(() => page.evaluate(() => window.__testSettingsWriteCount)).toBe(1);
  } finally {
    await runtime.close();
  }
  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('generated Desktop panel settings persist, apply to all three surfaces, clamp, scroll, and reset safely', async ({ browser }) => {
  const runtime = await openDesktopRuntime(browser);
  const { page, pageErrors, externalRequests } = runtime;
  try {
    await openMain(page);
    await expect.poll(() => page.evaluate(() => {
      const rect = document.getElementById('panel').getBoundingClientRect();
      return { width: rect.width, height: rect.height, vars: [
        getComputedStyle(document.getElementById('panel')).getPropertyValue('--panel-width').trim(),
        getComputedStyle(document.getElementById('panel')).getPropertyValue('--panel-height').trim(),
      ] };
    })).toEqual({ width: 360, height: 240, vars: ['360px', '240px'] });

    await page.locator('#btn-settings').click();
    await expect(page.locator('#settings-panel')).not.toHaveClass(/hidden/);
    await expect.poll(() => page.evaluate(() => {
      const rect = document.getElementById('settings-panel').getBoundingClientRect();
      return { width: rect.width, height: rect.height, vars: [
        getComputedStyle(document.getElementById('settings-panel')).getPropertyValue('--panel-width').trim(),
        getComputedStyle(document.getElementById('settings-panel')).getPropertyValue('--panel-height').trim(),
      ] };
    })).toEqual({ width: 360, height: 240, vars: ['360px', '240px'] });
    await expect.poll(() => page.evaluate(() => {
      const body = document.querySelector('#settings-panel .settings-body');
      return {
        overflow: getComputedStyle(body).overflowY,
        scrollable: body.scrollHeight > body.clientHeight,
        headerVisible: document.querySelector('#settings-panel .settings-header').getBoundingClientRect().height > 0,
        actionsPresent: document.getElementById('btn-reset-settings').getBoundingClientRect().height > 0,
      };
    })).toEqual({ overflow: 'auto', scrollable: true, headerVisible: true, actionsPresent: true });

    await page.locator('#panel-height').fill('80');
    await page.locator('#msg-input').click();
    await expect.poll(() => page.evaluate(() => {
      const panel = document.getElementById('panel');
      const input = document.getElementById('msg-input');
      const panelRect = panel.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      return {
        height: panel.getBoundingClientRect().height,
        scrollable: panel.scrollHeight > panel.clientHeight,
        headerVisible: panel.querySelector('.panel-header').getBoundingClientRect().height > 0,
        inputVisible: panel.querySelector('.panel-input').getBoundingClientRect().height > 0,
        active: document.activeElement === input,
        scrollTop: panel.scrollTop,
        inputInsidePanel: inputRect.left >= panelRect.left - 0.01
          && inputRect.right <= panelRect.right + 0.01
          && inputRect.top >= panelRect.top - 0.01
          && inputRect.bottom <= panelRect.bottom + 0.01,
      };
    })).toEqual({ height: 80, scrollable: true, headerVisible: true, inputVisible: true, active: true, scrollTop: 13, inputInsidePanel: true });
    await page.locator('#panel-height').fill('240');

    await page.locator('#btn-history').click();
    await expect(page.locator('#history-panel')).not.toHaveClass(/hidden/);
    await expect.poll(() => page.evaluate(() => {
      const rect = document.getElementById('history-panel').getBoundingClientRect();
      return { width: rect.width, height: rect.height, vars: [
        getComputedStyle(document.getElementById('history-panel')).getPropertyValue('--panel-width').trim(),
        getComputedStyle(document.getElementById('history-panel')).getPropertyValue('--panel-height').trim(),
      ] };
    })).toEqual({ width: 360, height: 240, vars: ['360px', '240px'] });

    await page.locator('#btn-settings').click();
    await page.locator('#panel-width').fill('420');
    await page.locator('#panel-height').fill('300');
    await expect(page.locator('#panel-width-value')).toHaveText('420px');
    await expect(page.locator('#panel-height-value')).toHaveText('300px');
    await expect.poll(() => localSettings(page)).toMatchObject({ panel: { width: 420, height: 300 } });
    await expect.poll(() => panelSnapshot(page)).toMatchObject({
      panel: { width: 420, height: 300, panelWidth: '420px', panelHeight: '300px' },
      'settings-panel': { width: 420, height: 300, panelWidth: '420px', panelHeight: '300px' },
      'history-panel': { panelWidth: '420px', panelHeight: '300px' },
    });

    await page.setViewportSize({ width: 360, height: 280 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.locator('#btn-close-settings').click();
    await page.locator('#btn-settings').click();
    await page.locator('#panel-width').fill('800');
    await page.locator('#panel-height').fill('0', { force: true });
    await expect(page.locator('#panel-height-value')).toHaveText('自動');
    await expect.poll(() => localSettings(page)).toMatchObject({ panel: { width: 800, height: 0 } });

    await page.evaluate(() => document.getElementById('btn-history').click());
    await expect(page.locator('#history-panel')).not.toHaveClass(/hidden/);
    await page.evaluate(() => {
      for (let index = 0; index < 200; index += 1) {
        window.__testSocket.emitFromServer('barrage', {
          messageId: `history-${index}`,
          nickname: '測試者',
          text: `可捲動歷史 ${index}`,
          color: '#58A6FF',
          timestamp: Date.now() + index,
          sessionId: 'panel-test',
        });
      }
    });
    await expect.poll(() => page.evaluate(() => {
      const panel = document.getElementById('history-panel');
      const list = document.getElementById('history-list');
      const rect = panel.getBoundingClientRect();
      return {
        rect: { width: rect.width, height: rect.height, left: rect.left, top: rect.top },
        listScrollable: list.scrollHeight > list.clientHeight,
        listOverflow: getComputedStyle(list).overflowY,
        vars: [getComputedStyle(panel).getPropertyValue('--panel-width').trim(), getComputedStyle(panel).getPropertyValue('--panel-height').trim()],
      };
    })).toEqual({
      rect: { width: 344, height: 264, left: 8, top: 8 },
      listScrollable: true,
      listOverflow: 'auto',
      vars: ['800px', 'auto'],
    });

    await page.evaluate(() => document.getElementById('btn-settings').click());
    await page.evaluate(() => document.getElementById('btn-reset-settings').click());
    await expect(page.locator('#panel-width')).toHaveValue('320');
    await expect(page.locator('#panel-height')).toHaveValue('0');
    await expect(page.locator('#panel-width-value')).toHaveText('320px');
    await expect(page.locator('#panel-height-value')).toHaveText('自動');
    await expect.poll(() => localSettings(page)).toMatchObject({
      panel: { width: 320, height: 0 },
      clientId: 'client-panel-test',
      nickname: '保留暱稱',
      nicknameChangeDate: '2026-07-15',
      currentRoomCode: '12345678',
      defaultRoomCode: '87654321',
      joinedRoomCodes: ['12345678', '87654321'],
      ownerCredentialKeys: ['room-owner:12345678'],
    });
    await expect.poll(() => panelSnapshot(page)).toMatchObject({
      panel: { panelWidth: '320px', panelHeight: 'auto' },
      'history-panel': { panelWidth: '320px', panelHeight: 'auto' },
      'settings-panel': { panelWidth: '320px', panelHeight: 'auto' },
    });
  } finally {
    await runtime.close();
  }
  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
