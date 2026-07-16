const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const ROOM_CODE = /^\d{8}$/;

export const APPEARANCE_DEFAULTS = Object.freeze({
  ball: Object.freeze({ color: '#58A6FF', size: 56, opacity: 0.9 }),
  danmaku: Object.freeze({ color: '#E6EDF3', size: 20, opacity: 0.9 }),
  input: Object.freeze({ color: '#1A1A2E', size: 16, opacity: 0.8 }),
  panel: Object.freeze({ width: 320, height: 0 }),
  ballPosition: Object.freeze({ x: null, y: 100 }),
  danmakuVisible: true,
  onboarded: false,
});

export const TEXT_LIMITS = Object.freeze({
  message: 100,
  nickname: 6,
  history: 200,
});

export const APPEARANCE_LIMITS = Object.freeze({
  ballSize: Object.freeze([32, 96]),
  danmakuSize: Object.freeze([12, 48]),
  inputSize: Object.freeze([12, 32]),
  opacity: Object.freeze([0.1, 1]),
  panelWidth: Object.freeze([280, 800]),
  panelHeight: Object.freeze([0, 800]),
});

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, [minimum, maximum], fallback) {
  return Math.min(maximum, Math.max(minimum, finiteNumber(value, fallback)));
}

function color(value, fallback) {
  return HEX_COLOR.test(String(value || '')) ? String(value).toUpperCase() : fallback;
}

function roomCode(value) {
  const normalized = String(value || '').trim();
  return ROOM_CODE.test(normalized) ? normalized : null;
}

function stringList(value, predicate = () => true) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item)).filter(predicate))];
}

function pointCoordinate(value, fallback) {
  if (value === null) return null;
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function cloneAppearance() {
  return {
    ball: { ...APPEARANCE_DEFAULTS.ball },
    danmaku: { ...APPEARANCE_DEFAULTS.danmaku },
    input: { ...APPEARANCE_DEFAULTS.input },
    panel: { ...APPEARANCE_DEFAULTS.panel },
    ballPosition: { ...APPEARANCE_DEFAULTS.ballPosition },
    danmakuVisible: APPEARANCE_DEFAULTS.danmakuVisible,
    onboarded: APPEARANCE_DEFAULTS.onboarded,
  };
}

export function normalizeSettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const defaults = cloneAppearance();
  const ball = source.ball && typeof source.ball === 'object' ? source.ball : {};
  const danmaku = source.danmaku && typeof source.danmaku === 'object' ? source.danmaku : {};
  const input = source.input && typeof source.input === 'object' ? source.input : {};
  const panel = source.panel && typeof source.panel === 'object' ? source.panel : {};
  const position = source.ballPosition && typeof source.ballPosition === 'object' ? source.ballPosition : {};

  return {
    ...defaults,
    ...(typeof source.clientId === 'string' && source.clientId ? { clientId: source.clientId } : {}),
    nickname: typeof source.nickname === 'string' && source.nickname ? source.nickname.slice(0, 6) : '匿名',
    ...(typeof source.nicknameChangeDate === 'string' ? { nicknameChangeDate: source.nicknameChangeDate } : {}),
    ...(roomCode(source.currentRoomCode) ? { currentRoomCode: roomCode(source.currentRoomCode) } : {}),
    ...(roomCode(source.defaultRoomCode) ? { defaultRoomCode: roomCode(source.defaultRoomCode) } : {}),
    joinedRoomCodes: stringList(source.joinedRoomCodes, (code) => ROOM_CODE.test(code)),
    ownerCredentialKeys: stringList(source.ownerCredentialKeys, (key) => /^room-owner:\d{8}$/.test(key)),
    ball: {
      color: color(ball.color, defaults.ball.color),
      size: clamp(ball.size, APPEARANCE_LIMITS.ballSize, defaults.ball.size),
      opacity: clamp(ball.opacity, APPEARANCE_LIMITS.opacity, defaults.ball.opacity),
    },
    danmaku: {
      color: color(danmaku.color, defaults.danmaku.color),
      size: clamp(danmaku.size, APPEARANCE_LIMITS.danmakuSize, defaults.danmaku.size),
      opacity: clamp(danmaku.opacity, APPEARANCE_LIMITS.opacity, defaults.danmaku.opacity),
    },
    input: {
      color: color(input.color, defaults.input.color),
      size: clamp(input.size, APPEARANCE_LIMITS.inputSize, defaults.input.size),
      opacity: clamp(input.opacity, APPEARANCE_LIMITS.opacity, defaults.input.opacity),
    },
    panel: {
      width: clamp(panel.width, APPEARANCE_LIMITS.panelWidth, defaults.panel.width),
      height: clamp(panel.height, APPEARANCE_LIMITS.panelHeight, defaults.panel.height),
    },
    ballPosition: {
      x: pointCoordinate(position.x, defaults.ballPosition.x),
      y: pointCoordinate(position.y, defaults.ballPosition.y),
    },
    danmakuVisible: source.danmakuVisible == null ? defaults.danmakuVisible : Boolean(source.danmakuVisible),
    onboarded: source.onboarded == null ? defaults.onboarded : Boolean(source.onboarded),
  };
}

export function resetAppearance(value = {}) {
  const current = normalizeSettings(value);
  return normalizeSettings({
    ...current,
    ...cloneAppearance(),
  });
}
