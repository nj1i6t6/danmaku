import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionStorage } from '../src/extension/storage.js';

function fakeChromeStorage({ failCredentialWrites = false } = {}) {
  const values = {};
  const calls = [];
  return {
    calls,
    values,
    chromeApi: {
      runtime: {},
      storage: {
        local: {
          async setAccessLevel(options) { calls.push(['access', options]); },
          async get(keys) {
            calls.push(['get', keys]);
            if (typeof keys === 'string') return { [keys]: values[keys] };
            return { ...values };
          },
          async set(items) {
            calls.push(['set', items]);
            if (failCredentialWrites && Object.hasOwn(items, 'danmaku.extension.credentials.v1')) {
              throw new Error('disk exploded secret-value');
            }
            Object.assign(values, structuredClone(items));
          },
          async remove(keys) {
            calls.push(['remove', keys]);
            for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
          },
        },
      },
    },
  };
}

test('extension storage restricts local storage to trusted contexts before use', async () => {
  const fake = fakeChromeStorage();
  const storage = createExtensionStorage(fake.chromeApi);
  await storage.initialize();
  assert.deepEqual(fake.calls[0], ['access', { accessLevel: 'TRUSTED_CONTEXTS' }]);
});

test('extension storage persists normalized public state and keeps credentials in a separate opaque record', async () => {
  const fake = fakeChromeStorage();
  const storage = createExtensionStorage(fake.chromeApi);
  await storage.initialize();
  await storage.saveState({ settings: { ball: { size: 500 } }, currentRoomCode: '12345678' });
  await storage.setOwnerCredential('12345678', 'owner-secret');

  const state = await storage.loadState();
  assert.equal(state.settings.ball.size, 96);
  assert.equal(state.currentRoomCode, '12345678');
  assert.equal(await storage.hasOwnerCredential('12345678'), true);
  assert.equal(await storage.getOwnerCredential('12345678'), 'owner-secret');
  assert.doesNotMatch(JSON.stringify(state), /owner-secret/);
});

test('credential persistence failure rejects and never falls back to a content-readable value', async () => {
  const fake = fakeChromeStorage({ failCredentialWrites: true });
  const storage = createExtensionStorage(fake.chromeApi);
  await storage.initialize();
  await assert.rejects(storage.setOwnerCredential('12345678', 'owner-secret'));
  assert.equal(await storage.hasOwnerCredential('12345678'), false);
  assert.doesNotMatch(JSON.stringify(fake.values), /owner-secret/);
});
