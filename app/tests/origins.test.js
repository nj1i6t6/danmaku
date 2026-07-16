'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isAllowedOrigin, isTauriOrigin, parseExtensionOrigins } = require('../origins');

const EXTENSION_A = `chrome-extension://${'a'.repeat(32)}`;
const EXTENSION_P = `chrome-extension://${'p'.repeat(32)}`;

test('origins allow native and Tauri clients but reject browser development origins by default', () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin('', 3000), true);
  for (const origin of [
    'http://tauri.localhost',
    'https://tauri.localhost',
    'tauri://localhost',
  ]) {
    assert.equal(isAllowedOrigin(origin, 3000), true, origin);
  }
  for (const origin of [
    'http://localhost',
    'http://localhost:80',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]) {
    assert.equal(isAllowedOrigin(origin, 3000), false, origin);
  }
  assert.equal(isAllowedOrigin('https://danmaku.kolvid.app', 3000), false);
});

test('local browser origins require an explicit development opt-in', () => {
  for (const origin of [
    'http://localhost',
    'http://localhost:80',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]) {
    assert.equal(isAllowedOrigin(origin, 3000, new Set(), true), true, origin);
  }
});

test('Tauri platform classification uses the same exact origins as the allowlist', () => {
  for (const origin of ['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost']) {
    assert.equal(isAllowedOrigin(origin, 3000), true, origin);
    assert.equal(isTauriOrigin(origin), true, origin);
  }
  for (const origin of ['https://tauri.localhost.attacker.example', 'http://localhost:3000', undefined]) {
    assert.equal(isTauriOrigin(origin), false, String(origin));
  }
});

test('origins allow only explicitly injected extension origins', () => {
  const configured = parseExtensionOrigins(` ${EXTENSION_A},${EXTENSION_P} `);

  assert.deepEqual([...configured], [EXTENSION_A, EXTENSION_P]);
  assert.equal(isAllowedOrigin(EXTENSION_A, 3000, configured), true);
  assert.equal(isAllowedOrigin(EXTENSION_P, 3000, configured), true);
  assert.equal(isAllowedOrigin(`chrome-extension://${'b'.repeat(32)}`, 3000, configured), false);
  assert.equal(isAllowedOrigin(EXTENSION_A, 3000), false);
});

test('extension origin parser rejects malformed or partial origins instead of widening access', () => {
  assert.deepEqual([...parseExtensionOrigins('')], []);
  for (const value of [
    `chrome-extension://${'q'.repeat(32)}`,
    `chrome-extension://${'A'.repeat(32)}`,
    `${EXTENSION_A}/`,
    `${EXTENSION_A},`,
    `https://${'a'.repeat(32)}`,
    'chrome-extension://short',
  ]) {
    assert.throws(() => parseExtensionOrigins(value), /invalid EXTENSION_ORIGINS/i, value);
  }
  assert.throws(() => parseExtensionOrigins([EXTENSION_A]), /EXTENSION_ORIGINS must be a string/i);
});

test('origins reject suffix spoofing and non-allowlisted browser sources', () => {
  for (const origin of [
    'https://danmaku.kolvid.app.attacker.example',
    'https://tauri.localhost.attacker.example',
    'http://localhost.attacker.example:3000',
    'https://evil.example',
  ]) {
    assert.equal(isAllowedOrigin(origin, 3000), false, origin);
  }
});
