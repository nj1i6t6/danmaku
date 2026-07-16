'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { performance } = require('node:perf_hooks');

function intEnv(name, fallback, min = 1) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be >= ${min}`);
  return value;
}

function parseNetworkDev(text, interfaceName) {
  for (const line of text.split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 0 || line.slice(0, separator).trim() !== interfaceName) continue;
    const fields = line.slice(separator + 1).trim().split(/\s+/).map(Number);
    if (fields.length < 16 || !fields.every(Number.isFinite)) break;
    return { rxBytes: fields[0], txBytes: fields[8] };
  }
  throw new Error(`network interface ${interfaceName} not found`);
}

function readNetworkBytes(interfaceName) {
  return parseNetworkDev(fs.readFileSync('/proc/net/dev', 'utf8'), interfaceName);
}

function readStatus(pid) {
  const text = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const values = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Za-z_]+):\s+(.+)$/);
    if (match) values[match[1]] = match[2];
  }
  const rssKb = Number.parseInt(values.VmRSS || '0', 10);
  return {
    rssBytes: rssKb * 1024,
    threads: Number.parseInt(values.Threads || '0', 10),
  };
}

function readProcStat(pid) {
  const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(' ');
  return {
    ticks: Number(fields[13]) + Number(fields[14]),
  };
}

function countFileDescriptors(pid) {
  return fs.readdirSync(`/proc/${pid}/fd`).length;
}

function probe(urlString, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const url = new URL(urlString);
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      response.once('end', () => resolve({
        ok: response.statusCode >= 200 && response.statusCode < 500,
        statusCode: response.statusCode,
        latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      }));
    });
    request.once('timeout', () => request.destroy(new Error('timeout')));
    request.once('error', (error) => resolve({
      ok: false,
      error: String(error.message || error),
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    }));
  });
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(2));
}

async function main() {
  const pid = Number.parseInt(process.env.SERVER_PID || process.argv[2] || '', 10);
  if (!Number.isInteger(pid) || pid < 2) throw new Error('SERVER_PID or argv[2] must be a valid PID');
  const durationSeconds = intEnv('DURATION_SECONDS', 600);
  const intervalMs = intEnv('SAMPLE_INTERVAL_MS', 1_000, 100);
  const healthUrl = process.env.HEALTH_URL || 'http://127.0.0.1:4399/';
  const outputPath = process.env.OUTPUT_PATH || '';
  const clockTicks = intEnv('CLK_TCK', 100);
  const networkInterface = process.env.NETWORK_INTERFACE || 'lo';
  const cpuCount = Math.max(1, require('node:os').cpus().length);
  const samples = [];
  let previous = { ...readProcStat(pid), time: performance.now() };
  const networkStart = readNetworkBytes(networkInterface);
  let previousNetwork = networkStart;
  const startedAt = new Date();
  const deadline = performance.now() + durationSeconds * 1000;

  while (performance.now() < deadline) {
    const sampleStartedAt = performance.now();
    let sample;
    try {
      const status = readStatus(pid);
      const stat = readProcStat(pid);
      const now = performance.now();
      const elapsedSeconds = Math.max(0.001, (now - previous.time) / 1000);
      const processCpuSeconds = (stat.ticks - previous.ticks) / clockTicks;
      const cpuPercentSingleCore = (processCpuSeconds / elapsedSeconds) * 100;
      const network = readNetworkBytes(networkInterface);
      previous = { ...stat, time: now };
      sample = {
        at: new Date().toISOString(),
        cpuPercentSingleCore: Number(cpuPercentSingleCore.toFixed(2)),
        cpuPercentHost: Number((cpuPercentSingleCore / cpuCount).toFixed(2)),
        rssBytes: status.rssBytes,
        threads: status.threads,
        fileDescriptors: countFileDescriptors(pid),
        network: {
          interface: networkInterface,
          scope: 'network-namespace',
          rxBytes: network.rxBytes,
          txBytes: network.txBytes,
          rxBytesPerSecond: Number((Math.max(0, network.rxBytes - previousNetwork.rxBytes) / elapsedSeconds).toFixed(2)),
          txBytesPerSecond: Number((Math.max(0, network.txBytes - previousNetwork.txBytes) / elapsedSeconds).toFixed(2)),
        },
        health: await probe(healthUrl),
      };
      previousNetwork = network;
    } catch (error) {
      sample = { at: new Date().toISOString(), processError: String(error.message || error) };
      samples.push(sample);
      break;
    }
    samples.push(sample);
    const remainingMs = intervalMs - (performance.now() - sampleStartedAt);
    if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs));
  }

  const numeric = (key) => samples.map((sample) => sample[key]).filter(Number.isFinite);
  const healthLatencies = samples.map((sample) => sample.health?.latencyMs).filter(Number.isFinite);
  const networkRxRates = samples.map((sample) => sample.network?.rxBytesPerSecond).filter(Number.isFinite);
  const networkTxRates = samples.map((sample) => sample.network?.txBytesPerSecond).filter(Number.isFinite);
  const networkLast = [...samples].reverse().find((sample) => sample.network)?.network;
  const summary = {
    serverPid: pid,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationSeconds,
    intervalMs,
    sampleCount: samples.length,
    cpuSingleCore: {
      meanPercent: numeric('cpuPercentSingleCore').length
        ? Number((numeric('cpuPercentSingleCore').reduce((a, b) => a + b, 0) / numeric('cpuPercentSingleCore').length).toFixed(2))
        : null,
      p95Percent: percentile(numeric('cpuPercentSingleCore'), 0.95),
      maxPercent: numeric('cpuPercentSingleCore').length ? Math.max(...numeric('cpuPercentSingleCore')) : null,
    },
    rss: {
      maxBytes: numeric('rssBytes').length ? Math.max(...numeric('rssBytes')) : null,
    },
    fileDescriptors: {
      max: numeric('fileDescriptors').length ? Math.max(...numeric('fileDescriptors')) : null,
    },
    threads: {
      max: numeric('threads').length ? Math.max(...numeric('threads')) : null,
    },
    network: {
      interface: networkInterface,
      scope: 'network-namespace',
      rxBytesDelta: networkLast ? Math.max(0, networkLast.rxBytes - networkStart.rxBytes) : null,
      txBytesDelta: networkLast ? Math.max(0, networkLast.txBytes - networkStart.txBytes) : null,
      rxBytesPerSecond: {
        mean: networkRxRates.length ? Number((networkRxRates.reduce((a, b) => a + b, 0) / networkRxRates.length).toFixed(2)) : null,
        p95: percentile(networkRxRates, 0.95),
        max: networkRxRates.length ? Math.max(...networkRxRates) : null,
      },
      txBytesPerSecond: {
        mean: networkTxRates.length ? Number((networkTxRates.reduce((a, b) => a + b, 0) / networkTxRates.length).toFixed(2)) : null,
        p95: percentile(networkTxRates, 0.95),
        max: networkTxRates.length ? Math.max(...networkTxRates) : null,
      },
    },
    healthLatency: {
      p50Ms: percentile(healthLatencies, 0.50),
      p95Ms: percentile(healthLatencies, 0.95),
      p99Ms: percentile(healthLatencies, 0.99),
      failures: samples.filter((sample) => sample.health && !sample.health.ok).length,
    },
    samples,
  };

  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, json);
  }
  process.stdout.write(json);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { parseNetworkDev };
