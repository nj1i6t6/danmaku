import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayController } from '../src/core/overlay-controller.js';

function settingsAdapter() {
  let value = {
    nickname: '小夜',
    ball: { color: '#58a6ff', size: 56, opacity: 0.9 },
    danmaku: { color: '#e6edf3', size: 20, opacity: 0.9 },
    input: { color: '#1a1a2e', size: 16, opacity: 0.8 },
  };
  return {
    load: () => structuredClone(value),
    save: (next) => { value = structuredClone(next); return structuredClone(value); },
    resetAppearance: (current) => ({ ...structuredClone(current), ball: { color: '#58a6ff', size: 56, opacity: 0.9 } }),
  };
}

function createController({ sendBarrage = async () => ({ ok: true, status: 'sent', messageId: 'm1' }), changeNickname = async () => ({ ok: true, nickname: '小夜', changeDate: '2026-07-15' }), settings = settingsAdapter() } = {}) {
  return createOverlayController({
    sendBarrage,
    changeNickname,
    settingsAdapter: settings,
    now: () => 100,
  });
}

test('overlay controller depends only on explicit send/settings/clock adapters', () => {
  assert.throws(() => createOverlayController({}), /sendBarrage/);
  assert.throws(() => createOverlayController({ sendBarrage() {}, settingsAdapter: {} }), /settingsAdapter\.load/);
  assert.throws(() => createOverlayController({ sendBarrage() {}, settingsAdapter: settingsAdapter() }), /changeNickname/);
  const controller = createController();
  assert.equal(controller.getSettings().nickname, '小夜');
  assert.equal(controller.getSendState().kind, 'ready');
});

test('late ACK cannot overwrite disconnect and preserves the original draft', async () => {
  let resolveSend;
  const controller = createOverlayController({
    sendBarrage: () => new Promise((resolve) => { resolveSend = resolve; }),
    changeNickname: async () => ({ ok: true, nickname: '小夜', changeDate: '2026-07-15' }),
    settingsAdapter: settingsAdapter(),
    now: () => 100,
  });
  const pending = controller.submit('舊草稿', { currentDraft: '舊草稿' });
  assert.equal(controller.getSendState().kind, 'pending');
  const disconnected = controller.disconnect();
  assert.equal(disconnected.canceledSnapshot, '舊草稿');
  resolveSend({ ok: true, status: 'sent', messageId: 'late' });
  const result = await pending;
  assert.equal(result.appliesToCurrentSubmission, false);
  assert.equal(result.state.kind, 'disconnected');
  assert.equal(result.draft, '舊草稿');
});

test('late ACK from an older generation cannot complete a newer submission', async () => {
  const deferred = [];
  const controller = createOverlayController({
    sendBarrage: () => new Promise((resolve) => deferred.push(resolve)),
    changeNickname: async () => ({ ok: true, nickname: '小夜', changeDate: '2026-07-15' }),
    settingsAdapter: settingsAdapter(),
    now: () => 100,
  });

  const oldSubmission = controller.submit('舊訊息', { currentDraft: '舊訊息' });
  controller.disconnect();
  controller.connect();
  const newSubmission = controller.submit('新訊息', { currentDraft: '新訊息' });
  assert.equal(controller.getSendState().kind, 'pending');
  assert.equal(controller.getSendState().snapshot, '新訊息');

  deferred[0]({ ok: true, status: 'sent', messageId: 'old-id' });
  const oldResult = await oldSubmission;
  assert.equal(oldResult.appliesToCurrentSubmission, false);
  assert.equal(controller.getSendState().kind, 'pending');
  assert.equal(controller.getSendState().snapshot, '新訊息');

  deferred[1]({ ok: true, status: 'sent', messageId: 'new-id' });
  const newResult = await newSubmission;
  assert.equal(newResult.appliesToCurrentSubmission, true);
  assert.equal(controller.getSendState().kind, 'ready');
  assert.equal(controller.getSendState().lastMessageId, 'new-id');
});

test('queued expiry restores or offers retry text without overwriting a new draft', async () => {
  let now = 200;
  const controller = createOverlayController({
    sendBarrage: async () => ({ ok: true, status: 'queued', messageId: 'q1', position: 2, estimatedWaitMs: 5000 }),
    changeNickname: async () => ({ ok: true, nickname: '小夜', changeDate: '2026-07-15' }),
    settingsAdapter: settingsAdapter(),
    now: () => now,
  });
  const submitted = await controller.submit('排隊內容', { currentDraft: '排隊內容' });
  assert.equal(submitted.state.kind, 'queued');
  assert.equal(submitted.draft, '');
  now = 250;
  const expired = controller.handleBarrageStatus({ messageId: 'q1', status: 'expired' }, '新草稿');
  assert.equal(expired.state.kind, 'ready');
  assert.equal(expired.draft, '新草稿');
  assert.equal(expired.retryText, '排隊內容');
});

test('nickname success persists only the server-authoritative value and later barrage uses it', async () => {
  const saved = [];
  const settings = settingsAdapter();
  const originalSave = settings.save;
  settings.save = (value) => {
    saved.push(structuredClone(value));
    return originalSave(value);
  };
  const sent = [];
  const controller = createController({
    settings,
    changeNickname: async (nickname) => {
      assert.equal(nickname, '客製名');
      return { ok: true, nickname: '伺服器名', changeDate: '2026-07-15' };
    },
    sendBarrage: async (payload) => {
      sent.push(payload);
      return { ok: true, status: 'sent', messageId: 'server-name' };
    },
  });

  const result = await controller.changeNickname('客製名');
  assert.equal(result.ok, true);
  assert.equal(result.durable, true);
  assert.equal(controller.getSettings().nickname, '伺服器名');
  assert.equal(controller.getSettings().nicknameChangeDate, '2026-07-15');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].nickname, '伺服器名');
  assert.equal(saved[0].nicknameChangeDate, '2026-07-15');

  await controller.submit('使用新暱稱', { currentDraft: '使用新暱稱' });
  assert.equal(sent.at(-1).nickname, '伺服器名');
});

test('server-authoritative nickname with surrounding whitespace is sent verbatim', async () => {
  const acceptedNickname = ' 名 ';
  const saved = [];
  const sent = [];
  const settings = settingsAdapter();
  const originalSave = settings.save;
  settings.save = (value) => {
    saved.push(structuredClone(value));
    return originalSave(value);
  };
  const controller = createController({
    settings,
    changeNickname: async () => ({ ok: true, nickname: acceptedNickname, changeDate: '2026-07-15' }),
    sendBarrage: async (payload) => {
      sent.push(payload);
      return { ok: true, status: 'sent', messageId: 'verbatim-name' };
    },
  });

  const result = await controller.changeNickname('客製名');
  assert.equal(result.ok, true);
  assert.equal(saved.at(-1).nickname, acceptedNickname);
  assert.equal(controller.getSettings().nickname, acceptedNickname);

  await controller.submit('使用逐字暱稱', { currentDraft: '使用逐字暱稱' });
  assert.equal(sent.at(-1).nickname, acceptedNickname);
});

test('nickname failure preserves complete server error and does not save or mutate settings', async () => {
  const settings = settingsAdapter();
  const original = settings.load();
  let saves = 0;
  settings.save = () => { saves += 1; throw new Error('must not save'); };
  const error = { code: 'RATE_LIMITED', scope: 'nickname', message: '今天已達變更上限', retryAfterMs: 43210000 };
  const controller = createController({ settings, changeNickname: async () => ({ ok: false, error }) });

  const result = await controller.changeNickname('新名字');
  assert.equal(result.ok, false);
  assert.deepEqual(result.error, error);
  assert.deepEqual(controller.getSettings(), original);
  assert.equal(saves, 0);
});

test('malformed successful nickname ACK fails closed without saving', async () => {
  for (const ack of [
    { ok: true, nickname: '', changeDate: '2026-07-15' },
    { ok: true, nickname: '   ', changeDate: '2026-07-15' },
    { ok: true, nickname: '1234567', changeDate: '2026-07-15' },
    { ok: true, nickname: '😀😀😀😀', changeDate: '2026-07-15' },
    { ok: true, nickname: '合法名', changeDate: '2026/07/15' },
  ]) {
    let saves = 0;
    const settings = settingsAdapter();
    const before = settings.load();
    settings.save = () => { saves += 1; throw new Error('must not save'); };
    const controller = createController({ settings, changeNickname: async () => ack });
    const result = await controller.changeNickname('請求名');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INVALID_ACK');
    assert.equal(result.error.scope, 'nickname');
    assert.deepEqual(controller.getSettings(), before);
    assert.equal(saves, 0);
  }
});

test('reset appearance keeps the accepted nickname and change date', async () => {
  const controller = createController({
    changeNickname: async () => ({ ok: true, nickname: '保留名', changeDate: '2026-07-15' }),
  });
  await controller.changeNickname('任意');
  const reset = controller.resetAppearance();
  assert.equal(reset.nickname, '保留名');
  assert.equal(reset.nicknameChangeDate, '2026-07-15');
});

test('save failure after a successful nickname ACK is durable false but barrage uses accepted in-memory state', async () => {
  const settings = settingsAdapter();
  settings.save = () => { throw new Error('storage unavailable'); };
  const sent = [];
  const controller = createController({
    settings,
    changeNickname: async () => ({ ok: true, nickname: '暫存名', changeDate: '2026-07-15' }),
    sendBarrage: async (payload) => {
      sent.push(payload);
      return { ok: true, status: 'sent', messageId: 'memory-name' };
    },
  });

  const result = await controller.changeNickname('暫存名');
  assert.equal(result.ok, true);
  assert.equal(result.durable, false);
  assert.match(result.warning, /未持久化/);
  assert.equal(controller.getSettings().nickname, '暫存名');
  await controller.submit('仍用接受名', { currentDraft: '仍用接受名' });
  assert.equal(sent.at(-1).nickname, '暫存名');
});

test('stale nickname ACK cannot save over a newer generation', async () => {
  const deferred = [];
  const saved = [];
  const settings = settingsAdapter();
  const originalSave = settings.save;
  settings.save = (value) => {
    saved.push(structuredClone(value));
    return originalSave(value);
  };
  const controller = createController({
    settings,
    changeNickname: () => new Promise((resolve) => deferred.push(resolve)),
  });

  const old = controller.changeNickname('舊名');
  const newer = controller.changeNickname('新名');
  assert.equal(controller.getNicknameChangeState().pending, true);
  deferred[0]({ ok: true, nickname: '舊伺服器名', changeDate: '2026-07-14' });
  const oldResult = await old;
  assert.equal(oldResult.stale, true);
  assert.equal(saved.length, 0);
  deferred[1]({ ok: true, nickname: '新伺服器名', changeDate: '2026-07-15' });
  const newResult = await newer;
  assert.equal(newResult.stale, undefined);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].nickname, '新伺服器名');
  assert.equal(controller.getSettings().nickname, '新伺服器名');
  assert.equal(controller.getNicknameChangeState().pending, false);
});
