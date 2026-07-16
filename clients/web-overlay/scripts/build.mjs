import path from 'node:path';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { serverUrlForBuild } from './server-url.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(here, '..');
const repositoryRoot = path.resolve(clientRoot, '..', '..');
const target = process.argv[2];
const targets = {
  desktop: { output: path.join(repositoryRoot, 'desktop', 'frontend', 'generated') },
  extension: { output: path.join(repositoryRoot, 'extension', 'dist') },
};

if (!targets[target]) {
  throw new TypeError('build target must be desktop or extension');
}

const serverUrl = serverUrlForBuild(process.env.DANMAKU_SERVER_URL);
const selectedTarget = targets[target];
const generatedDir = selectedTarget.output;

if (target === 'desktop') {
  const tauriConfigPath = path.join(repositoryRoot, 'desktop', 'src-tauri', 'tauri.conf.json');
  const tauriConfig = JSON.parse(await readFile(tauriConfigPath, 'utf8'));
  const mergedConfig = process.env.TAURI_CONFIG ? JSON.parse(process.env.TAURI_CONFIG) : null;
  const overrideSecurity = mergedConfig?.app?.security;
  const hasCspOverride = overrideSecurity && typeof overrideSecurity === 'object'
    && Object.hasOwn(overrideSecurity, 'csp');
  const csp = String(hasCspOverride ? overrideSecurity.csp : (tauriConfig?.app?.security?.csp ?? ''));
  const connectDirectives = csp.split(';').map((directive) => directive.trim())
    .filter((directive) => /^connect-src(?:\s|$)/i.test(directive));
  if (connectDirectives.length !== 1) {
    throw new Error(`Desktop CSP must contain exactly one connect-src directive (found: ${connectDirectives.length})`);
  }
  const allowed = new Set(connectDirectives[0].split(/\s+/).slice(1));
  const websocketUrl = new URL(serverUrl);
  websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const expected = new Set([
    "'self'",
    'ipc:',
    'http://ipc.localhost',
    serverUrl,
    websocketUrl.origin,
  ]);
  const missing = [...expected].filter((source) => !allowed.has(source));
  const unexpected = [...allowed].filter((source) => !expected.has(source));
  if (missing.length || unexpected.length) {
    throw new Error(`Desktop CSP connect-src must exactly match the selected endpoint (missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'})`);
  }
}

await rm(generatedDir, { recursive: true, force: true });
await mkdir(generatedDir, { recursive: true });

const commonBuild = {
  bundle: true,
  define: { __DANMAKU_SERVER_URL__: JSON.stringify(serverUrl) },
  format: 'esm',
  logLevel: 'warning',
  platform: 'browser',
  sourcemap: false,
  target: ['es2022'],
  loader: { '.css': 'text' },
};

if (target === 'desktop') {
  await build({
    ...commonBuild,
    entryPoints: [path.join(clientRoot, 'src', 'desktop', 'shared-core-entry.js')],
    outfile: path.join(generatedDir, 'shared-core.js'),
  });
  await copyFile(
    path.join(clientRoot, 'src', 'core', 'overlay.css'),
    path.join(generatedDir, 'overlay.css'),
  );
}

if (target === 'extension') {
  await build({
    ...commonBuild,
    entryPoints: [path.join(clientRoot, 'src', 'extension', 'background.js')],
    outfile: path.join(generatedDir, 'background.js'),
  });
  for (const entry of ['content', 'popup', 'options']) {
    await build({
      ...commonBuild,
      format: 'iife',
      entryPoints: [path.join(clientRoot, 'src', 'extension', `${entry}.js`)],
      outfile: path.join(generatedDir, `${entry}.js`),
    });
  }
  for (const entry of ['popup.html', 'popup.css', 'options.html', 'options.css']) {
    await copyFile(path.join(clientRoot, 'src', 'extension', entry), path.join(generatedDir, entry));
  }
  const sourceIcons = path.join(clientRoot, 'src', 'extension', 'icons');
  const outputIcons = path.join(generatedDir, 'icons');
  await mkdir(outputIcons, { recursive: true });
  for (const icon of await readdir(sourceIcons)) {
    if (/^icon-(16|32|48|128)\.png$/.test(icon)) await copyFile(path.join(sourceIcons, icon), path.join(outputIcons, icon));
  }
  const manifestSource = JSON.parse(await readFile(path.join(clientRoot, 'src', 'extension', 'manifest.json'), 'utf8'));
  const websocketUrl = new URL(serverUrl);
  websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  manifestSource.content_security_policy = {
    extension_pages: `script-src 'self'; object-src 'self'; connect-src 'self' ${serverUrl} ${websocketUrl.origin}`,
  };
  await writeFile(path.join(generatedDir, 'manifest.json'), `${JSON.stringify(manifestSource, null, 2)}\n`);
}
