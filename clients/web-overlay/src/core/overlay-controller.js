import {
  canSubmit,
  createSendState,
  interpretBarrageAck,
  reduceSendState,
  settleDraft,
  settleExpiredDraft,
} from './send-state.js';
import { TEXT_LIMITS } from './settings-contract.js';

const SETTINGS_METHODS = ['load', 'save', 'resetAppearance'];
const CHANGE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function invalidNicknameAck(message = '伺服器回應格式錯誤') {
  return {
    ok: false,
    error: { code: 'INVALID_ACK', scope: 'nickname', message },
  };
}

function validChangeDate(value) {
  const match = CHANGE_DATE_PATTERN.exec(String(value ?? ''));
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(`${yearText}-${monthText}-${dayText}T00:00:00.000Z`);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day;
}

function validNicknameAck(ack) {
  return typeof ack?.nickname === 'string'
    && ack.nickname.trim().length > 0
    && ack.nickname.length <= TEXT_LIMITS.nickname
    && validChangeDate(ack.changeDate);
}

export function createOverlayController({
  sendBarrage,
  changeNickname: changeNicknameAdapter,
  settingsAdapter,
  now = () => performance.now(),
  initialSendKind = 'ready',
} = {}) {
  if (typeof sendBarrage !== 'function') throw new TypeError('overlay controller sendBarrage adapter is required');
  for (const method of SETTINGS_METHODS) {
    if (typeof settingsAdapter?.[method] !== 'function') {
      throw new TypeError(`overlay controller settingsAdapter.${method} must be a function`);
    }
  }
  if (typeof changeNicknameAdapter !== 'function') {
    throw new TypeError('overlay controller changeNickname adapter is required');
  }
  if (typeof now !== 'function') throw new TypeError('overlay controller clock adapter must be a function');

  let settings = settingsAdapter.load();
  let sendState = createSendState(initialSendKind);
  let nicknameGeneration = 0;
  let nicknamePendingGeneration = null;

  function transition(event) {
    sendState = reduceSendState(sendState, event, now());
    return sendState;
  }

  return {
    getSettings() { return settings; },
    saveSettings(value) {
      settings = settingsAdapter.save(value);
      return settings;
    },
    resetAppearance() {
      settings = settingsAdapter.resetAppearance(settings);
      return settings;
    },
    getNicknameChangeState() {
      return {
        pending: nicknamePendingGeneration !== null,
        generation: nicknameGeneration,
      };
    },
    async changeNickname(rawNickname) {
      const generation = ++nicknameGeneration;
      nicknamePendingGeneration = generation;
      let rawAck;
      try {
        rawAck = await changeNicknameAdapter(String(rawNickname ?? '').trim());
      } catch {
        rawAck = {
          ok: false,
          error: { code: 'NICKNAME_ADAPTER_ERROR', scope: 'nickname', message: '暱稱變更失敗' },
        };
      }

      const current = generation === nicknameGeneration;
      const ack = rawAck && typeof rawAck === 'object' ? rawAck : invalidNicknameAck();
      if (ack.ok !== true) {
        if (current) nicknamePendingGeneration = null;
        return ack.ok === false && ack.error ? ack : invalidNicknameAck();
      }
      if (!validNicknameAck(ack)) {
        if (current) nicknamePendingGeneration = null;
        return invalidNicknameAck('伺服器暱稱回應格式錯誤');
      }
      if (!current) {
        return { ...ack, stale: true, applied: false, durable: false };
      }

      const acceptedSettings = {
        ...settings,
        nickname: ack.nickname,
        nicknameChangeDate: ack.changeDate,
      };
      nicknamePendingGeneration = null;
      try {
        const persisted = settingsAdapter.save(acceptedSettings);
        settings = {
          ...(persisted && typeof persisted === 'object' ? persisted : acceptedSettings),
          nickname: ack.nickname,
          nicknameChangeDate: ack.changeDate,
        };
        return { ...ack, applied: true, durable: true };
      } catch {
        settings = acceptedSettings;
        return {
          ...ack,
          applied: true,
          durable: false,
          warning: '暱稱已被伺服器接受，但本機未持久化；本次執行仍使用已接受暱稱',
        };
      }
    },
    getSendState() { return sendState; },
    connect() { return transition({ type: 'connect' }); },
    disconnect() { return transition({ type: 'disconnect' }); },
    changeRoom() { return transition({ type: 'room-change' }); },
    tick() { return transition({ type: 'tick' }); },
    async submit(rawSnapshot, {
      currentDraft = rawSnapshot,
      preserveComposer = false,
    } = {}) {
      const raw = String(rawSnapshot ?? '');
      const snapshot = raw.trim().slice(0, 100);
      if (!snapshot) return { accepted: false, reason: 'EMPTY', state: sendState, draft: currentDraft };
      if (!canSubmit(sendState)) return { accepted: false, reason: 'BLOCKED', state: sendState, draft: currentDraft };

      const submissionState = reduceSendState(sendState, { type: 'submit', snapshot: raw }, now());
      sendState = submissionState;
      const rawAck = await sendBarrage({
        text: snapshot,
        nickname: settings.nickname,
        color: settings.danmaku.color,
      });
      const ack = interpretBarrageAck(rawAck);
      const appliesToCurrentSubmission = sendState === submissionState;
      if (appliesToCurrentSubmission) {
        sendState = reduceSendState(sendState, { type: 'ack', ack }, now());
      }

      let draft = currentDraft;
      let retryText = null;
      if (!preserveComposer && appliesToCurrentSubmission) draft = settleDraft(currentDraft, raw, ack);
      if (appliesToCurrentSubmission && sendState.canceledSnapshot) {
        const settled = settleExpiredDraft(draft, sendState.canceledSnapshot);
        draft = settled.draft;
        retryText = settled.retryText;
      }
      return { accepted: true, ack, state: sendState, draft, retryText, appliesToCurrentSubmission };
    },
    handleBarrageStatus(data, currentDraft = '') {
      if (!data || data.messageId !== sendState.messageId) {
        return { state: sendState, draft: currentDraft, retryText: null };
      }
      if (data.status === 'delivered') {
        sendState = reduceSendState(sendState, { type: 'delivered', messageId: data.messageId }, now());
        return { state: sendState, draft: currentDraft, retryText: null };
      }
      if (data.status === 'expired') {
        const snapshot = sendState.snapshot || '';
        sendState = reduceSendState(sendState, { type: 'expired', messageId: data.messageId }, now());
        const settled = settleExpiredDraft(currentDraft, snapshot);
        return { state: sendState, ...settled };
      }
      return { state: sendState, draft: currentDraft, retryText: null };
    },
  };
}
