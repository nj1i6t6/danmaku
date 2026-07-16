import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSendState,
  reduceSendState,
  interpretBarrageAck,
  settleDraft,
  settleExpiredDraft,
  remainingMs,
  describeSendButton,
} from '../src/core/send-state.js';

test('typed ACK、排隊、斷線與晚到 ACK 使用單調時間和原始快照', () => {
  const ready = createSendState();
  const pending = reduceSendState(ready, { type: 'submit', snapshot: '舊草稿' }, 100);
  const queuedAck = interpretBarrageAck({
    ok: true,
    status: 'queued',
    messageId: 'message-1',
    position: 3,
    estimatedWaitMs: 9000,
  });
  const queued = reduceSendState(pending, { type: 'ack', ack: queuedAck }, 120);
  assert.deepEqual([queued.kind, queued.messageId, queued.position], ['queued', 'message-1', 3]);
  assert.equal(remainingMs(queued, 1120), 8000);
  assert.equal(settleDraft('舊草稿', '舊草稿', queuedAck), '');
  assert.equal(settleDraft('送出後的新草稿', '舊草稿', queuedAck), '送出後的新草稿');

  const disconnected = reduceSendState(queued, { type: 'disconnect' }, 130);
  assert.equal(disconnected.canceledSnapshot, '舊草稿');
  const sent = interpretBarrageAck({ ok: true, status: 'sent', messageId: 'message-2' });
  assert.equal(reduceSendState(disconnected, { type: 'ack', ack: sent }, 150).kind, 'disconnected');
  assert.match(describeSendButton(disconnected, 150), /未連線/);
  assert.deepEqual(settleExpiredDraft('新草稿', '舊草稿'), { draft: '新草稿', retryText: '舊草稿' });
});

test('錯誤 ACK 的 scope 與 deadline 會安全正規化', () => {
  const pending = reduceSendState(createSendState(), { type: 'submit', snapshot: '訊息' }, 100);
  const failed = interpretBarrageAck({
    ok: false,
    error: { code: 'COOLDOWN', scope: 'message', message: '請稍候', retryAfterMs: 3000 },
  });
  assert.equal(failed.error.scope, 'user');
  const cooldown = reduceSendState(pending, { type: 'ack', ack: failed }, 200);
  assert.deepEqual([cooldown.kind, cooldown.deadline], ['cooldown', 3200]);
});

test('沒有 deadline 的房間忙碌狀態會在切房後解除', () => {
  const pending = reduceSendState(createSendState(), { type: 'submit', snapshot: '訊息' }, 100);
  const queueFull = interpretBarrageAck({
    ok: false,
    error: { code: 'QUEUE_FULL', scope: 'room', message: 'room queue is full' },
  });
  const busy = reduceSendState(pending, { type: 'ack', ack: queueFull }, 200);

  assert.equal(busy.kind, 'room-busy');
  assert.equal(reduceSendState(busy, { type: 'room-change' }, 300).kind, 'ready');
});
