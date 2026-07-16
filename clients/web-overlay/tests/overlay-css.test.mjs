import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(here, '../src/core/overlay.css');

test('shared overlay CSS is local-only and preserves click-through boundaries', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.doesNotMatch(css, /@import\b|url\(\s*['"]?https?:/i);
  assert.match(css, /html, body[\s\S]{0,300}pointer-events:\s*none/);
  for (const selector of ['.floating-ball', '.panel', '.history-panel', '.settings-panel', '.room-manager-panel', '.hsv-picker-dialog', '.hsv-picker-controls']) {
    assert.match(css, new RegExp(`${selector.replace('.', '\\.')}[\\s\\S]{0,300}pointer-events:\\s*auto`));
  }
});

test('shared overlay CSS styles the semantic nickname controls and status feedback', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.match(css, /\.nickname-form[\s\S]{0,500}color:/);
  assert.match(css, /\.nickname-controls[\s\S]{0,300}display:\s*flex/);
  assert.match(css, /\.nickname-controls[\s\S]{0,500}pointer-events:\s*auto/);
  assert.match(css, /\.nickname-status[\s\S]{0,300}min-height:/);
});
