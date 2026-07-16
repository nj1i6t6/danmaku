import { APPEARANCE_LIMITS, TEXT_LIMITS } from '../core/settings-contract.js';

const ROOM_CODE = /^\d{8}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const INSTANCE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const VISIBILITY_STATES = new Set(['visible', 'hidden', 'prerender']);
const ROOM_VISIBILITIES = new Set(['public', 'unlisted']);
const RETENTION_DAYS = new Set([1, 3, 7]);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const source = object(value, label);
  const extras = Object.keys(source).filter((key) => !allowed.includes(key));
  if (extras.length) throw new TypeError(`${label} has extra fields: ${extras.join(', ')}`);
  return source;
}

function requiredString(value, label, maximum, { minimum = 1, trim = true } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const normalized = trim ? value.trim() : value;
  const length = Array.from(normalized).length;
  if (length < minimum || length > maximum) throw new TypeError(`${label} length is invalid`);
  return normalized;
}

function optionalString(value, label, maximum, options = {}) {
  if (value === undefined) return undefined;
  return requiredString(value, label, maximum, options);
}

function roomCode(value) {
  const normalized = String(value ?? '').trim();
  if (!ROOM_CODE.test(normalized)) throw new TypeError('roomCode must be exactly 8 digits');
  return normalized;
}

function integer(value, label, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function numberInRange(value, label, [minimum, maximum]) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function color(value, label) {
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) throw new TypeError(`${label} must use #RRGGBB`);
  return value.toUpperCase();
}

function emptyPayload(payload, action) {
  exactKeys(payload, [], `${action} payload`);
  return {};
}

function normalizeSettingsPatch(payload) {
  const source = exactKeys(payload, [
    'ball', 'danmaku', 'input', 'panel', 'ballPosition', 'danmakuVisible', 'onboarded',
  ], 'settings');
  const result = {};

  if (source.ball !== undefined) {
    const value = exactKeys(source.ball, ['color', 'size', 'opacity'], 'settings.ball');
    result.ball = {};
    if (value.color !== undefined) result.ball.color = color(value.color, 'settings.ball.color');
    if (value.size !== undefined) result.ball.size = numberInRange(value.size, 'settings.ball.size', APPEARANCE_LIMITS.ballSize);
    if (value.opacity !== undefined) result.ball.opacity = numberInRange(value.opacity, 'settings.ball.opacity', APPEARANCE_LIMITS.opacity);
  }
  if (source.danmaku !== undefined) {
    const value = exactKeys(source.danmaku, ['color', 'size', 'opacity'], 'settings.danmaku');
    result.danmaku = {};
    if (value.color !== undefined) result.danmaku.color = color(value.color, 'settings.danmaku.color');
    if (value.size !== undefined) result.danmaku.size = numberInRange(value.size, 'settings.danmaku.size', APPEARANCE_LIMITS.danmakuSize);
    if (value.opacity !== undefined) result.danmaku.opacity = numberInRange(value.opacity, 'settings.danmaku.opacity', APPEARANCE_LIMITS.opacity);
  }
  if (source.input !== undefined) {
    const value = exactKeys(source.input, ['color', 'size', 'opacity'], 'settings.input');
    result.input = {};
    if (value.color !== undefined) result.input.color = color(value.color, 'settings.input.color');
    if (value.size !== undefined) result.input.size = numberInRange(value.size, 'settings.input.size', APPEARANCE_LIMITS.inputSize);
    if (value.opacity !== undefined) result.input.opacity = numberInRange(value.opacity, 'settings.input.opacity', APPEARANCE_LIMITS.opacity);
  }
  if (source.panel !== undefined) {
    const value = exactKeys(source.panel, ['width', 'height'], 'settings.panel');
    result.panel = {};
    if (value.width !== undefined) result.panel.width = numberInRange(value.width, 'settings.panel.width', APPEARANCE_LIMITS.panelWidth);
    if (value.height !== undefined) result.panel.height = numberInRange(value.height, 'settings.panel.height', APPEARANCE_LIMITS.panelHeight);
  }
  if (source.ballPosition !== undefined) {
    const value = exactKeys(source.ballPosition, ['x', 'y'], 'settings.ballPosition');
    result.ballPosition = {};
    for (const key of ['x', 'y']) {
      if (value[key] === undefined) continue;
      if (value[key] !== null && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) {
        throw new TypeError(`settings.ballPosition.${key} must be a finite number or null`);
      }
      result.ballPosition[key] = value[key];
    }
  }
  for (const key of ['danmakuVisible', 'onboarded']) {
    if (source[key] !== undefined) {
      if (typeof source[key] !== 'boolean') throw new TypeError(`settings.${key} must be a boolean`);
      result[key] = source[key];
    }
  }
  if (!Object.keys(result).length) throw new TypeError('settings update must contain at least one field');
  return result;
}

const validators = {
  'state/get': emptyPayload,
  'privacy/consent': emptyPayload,
  'privacy/revoke': emptyPayload,
  'overlay/register'(payload) {
    const value = exactKeys(payload, ['instanceId', 'visibilityState'], 'overlay/register payload');
    if (typeof value.instanceId !== 'string' || !INSTANCE_ID.test(value.instanceId)) throw new TypeError('instanceId is invalid');
    if (!VISIBILITY_STATES.has(value.visibilityState)) throw new TypeError('visibilityState is invalid');
    return { instanceId: value.instanceId, visibilityState: value.visibilityState };
  },
  'overlay/unregister'(payload) {
    const value = exactKeys(payload, ['instanceId'], 'overlay/unregister payload');
    if (typeof value.instanceId !== 'string' || !INSTANCE_ID.test(value.instanceId)) throw new TypeError('instanceId is invalid');
    return { instanceId: value.instanceId };
  },
  'overlay/visibility'(payload) {
    const value = exactKeys(payload, ['instanceId', 'visibilityState'], 'overlay/visibility payload');
    if (typeof value.instanceId !== 'string' || !INSTANCE_ID.test(value.instanceId)) throw new TypeError('instanceId is invalid');
    if (!VISIBILITY_STATES.has(value.visibilityState)) throw new TypeError('visibilityState is invalid');
    return { instanceId: value.instanceId, visibilityState: value.visibilityState };
  },
  'overlay/set-visible'(payload) {
    const value = exactKeys(payload, ['visible'], 'overlay/set-visible payload');
    if (typeof value.visible !== 'boolean') throw new TypeError('visible must be a boolean');
    return { visible: value.visible };
  },
  'popup/status'(payload) {
    const value = exactKeys(payload, ['tabId'], 'popup/status payload');
    return { tabId: integer(value.tabId, 'tabId', 1) };
  },
  'overlay/toggle'(payload) {
    const value = exactKeys(payload, ['tabId'], 'overlay/toggle payload');
    return { tabId: integer(value.tabId, 'tabId', 1) };
  },
  'settings/update'(payload) {
    const value = exactKeys(payload, ['settings'], 'settings/update payload');
    return { settings: normalizeSettingsPatch(value.settings) };
  },
  'settings/reset': emptyPayload,
  'nickname/change'(payload) {
    const value = exactKeys(payload, ['nickname'], 'nickname/change payload');
    return { nickname: requiredString(value.nickname, 'nickname', TEXT_LIMITS.nickname) };
  },
  'barrage/send'(payload) {
    const value = exactKeys(payload, ['text'], 'barrage/send payload');
    return { text: requiredString(value.text, 'text', TEXT_LIMITS.message) };
  },
  'room/default': emptyPayload,
  'room/leave': emptyPayload,
  'room/exit': emptyPayload,
  'room/lookup'(payload) {
    const value = exactKeys(payload, ['roomCode'], 'room/lookup payload');
    return { roomCode: roomCode(value.roomCode) };
  },
  'room/list'(payload) {
    const value = exactKeys(payload, ['query', 'page'], 'room/list payload');
    return {
      ...(value.query === undefined ? {} : { query: optionalString(value.query, 'query', 40) }),
      page: value.page === undefined ? 1 : integer(value.page, 'page', 1, 10_000),
    };
  },
  'room/join'(payload) {
    const value = exactKeys(payload, ['roomCode', 'password'], 'room/join payload');
    return {
      roomCode: roomCode(value.roomCode),
      ...(value.password === undefined ? {} : { password: requiredString(value.password, 'password', 64, { minimum: 1, trim: false }) }),
    };
  },
  'room/create'(payload) {
    const value = exactKeys(payload, ['name', 'visibility', 'password', 'retentionDays'], 'room/create payload');
    if (!ROOM_VISIBILITIES.has(value.visibility)) throw new TypeError('visibility is invalid');
    if (!RETENTION_DAYS.has(value.retentionDays)) throw new TypeError('retentionDays is invalid');
    const password = value.password === undefined ? undefined : requiredString(value.password, 'password', 64, { minimum: 6, trim: false });
    return {
      name: requiredString(value.name, 'name', 40),
      visibility: value.visibility,
      retentionDays: value.retentionDays,
      ...(password === undefined ? {} : { password }),
    };
  },
  'room/update'(payload) {
    const value = exactKeys(payload, ['roomCode', 'name', 'visibility', 'passwordAction'], 'room/update payload');
    const result = { roomCode: roomCode(value.roomCode) };
    if (value.name !== undefined) result.name = requiredString(value.name, 'name', 40);
    if (value.visibility !== undefined) {
      if (!ROOM_VISIBILITIES.has(value.visibility)) throw new TypeError('visibility is invalid');
      result.visibility = value.visibility;
    }
    if (value.passwordAction !== undefined) {
      const action = exactKeys(value.passwordAction, ['type', 'password'], 'passwordAction');
      if (action.type === 'remove') {
        if (action.password !== undefined) throw new TypeError('passwordAction remove has extra password');
        result.passwordAction = { type: 'remove' };
      } else if (action.type === 'set') {
        result.passwordAction = {
          type: 'set',
          password: requiredString(action.password, 'password', 64, { minimum: 6, trim: false }),
        };
      } else {
        throw new TypeError('passwordAction type is invalid');
      }
    }
    if (Object.keys(result).length === 1) throw new TypeError('room update must contain a change');
    return result;
  },
  'room/delete'(payload) {
    const value = exactKeys(payload, ['roomCode'], 'room/delete payload');
    return { roomCode: roomCode(value.roomCode) };
  },
  'report/create'(payload) {
    const value = exactKeys(payload, ['messageId', 'reason'], 'report/create payload');
    return {
      messageId: requiredString(value.messageId, 'messageId', 128),
      ...(value.reason === undefined ? {} : { reason: optionalString(value.reason, 'reason', 200) }),
    };
  },
};

export function parseExtensionMessage(input) {
  const envelope = exactKeys(input, ['action', 'payload'], 'extension message');
  if (typeof envelope.action !== 'string' || !Object.hasOwn(validators, envelope.action)) {
    throw new TypeError('unknown extension action');
  }
  const payload = validators[envelope.action](envelope.payload ?? {}, envelope.action);
  return { action: envelope.action, payload };
}

export const EXTENSION_ACTIONS = Object.freeze(Object.keys(validators));
