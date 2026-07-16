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
    window.__nicknameAckQueue = [];
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
        timeout() {
          return { emit(eventName, payload, callback) {
            window.__testOutgoing.push({ event: eventName, payload });
            if (eventName === 'nickname-change') {
              if (window.__nicknamePending) {
                window.__resolveNickname = callback;
                return;
              }
              callback(null, window.__nicknameAckQueue.shift() || {
                ok: true,
                nickname: payload.nickname,
                changeDate: '2026-07-15',
              });
              return;
            }
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

async function openDesktopRuntime(browser, initialSettings = {}) {
  const server = await startStaticServer();
  const context = await browser.newContext();
  try {
    await context.addInitScript(({ settings }) => {
      localStorage.setItem('danmaku-overlay-settings', JSON.stringify({
        onboarded: true,
        nickname: '舊暱稱',
        nicknameChangeDate: '2026-07-14',
        ...settings,
      }));
      window.__TAURI__ = undefined;
      window.__nicknamePending = false;
    }, { settings: initialSettings });
    await context.addInitScript({ content: MOCK_SOCKET_IO });
    const page = await context.newPage();
    await page.goto(server.url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof window.__testSocket === 'object');
    await expect(page.locator('#floating-ball')).toBeAttached();
    await expect.poll(() => page.locator('#btn-send').getAttribute('aria-disabled')).toBe('false');
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

async function openSettings(page) {
  await page.locator('#floating-ball').click();
  await expect(page.locator('#panel')).not.toHaveClass(/hidden/);
  await page.locator('#btn-settings').click();
  await expect(page.locator('#settings-panel')).not.toHaveClass(/hidden/);
}

function localSettings(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('danmaku-overlay-settings')));
}

test('nickname success ACK updates storage and the next barrage uses the accepted name', async ({ browser }) => {
  const runtime = await openDesktopRuntime(browser);
  const { page } = runtime;
  try {
    await openSettings(page);
    await page.locator('#nickname-input').fill('請求暱稱');
    await page.evaluate(() => window.__nicknameAckQueue.push({ ok: true, nickname: '伺服器名', changeDate: '2026-07-15' }));
    await page.locator('#nickname-form').evaluate((form) => form.requestSubmit());
    await expect(page.locator('#nickname-status')).toHaveText('伺服器已接受暱稱：伺服器名');
    await expect.poll(() => localSettings(page)).toMatchObject({ nickname: '伺服器名', nicknameChangeDate: '2026-07-15' });

    await page.locator('#msg-input').fill('使用保存名');
    await page.locator('#btn-send').click();
    await expect.poll(() => page.evaluate(() => window.__testOutgoing
      .filter(({ event }) => event === 'barrage').at(-1)?.payload.nickname)).toBe('伺服器名');
  } finally {
    await runtime.close();
  }
});

test('RATE_LIMITED failure shows the server message and keeps storage and outgoing nickname unchanged', async ({ browser }) => {
  const runtime = await openDesktopRuntime(browser);
  const { page } = runtime;
  try {
    await openSettings(page);
    await page.locator('#nickname-input').fill('不應採用');
    await page.evaluate(() => window.__nicknameAckQueue.push({ ok: false, error: { code: 'RATE_LIMITED', scope: 'nickname', message: '今天已達變更上限', retryAfterMs: 43210000 } }));
    await page.locator('#nickname-form').evaluate((form) => form.requestSubmit());
    await expect(page.locator('#nickname-status')).toHaveText('今天已達變更上限');
    await expect.poll(() => localSettings(page)).toMatchObject({ nickname: '舊暱稱', nicknameChangeDate: '2026-07-14' });
    await expect(page.locator('#nickname-input')).toHaveValue('舊暱稱');

    await page.locator('#msg-input').fill('失敗後仍用舊名');
    await page.locator('#btn-send').click();
    await expect.poll(() => page.evaluate(() => window.__testOutgoing
      .filter(({ event }) => event === 'barrage').at(-1)?.payload.nickname)).toBe('舊暱稱');
  } finally {
    await runtime.close();
  }
});

test('pending duplicate nickname submit is blocked and both controls are disabled', async ({ browser }) => {
  const runtime = await openDesktopRuntime(browser);
  const { page } = runtime;
  try {
    await openSettings(page);
    await page.evaluate(() => { window.__nicknamePending = true; });
    await page.locator('#nickname-input').fill('等待回應');
    await page.locator('#nickname-form').evaluate((form) => form.requestSubmit());
    await expect(page.locator('#nickname-input')).toBeDisabled();
    await expect(page.locator('#nickname-save')).toBeDisabled();
    await page.locator('#nickname-form').evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await expect.poll(() => page.evaluate(() => window.__testOutgoing.filter(({ event }) => event === 'nickname-change').length)).toBe(1);
    await page.evaluate(() => window.__resolveNickname({ ok: true, nickname: '等待回應', changeDate: '2026-07-15' }));
    await expect(page.locator('#nickname-input')).toBeEnabled();
    await expect(page.locator('#nickname-save')).toBeEnabled();
  } finally {
    await runtime.close();
  }
});

test('reset appearance preserves the saved nickname and change date', async ({ browser }) => {
  const runtime = await openDesktopRuntime(browser);
  const { page } = runtime;
  try {
    await openSettings(page);
    await page.locator('#nickname-input').fill('保留暱稱');
    await page.evaluate(() => window.__nicknameAckQueue.push({ ok: true, nickname: '伺服器保留名', changeDate: '2026-07-15' }));
    await page.locator('#nickname-form').evaluate((form) => form.requestSubmit());
    await expect(page.locator('#nickname-input')).toHaveValue('伺服器保留名');
    await page.locator('#btn-reset-settings').click();
    await expect(page.locator('#nickname-input')).toHaveValue('伺服器保留名');
    await expect.poll(() => localSettings(page)).toMatchObject({ nickname: '伺服器保留名', nicknameChangeDate: '2026-07-15' });
  } finally {
    await runtime.close();
  }
});

test('invalid successful ACK is rejected without storage mutation', async ({ browser }) => {
  const runtime = await openDesktopRuntime(browser);
  const { page } = runtime;
  try {
    await openSettings(page);
    await page.locator('#nickname-input').fill('不合法回應');
    await page.evaluate(() => window.__nicknameAckQueue.push({ ok: true, nickname: '', changeDate: '2026-07-15' }));
    await page.locator('#nickname-form').evaluate((form) => form.requestSubmit());
    await expect(page.locator('#nickname-status')).toHaveText('伺服器暱稱回應格式錯誤');
    await expect.poll(() => localSettings(page)).toMatchObject({ nickname: '舊暱稱', nicknameChangeDate: '2026-07-14' });
  } finally {
    await runtime.close();
  }
});

test('UTF-16-over-limit emoji successful ACK is rejected without storage or barrage mutation', async ({ browser }) => {
  const runtime = await openDesktopRuntime(browser);
  const { page } = runtime;
  try {
    await openSettings(page);
    await page.locator('#nickname-input').fill('不合法回應');
    await page.evaluate(() => window.__nicknameAckQueue.push({ ok: true, nickname: '😀😀😀😀', changeDate: '2026-07-15' }));
    await page.locator('#nickname-form').evaluate((form) => form.requestSubmit());
    await expect(page.locator('#nickname-status')).toHaveText('伺服器暱稱回應格式錯誤');
    await expect.poll(() => localSettings(page)).toMatchObject({ nickname: '舊暱稱', nicknameChangeDate: '2026-07-14' });

    await page.locator('#msg-input').fill('emoji ACK 失敗後仍用舊名');
    await page.locator('#btn-send').click();
    await expect.poll(() => page.evaluate(() => window.__testOutgoing
      .filter(({ event }) => event === 'barrage').at(-1)?.payload.nickname)).toBe('舊暱稱');
  } finally {
    await runtime.close();
  }
});

test('generated runtime controller sends an accepted nickname verbatim', async ({ browser }) => {
  const runtime = await openDesktopRuntime(browser);
  const { page } = runtime;
  try {
    const result = await page.evaluate(async () => {
      const core = await import('/generated/shared-core.js');
      const acceptedNickname = ' 名 ';
      const saved = [];
      const outgoing = [];
      const settings = {
        load: () => ({ nickname: '舊暱稱', danmaku: { color: '#E6EDF3' } }),
        save: (value) => {
          saved.push({ nickname: value.nickname, nicknameChangeDate: value.nicknameChangeDate });
          return value;
        },
        resetAppearance: (value) => value,
      };
      const controller = core.createOverlayController({
        sendBarrage: async (payload) => {
          outgoing.push(payload);
          return { ok: true, status: 'sent', messageId: 'verbatim-name' };
        },
        changeNickname: async () => ({ ok: true, nickname: acceptedNickname, changeDate: '2026-07-15' }),
        settingsAdapter: settings,
      });

      await controller.changeNickname('請求暱稱');
      await controller.submit('使用逐字暱稱', { currentDraft: '使用逐字暱稱' });
      return { saved, nickname: controller.getSettings().nickname, outgoing: outgoing.at(-1).nickname };
    });
    expect(result.saved).toEqual([{ nickname: ' 名 ', nicknameChangeDate: '2026-07-15' }]);
    expect(result.nickname).toBe(' 名 ');
    expect(result.outgoing).toBe(' 名 ');
  } finally {
    await runtime.close();
  }
});

test('generated runtime controller rejects stale successful ACK without saving', async ({ browser }) => {
  const runtime = await openDesktopRuntime(browser);
  const { page } = runtime;
  try {
    const result = await page.evaluate(async () => {
      const core = await import('/generated/shared-core.js');
      const saved = [];
      const deferred = [];
      const controller = core.createOverlayController({
        sendBarrage: async () => ({ ok: true, status: 'sent', messageId: 'm' }),
        changeNickname: () => new Promise((resolve) => deferred.push(resolve)),
        settingsAdapter: {
          load: () => ({ nickname: '舊暱稱', danmaku: { color: '#E6EDF3' } }),
          save: (value) => { saved.push(value); return value; },
          resetAppearance: (value) => value,
        },
      });
      const old = controller.changeNickname('舊名');
      const newer = controller.changeNickname('新名');
      deferred[0]({ ok: true, nickname: '舊伺服器名', changeDate: '2026-07-14' });
      const oldResult = await old;
      deferred[1]({ ok: true, nickname: '新伺服器名', changeDate: '2026-07-15' });
      const newResult = await newer;
      return { oldResult, newResult, saved: saved.map(({ nickname, nicknameChangeDate }) => ({ nickname, nicknameChangeDate })) };
    });
    expect(result.oldResult.stale).toBe(true);
    expect(result.saved).toEqual([{ nickname: '新伺服器名', nicknameChangeDate: '2026-07-15' }]);
  } finally {
    await runtime.close();
  }
});
