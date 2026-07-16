import {
  normalizeSettings,
  resetAppearance as resetAppearanceContract,
} from '../core/settings-contract.js';
import { validRoomCode } from '../core/room-model.js';

const DEFAULT_KEY = 'danmaku-overlay-settings';
const LEGACY_JOINED_ROOM_KEY = 'danmaku-overlay-joined-room-codes';

function migrateLegacySettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (value.ballPosition !== undefined || !value.ballPos || typeof value.ballPos !== 'object') return value;
  return { ...value, ballPosition: value.ballPos };
}

export function createDesktopSettingsAdapter(storage, key = DEFAULT_KEY) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new TypeError('Desktop settings storage must implement getItem/setItem');
  }

  function load() {
    try {
      const raw = storage.getItem(key);
      return normalizeSettings(raw ? migrateLegacySettings(JSON.parse(raw)) : {});
    } catch {
      return normalizeSettings();
    }
  }

  function save(value) {
    const normalized = normalizeSettings(value);
    storage.setItem(key, JSON.stringify(normalized));
    return normalized;
  }

  return {
    load,
    save,
    resetAppearance(value = load()) {
      return save(resetAppearanceContract(value));
    },
  };
}

function validJoinedCodes(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((code) => String(code)).filter(validRoomCode))]
    : [];
}

/**
 * Desktop-only bridge for the old shortcut key. After construction, settings
 * is the sole authority; the legacy key is read only for this one migration.
 */
export function createDesktopJoinedRoomStore({
  getSettings,
  saveSettings,
  legacyStorage = globalThis.localStorage,
  legacyKey = LEGACY_JOINED_ROOM_KEY,
} = {}) {
  if (typeof getSettings !== 'function') throw new TypeError('Desktop joined room getSettings adapter is required');
  if (typeof saveSettings !== 'function') throw new TypeError('Desktop joined room saveSettings adapter is required');

  function currentSettings() {
    const value = getSettings();
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function readLegacyCodes() {
    if (!legacyStorage || typeof legacyStorage.getItem !== 'function') return { present: false, codes: [] };
    try {
      const raw = legacyStorage.getItem(legacyKey);
      if (raw == null) return { present: false, codes: [] };
      try {
        return { present: true, codes: validJoinedCodes(JSON.parse(raw)) };
      } catch {
        return { present: true, codes: [] };
      }
    } catch {
      return { present: false, codes: [] };
    }
  }

  let legacyCleanupPending = false;

  function cleanupOrMirrorLegacy(codes) {
    if (!legacyStorage) return;
    try {
      if (typeof legacyStorage.removeItem !== 'function') throw new Error('legacy joined room cleanup unavailable');
      legacyStorage.removeItem(legacyKey);
      if (typeof legacyStorage.getItem === 'function' && legacyStorage.getItem(legacyKey) != null) {
        throw new Error('legacy joined room cleanup did not remove the key');
      }
      legacyCleanupPending = false;
    } catch {
      legacyCleanupPending = true;
      if (typeof legacyStorage.setItem !== 'function') throw new Error('legacy joined room cleanup failed');
      legacyStorage.setItem(legacyKey, JSON.stringify(validJoinedCodes(codes)));
    }
  }

  function migrate() {
    const legacy = readLegacyCodes();
    if (!legacy.present) return;
    let saved;
    try {
      const settings = currentSettings();
      const merged = [...new Set([...validJoinedCodes(settings.joinedRoomCodes), ...legacy.codes])];
      saved = saveSettings({ ...settings, joinedRoomCodes: merged });
    } catch {
      return;
    }
    try {
      cleanupOrMirrorLegacy(saved?.joinedRoomCodes);
    } catch {
      // The settings authority already contains every legacy code. Keep trying
      // to remove or mirror the compatibility key on later writes.
      legacyCleanupPending = true;
    }
  }

  migrate();

  function saveCodes(codes) {
    const previous = currentSettings();
    const saved = saveSettings({ ...previous, joinedRoomCodes: validJoinedCodes(codes) });
    if (legacyCleanupPending) {
      try {
        cleanupOrMirrorLegacy(saved?.joinedRoomCodes);
      } catch {
        try { saveSettings(previous); } catch { /* Preserve the original storage failure. */ }
        throw new Error('legacy joined room synchronization failed');
      }
    }
    return saved;
  }

  return {
    list() {
      return validJoinedCodes(currentSettings().joinedRoomCodes);
    },
    add(value) {
      const code = String(typeof value === 'string' ? value : value?.roomCode || '');
      if (!validRoomCode(code)) return;
      return saveCodes([code, ...this.list().filter((item) => item !== code)]);
    },
    remove(value) {
      const code = String(value || '');
      return saveCodes(this.list().filter((item) => item !== code));
    },
  };
}
