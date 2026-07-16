import test from 'node:test';
import assert from 'node:assert/strict';

const identity = await import('../src/core/client-identity.js').catch(() => ({}));

test('client identity falls back to one process-local id when keyring access fails', async () => {
  assert.equal(typeof identity.createClientIdProvider, 'function');
  let generated = 0;
  const provider = identity.createClientIdProvider({
    load: async () => { throw new Error('keyring unavailable'); },
    save: async () => { throw new Error('keyring unavailable'); },
    generate: () => { generated += 1; return 'process-local-id'; },
  });

  assert.equal(await provider.get(), 'process-local-id');
  assert.equal(await provider.get(), 'process-local-id');
  assert.equal(generated, 1);
});
