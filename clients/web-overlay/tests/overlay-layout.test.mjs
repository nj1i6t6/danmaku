import test from 'node:test';
import assert from 'node:assert/strict';

const layout = await import('../src/core/overlay-layout.js').catch(() => ({}));

test('overlay panel chooses a visible side and stays inside the viewport', () => {
  assert.equal(typeof layout.positionAdjacentOverlay, 'function');

  const viewport = { width: 1280, height: 720 };
  const panel = { width: 280, height: 166 };
  const rightEdge = layout.positionAdjacentOverlay({
    left: 1204,
    right: 1260,
    top: 100,
  }, panel, viewport);
  assert.ok(rightEdge.left < 1204, 'a right-edge anchor must open the panel on its left');
  assert.ok(rightEdge.left >= 8);
  assert.ok(rightEdge.left + Math.min(panel.width, rightEdge.maxWidth) <= viewport.width - 8);
  assert.ok(rightEdge.top >= 8);
  assert.ok(rightEdge.top + Math.min(panel.height, rightEdge.maxHeight) <= viewport.height - 8);

  const bottomEdge = layout.positionAdjacentOverlay({
    left: 20,
    right: 76,
    top: 680,
  }, panel, viewport);
  assert.equal(bottomEdge.left, 84, 'an anchor with enough right-side space should open right');
  assert.ok(bottomEdge.top + panel.height <= viewport.height - 8);

  const narrow = layout.positionAdjacentOverlay({
    left: 164,
    right: 220,
    top: 12,
  }, panel, { width: 240, height: 200 });
  assert.equal(narrow.maxWidth, 224);
  assert.equal(narrow.maxHeight, 184);
  assert.ok(narrow.left >= 8 && narrow.top >= 8);
});
