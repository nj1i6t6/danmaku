'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { passwordDigest, verifyPassword, createKdfLimiter } = require('../rooms/credentials');

test('password KDF is asynchronous and verifies a digest without blocking the caller API', async () => {
  const pending = passwordDigest('secret1');
  assert.equal(typeof pending?.then, 'function');
  const digest = await pending;
  assert.equal(await verifyPassword('secret1', digest.salt, digest.hash), true);
  assert.equal(await verifyPassword('wrongxx', digest.salt, digest.hash), false);
});

test('KDF limiter bounds active work and rejects a full waiting queue', async () => {
  const releases = [];
  const limiter = createKdfLimiter({
    concurrency: 1,
    maxQueue: 1,
    derive: () => new Promise((resolve) => releases.push(resolve)),
  });
  const first = limiter.run('first');
  const second = limiter.run('second');
  await assert.rejects(limiter.run('third'), { code: 'KDF_BUSY' });
  releases.shift()(Buffer.from('one'));
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  releases.shift()(Buffer.from('two'));
  assert.deepEqual(await second, Buffer.from('two'));
});
