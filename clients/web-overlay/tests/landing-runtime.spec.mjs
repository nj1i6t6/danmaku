import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..', '..', '..');
const publicRoot = path.join(repositoryRoot, 'app', 'public');
const artifactRoot = path.join(repositoryRoot, '.task-artifacts');
const indexSource = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
const styleSource = fs.readFileSync(path.join(publicRoot, 'style.css'), 'utf8');
const statusSource = fs.readFileSync(path.join(publicRoot, 'status.js'), 'utf8');
const releaseRoot = 'https://github.com/nj1i6t6/danmaku/releases/download/v1.0.3';
const androidDownload = `${releaseRoot}/danmaku-overlay-android-0.1.3.apk`;
const windowsDownload = `${releaseRoot}/danmaku-overlay_0.1.0_x64-setup.exe`;
const macosDownload = `${releaseRoot}/danmaku-overlay_0.1.0_aarch64.dmg`;
const extensionDownload = `${releaseRoot}/danmaku-overlay-extension-1.0.0.zip`;
const chromeStore = 'https://chromewebstore.google.com/detail/aodgflcajjcogogdmondjccplikngddi';
const repository = 'https://github.com/nj1i6t6/danmaku';
const pageSource = indexSource
  .replace(/\s*<link\b[^>]+rel=["'](?:icon|apple-touch-icon|stylesheet)["'][^>]*>/gi, '')
  .replace(/\s*<script\b[^>]+src=["']\/status\.js["'][^>]*><\/script>/gi, '')
  .replace('</head>', `<style>${styleSource}</style></head>`);
const widths = [320, 768, 1024, 1440];
let browser;

fs.mkdirSync(artifactRoot, { recursive: true });

test.beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
});

test.afterAll(async () => browser?.close());

for (const width of widths) {
  test(`landing remains readable and inert at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const consoleErrors = [];
    const pageErrors = [];
    const networkRequests = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => networkRequests.push(request.url()));

    await page.setContent(pageSource, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      window.__fetchCalls = [];
      window.fetch = async (input, init) => {
        window.__fetchCalls.push({ input: String(input), init });
        throw new Error('static landing must not fetch');
      };
    });
    await page.addScriptTag({ content: statusSource });

    await expect(page.locator('#static-service-note')).toHaveText('純前端頁面');
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('.platform-card')).toHaveCount(5);

    const metrics = await page.evaluate(() => ({
      htmlOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
      focusable: document.querySelectorAll('a[href], button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex="-1"])').length,
      headingOrder: [...document.querySelectorAll('h1,h2,h3')].map((heading) => Number(heading.tagName.slice(1))),
      fetchCalls: window.__fetchCalls,
      cardsInsideViewport: [...document.querySelectorAll('.platform-card')].every((card) => {
        const box = card.getBoundingClientRect();
        return box.left >= -0.5 && box.right <= window.innerWidth + 0.5;
      }),
      lang: document.documentElement.lang,
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content || '',
      staticServiceText: document.querySelector('#static-service-note')?.textContent,
    }));

    expect(metrics.htmlOverflow).toBeLessThanOrEqual(0);
    expect(metrics.bodyOverflow).toBeLessThanOrEqual(0);
    expect(metrics.cardsInsideViewport).toBe(true);
    expect(metrics.focusable).toBe(18);
    expect(metrics.headingOrder[0]).toBe(1);
    expect(metrics.headingOrder.slice(1).every((level) => level === 2 || level === 3)).toBe(true);
    expect(metrics.fetchCalls).toHaveLength(0);
    expect(metrics.lang).toBe('zh-Hant-TW');
    expect(metrics.title).toBe('彈幕 Overlay');
    expect(metrics.description.length).toBeGreaterThan(20);
    expect(metrics.staticServiceText).toBe('純前端頁面');

    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('skip-link'))).toBe(true);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(networkRequests).toEqual([]);

    await page.screenshot({
      path: path.join(artifactRoot, `task9-landing-${width}.png`),
      fullPage: true,
    });
    await page.close();
  });
}

test('landing remains static when network APIs are unavailable', async () => {
  const page = await browser.newPage({ viewport: { width: 768, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setContent(pageSource, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.__fetchCalls = 0;
    window.fetch = async () => {
      window.__fetchCalls += 1;
      throw new Error('fixture internal detail');
    };
  });
  await page.addScriptTag({ content: statusSource });
  await expect(page.locator('#static-service-note')).toHaveText('純前端頁面');
  expect(await page.evaluate(() => window.__fetchCalls)).toBe(0);
  expect(await page.locator('body').textContent()).not.toContain('fixture internal detail');
  expect(pageErrors).toEqual([]);
  await page.close();
});

test('configured platform destinations replace disabled buttons with hardened HTTPS anchors', async () => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
  await page.setContent(pageSource, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: statusSource });

  const expected = new Map([
    ['android', androidDownload],
    ['windows', windowsDownload],
    ['macos', macosDownload],
    ['chrome', chromeStore],
    ['edge', extensionDownload],
  ]);
  for (const [platform, href] of expected) {
    const anchor = page.locator(`[data-platform="${platform}"] a.entry-button`);
    await expect(anchor).toHaveAttribute('href', href);
    await expect(anchor).toHaveAttribute('target', '_blank');
    await expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(anchor).not.toHaveClass(/is-pending/);
    await expect(anchor).toHaveCSS('cursor', 'pointer');
    await expect(anchor).toHaveCSS('pointer-events', 'auto');
  }
  await expect(page.locator('[data-platform] button[data-link-key]')).toHaveCount(0);
  await expect(page.locator('.configurable-link a[href="https://github.com/nj1i6t6/danmaku"]')).toHaveCount(2);
  await expect(page.locator('.configurable-link a[href="https://github.com/nj1i6t6/danmaku"]').first()).toHaveAttribute('href', repository);
  await page.close();
});
