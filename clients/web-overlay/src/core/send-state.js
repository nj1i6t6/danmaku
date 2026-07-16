export const SEND_KINDS = Object.freeze([
  'ready', 'pending', 'queued', 'cooldown', 'muted', 'room-busy', 'disconnected',
]);
const ERROR_SCOPES = new Set(['user', 'room', 'global', 'connection']);
const normalizeErrorScope = (scope, fallback = 'user') => ERROR_SCOPES.has(scope) ? scope : fallback;

export function createSendState(kind = 'ready', details = {}) {
  if (!SEND_KINDS.includes(kind)) throw new TypeError(`Unknown send state: ${kind}`);
  return { kind, ...details };
}

export function interpretBarrageAck(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: { code: 'INVALID_ACK', scope: 'connection', message: '伺服器回應格式錯誤' } };
  }
  if (raw.ok === true && raw.status === 'sent' && typeof raw.messageId === 'string') {
    return { ok: true, status: 'sent', messageId: raw.messageId };
  }
  if (raw.ok === true && raw.status === 'queued' && typeof raw.messageId === 'string') {
    return {
      ok: true,
      status: 'queued',
      messageId: raw.messageId,
      position: Math.max(1, Number(raw.position) || 1),
      estimatedWaitMs: Math.max(0, Number(raw.estimatedWaitMs) || 0),
    };
  }
  const source = raw.error && typeof raw.error === 'object' ? raw.error : {};
  return {
    ok: false,
    error: {
      ...source,
      code: String(source.code || 'SEND_FAILED'),
      scope: normalizeErrorScope(source.scope),
      message: String(source.message || '彈幕傳送失敗'),
      ...(Number.isFinite(Number(source.retryAfterMs))
        ? { retryAfterMs: Math.max(0, Number(source.retryAfterMs)) }
        : {}),
    },
  };
}

function stateForError(error, now) {
  const retryAfterMs = Math.max(0, Number(error.retryAfterMs) || 0);
  const details = { error, reason: error.message };
  if (retryAfterMs) details.deadline = now + retryAfterMs;
  if (error.code === 'COOLDOWN' || error.code === 'RATE_LIMITED') return createSendState('cooldown', details);
  if (error.code === 'MUTED') return createSendState('muted', details);
  if (error.code === 'ROOM_BUSY' || error.code === 'ROOM_RATE_LIMITED' || error.scope === 'room') {
    return createSendState('room-busy', details);
  }
  return createSendState('ready', details);
}

export function reduceSendState(state, event, now = performance.now()) {
  switch (event.type) {
    case 'submit':
      return createSendState('pending', { snapshot: event.snapshot });
    case 'ack': {
      if (state.kind !== 'pending') return state;
      const ack = event.ack;
      if (ack.ok && ack.status === 'sent') return createSendState('ready', { lastMessageId: ack.messageId });
      if (ack.ok && ack.status === 'queued') {
        return createSendState('queued', {
          snapshot: state.snapshot,
          messageId: ack.messageId,
          position: ack.position,
          deadline: now + ack.estimatedWaitMs,
        });
      }
      if (ack.error?.code === 'NOT_CONNECTED') {
        return createSendState('disconnected', { previous: state, canceledSnapshot: state.snapshot });
      }
      return stateForError(ack.error, now);
    }
    case 'delivered':
      if (state.kind === 'queued' && state.messageId === event.messageId) {
        return createSendState('ready', { lastMessageId: event.messageId });
      }
      return state;
    case 'expired':
      if (state.kind === 'queued' && state.messageId === event.messageId) {
        return createSendState('ready', { expiredSnapshot: state.snapshot, lastMessageId: event.messageId });
      }
      return state;
    case 'disconnect':
      return createSendState('disconnected', {
        previous: state,
        ...(['pending', 'queued'].includes(state.kind) && state.snapshot ? { canceledSnapshot: state.snapshot } : {}),
      });
    case 'connect':
      return state.kind === 'disconnected'
        ? createSendState('ready', state.canceledSnapshot ? { canceledSnapshot: state.canceledSnapshot } : {})
        : state;
    case 'room-change':
      if (state.kind === 'room-busy') return createSendState('ready');
      return ['pending', 'queued'].includes(state.kind) && state.snapshot
        ? createSendState('ready', { canceledSnapshot: state.snapshot })
        : state;
    case 'tick':
      if (['cooldown', 'muted', 'room-busy'].includes(state.kind) && state.deadline && now >= state.deadline) {
        return createSendState('ready');
      }
      return state;
    default:
      return state;
  }
}

export function remainingMs(state, now = performance.now()) {
  return state.deadline ? Math.max(0, state.deadline - now) : 0;
}

export function canSubmit(state) {
  return state.kind === 'ready';
}

export function settleDraft(currentDraft, snapshot, ack) {
  if (!ack?.ok || !['sent', 'queued'].includes(ack.status)) return currentDraft;
  return currentDraft === snapshot ? '' : currentDraft;
}

export function settleExpiredDraft(currentDraft, snapshot) {
  return currentDraft === '' || currentDraft === snapshot
    ? { draft: snapshot, retryText: null }
    : { draft: currentDraft, retryText: snapshot };
}

export function describeSendButton(state, now = performance.now()) {
  const seconds = Math.ceil(remainingMs(state, now) / 1000);
  switch (state.kind) {
    case 'ready': return '發送';
    case 'pending': return '傳送中…';
    case 'queued': return `排隊 #${state.position}`;
    case 'cooldown': return `冷卻中 ${seconds} 秒`;
    case 'muted': return seconds ? `禁言中 ${seconds} 秒` : '目前已禁言';
    case 'room-busy': return seconds ? `房間忙碌 ${seconds} 秒` : '房間忙碌';
    case 'disconnected': return '尚未連線';
    default: return '暫時無法發送';
  }
}

export function describeSendState(state, now = performance.now()) {
  const seconds = Math.ceil(remainingMs(state, now) / 1000);
  switch (state.kind) {
    case 'ready': return state.reason || '可以發送';
    case 'pending': return '傳送中，請稍候';
    case 'queued': return `排隊第 ${state.position} 位${seconds ? `，約 ${seconds} 秒` : ''}`;
    case 'cooldown': return `冷卻中${seconds ? `，還有 ${seconds} 秒` : ''}`;
    case 'muted': return state.reason || '目前已被禁言';
    case 'room-busy': return state.reason || '房間忙碌中';
    case 'disconnected': return '尚未連線，訊息會保留';
    default: return '暫時無法發送';
  }
}
