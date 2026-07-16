'use strict';

function defaultRoomFromResponse(response) {
  const room = response?.ok ? response.room : null;
  if (!room || !/^\d{8}$/.test(String(room.roomCode || '')) || Number(room.capacity) !== 1000) {
    throw new Error('invalid dedicated room-default response');
  }
  return {
    roomCode: String(room.roomCode),
    roomName: String(room.roomName || room.name || ''),
    capacity: Number(room.capacity),
  };
}

function summarizeEventLoopJsonl(text, { startedAt, finishedAt }) {
  const startMs = Date.parse(startedAt);
  const finishMs = Date.parse(finishedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs) || finishMs < startMs) {
    throw new Error('invalid stage time window');
  }

  const samples = String(text).split('\n').filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid event-loop JSONL at line ${index + 1}: ${error.message}`);
    }
  }).filter((sample) => {
    const atMs = Date.parse(sample.at);
    return Number.isFinite(atMs) && atMs >= startMs && atMs <= finishMs;
  });

  const observationCount = samples.reduce((sum, sample) => sum + (Number.isFinite(sample.count) ? sample.count : 0), 0);
  const weightedMeanTotal = samples.reduce((sum, sample) => {
    if (!Number.isFinite(sample.count) || !Number.isFinite(sample.meanMs)) return sum;
    return sum + (sample.count * sample.meanMs);
  }, 0);
  const conservativeMax = (key) => {
    const values = samples.map((sample) => sample[key]).filter(Number.isFinite);
    return values.length ? Math.max(...values) : null;
  };

  return {
    sampleCount: samples.length,
    observationCount,
    meanMs: observationCount ? Number((weightedMeanTotal / observationCount).toFixed(3)) : null,
    p50Ms: conservativeMax('p50Ms'),
    p95Ms: conservativeMax('p95Ms'),
    p99Ms: conservativeMax('p99Ms'),
    maxMs: conservativeMax('maxMs'),
  };
}

function summarizeSamplerWindow(allSamples, { startedAt, finishedAt }) {
  const startMs = Date.parse(startedAt);
  const finishMs = Date.parse(finishedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs) || finishMs < startMs) {
    throw new Error('invalid sampler stage time window');
  }
  const samples = Array.isArray(allSamples) ? allSamples.filter((sample) => {
    const atMs = Date.parse(sample?.at);
    return Number.isFinite(atMs) && atMs >= startMs && atMs <= finishMs;
  }) : [];
  const numeric = (selector) => samples.map(selector).filter(Number.isFinite);
  const percentile = (values, fraction) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(2));
  };
  const summarizeRates = (values) => ({
    mean: values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : null,
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : null,
  });
  const cpu = numeric((sample) => sample.cpuPercentSingleCore);
  const rss = numeric((sample) => sample.rssBytes);
  const fileDescriptors = numeric((sample) => sample.fileDescriptors);
  const threads = numeric((sample) => sample.threads);
  const health = numeric((sample) => sample.health?.latencyMs);
  const rxRates = numeric((sample) => sample.network?.rxBytesPerSecond);
  const txRates = numeric((sample) => sample.network?.txBytesPerSecond);
  const firstNetwork = samples.find((sample) => sample.network)?.network;
  const lastNetwork = [...samples].reverse().find((sample) => sample.network)?.network;
  const processErrors = Array.isArray(allSamples)
    ? allSamples.filter((sample) => sample?.processError).map((sample) => sample.processError)
    : [];

  return {
    sampleCount: samples.length,
    processErrors,
    cpuSingleCore: {
      meanPercent: cpu.length ? Number((cpu.reduce((sum, value) => sum + value, 0) / cpu.length).toFixed(2)) : null,
      p95Percent: percentile(cpu, 0.95),
      maxPercent: cpu.length ? Math.max(...cpu) : null,
    },
    rss: { maxBytes: rss.length ? Math.max(...rss) : null },
    fileDescriptors: { max: fileDescriptors.length ? Math.max(...fileDescriptors) : null },
    threads: { max: threads.length ? Math.max(...threads) : null },
    network: {
      interface: lastNetwork?.interface ?? null,
      scope: lastNetwork?.scope ?? null,
      rxBytesDelta: firstNetwork && lastNetwork ? Math.max(0, lastNetwork.rxBytes - firstNetwork.rxBytes) : null,
      txBytesDelta: firstNetwork && lastNetwork ? Math.max(0, lastNetwork.txBytes - firstNetwork.txBytes) : null,
      rxBytesPerSecond: summarizeRates(rxRates),
      txBytesPerSecond: summarizeRates(txRates),
    },
    healthLatency: {
      p50Ms: percentile(health, 0.50),
      p95Ms: percentile(health, 0.95),
      p99Ms: percentile(health, 0.99),
      failures: samples.filter((sample) => sample.health && (!sample.health.ok || sample.health.statusCode < 200 || sample.health.statusCode >= 300)).length,
    },
    samples,
  };
}

function evaluateStage({ expectedClients, load, sampler, serverEventLoop }) {
  const failures = [];
  const fail = (code, actual, expected) => failures.push({ code, actual, expected });

  if (load?.clientsTarget !== expectedClients) {
    fail('CLIENT_TARGET_MISMATCH', load?.clientsTarget ?? null, expectedClients);
  }
  if (load?.clientsConnectedAndJoined !== expectedClients) {
    fail('CLIENT_JOIN_SHORTFALL', load?.clientsConnectedAndJoined ?? null, expectedClients);
  }
  if (load?.connectLatency?.samples !== expectedClients) {
    fail('CONNECT_SAMPLES_MISSING', load?.connectLatency?.samples ?? null, expectedClients);
  }
  if (load?.joinLatency?.samples !== expectedClients) {
    fail('JOIN_SAMPLES_MISSING', load?.joinLatency?.samples ?? null, expectedClients);
  }

  const ack = load?.ack || {};
  const ackTotal = ['sent', 'queued', 'rejected', 'timeout']
    .reduce((sum, key) => sum + (Number.isFinite(ack[key]) ? ack[key] : 0), 0);
  const minimumScheduledMessages = Array.isArray(load?.roomPlan)
    ? load.roomPlan.reduce((sum, room) => {
      if (!(room?.clients > 0) || !(room?.messageRatePerSecond > 0) || !(load?.durationSeconds > 0)) return sum;
      return sum + Math.max(0, Math.floor(room.messageRatePerSecond * load.durationSeconds) - 1);
    }, 0)
    : 0;
  if (minimumScheduledMessages <= 0) {
    fail('LOAD_PLAN_MISSING', minimumScheduledMessages, '> 0');
  } else if (ackTotal < minimumScheduledMessages) {
    fail('LOAD_NOT_SUSTAINED', ackTotal, `>= ${minimumScheduledMessages}`);
  }
  if (!Number.isFinite(load?.ackLatency?.samples) || load.ackLatency.samples !== ackTotal) {
    fail('ACK_ACCOUNTING_MISMATCH', load?.ackLatency?.samples ?? null, ackTotal);
  }
  if (ack.timeout !== 0) fail('ACK_TIMEOUT', ack.timeout ?? null, 0);
  if (ack.rejected !== 0) fail('ACK_REJECTED', ack.rejected ?? null, 0);
  if (ack.errorsByCode && Object.keys(ack.errorsByCode).length > 0) {
    fail('ACK_ERRORS_PRESENT', ack.errorsByCode, {});
  }

  if (load?.unexpectedDisconnects !== 0) {
    fail('UNEXPECTED_DISCONNECT', load?.unexpectedDisconnects ?? null, 0);
  }
  if (load?.queueStatus?.expired !== 0) {
    fail('QUEUE_EXPIRED', load?.queueStatus?.expired ?? null, 0);
  }
  if (load?.queueStatus?.stillPendingAtShutdown !== 0) {
    fail('DELIVERY_PENDING', load?.queueStatus?.stillPendingAtShutdown ?? null, 0);
  }
  if (Number.isFinite(ack.queued) && load?.queueStatus?.delivered !== ack.queued) {
    fail('QUEUE_STATUS_MISMATCH', load?.queueStatus?.delivered ?? null, ack.queued);
  }
  const accepted = (Number.isFinite(ack.sent) ? ack.sent : 0) + (Number.isFinite(ack.queued) ? ack.queued : 0);
  if (accepted > 0 && !(load?.deliveryLatency?.samples > 0)) {
    fail('DELIVERY_SAMPLES_MISSING', load?.deliveryLatency?.samples ?? null, '> 0');
  }

  if (!(sampler?.sampleCount > 0) || !Array.isArray(sampler?.samples) || sampler.samples.length === 0) {
    fail('SAMPLER_SAMPLES_MISSING', sampler?.sampleCount ?? null, '> 0');
  }
  const processErrors = Array.isArray(sampler?.processErrors)
    ? sampler.processErrors
    : (Array.isArray(sampler?.samples)
      ? sampler.samples.filter((sample) => sample?.processError).map((sample) => sample.processError)
      : []);
  if (processErrors.length > 0) fail('SAMPLER_PROCESS_ERROR', processErrors, []);
  const unhealthySamples = Array.isArray(sampler?.samples)
    ? sampler.samples.filter((sample) => sample?.health && (!sample.health.ok || sample.health.statusCode < 200 || sample.health.statusCode >= 300)).length
    : 0;
  if (sampler?.healthLatency?.failures !== 0 || unhealthySamples > 0) {
    fail('HEALTH_FAILURE', {
      summaryFailures: sampler?.healthLatency?.failures ?? null,
      unhealthySamples,
    }, { summaryFailures: 0, unhealthySamples: 0 });
  }

  if (!(serverEventLoop?.sampleCount > 0) || !(serverEventLoop?.observationCount > 0)) {
    fail('SERVER_EVENT_LOOP_MISSING', {
      sampleCount: serverEventLoop?.sampleCount ?? null,
      observationCount: serverEventLoop?.observationCount ?? null,
    }, { sampleCount: '> 0', observationCount: '> 0' });
  }

  const metricPaths = [
    'load.connectLatency.p50Ms', 'load.connectLatency.p95Ms', 'load.connectLatency.p99Ms', 'load.connectLatency.maxMs',
    'load.joinLatency.p50Ms', 'load.joinLatency.p95Ms', 'load.joinLatency.p99Ms', 'load.joinLatency.maxMs',
    'load.ackLatency.p50Ms', 'load.ackLatency.p95Ms', 'load.ackLatency.p99Ms', 'load.ackLatency.maxMs',
    'load.deliveryLatency.p50Ms', 'load.deliveryLatency.p95Ms', 'load.deliveryLatency.p99Ms', 'load.deliveryLatency.maxMs',
    'load.loadGeneratorEventLoopLag.meanMs', 'load.loadGeneratorEventLoopLag.p95Ms',
    'load.loadGeneratorEventLoopLag.p99Ms', 'load.loadGeneratorEventLoopLag.maxMs',
    'sampler.cpuSingleCore.meanPercent', 'sampler.cpuSingleCore.p95Percent', 'sampler.cpuSingleCore.maxPercent',
    'sampler.rss.maxBytes', 'sampler.fileDescriptors.max', 'sampler.threads.max',
    'sampler.healthLatency.p50Ms', 'sampler.healthLatency.p95Ms', 'sampler.healthLatency.p99Ms',
    'sampler.network.rxBytesDelta', 'sampler.network.txBytesDelta',
    'sampler.network.rxBytesPerSecond.mean', 'sampler.network.rxBytesPerSecond.p95', 'sampler.network.rxBytesPerSecond.max',
    'sampler.network.txBytesPerSecond.mean', 'sampler.network.txBytesPerSecond.p95', 'sampler.network.txBytesPerSecond.max',
    'serverEventLoop.meanMs', 'serverEventLoop.p50Ms', 'serverEventLoop.p95Ms', 'serverEventLoop.p99Ms', 'serverEventLoop.maxMs',
  ];
  const roots = { load, sampler, serverEventLoop };
  const missingMetrics = metricPaths.filter((metricPath) => {
    const value = metricPath.split('.').reduce((current, key) => current?.[key], roots);
    return !Number.isFinite(value) || value < 0;
  });
  if (missingMetrics.length > 0) fail('PROMISED_METRIC_MISSING', missingMetrics, []);
  if (sampler?.network?.scope !== 'network-namespace') {
    fail('NETWORK_SCOPE_INVALID', sampler?.network?.scope ?? null, 'network-namespace');
  }

  return {
    ok: failures.length === 0,
    failures,
    performanceLimits: 'observational-only: no numeric SLO is declared in the authoritative specification',
  };
}

function validateStagingProcess({
  baseUrl,
  serverPid,
  eventLoopMetricsPath,
  environText,
  cmdlineText,
}) {
  if (!Number.isInteger(serverPid) || serverPid < 2) throw new Error('invalid staging SERVER_PID');
  const url = new URL(baseUrl);
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (!allowedHosts.has(url.hostname)) throw new Error('load matrix BASE_URL must be loopback');
  const port = Number.parseInt(url.port, 10);
  if (!Number.isInteger(port)) throw new Error('load matrix BASE_URL must include an explicit port');
  if (port === 3999) throw new Error('refusing production port 3999');

  const environment = Object.fromEntries(String(environText).split('\0').filter(Boolean).map((entry) => {
    const separator = entry.indexOf('=');
    return separator < 0 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  if (Number.parseInt(environment.PORT || '', 10) !== port) {
    throw new Error('staging PID port does not match BASE_URL');
  }
  if (!environment.DB_PATH || !environment.DB_PATH.startsWith('/tmp/')) {
    throw new Error('staging PID must use a temporary DB_PATH');
  }
  if (environment.EVENT_LOOP_METRICS_PATH !== eventLoopMetricsPath) {
    throw new Error('staging PID event-loop metrics path does not match');
  }
  if (!String(environment.NODE_OPTIONS || '').includes('event-loop-hook.js')) {
    throw new Error('staging PID is missing the event-loop hook');
  }
  if (!String(cmdlineText).replaceAll('\0', ' ').includes('load-tests/staging-server.js')) {
    throw new Error('SERVER_PID is not load-tests/staging-server.js');
  }
  return {
    port,
    host: url.hostname,
    databaseScope: 'temporary',
    eventLoopHook: true,
  };
}

module.exports = {
  defaultRoomFromResponse,
  summarizeEventLoopJsonl,
  summarizeSamplerWindow,
  evaluateStage,
  validateStagingProcess,
};
