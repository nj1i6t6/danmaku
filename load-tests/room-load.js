'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { DeliveryLatencyTracker } = require('./delivery-latency-tracker');
const { defaultRoomFromResponse } = require('./matrix-gates');

const appRequire = createRequire(path.resolve(__dirname, '../app/package.json'));
const { io } = appRequire('socket.io-client');

function envInt(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

function latencySummary(values) {
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.50),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: values.length ? Number(Math.max(...values).toFixed(2)) : null,
  };
}

function emitAck(socket, event, payload, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    socket.timeout(timeoutMs).emit(event, payload, (error, response) => {
      resolve({
        transportError: error ? String(error.message || error) : null,
        response: error ? null : response,
        latencyMs: performance.now() - startedAt,
      });
    });
  });
}

function parseRoomCodes() {
  return (process.env.ROOM_CODES || process.env.ROOM_CODE || '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
}

async function resolveRoomPlan(baseUrl, clientsTarget) {
  const probe = io(baseUrl, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    timeout: 10_000,
    auth: { clientId: `load-discovery-${randomUUID()}` },
  });

  try {
    await new Promise((resolve, reject) => {
      probe.once('connect', resolve);
      probe.once('connect_error', reject);
    });

    let roomCodes = parseRoomCodes();
    if (roomCodes.length === 0) {
      const found = await emitAck(probe, 'room-default', {});
      if (found.transportError) throw new Error(`room discovery timeout: ${found.transportError}`);
      roomCodes = [defaultRoomFromResponse(found.response).roomCode];
    }

    const uniqueCodes = [...new Set(roomCodes)];
    const roomPlan = [];
    for (const roomCode of uniqueCodes) {
      if (!/^\d{8}$/.test(roomCode)) throw new Error(`invalid ROOM_CODES entry: ${roomCode}`);
      const lookup = await emitAck(probe, 'room-lookup', { roomCode });
      if (lookup.transportError) throw new Error(`room lookup timeout for ${roomCode}: ${lookup.transportError}`);
      if (!lookup.response?.ok) throw new Error(`room lookup failed for ${roomCode}: ${JSON.stringify(lookup.response)}`);
      const room = lookup.response.room;
      const capacity = Number(room?.capacity);
      if (!Number.isInteger(capacity) || capacity < 1) {
        throw new Error(`room ${roomCode} returned invalid capacity: ${JSON.stringify(room)}`);
      }
      roomPlan.push({
        roomCode,
        roomName: room.roomName || room.name || roomCode,
        capacity,
        messageRatePerSecond: capacity >= 1000 ? 10 : 5,
      });
    }

    const totalCapacity = roomPlan.reduce((sum, room) => sum + room.capacity, 0);
    if (totalCapacity < clientsTarget) {
      throw new Error(`room capacity ${totalCapacity} is below CLIENTS=${clientsTarget}; provide more ROOM_CODES`);
    }
    return roomPlan;
  } finally {
    probe.disconnect();
  }
}

function assignRooms(roomPlan, clientsTarget) {
  const assignments = [];
  for (const room of roomPlan) {
    const remaining = clientsTarget - assignments.length;
    if (remaining <= 0) break;
    const count = Math.min(room.capacity, remaining);
    for (let index = 0; index < count; index += 1) assignments.push(room);
  }
  if (assignments.length !== clientsTarget) throw new Error('unable to assign every client within room capacities');
  return assignments;
}

async function connectAndJoin({ baseUrl, room, index, metrics, deliveryObserver }) {
  const clientId = `load-${index}-${randomUUID()}`;
  const socket = io(baseUrl, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    timeout: 15_000,
    auth: { clientId },
  });

  const connectStartedAt = performance.now();
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  metrics.connectLatencyMs.push(performance.now() - connectStartedAt);

  socket.on('disconnect', (reason) => {
    if (!metrics.shuttingDown) {
      metrics.unexpectedDisconnects += 1;
      metrics.disconnectReasons[reason] = (metrics.disconnectReasons[reason] || 0) + 1;
    }
  });

  socket.on('barrage-status', (status) => {
    if (status?.status === 'delivered') metrics.queueDelivered += 1;
    if (status?.status === 'expired') metrics.queueExpired += 1;
  });

  if (deliveryObserver) {
    socket.on('barrage', (message) => {
      metrics.deliveryTracker.observed(message?.messageId, performance.now());
      metrics.observedDeliveries += 1;
    });
  }

  const joined = await emitAck(socket, 'join-room', { roomCode: room.roomCode });
  metrics.joinLatencyMs.push(joined.latencyMs);
  if (joined.transportError || !joined.response?.ok) {
    socket.disconnect();
    throw new Error(`join failed for client ${index} in ${room.roomCode}: ${joined.transportError || JSON.stringify(joined.response)}`);
  }

  return { socket, roomCode: room.roomCode };
}

function recordAck(metrics, roomMetrics, submittedAt, error, response) {
  const latencyMs = performance.now() - submittedAt;
  metrics.ackLatencyMs.push(latencyMs);
  roomMetrics.ackLatencyMs.push(latencyMs);
  if (error) {
    metrics.ackTimeout += 1;
    roomMetrics.timeout += 1;
    return;
  }
  if (response?.ok && response.status === 'sent') {
    metrics.ackSent += 1;
    roomMetrics.sent += 1;
  } else if (response?.ok && response.status === 'queued') {
    metrics.ackQueued += 1;
    roomMetrics.queued += 1;
  } else {
    metrics.ackRejected += 1;
    roomMetrics.rejected += 1;
    const code = response?.error?.code || 'UNKNOWN';
    metrics.errorsByCode[code] = (metrics.errorsByCode[code] || 0) + 1;
    roomMetrics.errorsByCode[code] = (roomMetrics.errorsByCode[code] || 0) + 1;
  }
  if (response?.messageId) metrics.deliveryTracker.accepted(response.messageId, submittedAt);
}

async function main() {
  const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4399';
  const clientsTarget = envInt('CLIENTS', 100, { min: 1, max: 10_000 });
  const durationSeconds = envInt('DURATION_SECONDS', 600, { min: 1, max: 86_400 });
  const overrideMessageRate = process.env.MESSAGES_PER_SECOND == null
    ? null
    : envInt('MESSAGES_PER_SECOND', 0, { min: 0, max: 1_000 });
  const batchSize = envInt('CONNECT_BATCH_SIZE', 50, { min: 1, max: 1_000 });
  const batchDelayMs = envInt('CONNECT_BATCH_DELAY_MS', 50, { min: 0, max: 60_000 });
  const roomPlan = await resolveRoomPlan(baseUrl, clientsTarget);
  const assignments = assignRooms(roomPlan, clientsTarget);
  const roomMetrics = Object.fromEntries(roomPlan.map((room) => [room.roomCode, {
    roomName: room.roomName,
    capacity: room.capacity,
    clients: assignments.filter((assigned) => assigned.roomCode === room.roomCode).length,
    messageRatePerSecond: overrideMessageRate ?? room.messageRatePerSecond,
    ackLatencyMs: [],
    sent: 0,
    queued: 0,
    rejected: 0,
    timeout: 0,
    errorsByCode: {},
  }]));

  const metrics = {
    baseUrl,
    clientsTarget,
    durationSeconds,
    connectLatencyMs: [],
    joinLatencyMs: [],
    ackLatencyMs: [],
    deliveryTracker: new DeliveryLatencyTracker(),
    ackSent: 0,
    ackQueued: 0,
    ackRejected: 0,
    ackTimeout: 0,
    queueDelivered: 0,
    queueExpired: 0,
    observedDeliveries: 0,
    unexpectedDisconnects: 0,
    disconnectReasons: {},
    errorsByCode: {},
    shuttingDown: false,
  };

  const clientLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  clientLoopDelay.enable();
  const socketEntries = [];
  const startedAt = new Date();
  const sendTimers = [];

  const shutdown = () => {
    metrics.shuttingDown = true;
    for (const timer of sendTimers) clearInterval(timer);
    for (const entry of socketEntries) entry.socket.disconnect();
  };

  process.once('SIGINT', () => {
    shutdown();
    process.exitCode = 130;
  });
  process.once('SIGTERM', () => {
    shutdown();
    process.exitCode = 143;
  });

  try {
    const firstClientByRoom = new Set();
    for (let start = 0; start < clientsTarget; start += batchSize) {
      const end = Math.min(clientsTarget, start + batchSize);
      const batch = [];
      for (let index = start; index < end; index += 1) {
        const room = assignments[index];
        const isObserver = !firstClientByRoom.has(room.roomCode);
        firstClientByRoom.add(room.roomCode);
        batch.push(connectAndJoin({ baseUrl, room, index, metrics, deliveryObserver: isObserver }));
      }
      socketEntries.push(...await Promise.all(batch));
      if (end < clientsTarget && batchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
      }
    }

    const entriesByRoom = new Map();
    for (const entry of socketEntries) {
      if (!entriesByRoom.has(entry.roomCode)) entriesByRoom.set(entry.roomCode, []);
      entriesByRoom.get(entry.roomCode).push(entry.socket);
    }

    for (const room of roomPlan) {
      const roomSockets = entriesByRoom.get(room.roomCode) || [];
      const rate = roomMetrics[room.roomCode].messageRatePerSecond;
      if (rate <= 0 || roomSockets.length === 0) continue;
      const senderCount = Math.min(roomSockets.length, Math.max(1, rate * 7));
      let sequence = 0;
      const intervalMs = Math.max(1, Math.floor(1000 / rate));
      const timer = setInterval(() => {
        const sender = roomSockets[sequence % senderCount];
        sequence += 1;
        if (!sender?.connected) return;
        const text = `壓測房${room.roomCode}第${sequence}則${Date.now()}`.slice(0, 48);
        const submittedAt = performance.now();
        sender.timeout(8_000).emit(
          'barrage',
          { text, nickname: '壓測', color: '#E6EDF3' },
          (error, response) => recordAck(metrics, roomMetrics[room.roomCode], submittedAt, error, response),
        );
      }, intervalMs);
      sendTimers.push(timer);
    }

    await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));
  } finally {
    shutdown();
    clientLoopDelay.disable();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const finishedAt = new Date();
  const summary = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedSeconds: Number(((finishedAt - startedAt) / 1000).toFixed(2)),
    baseUrl,
    clientsTarget,
    clientsConnectedAndJoined: socketEntries.length,
    durationSeconds,
    roomPlan: roomPlan.map((room) => ({ ...room, ...roomMetrics[room.roomCode], ackLatency: latencySummary(roomMetrics[room.roomCode].ackLatencyMs), ackLatencyMs: undefined })),
    totalMessagesPerSecond: Object.values(roomMetrics).reduce((sum, room) => sum + room.messageRatePerSecond, 0),
    connectLatency: latencySummary(metrics.connectLatencyMs),
    joinLatency: latencySummary(metrics.joinLatencyMs),
    ackLatency: latencySummary(metrics.ackLatencyMs),
    deliveryLatency: latencySummary(metrics.deliveryTracker.latencies),
    ack: {
      sent: metrics.ackSent,
      queued: metrics.ackQueued,
      rejected: metrics.ackRejected,
      timeout: metrics.ackTimeout,
      errorsByCode: metrics.errorsByCode,
    },
    queueStatus: {
      delivered: metrics.queueDelivered,
      expired: metrics.queueExpired,
      stillPendingAtShutdown: metrics.deliveryTracker.pendingCount,
    },
    observedDeliveries: metrics.observedDeliveries,
    unexpectedDisconnects: metrics.unexpectedDisconnects,
    disconnectReasons: metrics.disconnectReasons,
    loadGeneratorEventLoopLag: {
      meanMs: Number((clientLoopDelay.mean / 1e6).toFixed(2)),
      p95Ms: Number((clientLoopDelay.percentile(95) / 1e6).toFixed(2)),
      p99Ms: Number((clientLoopDelay.percentile(99) / 1e6).toFixed(2)),
      maxMs: Number((clientLoopDelay.max / 1e6).toFixed(2)),
    },
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
