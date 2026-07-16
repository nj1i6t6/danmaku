import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverUrlForBuild } from './server-url.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tauriRoot = path.resolve(here, '..', '..', '..', 'desktop', 'src-tauri');
const serverUrl = serverUrlForBuild(process.env.DANMAKU_SERVER_URL);
const websocketUrl = new URL(serverUrl);
websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
const csp = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost ${serverUrl} ${websocketUrl.origin}; img-src 'self' data:`;
const config = { app: { security: { csp } } };

const [command, ...args] = process.argv.slice(2);
if (command === '--print-config') {
  process.stdout.write(`${JSON.stringify(config)}\n`);
  process.exit(0);
}
if (!['build', 'dev'].includes(command)) {
  throw new TypeError('Tauri wrapper command must be build or dev');
}

const result = spawnSync(
  'cargo',
  ['tauri', command, '--config', JSON.stringify(config), ...args],
  {
    cwd: tauriRoot,
    env: { ...process.env, DANMAKU_SERVER_URL: serverUrl },
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
