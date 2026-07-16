'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

class KdfBusyError extends Error {
  constructor() {
    super('password KDF queue is full');
    this.code = 'KDF_BUSY';
  }
}

function createKdfLimiter({ concurrency = 2, maxQueue = 16, derive = scrypt } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be positive');
  if (!Number.isInteger(maxQueue) || maxQueue < 0) throw new TypeError('maxQueue must be non-negative');
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active += 1;
      Promise.resolve(derive(...job.args)).then(job.resolve, job.reject).finally(() => {
        active -= 1;
        drain();
      });
    }
  };
  return {
    run(...args) {
      if (active >= concurrency && queue.length >= maxQueue) return Promise.reject(new KdfBusyError());
      return new Promise((resolve, reject) => {
        queue.push({ args, resolve, reject });
        drain();
      });
    },
  };
}

const passwordKdf = createKdfLimiter();

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function issueCredential() {
  return crypto.randomBytes(32).toString('base64url');
}

async function passwordDigest(password, salt = crypto.randomBytes(16)) {
  return { salt, hash: await passwordKdf.run(password, salt, 32) };
}

function safeEqual(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left || '');
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function verifyPassword(password, salt, expected) {
  if (!salt || !expected || typeof password !== 'string') return false;
  return safeEqual(await passwordKdf.run(password, salt, expected.length), expected);
}

module.exports = { KdfBusyError, createKdfLimiter, hashSecret, issueCredential, passwordDigest, safeEqual, verifyPassword };
