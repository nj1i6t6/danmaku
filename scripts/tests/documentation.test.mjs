import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);
const read = async (relative) => readFile(new URL(relative, ROOT), 'utf8');

const LICENSE_SHA256 = '05a907829bd5b950017f82ce1f5f97a1d7886c8f8a139fd5040ab7ac75f233de';

test('custom LICENSE is preserved byte-for-byte', async () => {
  const license = await readFile(new URL('LICENSE', ROOT));
  assert.equal(createHash('sha256').update(license).digest('hex'), LICENSE_SHA256);
});

test('README documents platform, verification, public export, and CI boundaries without fake release links', async () => {
  const source = await read('README.md');
  for (const pattern of [
    /source-available.*不是 OSI open source/s,
    /Chrome／Edge.*Manifest V3/s,
    /npm test --prefix app/,
    /testDebugUnitTest lintDebug assembleDebug/,
    /verify-public-tree\.mjs --source \./,
    /export-public\.mjs --output/,
    /GitHub-hosted Windows、macOS、Browser Extension 與 Android workflows/,
    /不使用部署／服務秘密；Android release workflow 只使用受保護 environment 中的四個 signing secrets/,
  ]) assert.match(source, pattern);
  assert.doesNotMatch(source, /https?:\/\/\S*(?:chromewebstore|microsoftedge|addons\.microsoft|releases\/download)/i);
});

test('self-hosting guide makes endpoint, proxy, database, extension origin, and exporter boundaries explicit', async () => {
  const source = await read('docs/self-hosting.md');
  for (const pattern of [
    /DANMAKU_SERVER_URL=https:\/\/danmaku\.example\.org/,
    /-PdanmakuServerUrl=https:\/\/danmaku\.example\.org/,
    /EXTENSION_ORIGINS=chrome-extension:\/\//,
    /127\.0\.0\.1:3999/,
    /X-Forwarded-Proto/,
    /StateDirectory=stock-danmaku/,
    /mode `0600`/,
    /npm run tauri:build --prefix clients\/web-overlay/,
    /PUBLIC-SOURCE-MANIFEST\.json/,
    /不會 `git init`、建立 repository、push、發布或部署/,
  ]) assert.match(source, pattern);
});

test('privacy, security, permission, and architecture docs describe the implemented trust boundaries', async () => {
  const privacy = await read('PRIVACY.md');
  const security = await read('SECURITY.md');
  const permissions = await read('docs/extension-permissions.md');
  const architecture = await read('docs/architecture.md');

  assert.match(privacy, /不讀取、上傳或分析宿主頁面正文、表單、輸入框、cookie、localStorage 或網址參數/);
  assert.match(privacy, /owner credential.*background／可信 extension context/s);
  assert.match(security, /Security → Advisories → Report a vulnerability/);
  assert.match(security, /content script 與 background 邊界/);
  assert.match(permissions, /http:\/\/\*\/\*/);
  assert.match(permissions, /https:\/\/\*\/\*/);
  assert.match(permissions, /禁止：[\s\S]*讀取或上傳正文、DOM 內容、表單、輸入框/);
  assert.match(permissions, /TRUSTED_CONTEXTS/);
  assert.match(architecture, /Extension 全部分頁只有一條背景 Socket/);
  assert.match(architecture, /Public verifier 拒絕額外檔案、symlink escape/);
});
