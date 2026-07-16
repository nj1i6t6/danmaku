'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function runToFile(script, env, stdoutPath, stderrPath, { cwd = process.cwd() } = {}) {
  const stdout = fs.openSync(stdoutPath, 'w');
  const stderr = fs.openSync(stderrPath, 'w');
  let child;
  try {
    child = spawn(process.execPath, [script], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', stdout, stderr],
    });
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }

  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(script)} failed (${code ?? signal}); see ${stderrPath}`));
    });
  });
  return { child, done, script };
}

function isRunning(child) {
  return child.exitCode == null && child.signalCode == null;
}

async function waitForChildren(tasks, terminateTimeoutMs = 2_000) {
  try {
    await Promise.all(tasks.map((task) => task.done));
  } catch (error) {
    for (const task of tasks) {
      if (isRunning(task.child)) task.child.kill('SIGTERM');
    }

    let timeout;
    await Promise.race([
      Promise.allSettled(tasks.map((task) => task.done)),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, terminateTimeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    for (const task of tasks) {
      if (isRunning(task.child)) task.child.kill('SIGKILL');
    }
    await Promise.allSettled(tasks.map((task) => task.done));
    throw error;
  }
}

module.exports = { runToFile, waitForChildren };
