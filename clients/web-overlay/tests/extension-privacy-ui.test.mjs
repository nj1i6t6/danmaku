import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '..', 'src', 'extension');
const disclosure = '彈幕 Overlay 會處理暱稱、彈幕訊息、隨機裝置識別碼、房間憑證及連線 IP，以提供聊天室、房間管理及防止濫用功能。擴充功能不會讀取或傳送目前網頁內容。';
const privacyUrl = 'https://github.com/nj1i6t6/danmaku/blob/main/PRIVACY.md';

function read(name) {
  return fs.readFileSync(path.join(extensionRoot, name), 'utf8');
}

test('popup presents explicit privacy consent before normal controls', () => {
  const html = read('popup.html');
  const script = read('popup.js');
  assert.match(html, new RegExp(disclosure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /id="privacy-consent"/);
  assert.match(html, /id="consent-accept"[^>]*>同意並開始使用</);
  assert.match(html, /id="consent-decline"[^>]*>暫不同意</);
  assert.match(html, new RegExp(`href="${privacyUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(script, /send\('privacy\/consent'/);
  assert.match(script, /send\('privacy\/revoke'/);
  assert.match(script, /privacyConsent/);
});

test('options page exposes consent state, policy and withdrawal control', () => {
  const html = read('options.html');
  const script = read('options.js');
  assert.match(html, new RegExp(disclosure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /id="privacy-consent"/);
  assert.match(html, /id="consent-accept"[^>]*>同意並開始使用</);
  assert.match(html, /id="consent-decline"[^>]*>暫不同意</);
  assert.match(html, /id="consent-revoke"[^>]*>撤回同意並中斷連線</);
  assert.match(html, new RegExp(`href="${privacyUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(script, /updateConsent\('privacy\/consent'\)/);
  assert.match(script, /updateConsent\('privacy\/revoke'\)/);
  assert.match(script, /privacyConsent/);
});
