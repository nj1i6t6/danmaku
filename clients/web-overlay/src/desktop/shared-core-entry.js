export {
  APPEARANCE_DEFAULTS,
  APPEARANCE_LIMITS,
  TEXT_LIMITS,
  normalizeSettings,
  resetAppearance,
} from '../core/settings-contract.js';
export { createSettingsStore } from '../core/settings-store.js';
export {
  SEND_KINDS,
  canSubmit,
  createSendState,
  describeSendButton,
  describeSendState,
  interpretBarrageAck,
  reduceSendState,
  remainingMs,
  settleDraft,
  settleExpiredDraft,
} from '../core/send-state.js';
export {
  createJoinedRoomStore,
  createRoomCommandQueue,
  createRoomTransitionGate,
  findDefaultRoom,
  normalizeRoom,
  normalizeRoomList,
  roomExitAction,
  roomExpiryHint,
  validRoomCode,
} from '../core/room-model.js';
export { createClientIdProvider } from '../core/client-identity.js';
export { positionAdjacentOverlay } from '../core/overlay-layout.js';
export { appendTextElement, renderRoomName, replaceTextList } from '../core/safe-render.js';
export {
  createColorDraft,
  hexToHsv,
  hsvToHex,
  hsvToRgb,
  rgbToHsv,
} from '../core/hsv-color-picker.js';

export { createDesktopJoinedRoomStore, createDesktopSettingsAdapter } from './settings-adapter.js';
export { createOverlayController } from '../core/overlay-controller.js';
export { initRoomManager } from '../core/room-manager.js';
export { mountOverlay } from '../core/overlay-template.js';

export const DANMAKU_SERVER_URL = __DANMAKU_SERVER_URL__;
