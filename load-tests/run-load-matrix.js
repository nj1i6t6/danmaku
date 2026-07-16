'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const {
  defaultRoomFromResponse,
  summarizeEventLoopJsonl,
  summarizeSamplerWindow,
  evaluateStage,
  validateStagingProcess,
} = require('./matrix-gates');
const { runToFile, waitForChildren } = require('./child-processes');

const root = path.resolve(__dirname, '..');
const appRequire = createRequire(path.join(root, 'app', 'package.json'));
const { io } = appRequire('socket.io-client');

function positiveInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function runCaptured(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(script)} failed (${code ?? signal}): ${stderr.slice(-4000)}`));
    });
  });
}


function emitAck(socket, event, payload, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

async function discoverDefaultRoom(baseUrl) {
  const clientId = `load-matrix-discovery-${randomUUID()}`;
  const socket = io(baseUrl, {
    transports: ['websocket'], forceNew: true, reconnection: false, timeout: 10_000,
    auth: { clientId, platform: 'windows' }, query: { clientId },
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return defaultRoomFromResponse(await emitAck(socket, 'room-default', {}));
  } finally {
    socket.disconnect();
  }
}

function compactStage(load, sampler, serverEventLoop, gate) {
  return {
    startedAt: load.startedAt,
    finishedAt: load.finishedAt,
    elapsedSeconds: load.elapsedSeconds,
    clientsTarget: load.clientsTarget,
    clientsConnectedAndJoined: load.clientsConnectedAndJoined,
    durationSeconds: load.durationSeconds,
    totalMessagesPerSecond: load.totalMessagesPerSecond,
    connectLatency: load.connectLatency,
    joinLatency: load.joinLatency,
    ackLatency: load.ackLatency,
    deliveryLatency: load.deliveryLatency,
    ack: load.ack,
    queueStatus: load.queueStatus,
    unexpectedDisconnects: load.unexpectedDisconnects,
    loadGeneratorEventLoopLag: load.loadGeneratorEventLoopLag,
    serverEventLoop,
    gate: gate,
    server: {
      sampleCount: sampler.sampleCount,
      cpuSingleCore: sampler.cpuSingleCore,
      rss: sampler.rss,
      fileDescriptors: sampler.fileDescriptors,
      threads: sampler.threads,
      healthLatency: sampler.healthLatency,
      network: sampler.network,
    },
  };
}

async function main() {
  const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4399';
  const serverPid = positiveInt('SERVER_PID', 0);
  const durationSeconds = positiveInt('DURATION_SECONDS', 600);
  const samplerPaddingSeconds = positiveInt('SAMPLER_PADDING_SECONDS', 15);
  const eventLoopMetricsPath = process.env.EVENT_LOOP_METRICS_PATH;
  if (!eventLoopMetricsPath || !path.isAbsolute(eventLoopMetricsPath)) {
    throw new Error('EVENT_LOOP_METRICS_PATH must be an absolute path from the isolated staging server');
  }
  fs.accessSync(eventLoopMetricsPath, fs.constants.R_OK);
  const stagingBinding = validateStagingProcess({
    baseUrl,
    serverPid,
    eventLoopMetricsPath,
    environText: fs.readFileSync(`/proc/${serverPid}/environ`, 'utf8'),
    cmdlineText: fs.readFileSync(`/proc/${serverPid}/cmdline`, 'utf8'),
  });
  const stages = (process.env.STAGES || '100,500,1000,2000').split(',').map((value) => Number.parseInt(value.trim(), 10));
  if (!stages.length || stages.some((value) => ![100, 500, 1000, 2000].includes(value))) {
    throw new Error('STAGES may contain only 100,500,1000,2000');
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const resultDir = path.resolve(process.env.RESULT_DIR || path.join(__dirname, 'results', runId));
  fs.mkdirSync(resultDir, { recursive: true });

  const defaultRoom = await discoverDefaultRoom(baseUrl);
  const provisionText = await runCaptured(path.join(__dirname, 'provision-rooms.js'), {
    BASE_URL: baseUrl,
    CUSTOM_ROOMS: '10',
  });
  const provision = JSON.parse(provisionText);
  if (!Array.isArray(provision.rooms) || provision.rooms.length !== 10) throw new Error('expected ten provisioned custom rooms');
  if (JSON.stringify(provision).includes('ownerCredential')) throw new Error('provision output leaked an owner credential');
  fs.writeFileSync(path.join(resultDir, 'provision.json'), `${JSON.stringify({ defaultRoom, ...provision }, null, 2)}\n`);

  const roomCodes = [defaultRoom.roomCode, ...provision.rooms.map((room) => room.roomCode)];
  const matrix = {
    ok: false,
    runId,
    baseUrl,
    serverPid,
    durationSeconds,
    samplerPaddingSeconds,
    eventLoopMetricsPath,
    stagingBinding,
    stages: [],
  };

  for (const clients of stages) {
    const prefix = path.join(resultDir, `stage-${clients}`);
    const loadPath = `${prefix}-load.json`;
    const loadErrorPath = `${prefix}-load.stderr.log`;
    const samplerPath = `${prefix}-server.json`;
    const samplerStdoutPath = `${prefix}-server.stdout.json`;
    const samplerErrorPath = `${prefix}-server.stderr.log`;
    const selectedCodes = clients <= 1000 ? [defaultRoom.roomCode] : roomCodes;

    const sampler = runToFile(path.join(__dirname, 'process-sampler.js'), {
      SERVER_PID: String(serverPid),
      DURATION_SECONDS: String(durationSeconds + samplerPaddingSeconds),
      SAMPLE_INTERVAL_MS: '1000',
      HEALTH_URL: `${baseUrl}/`,
      NETWORK_INTERFACE: process.env.NETWORK_INTERFACE || 'lo',
      OUTPUT_PATH: samplerPath,
    }, samplerStdoutPath, samplerErrorPath, { cwd: root });

    const load = runToFile(path.join(__dirname, 'room-load.js'), {
      BASE_URL: baseUrl,
      CLIENTS: String(clients),
      DURATION_SECONDS: String(durationSeconds),
      ROOM_CODES: selectedCodes.join(','),
      CONNECT_BATCH_SIZE: '50',
      CONNECT_BATCH_DELAY_MS: '50',
    }, loadPath, loadErrorPath, { cwd: root });

    await waitForChildren([load, sampler]);
    const loadResult = JSON.parse(fs.readFileSync(loadPath, 'utf8'));
    const samplerResult = JSON.parse(fs.readFileSync(samplerPath, 'utf8'));
    const stageWindow = { startedAt: loadResult.startedAt, finishedAt: loadResult.finishedAt };
    const samplerWindow = summarizeSamplerWindow(samplerResult.samples, stageWindow);
    const serverEventLoop = summarizeEventLoopJsonl(
      fs.readFileSync(eventLoopMetricsPath, 'utf8'),
      stageWindow,
    );
    const gate = evaluateStage({
      expectedClients: clients,
      load: loadResult,
      sampler: samplerWindow,
      serverEventLoop,
    });
    const compact = compactStage(loadResult, samplerWindow, serverEventLoop, gate);
    matrix.stages.push(compact);
    fs.writeFileSync(path.join(resultDir, 'matrix-summary.json'), `${JSON.stringify(matrix, null, 2)}\n`);
    if (!gate.ok) {
      throw new Error(`load stage ${clients} failed gate: ${JSON.stringify(gate.failures)}`);
    }
    process.stdout.write(`[load-matrix] ${clients} clients complete: disconnects=${compact.unexpectedDisconnects}, ackTimeout=${compact.ack.timeout}\n`);
  }

  matrix.ok = true;
  fs.writeFileSync(path.join(resultDir, 'matrix-summary.json'), `${JSON.stringify(matrix, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, resultDir, stages: matrix.stages.map((stage) => stage.clientsTarget) })}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
