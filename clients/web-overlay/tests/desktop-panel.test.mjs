import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPEARANCE_DEFAULTS, APPEARANCE_LIMITS } from '../src/core/settings-contract.js';
import { OVERLAY_TEMPLATE } from '../src/core/overlay-template.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..', '..', '..');
const appSource = fs.readFileSync(path.join(repositoryRoot, 'desktop', 'frontend', 'js', 'overlay-app.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(here, '../src/core/overlay.css'), 'utf8');

function inputMarkup(id) {
  return OVERLAY_TEMPLATE.match(new RegExp(`<input[^>]+id=["']${id}["'][^>]*>`))?.[0] || '';
}

test('shared panel controls expose the exact width/height range contract and semantic outputs', () => {
  for (const [id, limits, defaultValue] of [
    ['panel-width', APPEARANCE_LIMITS.panelWidth, APPEARANCE_DEFAULTS.panel.width],
    ['panel-height', APPEARANCE_LIMITS.panelHeight, APPEARANCE_DEFAULTS.panel.height],
  ]) {
    const markup = inputMarkup(id);
    assert.match(markup, /type=["']range["']/);
    assert.match(markup, new RegExp(`min=["']${limits[0]}["']`));
    assert.match(markup, new RegExp(`max=["']${limits[1]}["']`));
    assert.match(markup, new RegExp(`value=["']${defaultValue}["']`));
  }
  assert.match(OVERLAY_TEMPLATE, /<label[^>]+for=["']panel-width["'][^>]*>[^<]*面板寬度/);
  assert.match(OVERLAY_TEMPLATE, /<label[^>]+for=["']panel-height["'][^>]*>[^<]*面板高度/);
  assert.match(OVERLAY_TEMPLATE, /id=["']panel-width-value["']/);
  assert.match(OVERLAY_TEMPLATE, /id=["']panel-height-value["']/);
  assert.match(OVERLAY_TEMPLATE, /panel-height-value["'][^>]*>自動</);
});

test('shared panel CSS uses custom properties with viewport clamps and scroll contracts', () => {
  assert.match(cssSource, /--panel-width\s*:\s*320px/);
  assert.match(cssSource, /--panel-height\s*:\s*auto/);
  for (const selector of ['.panel', '.history-panel', '.settings-panel']) {
    const block = cssSource.slice(cssSource.indexOf(selector), cssSource.indexOf('}', cssSource.indexOf(selector)) + 1);
    assert.match(block, /width:\s*min\([^;]*var\(--panel-width\)/);
    assert.match(block, /max-width:\s*calc\(100vw\s*-\s*16px\)/);
    assert.match(block, /height:\s*var\(--panel-height\)/);
    assert.match(block, /max-height:\s*calc\(100vh\s*-\s*16px\)/);
  }
  assert.match(cssSource, /\.history-list[\s\S]{0,500}overflow-y:\s*auto/);
  assert.match(cssSource, /\.settings-body[\s\S]{0,500}overflow-y:\s*auto/);
  assert.match(cssSource, /\.panel[\s\S]{0,500}overflow-y:\s*auto/);
});

test('Desktop source wires panel apply/sync, immediate save, shared applyAll, and reset path', () => {
  assert.match(appSource, /function applyPanelSettings\(\)/);
  assert.match(appSource, /function syncPanelControls\(\)/);
  assert.match(appSource, /panel-width-value/);
  assert.match(appSource, /panel-height-value/);
  assert.match(appSource, /APPEARANCE_LIMITS\.panelWidth/);
  assert.match(appSource, /APPEARANCE_LIMITS\.panelHeight/);
  assert.match(appSource, /['"]panel['"][\s\S]{0,300}['"]history-panel['"][\s\S]{0,300}['"]settings-panel['"]/);
  assert.match(appSource, /function updatePanelSetting\(key, value\)[\s\S]{0,220}settings\.panel\[key\]\s*=\s*value[\s\S]{0,220}saveSettings\(settings\)[\s\S]{0,220}applyPanelSettings\(\)/);
  assert.match(appSource, /panel-width[\s\S]{0,180}updatePanelSetting\(['"]width['"]/);
  assert.match(appSource, /panel-height[\s\S]{0,180}updatePanelSetting\(['"]height['"]/);
  assert.match(appSource, /function applyAllSettings\(\)[\s\S]{0,250}applyPanelSettings\(\)/);
  assert.match(appSource, /function resetSettings\(\)[\s\S]{0,220}overlayController\.resetAppearance\(\)/);
  assert.match(appSource, /resetSettings\(\)/);
});
