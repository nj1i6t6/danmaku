import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPEARANCE_DEFAULTS, APPEARANCE_LIMITS, TEXT_LIMITS } from '../src/core/settings-contract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const settingsKt = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuSettings.kt'), 'utf8');
const settingsXml = fs.readFileSync(path.join(root, 'android/app/src/main/res/layout/settings_view.xml'), 'utf8');
const panelXml = fs.readFileSync(path.join(root, 'android/app/src/main/res/layout/panel_view.xml'), 'utf8');
const serviceKt = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/kolvid/danmaku/DanmakuOverlayService.kt'), 'utf8');

test('shared defaults 與 Android DanmakuSettings 常數一致', () => {
  const expected = [
    ['DEFAULT_BALL_COLOR', APPEARANCE_DEFAULTS.ball.color],
    ['DEFAULT_BALL_SIZE', APPEARANCE_DEFAULTS.ball.size],
    ['DEFAULT_DM_COLOR', APPEARANCE_DEFAULTS.danmaku.color],
    ['DEFAULT_DM_SIZE', APPEARANCE_DEFAULTS.danmaku.size],
    ['DEFAULT_INPUT_COLOR', APPEARANCE_DEFAULTS.input.color],
    ['DEFAULT_INPUT_SIZE', APPEARANCE_DEFAULTS.input.size],
    ['DEFAULT_PANEL_WIDTH', APPEARANCE_DEFAULTS.panel.width],
    ['DEFAULT_PANEL_HEIGHT', APPEARANCE_DEFAULTS.panel.height],
  ];
  for (const [name, value] of expected) {
    assert.match(settingsKt, new RegExp(`const val ${name} = ${typeof value === 'string' ? `"${value}"` : `${value}(?:\\.0f)?`}`));
  }
});

test('shared ranges、訊息、暱稱與歷史上限對齊 Android contract', () => {
  const seek = (id, [minimum, maximum]) => {
    const block = settingsXml.match(new RegExp(`<SeekBar[\\s\\S]{0,300}android:id="@\\+id/${id}"[\\s\\S]{0,300}?>`))?.[0] || '';
    assert.match(block, new RegExp(`android:min="${minimum}"`));
    assert.match(block, new RegExp(`android:max="${maximum}"`));
  };
  seek('settings_ball_size', APPEARANCE_LIMITS.ballSize);
  seek('settings_dm_size', APPEARANCE_LIMITS.danmakuSize);
  seek('settings_input_size', APPEARANCE_LIMITS.inputSize);
  seek('settings_panel_width', APPEARANCE_LIMITS.panelWidth);
  assert.deepEqual(TEXT_LIMITS, { message: 100, nickname: 6, history: 200 });
  const nicknameInput = settingsXml.match(/<EditText[\s\S]*?settings_nickname_input[\s\S]*?\/>/)?.[0] || '';
  assert.match(nicknameInput, new RegExp(`android:maxLength="${TEXT_LIMITS.nickname}"`));
  const composer = panelXml.match(/<EditText[\s\S]*?panel_msg_input[\s\S]*?\/>/)?.[0] || '';
  assert.match(composer, new RegExp(`android:maxLength="${TEXT_LIMITS.message}"`));
  assert.match(serviceKt, new RegExp(`historyMessages\\.size\\s*>\\s*${TEXT_LIMITS.history}`));
});
