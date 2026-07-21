'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createServer } = require('../server');

const RELEASE_ROOT = 'https://github.com/nj1i6t6/danmaku/releases/download/v1.0.3';
const ANDROID_DOWNLOAD = `${RELEASE_ROOT}/danmaku-overlay-android-0.1.3.apk`;
const WINDOWS_DOWNLOAD = `${RELEASE_ROOT}/danmaku-overlay_0.1.0_x64-setup.exe`;
const MACOS_DOWNLOAD = `${RELEASE_ROOT}/danmaku-overlay_0.1.0_aarch64.dmg`;
const EXTENSION_DOWNLOAD = `${RELEASE_ROOT}/danmaku-overlay-extension-1.0.0.zip`;
const CHROME_STORE = 'https://chromewebstore.google.com/detail/aodgflcajjcogogdmondjccplikngddi';
const REPOSITORY = 'https://github.com/nj1i6t6/danmaku';
const SITE_ORIGIN = 'https://danmaku.kolvid.app';
const OG_IMAGE = `${SITE_ORIGIN}/icons/og.png`;
const PRIVACY_DOC = `${REPOSITORY}/blob/main/PRIVACY.md`;
const SECURITY_DOC = `${REPOSITORY}/blob/main/SECURITY.md`;
const TERMS_DOC = `${REPOSITORY}/blob/main/TERMS-OF-SERVICE.md`;
const LICENSE_DOC = `${REPOSITORY}/blob/main/LICENSE`;
const SCHEMA_ORG = 'https://schema.org';
const ALLOWED_LANDING_URLS = new Set([
  SCHEMA_ORG,
  `${SITE_ORIGIN}/`,
  OG_IMAGE,
  ANDROID_DOWNLOAD,
  WINDOWS_DOWNLOAD,
  MACOS_DOWNLOAD,
  EXTENSION_DOWNLOAD,
  CHROME_STORE,
  REPOSITORY,
  PRIVACY_DOC,
  SECURITY_DOC,
  TERMS_DOC,
  LICENSE_DOC,
]);

function request(url, { method = 'GET', headers = {}, body, timeoutMs = 2_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout: ${method} ${url}`)));
    req.once('error', reject);
    req.end(body);
  });
}

async function withService(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-landing-'));
  const service = createServer({
    dbPath: path.join(dir, 'test.db'),
    port: 0,
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    const address = await service.listen();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('healthz returns only the minimal non-cacheable service status', async () => {
  await withService(async (url) => {
    const response = await request(`${url}/healthz`);

    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(response.body), { status: 'ok' });
    assert.deepEqual(Object.keys(JSON.parse(response.body)), ['status']);
  });
});

test('retired Web stock and owner-session HTTP entry points return 404 before parsing requests or preflights', async () => {
  await withService(async (url) => {
    const retiredPaths = [`/api/${'search'}`, `/symbols${'.json'}`, '/api/owner-session'];
    const preflightHeaders = {
      Origin: `chrome-extension://${'a'.repeat(32)}`,
      'Access-Control-Request-Method': 'POST',
    };
    const responses = await Promise.all([
      ...retiredPaths.flatMap((retiredPath) => [
        request(`${url}${retiredPath}?retired=1`),
        request(`${url}${retiredPath}/?retired=1`, { method: 'OPTIONS', headers: preflightHeaders }),
        request(`${url}${retiredPath}%2F`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        }),
      ]),
      request(`${url}/api/${'search'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
    ]);

    assert.deepEqual(responses.map((response) => response.status), Array(responses.length).fill(404));
    for (const response of responses) assert.equal(response.headers['set-cookie'], undefined);
  });
});

test('landing responses use a local-only CSP that cannot be framed', async () => {
  await withService(async (url) => {
    const response = await request(`${url}/`);
    const csp = response.headers['content-security-policy'];

    assert.equal(response.status, 200);
    assert.ok(csp);
    assert.doesNotMatch(csp, /unsafe-inline|tradingview|(?:^|\s)https:|(?:^|\s)wss:/i);
    for (const directive of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
      assert.match(csp, new RegExp(`(?:^|;\\s*)${directive.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(?:;|$)`));
    }
  });
});

test('root is a minimal local-only Overlay landing page with an exact asset allowlist', async () => {
  await withService(async (url) => {
    const response = await request(`${url}/`);
    const externalUrls = [...response.body.matchAll(/\bhttps?:\/\/[^"'\s<]+/gi)].map((match) => match[0]);

    assert.equal(response.status, 200);
    assert.match(response.body, /<title>彈幕 Overlay｜/);
    assert.match(response.body, /rel="canonical"[^>]*href="https:\/\/danmaku\.kolvid\.app\/"/);
    assert.match(response.body, /property="og:image"[^>]*content="https:\/\/danmaku\.kolvid\.app\/icons\/og\.png"/);
    assert.match(response.body, /name="twitter:card"[^>]*content="summary_large_image"/);
    assert.match(response.body, /type="application\/ld\+json"/);
    assert.match(response.body, /"@type":\s*"SoftwareApplication"/);
    for (const platform of ['Android', 'Windows', 'macOS', 'Chrome', 'Edge']) {
      assert.match(response.body, new RegExp(platform));
    }
    assert.match(response.body, /id="static-service-note"/);
    assert.match(response.body, /安裝時[^<]*HTTP[^<]*HTTPS[^<]*網站權限/);
    assert.match(response.body, /只[^<]*Overlay[^<]*不讀取[^<]*上傳[^<]*宿主頁面/);
    assert.deepEqual(
      [...response.body.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/gi)].map((match) => match[1]),
      ['/style.css'],
    );
    assert.deepEqual(
      [...response.body.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*>/gi)].map((match) => match[1]),
      ['/status.js'],
    );
    assert.doesNotMatch(response.body, /socket\.io|tradingview|api\/search|symbols\.json|股票搜尋|看盤|<iframe|<object|<embed|manifest\.webmanifest|\/js\//i);
    assert.ok(
      externalUrls.every((href) => ALLOWED_LANDING_URLS.has(href)),
      `unexpected external URL: ${externalUrls.filter((href) => !ALLOWED_LANDING_URLS.has(href)).join(', ')}`,
    );
    for (const required of [
      ANDROID_DOWNLOAD,
      WINDOWS_DOWNLOAD,
      MACOS_DOWNLOAD,
      EXTENSION_DOWNLOAD,
      CHROME_STORE,
      REPOSITORY,
      PRIVACY_DOC,
      SECURITY_DOC,
      TERMS_DOC,
      LICENSE_DOC,
      OG_IMAGE,
      SCHEMA_ORG,
    ]) {
      assert.ok(externalUrls.includes(required), `missing required URL: ${required}`);
    }
    assert.doesNotMatch(
      response.body,
      /<script\b(?![^>]*(?:\bsrc=|type=["']application\/ld\+json["']))|\sstyle=/i,
    );
  });
});

test('landing exposes five platform entries and keeps unconfigured destinations disabled', async () => {
  await withService(async (url) => {
    const response = await request(`${url}/`);

    assert.equal(response.status, 200);
    assert.deepEqual(
      [...response.body.matchAll(/data-platform="([^"]+)"/g)].map((match) => match[1]),
      ['android', 'windows', 'macos', 'chrome', 'edge'],
    );
    assert.match(response.body, new RegExp(`data-android-download="${ANDROID_DOWNLOAD.replaceAll('.', '\\.')}"`));
    assert.match(response.body, new RegExp(`data-windows-download="${WINDOWS_DOWNLOAD.replaceAll('.', '\\.')}"`));
    assert.match(response.body, new RegExp(`data-macos-download="${MACOS_DOWNLOAD.replaceAll('.', '\\.')}"`));
    assert.match(response.body, new RegExp(`data-extension-download="${EXTENSION_DOWNLOAD.replaceAll('.', '\\.')}"`));
    assert.doesNotMatch(response.body, /data-github-releases=/);
    assert.match(response.body, new RegExp(`data-chrome-store="${CHROME_STORE.replaceAll('.', '\\.')}"`));
    assert.match(response.body, /data-edge-store=""/);
    assert.match(response.body, /data-link-key="chromeStore"/);
    assert.match(response.body, /CHROME WEB STORE/);
    assert.match(response.body, new RegExp(`data-repository="${REPOSITORY}"`));
    assert.equal([...response.body.matchAll(/<button\b[^>]*\bdisabled\b/g)].length, 7);
    assert.doesNotMatch(response.body, /href=""/i);
    assert.match(response.body, new RegExp(PRIVACY_DOC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(response.body, new RegExp(SECURITY_DOC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(response.body, new RegExp(TERMS_DOC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(response.body, new RegExp(LICENSE_DOC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(response.body, /id="privacy"/);
    assert.match(response.body, /id="security"/);
    assert.match(response.body, /id="terms"/);
    assert.match(response.body, /id="license"/);
  });
});

test('landing script hydrates local configuration without backend or network requests', async () => {
  await withService(async (url) => {
    const response = await request(`${url}/status.js`);
    const fetchCalls = [];
    const downloads = { dataset: { androidDownload: '', windowsDownload: '', macosDownload: '', chromeStore: '', edgeStore: '', repository: '' } };
    const context = {
      document: {
        getElementById: (id) => (id === 'downloads' ? downloads : null),
        querySelectorAll: () => [],
      },
      fetch: async (...args) => {
        fetchCalls.push(args);
        throw new Error('landing must not fetch');
      },
    };

    assert.equal(response.status, 200);
    vm.runInNewContext(response.body, context);
    assert.equal(fetchCalls.length, 0);
    assert.doesNotMatch(response.body, /\bfetch\s*\(|\/healthz|socket\.io|new\s+WebSocket/i);
  });
});

test('landing link hydration accepts only HTTPS destinations and hardens external anchors', async () => {
  await withService(async (url) => {
    const response = await request(`${url}/status.js`);
    const makeWrapper = (linkKey) => ({
      dataset: { linkKey },
      control: {
        className: 'entry-button is-pending',
        dataset: { linkLabel: `open ${linkKey}` },
        textContent: `pending ${linkKey}`,
      },
      querySelector(selector) { return selector === 'button' ? this.control : null; },
      replaceChildren(child) { this.child = child; },
    });
    const android = makeWrapper('androidDownload');
    const windows = makeWrapper('windowsDownload');
    const macos = makeWrapper('macosDownload');
    const repository = makeWrapper('repository');
    const chrome = makeWrapper('chromeStore');
    const edge = makeWrapper('edgeStore');
    const downloads = {
      dataset: {
        androidDownload: ANDROID_DOWNLOAD,
        windowsDownload: WINDOWS_DOWNLOAD,
        macosDownload: MACOS_DOWNLOAD,
        repository: REPOSITORY,
        chromeStore: CHROME_STORE,
        edgeStore: '',
      },
    };
    const context = {
      URL,
      document: {
        getElementById: (id) => (id === 'downloads' ? downloads : null),
        querySelectorAll: () => [android, windows, macos, repository, chrome, edge],
        createElement: () => ({}),
      },
    };

    vm.runInNewContext(response.body, context);
    assert.equal(android.child.href, ANDROID_DOWNLOAD);
    assert.equal(windows.child.href, WINDOWS_DOWNLOAD);
    assert.equal(macos.child.href, MACOS_DOWNLOAD);
    assert.equal(android.child.target, '_blank');
    assert.equal(android.child.rel, 'noopener noreferrer');
    assert.equal(android.child.className, 'entry-button');
    assert.equal(android.child.textContent, 'open androidDownload');
    assert.equal(repository.child.href, REPOSITORY);
    assert.equal(repository.child.target, '_blank');
    assert.equal(repository.child.rel, 'noopener noreferrer');
    assert.equal(chrome.child.href, CHROME_STORE);
    assert.equal(chrome.child.target, '_blank');
    assert.equal(chrome.child.rel, 'noopener noreferrer');
    assert.equal(edge.child, undefined);
  });
});

test('Cloudflare Pages headers preserve the static-only landing boundary', () => {
  const headers = fs.readFileSync(path.resolve(__dirname, '..', 'public', '_headers'), 'utf8');
  assert.match(headers, /^\/\*$/m);
  assert.match(headers, /Content-Security-Policy:\s*default-src 'self';[^\n]*connect-src 'none';[^\n]*object-src 'none';[^\n]*frame-ancestors 'none';[^\n]*form-action 'none'/);
  assert.match(headers, /X-Content-Type-Options:\s*nosniff/);
  assert.match(headers, /Referrer-Policy:\s*strict-origin-when-cross-origin/);
  assert.match(headers, /Permissions-Policy:\s*camera=\(\), microphone=\(\), geolocation=\(\)/);
  const csp = headers.split('\n').find((line) => line.includes('Content-Security-Policy:')) || '';
  assert.doesNotMatch(csp, /https?:\/\/|\*/);
});

test('removed service worker source is not publicly served', async () => {
  await withService(async (url) => {
    const response = await request(`${url}/sw.js`);
    assert.equal(response.status, 404);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  });
});

test('public metadata and package configuration describe only the Overlay service', async () => {
  const appRoot = path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  const lockJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package-lock.json'), 'utf8'));
  const envExample = fs.readFileSync(path.resolve(appRoot, '..', '.env.example'), 'utf8');

  assert.equal(packageJson.name, 'danmaku-overlay-backend');
  assert.match(packageJson.description, /Overlay backend/i);
  assert.equal(lockJson.name, packageJson.name);
  assert.equal(lockJson.packages[''].name, packageJson.name);
  assert.match(envExample, /^EXTENSION_ORIGINS=$/m);
  assert.match(envExample, /chrome-extension:\/\/\[a-p\]\{32\}/);

  await withService(async (url) => {
    const [robots, sitemap] = await Promise.all([
      request(`${url}/robots.txt`),
      request(`${url}/sitemap.xml`),
    ]);
    assert.equal(robots.status, 200);
    assert.match(robots.body, /^Sitemap: https:\/\/danmaku\.kolvid\.app\/sitemap\.xml$/m);
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.body, /<loc>https:\/\/danmaku\.kolvid\.app\/<\/loc>/);
    assert.match(sitemap.body, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
    assert.deepEqual([...robots.body.matchAll(/^Allow:\s*(.+)$/gm)].map((match) => match[1]), ['/']);
    assert.equal([...sitemap.body.matchAll(/<loc>/g)].length, 1);
  });
});

test('landing serves a local Open Graph image asset', async () => {
  await withService(async (url) => {
    const response = await request(`${url}/icons/og.png`);
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'] || '', /image\/png/);
    assert.ok(Buffer.byteLength(response.body, 'binary') > 1000);
  });
});
