import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const executablePath = process.env.UNPACKED_CHROMIUM_PATH;
const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..', '..', '..');
const extensionPath = path.join(repositoryRoot, 'extension', 'dist');
const evidenceRoot = path.join(repositoryRoot, 'test-results', 'task9');
const require = createRequire(import.meta.url);
const { Server: SocketIoServer } = require(path.join(repositoryRoot, 'app', 'node_modules', 'socket.io'));
const socketFixturePort = Number(process.env.UNPACKED_FIXTURE_PORT || 3999);
if (!Number.isInteger(socketFixturePort) || socketFixturePort < 1 || socketFixturePort > 65535) {
  throw new TypeError('UNPACKED_FIXTURE_PORT must be an integer between 1 and 65535');
}

const DEFAULT_ROOM = Object.freeze({
  roomCode: '10000000',
  name: '預設',
  count: 1,
  capacity: 1000,
  visibility: 'public',
  retentionDays: null,
  expiresAt: null,
});

function mark(message) { console.log(`[unpacked-e2e] ${message}`); }

function clone(value) {
  return structuredClone(value);
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server?.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function fixtureHtml(label, { hostile = false } = {}) {
  const hostileCss = hostile ? `
    * { all: unset !important; color: magenta !important; font-size: 2px !important; z-index: 2147483647 !important; }
    html, body { display: block !important; width: 100% !important; min-height: 100% !important; }
    #host-button { display: block !important; position: fixed !important; left: 8px !important; bottom: 8px !important; padding: 20px !important; background: red !important; }
    #danmaku-overlay-extension-host { opacity: .01 !important; pointer-events: auto !important; }
  ` : '';
  return `<!doctype html>
  <html lang="zh-Hant-TW"><head><meta charset="utf-8"><title>${label}</title><style>
    body { margin: 0; min-height: 100vh; background: #eef2f7; font-family: sans-serif; }
    #host-button { margin: 24px; padding: 12px 18px; }
    ${hostileCss}
  </style></head><body>
    <button id="host-button" type="button">${label} 宿主按鈕</button>
    <form><input id="private-field" value="private-form-value"></form>
    <main>${'一般宿主內容'.repeat(120)}</main>
    <script>
      window.hostClicks = 0;
      window.__attack = 0;
      document.querySelector('#host-button').addEventListener('click', () => { window.hostClicks += 1; });
    </script>
  </body></html>`;
}

async function createFixture(label, options) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url || '/');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(fixtureHtml(label, options));
  });
  const address = await listen(server);
  return { server, origin: `http://127.0.0.1:${address.port}`, requests };
}

async function createSocketFixture() {
  const httpServer = createServer((request, response) => {
    if (request.url === '/metrics') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(metrics));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  const io = new SocketIoServer(httpServer, {
    cors: { origin: true, credentials: false },
    transports: ['websocket'],
    allowEIO3: false,
  });
  const rooms = new Map([[DEFAULT_ROOM.roomCode, clone(DEFAULT_ROOM)]]);
  const history = new Map([[DEFAULT_ROOM.roomCode, []]]);
  const metrics = {
    totalConnections: 0,
    activeConnections: 0,
    maxActiveConnections: 0,
    barragePayloads: [],
    ownerUpdates: [],
    ownerDeletes: [],
  };
  let nextMessage = 1;

  io.on('connection', (socket) => {
    metrics.totalConnections += 1;
    metrics.activeConnections += 1;
    metrics.maxActiveConnections = Math.max(metrics.maxActiveConnections, metrics.activeConnections);
    socket.data.roomCode = DEFAULT_ROOM.roomCode;
    socket.on('disconnect', () => { metrics.activeConnections = Math.max(0, metrics.activeConnections - 1); });

    socket.on('room-default', (_payload, ack) => ack({ ok: true, room: clone(DEFAULT_ROOM) }));
    socket.on('join-room', ({ roomCode }, ack) => {
      const room = rooms.get(roomCode);
      if (!room) return ack({ ok: false, error: { code: 'ROOM_NOT_FOUND', scope: 'room', message: '房間不存在' } });
      socket.data.roomCode = roomCode;
      ack({ ok: true, room: clone(room), recentMessages: clone(history.get(roomCode) || []) });
    });
    socket.on('leave-room', (_payload, ack) => {
      socket.data.roomCode = null;
      ack({ ok: true });
    });
    socket.on('room-list-public', (_payload, ack) => ack({
      ok: true,
      rooms: [...rooms.values()].map(clone),
      pagination: { page: 1, pageCount: 1, total: rooms.size },
    }));
    socket.on('room-lookup', ({ roomCode }, ack) => {
      const room = rooms.get(roomCode);
      ack(room
        ? { ok: true, room: { ...clone(room), passwordRequired: false } }
        : { ok: false, error: { code: 'ROOM_NOT_FOUND', scope: 'room', message: '房間不存在' } });
    });
    socket.on('nickname-change', ({ nickname }, ack) => ack({ ok: true, nickname, changeDate: '2026-07-16' }));
    socket.on('barrage', (payload, ack) => {
      metrics.barragePayloads.push(clone(payload));
      const roomCode = socket.data.roomCode || DEFAULT_ROOM.roomCode;
      const message = {
        messageId: `real-${nextMessage++}`,
        roomCode,
        text: payload.text,
        nickname: payload.nickname,
        color: payload.color,
        timestamp: Date.now(),
      };
      const entries = history.get(roomCode) || [];
      entries.push(message);
      history.set(roomCode, entries.slice(-200));
      ack({ ok: true, queued: false, messageId: message.messageId });
      io.emit('barrage', clone(message));
    });
    socket.on('report', (_payload, ack) => ack({ ok: true }));
    socket.on('room-create', (payload, ack) => {
      const room = {
        roomCode: '22222222',
        name: payload.name,
        count: 1,
        capacity: 200,
        visibility: payload.visibility,
        retentionDays: payload.retentionDays,
        expiresAt: '2026-07-23T00:00:00.000Z',
        ownedByClient: true,
      };
      rooms.set(room.roomCode, room);
      history.set(room.roomCode, []);
      socket.data.roomCode = room.roomCode;
      ack({ ok: true, room: clone(room), recentMessages: [], ownerCredential: 'owner-secret-real-e2e' });
    });
    socket.on('room-update', (payload, ack) => {
      metrics.ownerUpdates.push(clone(payload));
      if (payload.ownerCredential !== 'owner-secret-real-e2e') {
        return ack({ ok: false, error: { code: 'OWNER_FORBIDDEN', scope: 'room', message: '憑證錯誤' } });
      }
      const room = rooms.get(payload.roomCode);
      if (!room) return ack({ ok: false, error: { code: 'ROOM_NOT_FOUND', scope: 'room', message: '房間不存在' } });
      const updated = {
        ...room,
        ...(payload.name ? { name: payload.name } : {}),
        ...(payload.visibility ? { visibility: payload.visibility } : {}),
      };
      rooms.set(updated.roomCode, updated);
      ack({ ok: true, room: clone(updated) });
    });
    socket.on('room-delete', (payload, ack) => {
      metrics.ownerDeletes.push(clone(payload));
      if (payload.ownerCredential !== 'owner-secret-real-e2e') {
        return ack({ ok: false, error: { code: 'OWNER_FORBIDDEN', scope: 'room', message: '憑證錯誤' } });
      }
      rooms.delete(payload.roomCode);
      history.delete(payload.roomCode);
      socket.data.roomCode = null;
      ack({ ok: true });
      io.emit('room-deleted', { roomCode: payload.roomCode });
    });
  });

  await listen(httpServer, socketFixturePort);
  return {
    io,
    httpServer,
    metrics,
    rooms,
    async close() {
      await new Promise((resolve) => io.close(resolve));
      await closeServer(httpServer);
    },
  };
}

function overlay(page) {
  return page.locator('#danmaku-overlay-extension-host');
}

async function waitForOverlay(page) {
  await expect(overlay(page)).toHaveCount(1);
  await expect(overlay(page).locator('#floating-ball')).toBeVisible();
}

async function dismissOnboarding(page) {
  const button = overlay(page).locator('#btn-onboarding-ok');
  if (await button.isVisible().catch(() => false)) await button.click();
}

async function openPanel(page) {
  const panel = overlay(page).locator('#panel');
  if (!(await panel.isVisible().catch(() => false))) {
    await overlay(page).locator('#floating-ball').click();
    await expect(panel).toBeVisible();
  }
}

async function openRoomManager(page) {
  await openPanel(page);
  const manager = overlay(page).locator('#room-manager-panel');
  if (!(await manager.isVisible().catch(() => false))) {
    await overlay(page).locator('#room-summary-button').click();
    await expect(manager).toBeVisible();
  }
}

async function serviceWorkerTarget(context, page, extensionId) {
  const session = await context.newCDPSession(page);
  const targets = await session.send('Target.getTargets');
  const target = targets.targetInfos.find((entry) => entry.type === 'service_worker' && entry.url.startsWith(`chrome-extension://${extensionId}/`));
  return { session, target };
}

test('real unpacked MV3 passes multi-origin lifecycle, owner, visibility, and singleton gates', async () => {
  expect(executablePath, 'UNPACKED_CHROMIUM_PATH is required for the genuine release gate').toBeTruthy();
  test.setTimeout(120_000);
  const build = spawnSync(process.execPath, [path.join(repositoryRoot, 'clients', 'web-overlay', 'scripts', 'build.mjs'), 'extension'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, DANMAKU_SERVER_URL: `http://127.0.0.1:${socketFixturePort}` },
  });
  expect(build.status, build.stderr || build.stdout).toBe(0);
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-unpacked-e2e-'));
  const pageErrors = [];
  const consoleErrors = [];
  const pageRequests = [];
  let fixtureA;
  let fixtureB;
  let socketFixture;
  let context;

  try {
    mark('start fixtures');
    fixtureA = await createFixture('Origin A');
    fixtureB = await createFixture('Origin B', { hostile: true });
    socketFixture = await createSocketFixture();
    mark('fixtures ready');
    mark('launch Chromium');
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    mark('Chromium launched');
    await expect.poll(() => context.serviceWorkers().filter((worker) => worker.url().startsWith('chrome-extension://')).length).toBe(1);
    mark('service worker ready');
    const worker = context.serviceWorkers().find((entry) => entry.url().startsWith('chrome-extension://'));
    const extensionId = new URL(worker.url()).host;

    const attachEvidence = (page) => {
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      page.on('request', (request) => pageRequests.push(request.url()));
    };

    expect(socketFixture.metrics.totalConnections).toBe(0);
    let consentPage = context.pages().find((page) => page.url() === `chrome-extension://${extensionId}/options.html`);
    if (!consentPage) {
      consentPage = await context.newPage();
      await consentPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    }
    attachEvidence(consentPage);
    await expect(consentPage.locator('#privacy-consent')).toContainText('隨機裝置識別碼');
    await expect(consentPage.locator('#consent-status')).toContainText('不會建立 Socket 連線');
    expect(socketFixture.metrics.totalConnections).toBe(0);
    await consentPage.locator('#consent-accept').click();
    await expect(consentPage.locator('#consent-status')).toContainText('已同意');
    await expect.poll(() => socketFixture.metrics.totalConnections).toBe(1);
    await consentPage.close();

    for (const initialPage of context.pages()) await initialPage.close();

    const pageA = await context.newPage();
    attachEvidence(pageA);
    mark('navigate active hostile origin');
    await pageA.goto(`${fixtureB.origin}/hostile`, { waitUntil: 'domcontentloaded' });
    await waitForOverlay(pageA);
    await expect.poll(() => socketFixture.metrics.totalConnections).toBe(1);
    expect(socketFixture.metrics.activeConnections).toBe(1);
    expect(socketFixture.metrics.maxActiveConnections).toBe(1);

    const hostileMetrics = await pageA.evaluate(() => {
      const host = document.getElementById('danmaku-overlay-extension-host');
      const ball = host.shadowRoot.getElementById('floating-ball');
      return {
        hostCount: document.querySelectorAll('#danmaku-overlay-extension-host').length,
        hostPointer: getComputedStyle(host).pointerEvents,
        hostOpacity: getComputedStyle(host).opacity,
        ballPointer: getComputedStyle(ball).pointerEvents,
        ballWidth: ball.getBoundingClientRect().width,
        ballFont: getComputedStyle(ball).fontSize,
      };
    });
    expect(hostileMetrics).toMatchObject({ hostCount: 1, hostPointer: 'none', hostOpacity: '1', ballPointer: 'auto' });
    expect(hostileMetrics.ballWidth).toBeGreaterThanOrEqual(50);
    expect(Number.parseFloat(hostileMetrics.ballFont)).toBeGreaterThan(2);
    await dismissOnboarding(pageA);
    await pageA.locator('#host-button').click();
    await expect.poll(() => pageA.evaluate(() => window.hostClicks)).toBe(1);
    await pageA.screenshot({ path: path.join(evidenceRoot, 'unpacked-extension-hostile.png'), fullPage: true });
    mark('hostile CSS verified');

    await openPanel(pageA);
    await overlay(pageA).locator('#btn-settings').click();
    await overlay(pageA).locator('#ball-size').fill('72');
    await overlay(pageA).locator('#ball-size').dispatchEvent('change');
    await expect.poll(() => overlay(pageA).locator('#floating-ball').evaluate((node) => node.getBoundingClientRect().width)).toBe(72);

    await pageA.goto(`${fixtureB.origin}/navigation`, { waitUntil: 'domcontentloaded' });
    await waitForOverlay(pageA);
    await expect.poll(() => socketFixture.metrics.totalConnections).toBe(1);
    await expect.poll(() => overlay(pageA).locator('#floating-ball').evaluate((node) => node.getBoundingClientRect().width)).toBe(72);
    await pageA.evaluate(() => {
      history.pushState({ route: 2 }, '', '/spa/route-two');
      const replacement = document.createElement('body');
      replacement.innerHTML = '<button id="spa-host-button">SPA replacement</button><main>new body</main>';
      document.documentElement.replaceChild(replacement, document.body);
    });
    await expect(overlay(pageA)).toHaveCount(1);
    await expect(overlay(pageA).locator('#floating-ball')).toBeVisible();
    expect(await pageA.evaluate(() => location.pathname)).toBe('/spa/route-two');
    await expect.poll(() => socketFixture.metrics.totalConnections).toBe(1);
    mark('navigation and SPA verified');

    await dismissOnboarding(pageA);
    await openRoomManager(pageA);
    await overlay(pageA).locator('#create-name').fill('真實房主房間');
    await overlay(pageA).locator('#room-create-form').evaluate((form) => form.requestSubmit());
    await expect(overlay(pageA).locator('#room-status')).toHaveText('房間已建立，房主管理能力已安全保存');
    await expect(overlay(pageA).locator('#owner-section')).toBeVisible();
    expect(JSON.stringify(await pageA.evaluate(() => ({ text: document.body.innerText, local: { ...localStorage }, session: { ...sessionStorage } })))).not.toContain('owner-secret-real-e2e');

    await overlay(pageA).locator('#owner-name').fill('真實房主更新');
    await overlay(pageA).locator('#owner-form').evaluate((form) => form.requestSubmit());
    await expect.poll(() => socketFixture.metrics.ownerUpdates.length).toBe(1);
    expect(socketFixture.metrics.ownerUpdates[0].ownerCredential).toBe('owner-secret-real-e2e');
    await expect(overlay(pageA).locator('#room-status')).toHaveText('房間設定已儲存');
    await expect(overlay(pageA).locator('#room-name')).toHaveText('真實房主更新');
    await pageA.screenshot({ path: path.join(evidenceRoot, 'unpacked-extension-owner-flow.png'), fullPage: true });
    mark('owner create/update verified');

    const pageB = await context.newPage();
    attachEvidence(pageB);
    await pageB.goto(`${fixtureA.origin}/second-tab`, { waitUntil: 'domcontentloaded' });
    await waitForOverlay(pageB);
    await dismissOnboarding(pageB);
    await expect(overlay(pageB).locator('#room-name')).toHaveText('真實房主更新');
    await expect.poll(() => overlay(pageB).locator('#floating-ball').evaluate((node) => node.getBoundingClientRect().width)).toBe(72);
    await expect.poll(() => socketFixture.metrics.totalConnections).toBe(1);
    expect(context.serviceWorkers().filter((entry) => entry.url().startsWith(`chrome-extension://${extensionId}/`))).toHaveLength(1);
    mark('two tabs and two origins share one socket');

    const visibilityMessage = {
      messageId: 'visibility-real-e2e',
      roomCode: '22222222',
      text: '<img src=x onerror=window.__attack=1>',
      nickname: '可見性',
      color: '#FFFFFF',
      timestamp: Date.now(),
    };
    socketFixture.io.emit('barrage', visibilityMessage);
    // Both tabs sit in room 22222222 and, under Chromium automation, both report
    // document.visibilityState === 'visible' (a background tab cannot be driven to
    // 'hidden' via CDP/headless/headed here), so both visible instances must render
    // the broadcast and keep the hostile payload inert. Background-tab animation
    // suppression (visibilityState === 'hidden') is exercised against the real
    // content render guard by tests/extension-e2e.spec.mjs and the background unit
    // suite, which can override visibilityState in-world.
    await expect(overlay(pageB).locator('.danmaku[data-message-id="visibility-real-e2e"]')).toHaveCount(1);
    await expect(overlay(pageA).locator('.danmaku[data-message-id="visibility-real-e2e"]')).toHaveCount(1);
    await expect(overlay(pageB).locator('.danmaku[data-message-id="visibility-real-e2e"] .danmaku-text')).toHaveText(visibilityMessage.text);
    expect(await pageB.evaluate(() => window.__attack)).toBe(0);
    expect(await pageA.evaluate(() => window.__attack)).toBe(0);
    mark('multi-instance broadcast and XSS-inert render verified');

    await openPanel(pageB);
    await overlay(pageB).locator('#msg-input').fill('真實 E2E 發送');
    await overlay(pageB).locator('#btn-send').click();
    await expect.poll(() => socketFixture.metrics.barragePayloads.length).toBe(1);
    expect(socketFixture.metrics.barragePayloads[0]).toMatchObject({ text: '真實 E2E 發送' });
    await expect(overlay(pageB).locator('.danmaku .danmaku-text', { hasText: '真實 E2E 發送' })).toHaveCount(1);
    mark('send verified');

    const { session, target } = await serviceWorkerTarget(context, pageB, extensionId);
    expect(target).toBeTruthy();
    // Terminate the background service worker. The dropped socket (active === 0) is
    // the observable proof the worker died; Playwright's ServiceWorker 'close' event
    // is not emitted until a replacement worker spawns on reload, so gating on it
    // here would deadlock before the reload can run.
    await session.send('Target.closeTarget', { targetId: target.targetId });
    await expect.poll(() => socketFixture.metrics.activeConnections).toBe(0);
    await pageB.reload({ waitUntil: 'domcontentloaded' });
    await waitForOverlay(pageB);
    await expect.poll(() => context.serviceWorkers().filter((entry) => entry.url().startsWith(`chrome-extension://${extensionId}/`)).length).toBe(1);
    await expect.poll(() => socketFixture.metrics.totalConnections).toBe(2);
    expect(socketFixture.metrics.maxActiveConnections).toBe(1);
    await dismissOnboarding(pageB);
    await openRoomManager(pageB);
    await expect(overlay(pageB).locator('#room-name')).toHaveText('真實房主更新');
    await expect(overlay(pageB).locator('#owner-section')).toBeVisible();
    mark('service worker restart and owner restore verified');

    pageB.once('dialog', (dialog) => dialog.accept());
    await overlay(pageB).locator('#delete-room-button').click();
    await expect.poll(() => socketFixture.metrics.ownerDeletes.length).toBe(1);
    expect(socketFixture.metrics.ownerDeletes[0].ownerCredential).toBe('owner-secret-real-e2e');
    await expect(overlay(pageB).locator('#room-name')).toHaveText('尚未加入房間');
    mark('delete verified');

    expect(socketFixture.metrics.activeConnections).toBe(1);
    expect(socketFixture.metrics.maxActiveConnections).toBe(1);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    const allowedOrigins = new Set([fixtureA.origin, fixtureB.origin, `chrome-extension://${extensionId}`]);
    for (const requestUrl of pageRequests) expect(allowedOrigins.has(new URL(requestUrl).origin)).toBe(true);
    expect(fixtureA.requests.length).toBeGreaterThan(0);
    expect(fixtureB.requests.length).toBeGreaterThan(0);
    mark('all assertions complete');
  } finally {
    mark('cleanup start');
    await context?.close();
    await socketFixture?.close();
    await closeServer(fixtureA?.server);
    await closeServer(fixtureB?.server);
    fs.rmSync(userDataDir, { recursive: true, force: true });
    mark('cleanup complete');
  }
});
