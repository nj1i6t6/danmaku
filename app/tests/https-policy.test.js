'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server');

function request(url, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers }, (res) => {
      res.resume();
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.once('error', reject);
    req.end();
  });
}

async function withService(options, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-https-policy-'));
  const service = createServer({
    dbPath: path.join(dir, 'test.db'),
    port: 0,
    logger: { log() {}, warn() {}, error() {} },
    ...options,
  });
  try {
    const address = await service.listen();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('trusted loopback proxy redirects HTTP to the fixed public HTTPS origin', async () => {
  await withService({
    trustCloudflareProxy: true,
    enforceHttps: true,
    publicOrigin: 'https://danmaku.kolvid.app',
  }, async (url) => {
    const response = await request(`${url}/healthz?probe=transport`, {
      headers: {
        Host: 'attacker.invalid',
        'X-Forwarded-Proto': 'http',
      },
    });
    assert.equal(response.status, 308);
    assert.equal(response.headers.location, 'https://danmaku.kolvid.app/healthz?probe=transport');
  });
});

test('trusted HTTPS response includes transport and browser capability hardening headers', async () => {
  await withService({
    trustCloudflareProxy: true,
    enforceHttps: true,
    publicOrigin: 'https://danmaku.kolvid.app',
  }, async (url) => {
    const response = await request(`${url}/healthz`, {
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers['strict-transport-security'], 'max-age=31536000');
    assert.equal(
      response.headers['permissions-policy'],
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    );
  });
});

test('trusted HTTP proxy traffic cannot open a plaintext Socket.IO handshake', async () => {
  await withService({
    trustCloudflareProxy: true,
    enforceHttps: true,
    publicOrigin: 'https://danmaku.kolvid.app',
  }, async (url) => {
    const response = await request(`${url}/socket.io/?EIO=4&transport=polling`, {
      headers: { 'X-Forwarded-Proto': 'http' },
    });
    assert.equal(response.status, 403);
  });
});

test('untrusted direct clients cannot activate HTTPS proxy behavior with forged headers', async () => {
  await withService({
    trustCloudflareProxy: false,
    enforceHttps: true,
    publicOrigin: 'https://danmaku.kolvid.app',
  }, async (url) => {
    const response = await request(`${url}/healthz`, {
      headers: { 'X-Forwarded-Proto': 'http' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.location, undefined);
    assert.equal(response.headers['strict-transport-security'], undefined);
  });
});
