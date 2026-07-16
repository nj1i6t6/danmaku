import { normalizeSettings, resetAppearance } from './settings-contract.js';

export function createSettingsStore(adapter, key = 'danmaku-overlay-settings') {
  if (!adapter || typeof adapter.get !== 'function' || typeof adapter.set !== 'function') {
    throw new TypeError('settings adapter must implement async get/set');
  }

  async function load() {
    try {
      return normalizeSettings(await adapter.get(key));
    } catch {
      return normalizeSettings();
    }
  }

  async function save(value) {
    const normalized = normalizeSettings(value);
    await adapter.set(key, normalized);
    return normalized;
  }

  return {
    load,
    save,
    async resetAppearance() {
      return save(resetAppearance(await load()));
    },
  };
}
