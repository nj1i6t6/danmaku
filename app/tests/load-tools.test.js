'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

test('load provisioning output never serializes owner credentials', () => {
  const source = fs.readFileSync(path.join(root, 'load-tests', 'provision-rooms.js'), 'utf8');
  assert.doesNotMatch(source, /ownerCredential\s*:/);
  assert.doesNotMatch(source, /response\.ownerCredential/);
});

test('staging secret assertion allows only the create ACK top-level owner credential', () => {
  const { assertNoSecrets } = require(path.join(root, 'load-tests', 'staging-contract.js'));
  const ownerCredential = 'A'.repeat(43);
  assert.doesNotThrow(() => assertNoSecrets({
    ok: true,
    ownerCredential,
    room: { roomCode: '12345678', name: '安全房間' },
    recentMessages: [],
  }, { allowTopLevelOwnerCredential: true }));
  assert.throws(() => assertNoSecrets({
    ok: true,
    ownerCredential,
    room: { roomCode: '12345678', ownerCredential },
  }, { allowTopLevelOwnerCredential: true }), /ownerCredential|credential/i);
  assert.throws(() => assertNoSecrets({
    ok: true,
    data: [{ roomCode: '12345678', ownerCredential }],
  }), /ownerCredential|credential/i);
});

test('staging cleanup reports delete failures without exposing owner credentials', async () => {
  const { cleanupCreatedRooms } = require(path.join(root, 'load-tests', 'staging-contract.js'));
  const rooms = [
    { socket: { connected: true }, roomCode: '11111111', ownerCredential: 'A'.repeat(43) },
    { socket: { connected: true }, roomCode: '22222222', ownerCredential: 'B'.repeat(43) },
    { socket: { connected: false }, roomCode: '33333333', ownerCredential: 'C'.repeat(43) },
  ];
  const failures = await cleanupCreatedRooms(rooms, async (_socket, _event, payload) => {
    if (payload.roomCode === '22222222') throw new Error('network cleanup failure');
    return { ok: true };
  });
  assert.deepEqual(failures, [
    { roomCode: '33333333', code: 'SOCKET_DISCONNECTED' },
    { roomCode: '22222222', code: 'CLEANUP_FAILED' },
  ]);
  assert.doesNotMatch(JSON.stringify(failures), /A{20}|B{20}|C{20}|ownerCredential/);
});

test('load server raises lookup capacity only through explicit createServer options', () => {
  const staging = fs.readFileSync(path.join(root, 'load-tests', 'staging-server.js'), 'utf8');
  const production = fs.readFileSync(path.join(root, 'app', 'server.js'), 'utf8');
  assert.match(staging, /createServer\([\s\S]*accessGuardOptions[\s\S]*lookupLimit/);
  assert.doesNotMatch(production, /LOAD_TEST_MODE|LOAD_TEST_LOOKUP_LIMIT/);
});

test('process sampler parses RX/TX bytes for the selected network interface', () => {
  const { parseNetworkDev } = require(path.join(root, 'load-tests', 'process-sampler.js'));
  const sample = `Inter-|   Receive                                                |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n    lo: 1200 1 0 0 0 0 0 0 3400 2 0 0 0 0 0 0\n  eth0: 10 1 0 0 0 0 0 0 20 2 0 0 0 0 0 0\n`;
  assert.deepEqual(parseNetworkDev(sample, 'lo'), { rxBytes: 1200, txBytes: 3400 });
  assert.throws(() => parseNetworkDev(sample, 'missing'), /not found/);
});

test('delivery latency tracker handles ack-before-delivery and delivery-before-ack', () => {
  const { DeliveryLatencyTracker } = require(path.join(root, 'load-tests', 'delivery-latency-tracker.js'));
  const tracker = new DeliveryLatencyTracker();
  tracker.accepted('ack-first', 100);
  tracker.observed('ack-first', 135);
  tracker.observed('delivery-first', 220);
  tracker.accepted('delivery-first', 200);
  assert.deepEqual(tracker.latencies, [35, 20]);
  assert.equal(tracker.pendingCount, 0);
});

test('load matrix accepts the default room only from the dedicated metadata response', () => {
  const { defaultRoomFromResponse } = require(path.join(root, 'load-tests', 'matrix-gates.js'));
  const room = defaultRoomFromResponse({
    ok: true,
    room: { roomCode: '12345678', name: '系統入口', capacity: 1000, retentionDays: null },
  });
  assert.deepEqual(room, { roomCode: '12345678', roomName: '系統入口', capacity: 1000 });
  assert.throws(
    () => defaultRoomFromResponse({ ok: true, data: [{ roomCode: '87654321', name: '預設', capacity: 1000 }] }),
    /dedicated room-default response/,
  );
});

test('server event-loop metrics are summarized only inside the stage window', () => {
  const { summarizeEventLoopJsonl } = require(path.join(root, 'load-tests', 'matrix-gates.js'));
  const jsonl = [
    { at: '2026-07-14T00:00:00.000Z', count: 5, meanMs: 99, p50Ms: 99, p95Ms: 99, p99Ms: 99, maxMs: 99 },
    { at: '2026-07-14T00:00:01.000Z', count: 10, meanMs: 2, p50Ms: 1, p95Ms: 8, p99Ms: 10, maxMs: 12 },
    { at: '2026-07-14T00:00:02.000Z', count: 30, meanMs: 4, p50Ms: 3, p95Ms: 18, p99Ms: 25, maxMs: 30 },
  ].map(JSON.stringify).join('\n');
  assert.deepEqual(summarizeEventLoopJsonl(jsonl, {
    startedAt: '2026-07-14T00:00:00.500Z',
    finishedAt: '2026-07-14T00:00:02.500Z',
  }), {
    sampleCount: 2,
    observationCount: 40,
    meanMs: 3.5,
    p50Ms: 3,
    p95Ms: 18,
    p99Ms: 25,
    maxMs: 30,
  });
});

test('server process metrics exclude sampler padding outside the load window', () => {
  const { summarizeSamplerWindow } = require(path.join(root, 'load-tests', 'matrix-gates.js'));
  const sample = (at, cpu, rss, bytes, latencyMs) => ({
    at,
    cpuPercentSingleCore: cpu,
    rssBytes: rss,
    threads: 8,
    fileDescriptors: 100,
    network: {
      interface: 'lo', scope: 'network-namespace', rxBytes: bytes, txBytes: bytes,
      rxBytesPerSecond: cpu * 10, txBytesPerSecond: cpu * 10,
    },
    health: { ok: true, statusCode: 200, latencyMs },
  });
  const summary = summarizeSamplerWindow([
    sample('2026-07-14T00:00:00.000Z', 99, 9999, 100, 99),
    sample('2026-07-14T00:00:01.000Z', 10, 100, 1000, 1),
    sample('2026-07-14T00:00:02.000Z', 20, 200, 1300, 2),
    sample('2026-07-14T00:00:03.000Z', 88, 8888, 9999, 88),
    { at: '2026-07-14T00:00:04.000Z', processError: 'sampler failed after load' },
  ], {
    startedAt: '2026-07-14T00:00:00.500Z',
    finishedAt: '2026-07-14T00:00:02.500Z',
  });
  assert.equal(summary.sampleCount, 2);
  assert.deepEqual(summary.processErrors, ['sampler failed after load']);
  assert.deepEqual(summary.cpuSingleCore, { meanPercent: 15, p95Percent: 20, maxPercent: 20 });
  assert.deepEqual(summary.rss, { maxBytes: 200 });
  assert.deepEqual(summary.network, {
    interface: 'lo', scope: 'network-namespace', rxBytesDelta: 300, txBytesDelta: 300,
    rxBytesPerSecond: { mean: 150, p95: 200, max: 200 },
    txBytesPerSecond: { mean: 150, p95: 200, max: 200 },
  });
  assert.deepEqual(summary.healthLatency, { p50Ms: 1, p95Ms: 2, p99Ms: 2, failures: 0 });
});

function validStageResults() {
  const latency = (samples) => ({ samples, p50Ms: 1, p95Ms: 2, p99Ms: 3, maxMs: 4 });
  return {
    expectedClients: 100,
    load: {
      clientsTarget: 100,
      clientsConnectedAndJoined: 100,
      durationSeconds: 10,
      totalMessagesPerSecond: 10,
      roomPlan: [{ roomCode: '12345678', clients: 100, messageRatePerSecond: 10 }],
      connectLatency: latency(100),
      joinLatency: latency(100),
      ackLatency: latency(100),
      deliveryLatency: latency(100),
      ack: { sent: 100, queued: 0, rejected: 0, timeout: 0, errorsByCode: {} },
      queueStatus: { delivered: 0, expired: 0, stillPendingAtShutdown: 0 },
      observedDeliveries: 100,
      unexpectedDisconnects: 0,
      loadGeneratorEventLoopLag: { meanMs: 1, p95Ms: 2, p99Ms: 3, maxMs: 4 },
    },
    sampler: {
      sampleCount: 10,
      cpuSingleCore: { meanPercent: 10, p95Percent: 20, maxPercent: 30 },
      rss: { maxBytes: 1024 },
      fileDescriptors: { max: 120 },
      threads: { max: 8 },
      healthLatency: { p50Ms: 1, p95Ms: 2, p99Ms: 3, failures: 0 },
      network: {
        interface: 'lo', scope: 'network-namespace', rxBytesDelta: 1000, txBytesDelta: 1000,
        rxBytesPerSecond: { mean: 100, p95: 200, max: 300 },
        txBytesPerSecond: { mean: 100, p95: 200, max: 300 },
      },
      samples: [{ health: { ok: true, statusCode: 200, latencyMs: 1 } }],
    },
    serverEventLoop: { sampleCount: 10, observationCount: 100, meanMs: 1, p50Ms: 1, p95Ms: 2, p99Ms: 3, maxMs: 4 },
  };
}

test('load stage gate fails closed on correctness errors or missing promised metrics', () => {
  const { evaluateStage } = require(path.join(root, 'load-tests', 'matrix-gates.js'));
  assert.deepEqual(evaluateStage(validStageResults()), {
    ok: true,
    failures: [],
    performanceLimits: 'observational-only: no numeric SLO is declared in the authoritative specification',
  });

  const cases = [
    ['CLIENT_JOIN_SHORTFALL', ({ load }) => { load.clientsConnectedAndJoined = 99; }],
    ['ACK_TIMEOUT', ({ load }) => { load.ack.timeout = 1; load.ackLatency.samples = 101; }],
    ['UNEXPECTED_DISCONNECT', ({ load }) => { load.unexpectedDisconnects = 1; }],
    ['ACK_REJECTED', ({ load }) => { load.ack.rejected = 1; load.ackLatency.samples = 101; }],
    ['QUEUE_EXPIRED', ({ load }) => { load.queueStatus.expired = 1; }],
    ['DELIVERY_PENDING', ({ load }) => { load.queueStatus.stillPendingAtShutdown = 1; }],
    ['DELIVERY_SAMPLES_MISSING', ({ load }) => { load.deliveryLatency.samples = 0; }],
    ['HEALTH_FAILURE', ({ sampler }) => { sampler.healthLatency.failures = 1; }],
    ['SAMPLER_PROCESS_ERROR', ({ sampler }) => { sampler.samples = [{ processError: 'gone' }]; }],
    ['SERVER_EVENT_LOOP_MISSING', ({ serverEventLoop }) => { serverEventLoop.sampleCount = 0; }],
  ];
  for (const [expectedCode, mutate] of cases) {
    const results = validStageResults();
    mutate(results);
    const gate = evaluateStage(results);
    assert.equal(gate.ok, false, expectedCode);
    assert.equal(gate.failures.some((failure) => failure.code === expectedCode), true, JSON.stringify(gate));
  }
});

test('load stage gate requires the promised message rate to be exercised', () => {
  const { evaluateStage } = require(path.join(root, 'load-tests', 'matrix-gates.js'));
  const results = validStageResults();
  results.load.ack = { sent: 1, queued: 0, rejected: 0, timeout: 0, errorsByCode: {} };
  results.load.ackLatency.samples = 1;
  results.load.deliveryLatency.samples = 1;
  results.load.observedDeliveries = 1;
  const gate = evaluateStage(results);
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.failures.find((failure) => failure.code === 'LOAD_NOT_SUSTAINED'), {
    code: 'LOAD_NOT_SUSTAINED',
    actual: 1,
    expected: '>= 99',
  });
});

test('load stage gate requires every promised metric family and honest network scope', () => {
  const { evaluateStage } = require(path.join(root, 'load-tests', 'matrix-gates.js'));
  const results = validStageResults();
  results.load.deliveryLatency.p99Ms = null;
  results.load.loadGeneratorEventLoopLag.maxMs = null;
  results.sampler.cpuSingleCore.p95Percent = null;
  results.sampler.rss.maxBytes = null;
  results.sampler.fileDescriptors.max = null;
  results.sampler.threads.max = null;
  results.sampler.healthLatency.p99Ms = null;
  results.sampler.network.txBytesPerSecond.p95 = null;
  results.sampler.network.scope = 'process';
  results.serverEventLoop.p99Ms = null;

  const gate = evaluateStage(results);
  assert.equal(gate.ok, false);
  const missing = gate.failures.find((failure) => failure.code === 'PROMISED_METRIC_MISSING');
  assert.deepEqual(missing.actual, [
    'load.deliveryLatency.p99Ms',
    'load.loadGeneratorEventLoopLag.maxMs',
    'sampler.cpuSingleCore.p95Percent',
    'sampler.rss.maxBytes',
    'sampler.fileDescriptors.max',
    'sampler.threads.max',
    'sampler.healthLatency.p99Ms',
    'sampler.network.txBytesPerSecond.p95',
    'serverEventLoop.p99Ms',
  ]);
  assert.equal(gate.failures.some((failure) => failure.code === 'NETWORK_SCOPE_INVALID'), true);
});

test('load matrix binds measurements to the isolated staging PID and refuses production', () => {
  const { validateStagingProcess } = require(path.join(root, 'load-tests', 'matrix-gates.js'));
  const valid = {
    baseUrl: 'http://127.0.0.1:4400',
    serverPid: 1234,
    eventLoopMetricsPath: '/tmp/load-event-loop.jsonl',
    environText: [
      'PORT=4400',
      'DB_PATH=/tmp/load.db',
      'EVENT_LOOP_METRICS_PATH=/tmp/load-event-loop.jsonl',
      'NODE_OPTIONS=--require=/workspace/load-tests/event-loop-hook.js',
    ].join('\0'),
    cmdlineText: 'node\0load-tests/staging-server.js\0',
  };
  assert.deepEqual(validateStagingProcess(valid), {
    port: 4400,
    host: '127.0.0.1',
    databaseScope: 'temporary',
    eventLoopHook: true,
  });
  assert.throws(() => validateStagingProcess({ ...valid, baseUrl: 'http://127.0.0.1:3999' }), /production port 3999/);
  assert.throws(() => validateStagingProcess({ ...valid, environText: valid.environText.replace('PORT=4400', 'PORT=4401') }), /PID port does not match/);
  assert.throws(() => validateStagingProcess({ ...valid, environText: valid.environText.replace('/tmp/load.db', '/var/lib/stock-danmaku.db') }), /temporary DB_PATH/);
  assert.throws(() => validateStagingProcess({ ...valid, cmdlineText: 'node\0server.js\0' }), /staging-server/);
});

test('paired load children terminate the sibling when one child fails', async () => {
  const os = require('node:os');
  const { runToFile, waitForChildren } = require(path.join(root, 'load-tests', 'child-processes.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-danmaku-load-child-'));
  const marker = path.join(dir, 'terminated');
  fs.writeFileSync(path.join(dir, 'fail.js'), "setTimeout(() => process.exit(7), 50);\n");
  fs.writeFileSync(path.join(dir, 'long.js'), "const fs=require('node:fs'); process.on('SIGTERM',()=>{fs.writeFileSync(process.env.MARKER,'yes');process.exit(0)}); setInterval(()=>{},1000);\n");
  try {
    const failed = runToFile(path.join(dir, 'fail.js'), {}, path.join(dir, 'fail.out'), path.join(dir, 'fail.err'), { cwd: dir });
    const long = runToFile(path.join(dir, 'long.js'), { MARKER: marker }, path.join(dir, 'long.out'), path.join(dir, 'long.err'), { cwd: dir });
    const startedAt = Date.now();
    await assert.rejects(waitForChildren([failed, long]), /fail\.js failed \(7\)/);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'yes');
    assert.equal(Date.now() - startedAt < 3_000, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real load entry points use canonical default discovery and wire the fail-closed gate', () => {
  const readLoadTool = (name) => fs.readFileSync(path.join(root, 'load-tests', name), 'utf8');
  for (const name of ['staging-integration.js', 'room-load.js', 'run-load-matrix.js']) {
    const source = readLoadTool(name);
    assert.match(source, /['"]room-default['"]/, `${name} must use room-default`);
    assert.doesNotMatch(source, /query:\s*['"]預設['"]/, `${name} must not infer the default room from search`);
  }
  const staging = readLoadTool('staging-integration.js');
  assert.doesNotMatch(staging, /api\/owner-session|set-cookie|HttpOnly|SameSite|\bCookie\b/,
    'staging integration must not depend on retired Web cookie authority');
  const matrix = readLoadTool('run-load-matrix.js');
  assert.match(matrix, /summarizeEventLoopJsonl\(/);
  assert.match(matrix, /summarizeSamplerWindow\(/);
  assert.match(matrix, /validateStagingProcess\(/);
  assert.match(matrix, /waitForChildren\(\[load, sampler\]\)/);
  assert.match(matrix, /evaluateStage\(/);
  assert.match(matrix, /gate:\s*gate/);
  assert.match(matrix, /if\s*\(!gate\.ok\)/);
});
