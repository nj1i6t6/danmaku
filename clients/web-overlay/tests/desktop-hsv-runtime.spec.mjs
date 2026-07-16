import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..', '..', '..', 'desktop', 'frontend');

const MOCK_SOCKET_IO = `
  (() => {
    window.io = () => {
      const handlers = new Map();
      const socket = {
        connected: false,
        on(eventName, callback) {
          const callbacks = handlers.get(eventName) || [];
          callbacks.push(callback);
          handlers.set(eventName, callbacks);
          return socket;
        },
        emitFromServer(eventName, payload) {
          for (const callback of handlers.get(eventName) || []) callback(payload);
        },
        timeout() {
          return { emit(_event, _payload, callback) {
            callback(null, { ok: false, error: { code: 'MOCK', message: 'mock socket' } });
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
      response.writeHead(200, { 'content-type': contentType(filePath) });
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
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => {
      localStorage.setItem('danmaku-overlay-settings', JSON.stringify({ onboarded: true }));
      window.__testTauriListeners = Object.create(null);
      window.__TAURI__ = {
        core: {
          invoke: async () => null,
        },
        event: {
          listen: async (eventName, callback) => {
            window.__testTauriListeners[eventName] = callback;
            return () => { delete window.__testTauriListeners[eventName]; };
          },
        },
      };
    });
    const page = await context.newPage();
    await page.goto(server.url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof window.__testTauriListeners['reset-settings'] === 'function');
    await expect(page.locator('#dm-color-trigger')).toBeAttached();
    return {
      page,
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

async function openDanmakuPicker(page) {
  await page.locator('#floating-ball').click();
  await expect(page.locator('#panel')).not.toHaveClass(/hidden/);
  await page.locator('#btn-settings').click();
  await expect(page.locator('#settings-panel')).not.toHaveClass(/hidden/);
  await page.locator('#dm-color-trigger').click();
  await expect(page.locator('#hsv-picker-dialog')).toBeVisible();
}

test('Tauri reset-settings closes HSV picker and invalidates stale preview draft', async ({ browser }) => {
  const runtime = await openDesktopRuntime(browser);
  const { page } = runtime;
  try {
    await openDanmakuPicker(page);
    await page.locator('#hsv-hue').fill('0');
    await page.locator('#hsv-saturation').fill('100');
    await page.locator('#hsv-value').fill('100');
    await expect(page.locator('#hsv-picker-hex')).toHaveText('#FF0000');

    await page.evaluate(() => window.__testTauriListeners['reset-settings']());

    await expect(page.locator('#hsv-picker-dialog')).toBeHidden();
    await expect(page.locator('#dm-color-value')).toHaveText('#E6EDF3');
    await expect.poll(() => page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem('danmaku-overlay-settings'));
      return {
        setting: settings.danmaku.color,
        swatch: document.getElementById('dm-color-swatch').style.backgroundColor,
      };
    })).toEqual({ setting: '#E6EDF3', swatch: 'rgb(230, 237, 243)' });

    await page.evaluate(() => document.getElementById('hsv-picker-apply').click());
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('danmaku-overlay-settings')).danmaku.color))
      .toBe('#E6EDF3');

    await page.locator('#dm-color-trigger').click();
    await expect(page.locator('#hsv-picker-dialog')).toBeVisible();
    await page.locator('#hsv-hue').fill('0');
    await page.locator('#hsv-saturation').fill('100');
    await page.locator('#hsv-value').fill('100');
    await page.evaluate(() => document.getElementById('btn-reset-settings').click());
    await expect(page.locator('#hsv-picker-dialog')).toBeHidden();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('danmaku-overlay-settings')).danmaku.color))
      .toBe('#E6EDF3');
  } finally {
    await runtime.close();
  }
});

test('Applying local danmaku color preserves a valid server message color', async ({ browser }) => {
  const runtime = await openDesktopRuntime(browser);
  const { page } = runtime;
  try {
    await page.evaluate(() => window.__testSocket.emitFromServer('barrage', {
      messageId: 'server-color-message',
      nickname: 'server',
      text: 'server-color',
      color: '#FF00AA',
      timestamp: Date.now(),
      sessionId: 'server-session',
    }));
    await expect(page.locator('.danmaku-text')).toHaveCSS('color', 'rgb(255, 0, 170)');

    await openDanmakuPicker(page);
    await page.locator('#hsv-hue').fill('120');
    await page.locator('#hsv-saturation').fill('100');
    await page.locator('#hsv-value').fill('100');
    await page.locator('#hsv-picker-apply').click();

    await expect(page.locator('.danmaku-text')).toHaveCSS('color', 'rgb(255, 0, 170)');
    await expect(page.locator('.danmaku')).toHaveJSProperty('style.color', '');
  } finally {
    await runtime.close();
  }
});

test('HSV dialog traps keyboard focus and inerts the overlay background', async ({ browser }) => {
  const runtime = await openDesktopRuntime(browser);
  const { page } = runtime;
  try {
    await openDanmakuPicker(page);
    await expect(page.locator('#hsv-picker-dialog')).toHaveAttribute('aria-modal', 'true');
    await expect.poll(() => page.evaluate(() => [
      'floating-ball',
      'panel',
      'settings-panel',
    ].map((id) => document.getElementById(id).hasAttribute('inert')))).toEqual([true, true, true]);

    const focusIds = [];
    for (let index = 0; index < 6; index += 1) {
      focusIds.push(await page.evaluate(() => document.activeElement?.id || 'BODY'));
      await page.keyboard.press('Tab');
    }
    expect(focusIds).toEqual([
      'hsv-hue',
      'hsv-saturation',
      'hsv-value',
      'hsv-picker-cancel',
      'hsv-picker-apply',
      'hsv-picker-close',
    ]);
    await expect.poll(() => page.evaluate(() => document.activeElement?.id || 'BODY')).toBe('hsv-hue');

    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => page.evaluate(() => document.activeElement?.id || 'BODY')).toBe('hsv-picker-close');
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => page.evaluate(() => document.activeElement?.id || 'BODY')).toBe('hsv-picker-apply');

    await page.keyboard.press('Escape');
    await expect(page.locator('#hsv-picker-dialog')).toBeHidden();
    await expect.poll(() => page.evaluate(() => [
      'floating-ball',
      'panel',
      'settings-panel',
    ].some((id) => document.getElementById(id).hasAttribute('inert')))).toBe(false);
    await expect.poll(() => page.evaluate(() => document.activeElement?.id || 'BODY')).toBe('dm-color-trigger');

    for (let index = 0; index < 90; index += 1) {
      await page.locator('#dm-color-trigger').click();
      await expect(page.locator('#hsv-picker-dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('#hsv-picker-dialog')).toBeHidden();
    }
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('[inert]')]
      .filter((element) => element.id !== 'hsv-picker-dialog').length)).toBe(0);
  } finally {
    await runtime.close();
  }
});
