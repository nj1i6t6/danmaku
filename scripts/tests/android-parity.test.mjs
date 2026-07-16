import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);
const read = async (path) => readFile(new URL(path, ROOT), 'utf8');

const files = await Promise.all([
  read('android/app/build.gradle.kts'),
  read('android/app/src/main/java/com/kolvid/danmaku/DanmakuSocketClient.kt'),
  read('android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'),
  read('android/app/src/main/java/com/kolvid/danmaku/DanmakuSettings.kt'),
  read('android/app/src/main/java/com/kolvid/danmaku/RoomModels.kt'),
  read('android/app/src/main/java/com/kolvid/danmaku/OwnerCredentialStore.kt'),
  read('android/app/src/main/res/layout/settings_view.xml'),
  read('android/app/src/main/res/layout/color_picker_panel.xml'),
  read('android/app/src/main/res/layout/panel_view.xml'),
]);

const [gradle, socket, service, settings, rooms, credentials, settingsXml, pickerXml, panelXml] = files;

test('Android endpoint is build-configured and fails closed instead of silently using the hosted service', () => {
  assert.match(gradle, /providers\.gradleProperty\("danmakuServerUrl"\)/);
  assert.match(gradle, /environmentVariable\("DANMAKU_SERVER_URL"\)/);
  assert.match(gradle, /buildConfigField\("String",\s*"DANMAKU_SERVER_URL"/);
  assert.match(gradle, /https:\/\/example\.invalid/);
  assert.match(gradle, /require\(danmakuServerUri\.scheme == "https"\)/);
  assert.match(socket, /IO\.socket\(BuildConfig\.DANMAKU_SERVER_URL, options\)/);
  assert.doesNotMatch(socket, /danmaku\.kolvid\.app/);
});

test('Android release signing is opt-in and reads exactly four environment variables', () => {
  assert.match(gradle, /providers\.environmentVariable\(name\)/);
  for (const name of [
    'DANMAKU_RELEASE_STORE_FILE',
    'DANMAKU_RELEASE_STORE_PASSWORD',
    'DANMAKU_RELEASE_KEY_ALIAS',
    'DANMAKU_RELEASE_KEY_PASSWORD',
  ]) assert.ok(gradle.includes(`"${name}"`), `missing ${name}`);
  assert.match(gradle, /releaseSigningValues\.values\.all\s*\{\s*!it\.isNullOrBlank\(\)\s*\}/);
  for (const name of [
    'DANMAKU_RELEASE_STORE_FILE',
    'DANMAKU_RELEASE_STORE_PASSWORD',
    'DANMAKU_RELEASE_KEY_ALIAS',
    'DANMAKU_RELEASE_KEY_PASSWORD',
  ]) assert.match(gradle, new RegExp(`requireNotNull\\(releaseSigningValues\\["${name}"\\]\\)`));
  assert.match(gradle, /signingConfigs\s*\{[\s\S]*create\("release"\)/);
  assert.match(gradle, /storeFile\s*=\s*file\(releaseSigningStoreFile\)/);
  assert.match(gradle, /storePassword\s*=\s*releaseSigningStorePassword/);
  assert.match(gradle, /keyAlias\s*=\s*releaseSigningKeyAlias/);
  assert.match(gradle, /keyPassword\s*=\s*releaseSigningKeyPassword/);
  assert.match(gradle, /if\s*\(releaseSigningConfigured\)\s*signingConfig\s*=\s*signingConfigs\.getByName\("release"\)/);
  assert.equal(gradle.includes('gradleProperty("DANMAKU_RELEASE_'), false);
  assert.doesNotMatch(gradle, /DANMAKU_RELEASE_(?:STORE_FILE|STORE_PASSWORD|KEY_ALIAS|KEY_PASSWORD)\s*=\s*["'`]/);
});

test('Android retains server-compatible message, nickname, and history bounds', () => {
  assert.match(panelXml, /android:maxLength="100"/);
  assert.match(settingsXml, /android:maxLength="6"/);
  assert.match(service, /historyMessages\.size > 200/);
});

test('Android settings defaults, ranges, and minimum opacity remain aligned', () => {
  for (const expected of [
    'DEFAULT_BALL_SIZE = 56',
    'DEFAULT_BALL_OPACITY = 0.9f',
    'DEFAULT_DM_SIZE = 20f',
    'DEFAULT_DM_OPACITY = 0.9f',
    'DEFAULT_INPUT_SIZE = 16f',
    'DEFAULT_INPUT_OPACITY = 0.8f',
    'DEFAULT_PANEL_WIDTH = 320',
  ]) assert.ok(settings.includes(expected), `missing ${expected}`);
  assert.match(settingsXml, /settings_ball_size[\s\S]*android:max="96"[\s\S]*android:progress="56"/);
  assert.match(settingsXml, /settings_dm_size[\s\S]*android:max="48"[\s\S]*android:progress="20"/);
  assert.match(settingsXml, /settings_input_size[\s\S]*android:max="32"[\s\S]*android:progress="16"/);
  assert.equal((service.match(/progress\.coerceAtLeast\(10\) \/ 100f/g) ?? []).length, 3);
});

test('HSV picker has explicit cancel and apply behavior without committing preview state', () => {
  assert.match(pickerXml, /@\+id\/color_picker_cancel/);
  assert.match(pickerXml, /@\+id\/color_picker_apply/);
  assert.match(service, /cancelButton\.setOnClickListener[\s\S]*resetPicker\(\)[\s\S]*View\.GONE/);
  assert.match(service, /applyButton\.setOnClickListener[\s\S]*onColorApplied\(committedColor\)/);
});

test('nickname uses typed acknowledgement and a Taipei-day change rule', () => {
  assert.match(socket, /emitTyped\("nickname-change"/);
  assert.match(socket, /NicknameChangeResult/);
  assert.match(socket, /changeDate\.matches/);
  assert.match(service, /NicknamePolicy\.canChange\(currentNicknameChangeDate\)/);
  assert.match(service, /saveNicknameChange/);
});

test('room exit remains visible and current-room exit falls back to the default room', () => {
  assert.match(service, /val exitButton = Button\(this\)/);
  assert.match(service, /R\.string\.exit_room/);
  assert.match(rooms, /RoomExitAction\.SWITCH_TO_DEFAULT/);
  assert.match(service, /RoomExitAction\.SWITCH_TO_DEFAULT[\s\S]*joinDefaultRoom/);
});

test('owner credential is durable, reset-preserved, and supplied to owner commands', () => {
  assert.match(credentials, /AndroidKeyStore/);
  assert.match(credentials, /AES\/GCM\/NoPadding/);
  assert.match(credentials, /\.commit\(\)/);
  assert.doesNotMatch(settings, /danmaku_owner_credentials_encrypted|KEY_OWNER_CREDENTIAL/);
  assert.match(service, /ownerCredentials\.put\(created\.room\.roomCode, credential\)/);
  assert.match(service, /updateRoom\(request, credential\)/);
  assert.match(service, /deleteRoom\(currentRoom\.roomCode, credential\)/);
  assert.match(socket, /put\("ownerCredential", ownerCredential\)/);
});
