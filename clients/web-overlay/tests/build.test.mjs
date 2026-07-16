import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(here, '..');
const repositoryRoot = path.resolve(clientRoot, '..', '..');
const desktopFrontend = path.join(repositoryRoot, 'desktop', 'frontend');
const generatedBundle = path.join(desktopFrontend, 'generated', 'shared-core.js');
const generatedCss = path.join(desktopFrontend, 'generated', 'overlay.css');
const sharedCss = path.join(clientRoot, 'src', 'core', 'overlay.css');
const extensionDist = path.join(repositoryRoot, 'extension', 'dist');

function trackedFrontendSnapshot() {
  return new Map([
    ['index.html', fs.readFileSync(path.join(desktopFrontend, 'index.html'))],
    ['js/overlay-app.js', fs.readFileSync(path.join(desktopFrontend, 'js', 'overlay-app.js'))],
  ]);
}

test('desktop build writes one generated shared bundle without overwriting tracked frontend', async () => {
  const before = trackedFrontendSnapshot();
  const result = spawnSync('npm', ['run', 'build:desktop'], {
    cwd: clientRoot,
    env: { ...process.env, DANMAKU_SERVER_URL: 'http://127.0.0.1:3999' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(generatedBundle), true);
  assert.equal(fs.existsSync(generatedCss), true);
  assert.deepEqual(fs.readFileSync(generatedCss), fs.readFileSync(sharedCss));
  for (const [relative, expected] of before) {
    assert.deepEqual(fs.readFileSync(path.join(desktopFrontend, relative)), expected, `${relative} was overwritten`);
  }

  const source = fs.readFileSync(generatedBundle, 'utf8');
  assert.doesNotMatch(source, /sourceMappingURL|\beval\s*\(|__DANMAKU_SERVER_URL__/);
  const bundle = await import(`${pathToFileURL(generatedBundle).href}?test=${Date.now()}`);
  assert.equal(bundle.DANMAKU_SERVER_URL, 'http://127.0.0.1:3999');
  assert.equal(bundle.normalizeSettings({ ball: { size: 500 } }).ball.size, 96);
});

test('desktop build removes stale files only inside the generated output boundary', () => {
  const generatedDir = path.dirname(generatedBundle);
  const stale = path.join(generatedDir, 'stale-artifact.js');
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(stale, 'stale');
  const result = spawnSync('npm', ['run', 'build:desktop'], {
    cwd: clientRoot,
    env: { ...process.env, DANMAKU_SERVER_URL: 'http://127.0.0.1:3999' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(stale), false);
});

test('desktop build defaults to loopback and rejects insecure remote endpoints', async () => {
  const defaultEnv = { ...process.env };
  delete defaultEnv.DANMAKU_SERVER_URL;
  const defaultBuild = spawnSync('npm', ['run', 'build:desktop'], {
    cwd: clientRoot,
    env: defaultEnv,
    encoding: 'utf8',
  });
  assert.equal(defaultBuild.status, 0, defaultBuild.stderr || defaultBuild.stdout);
  const bundle = await import(`${pathToFileURL(generatedBundle).href}?default=${Date.now()}`);
  assert.equal(bundle.DANMAKU_SERVER_URL, 'http://127.0.0.1:3999');

  const insecureRemote = spawnSync('npm', ['run', 'build:desktop'], {
    cwd: clientRoot,
    env: { ...process.env, DANMAKU_SERVER_URL: 'http://example.com' },
    encoding: 'utf8',
  });
  assert.notEqual(insecureRemote.status, 0);
  assert.match(insecureRemote.stderr, /HTTPS|loopback/i);
});

test('desktop custom HTTPS endpoint fails closed without a matching Tauri CSP extension', () => {
  const env = { ...process.env, DANMAKU_SERVER_URL: 'https://self-hosted.example' };
  delete env.TAURI_CONFIG;
  const result = spawnSync('npm', ['run', 'build:desktop'], {
    cwd: clientRoot,
    env,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /CSP|TAURI_CONFIG/i);
});

test('desktop custom HTTPS endpoint accepts only a matching Tauri CSP extension', async () => {
  const endpoint = 'https://self-hosted.example';
  const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost https://self-hosted.example wss://self-hosted.example; img-src 'self' data:";
  const result = spawnSync('npm', ['run', 'build:desktop'], {
    cwd: clientRoot,
    env: {
      ...process.env,
      DANMAKU_SERVER_URL: endpoint,
      TAURI_CONFIG: JSON.stringify({ app: { security: { csp } } }),
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const bundle = await import(`${pathToFileURL(generatedBundle).href}?custom=${Date.now()}`);
  assert.equal(bundle.DANMAKU_SERVER_URL, endpoint);
});

test('desktop CSP guard rejects wildcard or extra connect origins even when the selected pair is present', () => {
  const endpoint = 'https://self-hosted.example';
  for (const extra of ['https:', 'https://unrelated.example']) {
    const csp = `default-src 'self'; connect-src 'self' ipc: http://ipc.localhost https://self-hosted.example wss://self-hosted.example ${extra};`;
    const result = spawnSync('npm', ['run', 'build:desktop'], {
      cwd: clientRoot,
      env: {
        ...process.env,
        DANMAKU_SERVER_URL: endpoint,
        TAURI_CONFIG: JSON.stringify({ app: { security: { csp } } }),
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `${extra} unexpectedly passed the exact-origin guard`);
    assert.match(`${result.stderr}\n${result.stdout}`, /CSP|connect-src|exact/i);
  }
});

test('desktop CSP guard rejects duplicate connect-src directives', () => {
  const endpoint = 'https://self-hosted.example';
  const csp = "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost https://self-hosted.example wss://self-hosted.example; connect-src https:";
  const result = spawnSync('npm', ['run', 'build:desktop'], {
    cwd: clientRoot,
    env: {
      ...process.env,
      DANMAKU_SERVER_URL: endpoint,
      TAURI_CONFIG: JSON.stringify({ app: { security: { csp } } }),
    },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0, 'duplicate connect-src unexpectedly passed the exact-origin guard');
  assert.match(`${result.stderr}\n${result.stdout}`, /CSP|connect-src|duplicate/i);
});

test('desktop CSP guard treats directive names as case-insensitive', () => {
  const endpoint = 'https://self-hosted.example';
  const csp = "default-src 'self'; CONNECT-SRC https:; connect-src 'self' ipc: http://ipc.localhost https://self-hosted.example wss://self-hosted.example";
  const result = spawnSync('npm', ['run', 'build:desktop'], {
    cwd: clientRoot,
    env: {
      ...process.env,
      DANMAKU_SERVER_URL: endpoint,
      TAURI_CONFIG: JSON.stringify({ app: { security: { csp } } }),
    },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0, 'alternate-case duplicate connect-src unexpectedly passed');
  assert.match(`${result.stderr}\n${result.stdout}`, /CSP|connect-src|duplicate/i);
});

test('desktop CSP guard rejects an explicit null CSP override', () => {
  const result = spawnSync('npm', ['run', 'build:desktop'], {
    cwd: clientRoot,
    env: {
      ...process.env,
      DANMAKU_SERVER_URL: 'http://127.0.0.1:3999',
      TAURI_CONFIG: JSON.stringify({ app: { security: { csp: null } } }),
    },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0, 'null CSP override unexpectedly fell back to the base policy');
  assert.match(`${result.stderr}\n${result.stdout}`, /CSP|connect-src/i);
});

test('Tauri wrapper derives an exact CSP merge config from the selected endpoint', () => {
  const result = spawnSync('node', ['scripts/tauri-build.mjs', '--print-config'], {
    cwd: clientRoot,
    env: { ...process.env, DANMAKU_SERVER_URL: 'https://self-hosted.example' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = JSON.parse(result.stdout);
  const csp = config.app.security.csp;
  assert.match(csp, /https:\/\/self-hosted\.example/);
  assert.match(csp, /wss:\/\/self-hosted\.example/);
  assert.doesNotMatch(csp, /danmaku\.kolvid\.app|127\.0\.0\.1|connect-src[^;]*(?:https:|wss:)\s/);
  const pkg = JSON.parse(fs.readFileSync(path.join(clientRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['tauri:build'], 'node scripts/tauri-build.mjs build');
  assert.equal(pkg.scripts['tauri:dev'], 'node scripts/tauri-build.mjs dev');
});

test('aggregate build command emits Desktop shared assets and Extension runtime bundles', () => {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: clientRoot,
    env: { ...process.env, DANMAKU_SERVER_URL: 'http://127.0.0.1:3999' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(generatedBundle), true);
  assert.equal(fs.existsSync(path.join(extensionDist, 'background.js')), true);
  assert.equal(fs.existsSync(path.join(extensionDist, 'content.js')), true);
  assert.equal(fs.existsSync(path.join(extensionDist, 'manifest.json')), true);
});

test('extension build emits only runtime-reachable bundles and removes stale generated files', () => {
  fs.mkdirSync(extensionDist, { recursive: true });
  fs.writeFileSync(path.join(extensionDist, 'stale-artifact.js'), 'stale');
  const result = spawnSync('npm', ['run', 'build:extension'], {
    cwd: clientRoot,
    env: { ...process.env, DANMAKU_SERVER_URL: 'http://127.0.0.1:3999' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(extensionDist, 'stale-artifact.js')), false);
  assert.equal(fs.existsSync(path.join(extensionDist, 'shared-core.js')), false);
  assert.equal(fs.existsSync(path.join(extensionDist, 'overlay.css')), false);
  for (const runtime of ['background.js', 'content.js', 'popup.js', 'options.js']) {
    const source = fs.readFileSync(path.join(extensionDist, runtime), 'utf8');
    assert.doesNotMatch(source, /sourceMappingURL|\beval\s*\(|__DANMAKU_SERVER_URL__|https?:\/\/[^"']+\.js/i);
  }
  const ignoreRules = fs.readFileSync(path.join(repositoryRoot, '.gitignore'), 'utf8');
  assert.match(ignoreRules, /^extension\/dist\/$/m);
});

test('extension package is reproducible across source mtime drift and writes a portable checksum', () => {
  const build = spawnSync('npm', ['run', 'build:extension'], {
    cwd: clientRoot,
    env: { ...process.env, DANMAKU_SERVER_URL: 'http://127.0.0.1:3999' },
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const first = spawnSync('npm', ['run', 'package:extension'], {
    cwd: clientRoot,
    encoding: 'utf8',
  });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDist, 'manifest.json'), 'utf8'));
  const releaseDir = path.join(repositoryRoot, 'release', 'browser-extension');
  const base = `danmaku-overlay-extension-${manifest.version}.zip`;
  const zip = path.join(releaseDir, base);
  const checksum = `${zip}.sha256`;
  const firstBytes = fs.readFileSync(zip);

  const shifted = new Date('2020-01-02T03:04:06.000Z');
  for (const file of walkFiles(extensionDist)) fs.utimesSync(file, shifted, shifted);

  const second = spawnSync('npm', ['run', 'package:extension'], {
    cwd: clientRoot,
    encoding: 'utf8',
  });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.deepEqual(fs.readFileSync(zip), firstBytes, 'ZIP bytes changed when only source mtimes changed');
  assert.match(fs.readFileSync(checksum, 'utf8'), new RegExp(`^[a-f0-9]{64}  ${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n$`));

  const check = spawnSync('sha256sum', ['--check', path.basename(checksum)], {
    cwd: releaseDir,
    encoding: 'utf8',
  });
  assert.equal(check.status, 0, check.stderr || check.stdout);
});

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(target) : [target];
  });
}
