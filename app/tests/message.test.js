const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createBarrageMessage, resolveReportedMessageId } = require('../message');

test('message: 相同文字仍產生不同 messageId', () => {
  const first = createBarrageMessage({ text: '同一句', nickname: '匿名', color: '#e6edf3', sessionId: 's1' });
  const second = createBarrageMessage({ text: '同一句', nickname: '匿名', color: '#e6edf3', sessionId: 's1' });
  assert.notStrictEqual(first.messageId, second.messageId);
  assert.match(first.messageId, /^[0-9a-f-]{36}$/i);
});

test('message: 新版檢舉優先採用明確 messageId', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.strictEqual(resolveReportedMessageId([], { messageId: id, messageText: '文字' }), id);
});

test('message: 舊版檢舉從最近歷史按 session 與文字找回 messageId', () => {
  const messages = [
    { messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', text: '重複', sessionId: 'old' },
    { messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', text: '重複', sessionId: 'target' },
  ];
  assert.strictEqual(
    resolveReportedMessageId(messages, { targetSessionId: 'target', messageText: '重複' }),
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
});

test('message: 找不到歷史時不偽造文字型 ID', () => {
  assert.strictEqual(resolveReportedMessageId([], { messageText: '不存在' }), null);
});
