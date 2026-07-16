'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const outputPath = process.env.EVENT_LOOP_METRICS_PATH;
if (outputPath) {
  const resolutionMs = Math.max(1, Number.parseInt(process.env.EVENT_LOOP_RESOLUTION_MS || '10', 10));
  const intervalMs = Math.max(100, Number.parseInt(process.env.EVENT_LOOP_SAMPLE_INTERVAL_MS || '1000', 10));
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();

  const writeSample = () => {
    if (histogram.count === 0) return;
    const sample = {
      at: new Date().toISOString(),
      count: histogram.count,
      meanMs: Number((histogram.mean / 1e6).toFixed(3)),
      p50Ms: Number((histogram.percentile(50) / 1e6).toFixed(3)),
      p95Ms: Number((histogram.percentile(95) / 1e6).toFixed(3)),
      p99Ms: Number((histogram.percentile(99) / 1e6).toFixed(3)),
      maxMs: Number((histogram.max / 1e6).toFixed(3)),
    };
    fs.appendFileSync(outputPath, `${JSON.stringify(sample)}\n`);
    histogram.reset();
  };

  const timer = setInterval(writeSample, intervalMs);
  timer.unref();
  process.once('beforeExit', () => {
    clearInterval(timer);
    writeSample();
    histogram.disable();
  });
}
