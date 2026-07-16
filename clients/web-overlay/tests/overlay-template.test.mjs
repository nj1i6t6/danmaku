import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERLAY_TEMPLATE,
  OVERLAY_TEMPLATE_IDS,
} from '../src/core/overlay-template.js';
import { APPEARANCE_LIMITS } from '../src/core/settings-contract.js';

const requiredIds = [
  'danmaku-stage',
  'floating-ball',
  'panel',
  'history-panel',
  'settings-panel',
  'room-manager-panel',
  'onboarding',
  'toast',
  'hsv-picker-dialog',
];

test('overlay template is trusted static markup with one complete UI tree', () => {
  assert.deepEqual(OVERLAY_TEMPLATE_IDS, requiredIds);
  for (const id of requiredIds) {
    const matches = OVERLAY_TEMPLATE.match(new RegExp(`id=["']${id}["']`, 'g')) || [];
    assert.equal(matches.length, 1, `${id} must occur exactly once`);
  }
  assert.doesNotMatch(OVERLAY_TEMPLATE, /<script\b|\son[a-z]+\s*=|\$\{/i);
  assert.match(OVERLAY_TEMPLATE, /aria-modal="true"/);
  assert.match(OVERLAY_TEMPLATE, /aria-live="polite"/);
});

test('overlay template settings ranges match the shared appearance contract', () => {
  const range = (id) => OVERLAY_TEMPLATE.match(new RegExp(`<input[^>]+id=["']${id}["'][^>]*>`))?.[0] || '';
  for (const [id, limits] of [
    ['ball-size', APPEARANCE_LIMITS.ballSize],
    ['dm-size', APPEARANCE_LIMITS.danmakuSize],
    ['input-size', APPEARANCE_LIMITS.inputSize],
  ]) {
    const markup = range(id);
    assert.match(markup, new RegExp(`min=["']${limits[0]}["']`));
    assert.match(markup, new RegExp(`max=["']${limits[1]}["']`));
  }
});

test('三個顏色設定使用可鍵盤操作的 shared HSV trigger 與靜態 dialog', () => {
  assert.doesNotMatch(OVERLAY_TEMPLATE, /<input[^>]+type=["']color["']/i);
  for (const target of ['ball', 'danmaku', 'input']) {
    const triggerId = `${target === 'danmaku' ? 'dm' : target}-color-trigger`;
    const trigger = OVERLAY_TEMPLATE.match(new RegExp(`<button[^>]+id=["']${triggerId}["'][^>]*>[\\s\\S]*?</button>`))?.[0] || '';
    assert.match(trigger, /type=["']button["']/);
    assert.match(trigger, /aria-controls=["']hsv-picker-dialog["']/);
    assert.match(trigger, new RegExp(`data-color-target=["']${target}["']`));
  }
  assert.equal((OVERLAY_TEMPLATE.match(/id=["']hsv-picker-dialog["']/g) || []).length, 1);
  assert.match(OVERLAY_TEMPLATE, /<[^>]+id=["']hsv-picker-dialog["'][^>]+role=["']dialog["']/);
  assert.match(OVERLAY_TEMPLATE, /aria-labelledby=["']hsv-picker-title["']/);
  for (const id of ['hsv-hue', 'hsv-saturation', 'hsv-value', 'hsv-picker-preview', 'hsv-picker-hex', 'hsv-picker-cancel', 'hsv-picker-apply']) {
    assert.match(OVERLAY_TEMPLATE, new RegExp(`id=["']${id}["']`), `${id} must be in the static dialog`);
  }
});

test('settings template exposes a semantic nickname form with a live status region', () => {
  assert.match(OVERLAY_TEMPLATE, /<form[^>]+id=["']nickname-form["']/);
  assert.match(OVERLAY_TEMPLATE, /<label[^>]+for=["']nickname-input["']/);
  assert.match(OVERLAY_TEMPLATE, /<input[^>]+id=["']nickname-input["'][^>]+maxlength=["']6["']/);
  assert.match(OVERLAY_TEMPLATE, /<button[^>]+id=["']nickname-save["'][^>]+type=["']submit["']/);
  assert.match(OVERLAY_TEMPLATE, /<[^>]+id=["']nickname-status["'][^>]+role=["']status["'][^>]+aria-live=["']polite["']/);
  for (const id of ['nickname-form', 'nickname-input', 'nickname-save', 'nickname-status']) {
    assert.equal((OVERLAY_TEMPLATE.match(new RegExp(`id=["']${id}["']`, 'g')) || []).length, 1, `${id} must occur exactly once`);
  }
});
