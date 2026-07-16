import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTextElement, renderRoomName, replaceTextList } from '../src/core/safe-render.js';

function fakeDocument() {
  return {
    createElement(tagName) {
      return {
        tagName,
        className: '',
        children: [],
        _text: '',
        set textContent(value) { this._text = String(value); },
        get textContent() { return this._text; },
        set innerHTML(_value) { throw new Error('不得使用 innerHTML'); },
        appendChild(child) { this.children.push(child); },
        replaceChildren(...children) { this.children = children; },
      };
    },
  };
}

test('伺服器字串只成為文字節點，不可插入 HTML', () => {
  const document = fakeDocument();
  const target = document.createElement('strong');
  renderRoomName(target, '<svg onload=alert(1)>');
  assert.equal(target.textContent, '<svg onload=alert(1)>');

  const parent = document.createElement('div');
  parent.ownerDocument = document;
  const child = appendTextElement(parent, 'span', 'room-name', '<img onerror=1>');
  assert.equal(child.textContent, '<img onerror=1>');
  assert.equal(child.className, 'room-name');
});

test('重建清單只採用 builder 產生的可信節點', () => {
  const document = fakeDocument();
  const parent = document.createElement('div');
  parent.ownerDocument = document;
  replaceTextList(parent, ['<script>1</script>', '正常'], (value) => {
    const item = document.createElement('p');
    item.textContent = value;
    return item;
  });
  assert.deepEqual(parent.children.map((item) => item.textContent), ['<script>1</script>', '正常']);
});
