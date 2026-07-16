import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..', '..', '..');
const publicRoot = path.join(repositoryRoot, 'app', 'public');
const evidenceRoot = path.join(repositoryRoot, 'test-results', 'task9');
const githubReleases = 'https://github.com/nj1i6t6/danmaku/releases';
const repository = 'https://github.com/nj1i6t6/danmaku';
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

let browser;
let server;
let origin;

function startFixture() {
  return new Promise((resolve, reject) => {
    server = createServer((request, response) => {
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

      const pathname = request.url === '/' ? '/index.html' : new URL(request.url, 'http://fixture.invalid').pathname;
      const relative = pathname.replace(/^\/+/, '');
      const target = path.resolve(publicRoot, relative);
      if (!target.startsWith(`${publicRoot}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        response.statusCode = 404;
        response.end('not found');
        return;
      }
      response.setHeader('Content-Type', contentTypes.get(path.extname(target).toLowerCase()) || 'application/octet-stream');
      fs.createReadStream(target).pipe(response);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      origin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

test.beforeAll(async () => {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  await startFixture();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
});

test.afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

for (const width of [320, 768, 1024, 1440]) {
  test(`landing is responsive, local-only, and error-free at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const consoleErrors = [];
    const pageErrors = [];
    const requests = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => requests.push(request.url()));

    const response = await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    expect(response?.status()).toBe(200);
    await expect(page.locator('#static-service-note')).toHaveText('純前端頁面');
    await expect(page.locator('h1')).toContainText('彈幕');
    await expect(page.locator('.platform-card')).toHaveCount(5);

    const layout = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      mainLeft: document.querySelector('main')?.getBoundingClientRect().left,
      mainRight: document.querySelector('main')?.getBoundingClientRect().right,
      language: document.documentElement.lang,
      headings: [...document.querySelectorAll('h1,h2,h3')].map((node) => node.tagName),
      interactive: document.querySelectorAll('a[href],button:not(:disabled),input,select,textarea,[tabindex]:not([tabindex="-1"])').length,
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.mainLeft).toBeGreaterThanOrEqual(0);
    expect(layout.mainRight).toBeLessThanOrEqual(width + 1);
    expect(layout.language).toBe('zh-Hant-TW');
    expect(layout.headings[0]).toBe('H1');
    expect(layout.interactive).toBe(16);

    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('skip-link'))).toBe(true);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(requests.length).toBeGreaterThanOrEqual(4);
    for (const requestUrl of requests) expect(new URL(requestUrl).origin).toBe(origin);
    expect(requests.some((requestUrl) => /\/healthz|\/socket\.io\//.test(new URL(requestUrl).pathname))).toBe(false);

    await page.screenshot({ path: path.join(evidenceRoot, `landing-${width}.png`), fullPage: true });
    await page.close();
  });
}

test('landing exposes only local static assets and no backend request', async () => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  const audit = await page.evaluate(() => ({
    scripts: [...document.scripts].map((node) => node.src),
    styles: [...document.querySelectorAll('link[rel="stylesheet"]')].map((node) => node.href),
    bodyText: document.body.innerText,
    hasInlineScript: [...document.scripts].some((node) => !node.src && node.textContent.trim()),
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.content,
    viewport: document.querySelector('meta[name="viewport"]')?.content,
    githubReleases: document.querySelector('[data-platform="android"] a.entry-button')?.href,
    repository: document.querySelector('.configurable-link a[href]')?.href,
    browserButtonsDisabled: [...document.querySelectorAll('[data-platform="chrome"] button, [data-platform="edge"] button')].every((button) => button.disabled),
  }));
  expect(audit.scripts).toEqual([`${origin}/status.js`]);
  expect(audit.styles).toEqual([`${origin}/style.css`]);
  expect(audit.hasInlineScript).toBe(false);
  expect(audit.bodyText).not.toMatch(/聊天室輸入|TradingView|股票搜尋/);
  expect(audit.title).toBe('彈幕 Overlay');
  expect(audit.description).toContain('Android');
  expect(audit.viewport).toContain('width=device-width');
  expect(audit.githubReleases).toBe(githubReleases);
  expect(audit.repository).toBe(repository);
  expect(audit.browserButtonsDisabled).toBe(true);
  await page.close();
});
