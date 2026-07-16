import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.resolve(here, '..', '..', '..', 'desktop', 'frontend', 'js', 'overlay-app.js');
const source = fs.readFileSync(appPath, 'utf8');

test('desktop wires nickname changes through the typed ACK adapter and saved settings', () => {
  assert.match(source, /changeNickname:\s*\(nickname\)\s*=>\s*emitAck\('nickname-change',\s*\{\s*nickname\s*\}\)/);
  assert.doesNotMatch(source, /currentDraft:\s*input\.value,[\s\S]{0,120}nickname:\s*['"]匿名['"]/);
  assert.match(source, /overlayController\.changeNickname\(nickname/);
  assert.match(source, /nicknameInput\.value\s*=\s*String\(settings\.nickname/);
});

test('desktop nickname UI disables both controls while pending and renders durable/server failures', () => {
  assert.match(source, /nicknameInput\.disabled\s*=\s*pending/);
  assert.match(source, /nicknameSave\.disabled\s*=\s*pending/);
  assert.match(source, /result\.error\?\.message/);
  assert.match(source, /result\.durable\s*===\s*false/);
  assert.match(source, /syncNicknameUi\(\)/);
});

test('desktop reset path resynchronizes the saved nickname instead of clearing it', () => {
  assert.match(source, /settings\s*=\s*overlayController\.resetAppearance\(\);[\s\S]{0,180}syncSettingsUi\(\)/);
  assert.match(source, /function syncSettingsUi\(\)[\s\S]{0,700}syncNicknameUi\(\)/);
});
