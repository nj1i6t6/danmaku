import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const sharedCore = path.join(root, 'clients', 'web-overlay', 'src', 'core');
const extensionSource = path.join(root, 'clients', 'web-overlay', 'src', 'extension');
const desktopAppPath = path.join(root, 'desktop', 'frontend', 'js', 'overlay-app.js');

async function importFresh(file) {
  return import(`${pathToFileURL(file).href}?test=${Date.now()}-${Math.random()}`);
}

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('Shared core: send state typed ack、snapshot 與 monotonic deadline', async () => {
  const {
    createSendState, reduceSendState, interpretBarrageAck,
    settleDraft, settleExpiredDraft, remainingMs, describeSendButton,
  } = await importFresh(path.join(sharedCore, 'send-state.js'));

  const ready = createSendState();
  const pending = reduceSendState(ready, { type: 'submit', snapshot: '舊草稿' }, 100);
  const queuedAck = interpretBarrageAck({ ok: true, status: 'queued', messageId: 'm1', position: 3, estimatedWaitMs: 9000 });
  const queued = reduceSendState(pending, { type: 'ack', ack: queuedAck }, 120);
  assert.deepEqual([queued.kind, queued.messageId, queued.position], ['queued', 'm1', 3]);
  assert.equal(remainingMs(queued, 1120), 8000);
  assert.equal(settleDraft('舊草稿', '舊草稿', queuedAck), '');
  assert.equal(settleDraft('送出後的新草稿', '舊草稿', queuedAck), '送出後的新草稿');

  const disconnected = reduceSendState(queued, { type: 'disconnect' }, 130);
  assert.equal(disconnected.canceledSnapshot, '舊草稿');
  const reconnected = reduceSendState(disconnected, { type: 'connect' }, 140);
  assert.equal(reconnected.canceledSnapshot, '舊草稿');
  const sent = interpretBarrageAck({ ok: true, status: 'sent', messageId: 'm2' });
  assert.equal(reduceSendState(disconnected, { type: 'ack', ack: sent }, 150).kind, 'disconnected');
  assert.equal(reduceSendState(reconnected, { type: 'ack', ack: sent }, 150).kind, 'ready');
  assert.deepEqual(reduceSendState(queued, { type: 'room-change' }, 150).canceledSnapshot, '舊草稿');

  const failed = interpretBarrageAck({ ok: false, error: { code: 'COOLDOWN', scope: 'user', message: '請稍候', retryAfterMs: 3000 } });
  const cooldown = reduceSendState(pending, { type: 'ack', ack: failed }, 200);
  assert.match(describeSendButton(cooldown, 1200), /冷卻.*2 秒/);
  assert.deepEqual(settleExpiredDraft('新草稿', '舊草稿'), { draft: '新草稿', retryText: '舊草稿' });
});

test('Shared core: room model 只持久化 roomCode 並安全正規化 metadata', async () => {
  const { normalizeRoom, createJoinedRoomStore, findDefaultRoom, validRoomCode } = await importFresh(path.join(sharedCore, 'room-model.js'));
  assert.equal(validRoomCode('12345678'), true);
  assert.equal(validRoomCode('AB12CD34'), false);
  assert.deepEqual(normalizeRoom({ roomName: '<img onerror=1>', roomCode: '12345678', count: 4, capacity: 50, requiresPassword: true, visibility: 'unlisted', retentionDays: 7, ownedByClient: true }), {
    name: '<img onerror=1>', roomCode: '12345678', count: 4, capacity: 50,
    requiresPassword: true, visibility: 'unlisted', retentionDays: 7, expiresAt: null, ownedByClient: true,
  });
  assert.equal(findDefaultRoom({ data: [{ name: '預設', roomCode: '87654321', count: 1, capacity: 1000, retentionDays: null }] }).roomCode, '87654321');
  let raw = null;
  const storage = { getItem: () => raw, setItem: (_key, value) => { raw = value; } };
  const rooms = createJoinedRoomStore(storage, 'joined-test');
  rooms.add({ roomCode: '12345678', name: '不得保存', password: '不得保存' });
  assert.equal(raw, '["12345678"]');
});

test('Shared core: safe room rendering 只使用 textContent', async () => {
  const { renderRoomName } = await importFresh(path.join(sharedCore, 'safe-render.js'));
  const target = {
    _text: '',
    set textContent(value) { this._text = value; },
    get textContent() { return this._text; },
    set innerHTML(_value) { throw new Error('不得使用 innerHTML'); },
  };
  renderRoomName(target, '<svg onload=alert(1)>');
  assert.equal(target.textContent, '<svg onload=alert(1)>');
});

test('Desktop 與 Extension 都顯示連線／受限狀態且不逐秒重播 live region', () => {
  const desktop = read('desktop/frontend/js/overlay-app.js');
  const content = read('clients/web-overlay/src/extension/content.js');
  assert.match(desktop, /describeSendButton/);
  assert.match(desktop, /announcedKind/);
  assert.match(desktop, /renderSendState\(true\)/);
  assert.match(content, /connectionLabel\(\)/);
  assert.match(content, /send-status/);
  assert.match(content, /aria-disabled/);
});

test('Shared room modal 具備 focus trap 並可逆還原背景 inert', () => {
  const source = read('clients/web-overlay/src/core/room-manager.js');
  assert.match(source, /event\.key !== 'Tab'/);
  assert.match(source, /querySelectorAll\(FOCUSABLE/);
  assert.match(source, /const inertRestoreByModal = new WeakMap\(\);/);
  assert.match(source, /element\.inert = true;/);
  assert.match(source, /for \(const \[element, wasInert\] of previous\) element\.inert = wasInert;/);
});

test('Shared controller 與 Desktop 使用 raw composer revision，queued 中斷不覆蓋新草稿', async () => {
  const source = read('clients/web-overlay/src/core/overlay-controller.js');
  const desktop = read('desktop/frontend/js/overlay-app.js');
  assert.match(source, /snapshot: raw/);
  assert.match(source, /settleDraft\(currentDraft, raw, ack\)/);
  assert.match(source, /settleExpiredDraft/);
  assert.match(desktop, /submitSnapshot\([^;\n]+\.value\);/);
  assert.match(desktop, /submitSnapshot\(snapshot,\s*\{\s*preserveComposer:\s*true\s*\}\)/);

  let resolveAck;
  const controllerModule = await importFresh(path.join(sharedCore, 'overlay-controller.js'));
  const controller = controllerModule.createOverlayController({
    sendBarrage: () => new Promise((resolve) => { resolveAck = resolve; }),
    changeNickname: async () => ({ ok: false, error: { code: 'NOOP', scope: 'nickname', message: 'noop' } }),
    settingsAdapter: {
      load: () => ({ nickname: '匿名', nicknameChangeDate: null, danmaku: { color: '#ffffff' } }),
      save: (value) => value,
      resetAppearance: (value) => value,
    },
    now: () => 100,
  });
  const pending = controller.submit('舊草稿', { currentDraft: '舊草稿' });
  controller.changeRoom();
  resolveAck({ ok: true, status: 'sent', messageId: 'm1' });
  const result = await pending;
  assert.equal(result.appliesToCurrentSubmission, false);
  assert.equal(result.draft, '舊草稿');
});

test('Desktop 與 Extension 使用完整 roomCode／typed ACK contract，無舊 Web client 路徑', () => {
  const desktop = read('desktop/frontend/js/overlay-app.js');
  const background = read('clients/web-overlay/src/extension/background.js');
  const content = read('clients/web-overlay/src/extension/content.js');
  const source = `${desktop}\n${background}\n${content}`;
  for (const event of ['room-default', 'room-create', 'room-lookup', 'room-list-public', 'join-room', 'leave-room', 'room-update', 'room-delete', 'barrage-status']) {
    assert.match(source, new RegExp(event));
  }
  assert.doesNotMatch(source, /emit\(['"]join-room['"],\s*\{\s*symbol/);
  assert.doesNotMatch(source, /app\/public\/js|owner-session/);
});

test('建立房間直接採用 create ack；Extension 背景先保存 credential 才回報管理能力', () => {
  const desktop = read('desktop/frontend/js/overlay-app.js');
  const manager = read('clients/web-overlay/src/core/room-manager.js');
  const background = read('clients/web-overlay/src/extension/background.js');
  assert.match(desktop, /async function createRoom[\s\S]*publishRoom/);
  const createStart = manager.indexOf("roomDocument.getElementById('room-create-form')");
  const createEnd = manager.indexOf("roomDocument.getElementById('owner-visibility')", createStart);
  const createHandler = manager.slice(createStart, createEnd);
  assert.match(createHandler, /await client\.createRoom\(payload\)/);
  assert.doesNotMatch(createHandler, /client\.joinRoom\(/);
  assert.match(background, /await storage\.setOwnerCredential\(room\.roomCode, raw\.ownerCredential\)/);
  assert.match(background, /ownerCapabilitySaved: true/);
});

test('Desktop 與 Extension report 使用 canonical ack，暱稱只在成功 ACK 後保存', () => {
  const desktop = read('desktop/frontend/js/overlay-app.js');
  const content = read('clients/web-overlay/src/extension/content.js');
  const background = read('clients/web-overlay/src/extension/background.js');
  const controller = read('clients/web-overlay/src/core/overlay-controller.js');
  assert.match(desktop, /await emitAck\(['"]report['"]/);
  assert.match(desktop, /if \(result\.ok\)[\s\S]*已送出檢舉/);
  assert.match(content, /send\('report\/create'/);
  assert.match(background, /report\/create['"]\) return emitAck\('report'/);
  assert.match(background, /action === 'nickname\/change'[\s\S]{0,160}emitAck\('nickname-change'/);
  assert.match(controller, /if \(ack\.ok !== true\)/);
  assert.match(controller, /settingsAdapter\.save\(acceptedSettings\)/);
});

test('Extension credential 僅存在 trusted background storage；Desktop 僅經 Rust credential command', () => {
  const content = read('clients/web-overlay/src/extension/content.js');
  const background = read('clients/web-overlay/src/extension/background.js');
  const storage = read('clients/web-overlay/src/extension/storage.js');
  assert.doesNotMatch(content, /ownerCredential/);
  assert.match(background, /storage\.getOwnerCredential/);
  assert.match(background, /storage\.setOwnerCredential/);
  assert.match(storage, /TRUSTED_CONTEXTS/);

  const desktop = read('desktop/frontend/js/overlay-app.js') + read('clients/web-overlay/src/core/room-manager.js');
  assert.doesNotMatch(desktop, /localStorage[^\n]*(owner|credential)|ownerCredential[^\n]*localStorage/i);
  assert.match(desktop, /credential_(?:set|get|delete)/);
  const rust = read('desktop/src-tauri/src/lib.rs');
  assert.match(rust, /credential_set/);
  assert.match(rust, /credential_get/);
  assert.doesNotMatch(rust, /println!\([^\n]*credential/i);
});

test('Extension 只在 top frame 安裝 Overlay；背景維持單一 Socket controller', () => {
  const content = read('clients/web-overlay/src/extension/content.js');
  const background = read('clients/web-overlay/src/extension/background.js');
  assert.match(content, /if \(windowRef\.top !== windowRef\) return null/);
  assert.match(content, /attachShadow\(\{ mode: 'open' \}\)/);
  assert.match(background, /createExtensionBackground/);
  assert.match(background, /const installedControllers = new WeakMap\(\);/);
  assert.match(background, /if \(previous\) await previous\.stop\(\)/);
});

test('Windows 房間面板屬於原生 click-through 互動區域', () => {
  const source = fs.readFileSync(desktopAppPath, 'utf8');
  assert.match(source, /INTERACTIVE_IDS[\s\S]*room-manager-panel/);
});

test('Android 載入預設房時不顯示虛構 roomCode', () => {
  const strings = fs.readFileSync(path.join(root, 'android/app/src/main/res/values/strings.xml'), 'utf8');
  assert.doesNotMatch(strings, /00000000/);
  assert.match(strings, /預設房載入中/);
});

test('Android 以 dedicated default ack 啟動，create ack 不做第二次 join', () => {
  const socket = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuSocketClient.kt'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  assert.match(socket, /room-default/);
  assert.doesNotMatch(service, /listPublicRooms\("預設"/);
  assert.doesNotMatch(service, /joinRoom\(created\.room\.roomCode/);
});

test('Android 成功切換房間時會取消舊房 queued 狀態', () => {
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  assert.match(service, /override fun onJoined[\s\S]*currentRoom\.roomCode != result\.room\.roomCode[\s\S]*sendState\.roomChanged/);
});

test('Android 首次連線才從 persisted room 啟動，reconnect 不重複 join', () => {
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  const initSocket = service.match(/private fun initSocket\(\)[\s\S]*?\n    }/)?.[0] || '';
  assert.doesNotMatch(initSocket, /joinCurrentRoom\(\)/);
  assert.match(service, /override fun onConnect[\s\S]*currentRoom\.roomCode\.isEmpty\(\)[\s\S]*joinCurrentRoom\(\)/);
});

test('Android reconnect join failure is handled and owner password updates reconnect state', () => {
  const socket = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuSocketClient.kt'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  assert.doesNotMatch(socket, /joinRoom\(code, desiredPassword\) \{ \}/);
  assert.match(socket, /fun onReconnectJoinFailed\(roomCode: String, error: SocketError\)/);
  assert.match(socket, /joinRoom\(code, desiredPassword\)[\s\S]*SocketResult\.Failure[\s\S]*onReconnectJoinFailed/);
  assert.match(socket, /passwordAction[\s\S]*desiredPassword/);
  assert.match(service, /override fun onReconnectJoinFailed[\s\S]*handleJoinFailure/);
});

test('Android persisted 密碼房失敗時回預設房，shortcut 重新要求密碼', () => {
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  assert.match(service, /private fun joinCurrentRoom[\s\S]*PASSWORD_REQUIRED[\s\S]*joinDefaultRoom/);
  assert.match(service, /private fun renderJoinedRooms[\s\S]*requiresPassword[\s\S]*room_lookup_btn/);
});

test('Android default discovery retries with a joined-room gate before sending', () => {
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  assert.match(service, /DEFAULT_ROOM_RETRY_MAX/);
  assert.match(service, /scheduleDefaultRoomRetry\(/);
  assert.match(service, /discoverDefaultRoom[\s\S]*scheduleDefaultRoomRetry/);
  assert.match(service, /submitComposer[\s\S]*currentRoom\.roomCode\.isEmpty\(\)/);
});

test('Android explicit room choices invalidate stale default discovery before it can reclaim membership', () => {
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  const discover = service.match(/private fun discoverDefaultRoom[\s\S]*?private fun joinDefaultRoom/)?.[0] || '';
  const joinDefault = service.match(/private fun joinDefaultRoom[\s\S]*?private fun scheduleDefaultRoomRetry/)?.[0] || '';
  const cancel = service.match(/private fun cancelDefaultRoomRecovery[\s\S]*?private fun joinCurrentRoom/)?.[0] || '';
  const joinFromManager = service.match(/private fun joinFromManager[\s\S]*?private fun closeRoomManagement/)?.[0] || '';
  const roomCreation = service.match(/private fun bindRoomCreation[\s\S]*?private fun bindOwnerManagement/)?.[0] || '';
  assert.match(service, /private val defaultRoomRequests = LatestRequestGate\(\)/);
  assert.match(joinDefault, /defaultRoomRequests\.next\(\)/);
  assert.match(discover, /isCurrent: \(\) -> Boolean[\s\S]*if \(!isCurrent\(\)\)/);
  assert.match(cancel, /defaultRoomRequests\.invalidate\(\)[\s\S]*removeCallbacks\(defaultRoomRetry\)[\s\S]*defaultRoomRetryGate\.reset\(\)/);
  assert.match(joinFromManager, /cancelDefaultRoomRecovery\(\)[\s\S]*joinRoom\(/);
  assert.match(roomCreation, /cancelDefaultRoomRecovery\(\)[\s\S]*createRoom\(/);
});

test('Android room list and lookup ignore stale asynchronous responses', () => {
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  const publicRooms = service.match(/private fun bindPublicRooms[\s\S]*?private fun bindRoomLookup/)?.[0] || '';
  const lookup = service.match(/private fun bindRoomLookup[\s\S]*?private fun bindRoomCreation/)?.[0] || '';
  assert.match(publicRooms, /LatestRequestGate\(\)[\s\S]*isCurrent\(/);
  assert.match(publicRooms, /fun resetPublicResults\(\)[\s\S]*requests\.invalidate\(\)[\s\S]*page = 1[\s\S]*totalPages = 1[\s\S]*container\.removeAllViews\(\)/);
  assert.match(publicRooms, /query\.addTextChangedListener\s*\{\s*resetPublicResults\(\)\s*\}/);
  assert.match(publicRooms, /room_public_search_btn\)\.setOnClickListener\s*\{\s*search\(\)\s*\}/);
  assert.match(lookup, /LatestRequestGate\(\)[\s\S]*isCurrent\(/);
  assert.match(lookup, /addTextChangedListener[\s\S]*invalidate\(\)/);
});

test('Android 已加入房間使用可見退出按鈕，退出目前房切回預設房', () => {
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  const socket = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuSocketClient.kt'), 'utf8');
  const start = service.indexOf('private fun renderJoinedRooms');
  const end = service.indexOf('private fun bindPublicRooms', start);
  const render = service.slice(start, end);
  const joinRoom = socket.match(/fun joinRoom[\s\S]*?fun leaveRoom/)?.[0] || '';
  const createRoom = socket.match(/fun createRoom[\s\S]*?fun updateRoom/)?.[0] || '';
  const clearIntent = socket.match(/fun clearDesiredRoomIntent[\s\S]*?fun lookupRoom/)?.[0] || '';
  assert.match(render, /val exitButton = Button\(this\)[\s\S]{0,250}minWidth = dp\(48\)/);
  assert.match(render, /exitJoinedRoom\(root, roomCode/);
  assert.doesNotMatch(render, /setOnLongClickListener/);
  assert.match(service, /private fun exitJoinedRoom[\s\S]{0,2200}RoomExitPolicy\.action/);
  assert.match(service, /private var joiningRoomCode: String\? = null/);
  assert.match(service, /private fun exitJoinedRoom[\s\S]{0,500}if \(joiningRoomCode == roomCode\)[\s\S]{0,300}return/);
  assert.match(service, /private fun joinFromManager[\s\S]{0,500}joiningRoomCode = roomCode[\s\S]{0,1800}joiningRoomCode = null/);
  assert.match(service, /RoomExitAction\.REMOVE_SHORTCUT[\s\S]{0,700}removeJoinedRoom/);
  assert.match(service, /RoomExitAction\.SWITCH_TO_DEFAULT[\s\S]{0,1800}clearDesiredRoomIntent\(\)[\s\S]{0,300}joinedRoomCode = null[\s\S]{0,1000}joinDefaultRoom/);
  assert.doesNotMatch(service, /exitJoinedRoom[\s\S]{0,1800}ownerCredentials\.remove/);
  assert.match(socket, /private val membershipRequests = LatestRequestGate\(\)/);
  assert.match(joinRoom, /membershipRequests\.next\(\)/);
  assert.match(joinRoom, /membershipRequests\.isCurrent\(/);
  assert.doesNotMatch(createRoom, /return@emitTyped/,
    'successful create ACK must reach the service so its one-time owner credential is not lost');
  assert.match(createRoom, /result\(parsed\)/);
  assert.match(clearIntent, /membershipRequests\.invalidate\(\)/);
});

test('Android repeated reconnect errors update state without Toast spam', () => {
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  const onError = service.match(/override fun onConnectionError[\s\S]*?override fun onReconnectJoinFailed/)?.[0] || '';
  assert.match(onError, /connectionNoticeGate\.disconnected\(\)/);
  assert.doesNotMatch(onError, /toast\(/);
});

test('Android service teardown invalidates and clears asynchronous UI work before superclass destruction', () => {
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  const destroy = service.match(/override fun onDestroy\(\)[\s\S]*?override fun onBind/)?.[0] || '';
  assert.match(service, /private fun postIfActive\(/);
  assert.doesNotMatch(service, /mainHandler\.post \{/);
  assert.doesNotMatch(service, /(?:pickerPanel|view|scrollView)\.post\s*\{/);
  assert.match(destroy, /destroyed = true[\s\S]*removeCallbacksAndMessages\(null\)[\s\S]*super\.onDestroy\(\)/);
});

test('Android disconnected composer label takes priority over room membership', () => {
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  const render = service.match(/private fun renderComposerState[\s\S]*?private fun explainSendState/)?.[0] || '';
  const textBlock = render.slice(render.indexOf('val text ='), render.indexOf('val description ='));
  const descriptionBlock = render.slice(render.indexOf('val description ='), render.indexOf('button.text ='));
  for (const block of [textBlock, descriptionBlock]) {
    assert.ok(block.indexOf('state.mode == SendMode.DISCONNECTED') >= 0);
    assert.ok(block.indexOf('state.mode == SendMode.DISCONNECTED') < block.indexOf('!roomReady'));
  }
  assert.match(textBlock, /send_disconnected/);
  assert.match(descriptionBlock, /send_state_disconnected/);
});

test('Android floating-ball delayed click cannot survive detach or service destruction', () => {
  const ball = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/FloatingBallView.kt'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  assert.match(ball, /private val singleClickRunnable = Runnable/);
  assert.match(ball, /handler\.postDelayed\(singleClickRunnable, doubleClickMs\)/);
  assert.doesNotMatch(ball, /\n\s*postDelayed\(\{/);
  assert.match(ball, /onDetachedFromWindow[\s\S]*handler\.removeCallbacksAndMessages\(null\)/);
  for (const callback of ['onSingleClick', 'onDoubleClick', 'onDragged', 'onLongPress']) {
    assert.match(service, new RegExp(`override fun ${callback}\\([^)]*\\) \\{[\\s\\S]{0,120}if \\(destroyed\\) return`));
  }
});

test('Android missing owner credential warns while present credential is durably committed', () => {
  const store = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/OwnerCredentialStore.kt'), 'utf8');
  const model = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/RoomModels.kt'), 'utf8');
  const socket = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuSocketClient.kt'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  assert.match(store, /preferences\.edit\(\)\.putString\(roomCode, packed\)\.commit\(\)/);
  assert.doesNotMatch(store, /putString\(roomCode, packed\)\.apply\(\)/);
  assert.match(model, /CreateRoomResult\(val room: RoomMetadata, val ownerCredential: String\?,/);
  assert.match(socket, /emitTyped\("room-create"[\s\S]{0,200}RoomSocketCodec::createRoom/);
  assert.doesNotMatch(socket, /response\.optString\("ownerCredential"\)/);
  assert.match(service, /ownerCredential\?\.let[\s\S]{0,200}\?: false/);
  assert.doesNotMatch(service, /ownerCredential\?\.let[\s\S]{0,200}\?: true/);
});
test('Android 保留時長有可見標籤、可讀預設值與明確深色選項樣式', () => {
  const layout = fs.readFileSync(path.join(root, 'android/app/src/main/res/layout/room_management_view.xml'), 'utf8');
  const item = fs.readFileSync(path.join(root, 'android/app/src/main/res/layout/room_retention_spinner_item.xml'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  assert.match(layout, /TextView[^>]+android:text="@string\/retention_description"[^>]+android:textColor="#[A-Fa-f0-9]{6}"/);
  assert.match(layout, /Spinner[^>]+android:id="@\+id\/room_retention_spinner"[^>]+android:minHeight="48dp"[^>]+android:popupBackground="#[A-Fa-f0-9]{6}"/);
  assert.match(item, /@android:id\/text1/);
  assert.match(item, /android:textColor="#E6EDF3"/);
  assert.match(item, /android:background="#2A2A35"/);
  assert.match(service, /ArrayAdapter[\s\S]{0,160}R\.layout\.room_retention_spinner_item/);
  assert.match(service, /setDropDownViewResource\(R\.layout\.room_retention_spinner_item\)/);
  assert.doesNotMatch(service, /simple_spinner_dropdown_item/);
  assert.match(service, /retention\.setSelection\(RoomPolicy\.RETENTION_DAYS\.indexOf\(RoomPolicy\.DEFAULT_RETENTION_DAYS\)\)/);
});

test('Android 暱稱設定由 server ACK 控制且發送使用保存值', () => {
  const layout = fs.readFileSync(path.join(root, 'android/app/src/main/res/layout/settings_view.xml'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuSettings.kt'), 'utf8');
  const socket = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuSocketClient.kt'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  assert.match(layout, /@\+id\/settings_nickname_input/);
  assert.match(layout, /@\+id\/settings_nickname_save/);
  assert.match(layout, /@\+id\/settings_nickname_status/);
  assert.match(layout, /settings_nickname_input[^>]+android:imeOptions="actionDone"[^>]+android:maxLength="6"/);
  assert.match(settings, /KEY_NICKNAME/);
  assert.match(settings, /KEY_NICKNAME_CHANGE_DATE/);
  assert.match(settings, /fun getNickname\(/);
  assert.match(settings, /fun saveNicknameChange[\s\S]{0,500}commit\(\)/);
  assert.match(settings, /resetAll[\s\S]{0,900}KEY_NICKNAME[\s\S]{0,300}KEY_NICKNAME_CHANGE_DATE/);
  assert.match(socket, /fun changeNickname[\s\S]{0,500}nickname-change[\s\S]{0,500}changeDate/);
  assert.match(service, /private val nicknameRequests = LatestRequestGate\(\)/);
  assert.match(service, /private var nicknameRequestPending = false/);
  assert.match(service, /saveNicknameChange/);
  assert.match(service, /currentNickname = DanmakuSettings\.getNickname\(this\)/);
  assert.match(service, /sendBarrage\(snapshot, currentNickname/);
  assert.doesNotMatch(service, /sendBarrage\(snapshot, getString\(R\.string\.anonymous\)/);
});

test('Android nickname ACK survives panel replacement without mutating detached views', () => {
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  const bindStart = service.indexOf('private fun bindNicknameSettings');
  const bindEnd = service.indexOf('private fun closeSettings', bindStart);
  const bind = service.slice(bindStart, bindEnd);
  const close = service.slice(bindEnd, service.indexOf('// --- 拖曳功能', bindEnd));
  assert.match(service, /private val nicknameRequests = LatestRequestGate\(\)/);
  assert.match(service, /private var nicknameRequestPending = false/);
  assert.doesNotMatch(bind, /val requests = LatestRequestGate\(\)/);
  assert.match(bind, /nicknameRequests\.next\(\)/);
  assert.match(bind, /nicknameRequests\.isCurrent\(/);
  assert.match(bind, /nicknameRequestPending = true/);
  assert.match(bind, /settingsView\?\.let[\s\S]{0,700}renderNicknameSettings/,
    'ACK must render only the currently attached settings view');
  assert.doesNotMatch(close, /nicknameRequests\.invalidate\(\)/,
    'closing a panel must not discard a server-authoritative nickname ACK');
});

test('Android Overlay 可用 Done 或浮窗內點空白收鍵盤且不關面板', () => {
  const roomLayout = fs.readFileSync(path.join(root, 'android/app/src/main/res/layout/room_management_view.xml'), 'utf8');
  const settingsLayout = fs.readFileSync(path.join(root, 'android/app/src/main/res/layout/settings_view.xml'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  for (const id of ['room_create_name', 'room_create_password', 'room_join_password']) {
    assert.match(roomLayout, new RegExp(`${id}[^>]+android:imeOptions="actionDone"`));
  }
  assert.match(settingsLayout, /settings_nickname_input[^>]+android:imeOptions="actionDone"/);
  assert.match(service, /InputMethodManager/);
  assert.match(service, /EditorInfo\.IME_ACTION_DONE/);
  assert.match(service, /private fun hideKeyboardAndClearFocus/);
  assert.match(service, /private fun bindDoneAction[\s\S]{0,800}setOnEditorActionListener/);
  assert.match(service, /bindRoomCreation[\s\S]{0,1200}bindDoneAction\(name\)[\s\S]{0,200}bindDoneAction\(password\)/);
  assert.match(service, /bindRoomLookup[\s\S]{0,4200}bindDoneAction\(code\)[\s\S]{0,300}bindDoneAction\(password\)/);
  assert.match(service, /bindNicknameSettings[\s\S]{0,4200}bindDoneAction\(input\)/);
  const dispatch = service.match(/override fun dispatchTouchEvent[\s\S]*?override fun onInterceptTouchEvent/)?.[0] || '';
  assert.match(dispatch, /ACTION_DOWN[\s\S]*findFocus\(\)[\s\S]*shouldDismissIme[\s\S]*hideKeyboardAndClearFocus/);
  assert.match(dispatch, /return super\.dispatchTouchEvent\(event\)/);
  const roomPanel = service.match(/private fun showRoomManagement[\s\S]*?private fun renderJoinedRooms/)?.[0] || '';
  const settingsPanel = service.match(/private fun showSettings[\s\S]*?private fun bindNicknameSettings/)?.[0] || '';
  assert.match(roomPanel, /softInputMode = WindowManager\.LayoutParams\.SOFT_INPUT_ADJUST_RESIZE/);
  assert.match(settingsPanel, /softInputMode = WindowManager\.LayoutParams\.SOFT_INPUT_ADJUST_RESIZE/);
});

test('Android composer announces pending and queued transitions without hiding status from accessibility', () => {
  const layout = fs.readFileSync(path.join(root, 'android/app/src/main/res/layout/panel_view.xml'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  assert.doesNotMatch(layout, /panel_send_status[\s\S]{0,300}importantForAccessibility="no"/);
  assert.match(service, /ComposerAccessibilityPolicy\.shouldAnnounce\(/);
});

test('Android 房間管理會向 TalkBack 宣告結果並說明翻頁邊界', () => {
  const layout = fs.readFileSync(path.join(root, 'android/app/src/main/res/layout/room_management_view.xml'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');
  assert.doesNotMatch(layout, /room_page_status[^>]+importantForAccessibility="no"/);
  assert.match(layout, /room_page_status[^>]+accessibilityLiveRegion="polite"/);
  assert.match(service, /room_prev_btn[\s\S]*isEnabled/);
  assert.match(service, /room_next_btn[\s\S]*stateDescription/);
});

test('Windows 與 Android 懸浮球可由鍵盤或輔助科技啟用', async () => {
  const { OVERLAY_TEMPLATE } = await importFresh(path.join(sharedCore, 'overlay-template.js'));
  const desktop = fs.readFileSync(path.join(root, 'desktop/frontend/js/overlay-app.js'), 'utf8');
  assert.match(OVERLAY_TEMPLATE, /<button[^>]+id="floating-ball"[^>]+type="button"[^>]+aria-label="[^"]+"/);
  assert.match(desktop, /floating-ball[\s\S]*addEventListener\('click'[\s\S]*event\.detail === 0[\s\S]*togglePanel/);

  const ball = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/FloatingBallView.kt'), 'utf8');
  const strings = fs.readFileSync(path.join(root, 'android/app/src/main/res/values/strings.xml'), 'utf8');
  assert.match(ball, /isClickable = true/);
  assert.match(ball, /isFocusable = true/);
  assert.match(ball, /IMPORTANT_FOR_ACCESSIBILITY_YES/);
  assert.match(ball, /contentDescription = context\.getString\(R\.string\.floating_ball_description/);
  assert.match(ball, /override fun performClick\(\)[\s\S]*listener\.onSingleClick/);
  assert.match(strings, /name="floating_ball_description"/);
});

test('Windows 內建 Socket.IO bundle，離線啟動不依賴 CDN', () => {
  const html = fs.readFileSync(path.join(root, 'desktop/frontend/index.html'), 'utf8');
  assert.doesNotMatch(html, /cdn\.socket\.io/);
  assert.match(html, /vendor\/socket\.io\.min\.js/);
  assert.equal(fs.existsSync(path.join(root, 'desktop/frontend/vendor/socket.io.min.js')), true);
});
