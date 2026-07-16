'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkDuplicate, addToBuffer, jaccardSimilarity, simpleHash, reset, removeRoom, roomBufferCount } = require('../protection/dedup');

test('dedup: 不同 session 不同內容放行', () => {
  reset();
  addToBuffer('session-a', '今天大盤漲', 'room1');
  const result = checkDuplicate('session-b', '明天會跌嗎', 'room1');
  assert.strictEqual(result.action, 'pass');
});

test('dedup: 跨 session 相同內容 shadow drop', () => {
  reset();
  addToBuffer('session-a', '今天大盤大漲', 'room1');
  // 10 秒內不同 session 發一模一樣的文字
  const result = checkDuplicate('session-b', '今天大盤大漲', 'room1');
  assert.strictEqual(result.action, 'shadow_drop');
});

test('dedup: 同 session 相似內容 cooldown', () => {
  reset();
  addToBuffer('session-a', '今天大盤漲很多', 'room1');
  // 同 session 30 秒內相似度過高
  const result = checkDuplicate('session-a', '今天大盤漲很多哦', 'room1');
  assert.strictEqual(result.action, 'cooldown');
});

test('dedup: 完全不同內容放行', () => {
  reset();
  addToBuffer('session-a', '今天天氣不錯', 'room1');
  const result = checkDuplicate('session-a', '台積電漲停了', 'room1');
  assert.strictEqual(result.action, 'pass');
});

test('dedup: 不同 room 獨立', () => {
  reset();
  addToBuffer('session-a', '今天大盤大漲', 'room1');
  // 不同 room 的相同文字應該放行
  const result = checkDuplicate('session-b', '今天大盤大漲', 'room2');
  assert.strictEqual(result.action, 'pass');
});

test('dedup: removing a deleted room releases its buffer', () => {
  reset();
  addToBuffer('session-a', '會被釋放的內容', 'room-deleted');
  assert.equal(roomBufferCount(), 1);
  assert.equal(removeRoom('room-deleted'), true);
  assert.equal(roomBufferCount(), 0);
  assert.equal(removeRoom('room-deleted'), false);
});

test('dedup: jaccardSimilarity 相同字串', () => {
  assert.strictEqual(jaccardSimilarity('abc', 'abc'), 1.0);
});

test('dedup: jaccardSimilarity 完全不同', () => {
  const sim = jaccardSimilarity('abcdef', 'xyzwvu');
  assert.strictEqual(sim, 0.0);
});

test('dedup: jaccardSimilarity 部分相似', () => {
  const sim = jaccardSimilarity('今天大盤漲', '今天大盤跌');
  assert.ok(sim > 0 && sim < 1);
});

test('dedup: jaccardSimilarity 高相似度', () => {
  const sim = jaccardSimilarity('今天大盤漲很多', '今天大盤漲很多哦');
  assert.ok(sim > 0.8, `相似度應 > 0.8，實際: ${sim}`);
});

test('dedup: simpleHash 一致性', () => {
  const h1 = simpleHash('test');
  const h2 = simpleHash('test');
  assert.strictEqual(h1, h2);
});

test('dedup: simpleHash 不同字串不同 hash', () => {
  const h1 = simpleHash('test1');
  const h2 = simpleHash('test2');
  assert.notStrictEqual(h1, h2);
});
