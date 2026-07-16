import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const verifier = path.join(root, 'scripts', 'verify-retired-stock.mjs');

const retiredFiles = [
  'app/symbols.json',
  'app/public/manifest.webmanifest',
  'app/public/sw.js',
  'app/public/js/app.js',
  'app/public/js/socket-client.js',
  'app/public/js/input.js',
  'app/public/js/send-state.js',
  'app/public/js/room-manager.js',
  'app/public/js/room-model.js',
  'app/public/js/safe-render.js',
  'app/public/js/router.js',
  'app/public/js/tradingview.js',
  'app/public/js/search.js',
  'app/public/js/menu.js',
  'app/public/js/history.js',
  'app/public/js/danmaku.js',
  'desktop/frontend/css/overlay.css',
  'desktop/frontend/js/room-manager.js',
  'desktop/frontend/js/room-model.js',
  'desktop/frontend/js/safe-render.js',
  'desktop/frontend/js/send-state.js',
];

test('retired Web, stock, PWA and replaced Desktop sources are absent', () => {
  const existing = retiredFiles.filter((relative) => fs.existsSync(path.join(root, relative)));
  assert.deepEqual(existing, []);
});

test('anti-zombie verifier exists and passes the current source/package tree', () => {
  assert.equal(fs.existsSync(verifier), true, 'scripts/verify-retired-stock.mjs must exist');
  const result = spawnSync(process.execPath, [verifier], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
