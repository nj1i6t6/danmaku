import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const configPath = path.join(desktopDir, 'src-tauri', 'tauri.conf.json');
const htmlPath = path.join(desktopDir, 'frontend', 'index.html');
const appPath = path.join(desktopDir, 'frontend', 'js', 'overlay-app.js');
const rustPath = path.join(desktopDir, 'src-tauri', 'src', 'lib.rs');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}


test('桌面 dev/build hooks 先在 shared client 產生 generated bundle', () => {
  const config = readJson(configPath);
  assert.equal(config.build.devUrl, undefined);
  assert.equal(config.build.frontendDist, '../frontend');
  assert.deepEqual(config.build.beforeBuildCommand, {
    cwd: '../../clients/web-overlay',
    script: 'npm run build:desktop',
  });
  assert.deepEqual(config.build.beforeDevCommand, {
    cwd: '../../clients/web-overlay',
    script: 'npm run build:desktop',
    wait: true,
  });
  assert.equal(
    path.resolve(path.dirname(configPath), config.build.beforeBuildCommand.cwd),
    path.resolve(here, '..', '..', 'clients', 'web-overlay'),
  );
});

test('純靜態前端使用 Tauri 全域 API，不載入無效的 CDN 目錄頁', () => {
  const config = readJson(configPath);
  const html = fs.readFileSync(htmlPath, 'utf8');
  const appSource = fs.readFileSync(appPath, 'utf8');

  assert.equal(config.app.withGlobalTauri, true);
  assert.doesNotMatch(html, /unpkg\.com\/@tauri-apps\//);
  assert.doesNotMatch(appSource, /import\(['"]@tauri-apps\/api\//);
});

test('桌面入口使用 generated shared settings adapter，不保留複製 contract', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(source, /createDesktopSettingsAdapter/);
  assert.match(source, /const settingsAdapter = createDesktopSettingsAdapter\(localStorage\)/);
  assert.doesNotMatch(source, /const DEFAULTS\s*=|function clamp\(/);
});

test('Desktop client identity 在 OS keyring 失敗時使用 process-local fallback', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(source, /\bcreateClientIdProvider\b/);
  assert.match(source, /const clientIdProvider = createClientIdProvider\(/);
  assert.match(source, /async function getStableClientId\(\)[\s\S]{0,120}clientIdProvider\.get\(\)/);
});

test('browser-dev credential adapter 不得把 owner credential no-op 假稱 durable', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  const start = source.indexOf('async function secureSet');
  const end = source.indexOf('async function secureDelete', start);
  const secureSet = source.slice(start, end);

  assert.notEqual(start, -1);
  assert.match(secureSet, /key === 'client-id'[\s\S]*browserSessionClientId = value[\s\S]*return/);
  assert.match(secureSet, /throw new Error\([^)]*(?:credential|vault|安全儲存)/i);
});

test('browser-dev owner credential delete 不得以 no-op 假稱 durable', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  const start = source.indexOf('async function secureDelete');
  const end = source.indexOf('const clientIdProvider', start);
  const secureDelete = source.slice(start, end);

  assert.notEqual(start, -1);
  assert.match(secureDelete, /if \(!tauriAvailable\)/);
  assert.match(secureDelete, /key === 'client-id'[\s\S]*browserSessionClientId = null[\s\S]*return/);
  assert.match(secureDelete, /throw new Error\([^)]*(?:credential|vault|安全儲存)/i);
});

test('桌面 Socket endpoint 由 generated build-time constant 提供', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(source, /\bDANMAKU_SERVER_URL\b/);
  assert.match(source, /io\(DANMAKU_SERVER_URL,/);
  assert.doesNotMatch(source, /const SERVER_URL|wss:\/\/danmaku\.kolvid\.app/);
});

test('Tauri base CSP permits only the default loopback Socket endpoint', () => {
  const csp = readJson(configPath).app.security.csp;
  for (const origin of [
    'http://127.0.0.1:3999',
    'ws://127.0.0.1:3999',
  ]) assert.match(csp, new RegExp(origin.replace(/[.:/]/g, '\\$&')));
  assert.doesNotMatch(csp, /danmaku\.kolvid\.app/);
  assert.doesNotMatch(csp, /connect-src[^;]*(?:https:|wss:)\s/);
});

test('桌面 send-state 與 room model 由 generated shared bundle 提供', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(source, /\bcreateOverlayController\b/);
  assert.match(source, /\bnormalizeRoom\b/);
  assert.doesNotMatch(source, /from ['"]\.\/send-state\.js['"]|from ['"]\.\/room-model\.js['"]/);
});

test('桌面 room manager 由 generated shared bundle 提供', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.doesNotMatch(source, /from ['"]\.\/room-manager\.js['"]/);
  assert.match(source, /\binitRoomManager\b/);
});

test('桌面樣式由 generated shared CSS 提供', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /href="generated\/overlay\.css"/);
  assert.doesNotMatch(html, /href="css\/overlay\.css"/);
});

test('桌面 runtime 從 generated shared template 掛載唯一 UI tree', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(html, /<main id="overlay-root"><\/main>/);
  assert.doesNotMatch(html, /id="floating-ball"|id="room-manager-panel"/);
  assert.match(source, /\bmountOverlay\b/);
  const mainStart = source.indexOf('async function main()');
  const initTauri = source.indexOf('await initTauri()', mainStart);
  const mount = source.indexOf("mountOverlay(document, document.getElementById('overlay-root'))", mainStart);
  assert.ok(mount > mainStart && mount < initTauri, 'shared template must mount before UI initialization');
});

test('桌面 send lifecycle 委派 shared overlay controller', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(source, /createOverlayController\(/);
  assert.doesNotMatch(source, /\blet sendState\b|\breduceSendState\(/);
  assert.match(source, /if \(result\.appliesToCurrentSubmission\)[\s\S]{0,160}input\.value = result\.draft/);
});

test('房間刪除與主動離開都會取消當前 submission 並恢復草稿', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  const deletedStart = source.indexOf("socket.on('room-deleted'");
  const deletedEnd = source.indexOf("socket.on('barrage'", deletedStart);
  const deletedHandler = source.slice(deletedStart, deletedEnd);
  const leaveStart = source.indexOf('async function leaveRoom');
  const leaveEnd = source.indexOf('function restoreCanceledSnapshot', leaveStart);
  const leaveHandler = source.slice(leaveStart, leaveEnd);
  assert.notEqual(deletedStart, -1);
  assert.notEqual(leaveStart, -1);
  assert.match(deletedHandler, /handleRoomChange\(\)/);
  assert.match(leaveHandler, /handleRoomChange\(\)/);
});

test('Desktop composer 只有成功 publish room 後才解鎖', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  const publishStart = source.indexOf('function publishRoom');
  const publishEnd = source.indexOf('async function joinDefaultRoom', publishStart);
  const connectStart = source.indexOf("socket.on('connect'");
  const connectEnd = source.indexOf("socket.on('disconnect'", connectStart);
  const deletedStart = source.indexOf("socket.on('room-deleted'");
  const deletedEnd = source.indexOf("socket.on('barrage'", deletedStart);
  const leaveStart = source.indexOf('async function leaveRoom');
  const leaveEnd = source.indexOf('function restoreCanceledSnapshot', leaveStart);
  assert.match(source.slice(publishStart, publishEnd), /overlayController\.connect\(\)/);
  assert.doesNotMatch(source.slice(connectStart, connectEnd), /overlayController\.connect\(\)/);
  assert.match(source.slice(deletedStart, deletedEnd), /overlayController\.disconnect\(\)/);
  assert.match(source.slice(leaveStart, leaveEnd), /overlayController\.disconnect\(\)/);
});

test('桌面 reconnect 與 explicit room operations 使用 generation gate 阻擋 stale ACK', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(source, /createRoomTransitionGate/);
  assert.match(source, /const roomTransitions = createRoomTransitionGate\(\)/);
  assert.match(source, /socket\.on\('connect',[\s\S]{0,180}roomTransitions\.begin\(\)/);
  assert.match(source, /async function joinRoom[\s\S]{0,180}roomTransitions\.begin\(\)/);
  assert.match(source, /async function createRoom[\s\S]{0,180}roomTransitions\.begin\(\)/);
  assert.match(source, /return \{ \.\.\.result, roomTransitionApplied \}/);
  assert.match(source, /socket\.on\('disconnect',[\s\S]{0,180}roomTransitions\.begin\(\)/);
  assert.match(source, /roomTransitions\.isCurrent\(/);
});

test('Desktop 將同一 Socket 的 membership commands 序列化', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(source, /\bcreateRoomCommandQueue\b/);
  assert.match(source, /const roomCommands = createRoomCommandQueue\(\)/);
  assert.match(source, /roomCommands\.run\(\(\) => emitAck\(event, payload\)\)/);
  for (const event of ['join-room', 'room-create', 'leave-room']) {
    assert.match(source, new RegExp(`emitRoomCommand\\('${event}'`));
    assert.doesNotMatch(source, new RegExp(`emitAck\\('${event}'`), `${event} bypasses the room command queue`);
  }
});

test('初次 default room ACK timeout 會重試且不搶走手動房間操作', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  const retryStart = source.indexOf('function scheduleDefaultRoomRetry');
  const retryEnd = source.indexOf('async function initSocket', retryStart);
  const recovery = source.slice(retryStart, retryEnd);
  const connectStart = source.indexOf("socket.on('connect'");
  const connectEnd = source.indexOf("socket.on('disconnect'", connectStart);
  const connect = source.slice(connectStart, connectEnd);
  const createStart = source.indexOf('async function createRoom');
  const createEnd = source.indexOf('async function initSocket', createStart);
  const joinStart = source.indexOf('async function joinRoom');
  const joinEnd = source.indexOf('async function leaveRoom', joinStart);

  assert.notEqual(retryStart, -1);
  assert.match(recovery, /ACK_TIMEOUT/);
  assert.match(recovery, /setTimeout\(/);
  assert.match(recovery, /joinDefaultRoom\(/);
  assert.match(connect, /scheduleDefaultRoomRetry\(/);
  assert.match(source.slice(createStart, createEnd), /cancelDefaultRoomRetry\(\)/);
  assert.match(source.slice(joinStart, joinEnd), /cancelDefaultRoomRetry\(\)/);
});

test('歷史列表不把伺服器資料插入 innerHTML 模板', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.doesNotMatch(source, /item\.innerHTML\s*=\s*`/);
});

test('桌面 Socket.IO 直接使用 WebSocket，避免 Tauri origin 的 polling CORS 失敗', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(source, /transports:\s*\[\s*['"]websocket['"]\s*\]/);
});

test('輸入欄顏色、大小與透明度設定會實際套用', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(source, /function applyInputSettings\(\)/);
  assert.match(source, /function applyAllSettings\(\)\s*\{[\s\S]*applyInputSettings\(\)/);
});

test('桌面輸入欄大小使用 shared appearance range，不另行截斷', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(source, /\bAPPEARANCE_LIMITS\b/);
  assert.match(source, /APPEARANCE_LIMITS\.inputSize/);
  assert.doesNotMatch(source, /Math\.min\(24,/);
});

test('桌面主面板與子面板使用 shared viewport-aware positioning', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(source, /\bpositionAdjacentOverlay\b/);
  assert.match(source, /function showAdjacentPanel\(/);
  assert.match(source, /togglePanel[\s\S]{0,500}showAdjacentPanel\(panel\)/);
  assert.match(source, /btn-history[\s\S]{0,500}showAdjacentPanel\(hist, document\.getElementById\('panel'\)\)/);
  assert.match(source, /btn-settings[\s\S]{0,500}showAdjacentPanel\(sett, document\.getElementById\('panel'\)\)/);
  assert.doesNotMatch(source, /rect\.right \+ 8/);
});

test('click-through 由原生游標監測與 DOM 互動區域共同控制', () => {
  const appSource = fs.readFileSync(appPath, 'utf8');
  const rustSource = fs.readFileSync(rustPath, 'utf8');

  assert.match(appSource, /set_interactive_regions/);
  assert.match(appSource, /MutationObserver/);
  assert.match(appSource, /ResizeObserver/);
  assert.doesNotMatch(appSource, /setIgnoreCursorEvents\(true\)/);
  assert.match(rustSource, /fn monitor_cursor_regions/);
  assert.match(rustSource, /cursor_position\(\)/);
  assert.match(rustSource, /inner_position\(\)/);
});

test('Desktop HSV picker shared runtime wiring source contract (DOM harness unavailable)', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(source, /\bcreateColorDraft\b/);
  assert.match(source, /\bhexToHsv\b/);
  assert.match(source, /\bhsvToHex\b/);
  assert.match(source, /const INTERACTIVE_IDS = \[[^\]]*['"]hsv-picker-dialog['"]/);
  assert.match(source, /const colorDrafts = new Map\(\)/);
  assert.match(source, /function initColorPicker\(\)/);
  assert.match(source, /function syncColorControls\(\)/);
  assert.doesNotMatch(source, /getElementById\(['"](?:ball|dm|input)-color['"]\)/);
});

test('Desktop HSV preview/cancel/apply semantics source contract (DOM harness unavailable)', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  const start = source.indexOf('const COLOR_TARGETS =');
  const end = source.indexOf('// ============================================================\n// 設定 UI', start + 1);
  const picker = source.slice(start, end === -1 ? source.length : end);
  assert.notEqual(start, -1);
  assert.match(picker, /createColorDraft\(color/);
  assert.match(picker, /draft\.preview\(/);
  assert.match(picker, /hsvToHex\(/);
  assert.match(picker, /hexToHsv\(/);
  assert.match(picker, /draft\.cancel\(\)/);
  assert.match(picker, /hsv-picker-cancel[\s\S]*closeColorPicker\(\)/);
  assert.match(picker, /draft\.apply\(\)/);
  assert.match(picker, /saveSettings\(settings\)/);
  assert.match(picker, /applyColorAppearance\(target\)/);
  const previewStart = picker.indexOf('function updateColorPreview');
  const previewEnd = picker.indexOf('function ', previewStart + 1);
  assert.doesNotMatch(picker.slice(previewStart, previewEnd === -1 ? picker.length : previewEnd), /saveSettings\(/);
  assert.match(picker, /Escape[\s\S]*closeColorPicker\(\)/);
  assert.match(picker, /trigger\?\.focus\(\)/);
});
