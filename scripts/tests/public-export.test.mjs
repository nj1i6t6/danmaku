import assert from 'node:assert/strict';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const exportScript = path.join(ROOT, 'scripts/export-public.mjs');
const verifyScript = path.join(ROOT, 'scripts/verify-public-tree.mjs');

function run(script, args, cwd = ROOT) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

async function temporaryDirectory(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test('current source public allowlist passes verification', () => {
  const result = run(verifyScript, ['--source', ROOT]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /public-tree verification passed/);
});

test('export copies only the explicit public allowlist and creates a deterministic sanitized manifest', async (t) => {
  const parent = await temporaryDirectory('danmaku-public-export-');
  t.after(() => rm(parent, { recursive: true, force: true }));
  const runtimeFixture = path.join(ROOT, 'load-tests', 'results', `public-export-${process.pid}.json`);
  const prefixSibling = path.join(ROOT, 'clients', 'web-overlay', 'src', 'extension', 'shared-core-entry.js.fixture');
  await mkdir(path.dirname(runtimeFixture), { recursive: true });
  await writeFile(runtimeFixture, '{"runtime":"private"}');
  await writeFile(prefixSibling, 'public sibling fixture');
  t.after(() => Promise.all([rm(runtimeFixture, { force: true }), rm(prefixSibling, { force: true })]));
  const output = path.join(parent, 'export');
  const result = run(exportScript, ['--output', output]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  for (const relative of [
    'README.md', 'LICENSE', '.env.example', '.github/workflows/ci.yml',
    'app/server.js', 'android/gradlew', 'desktop/src-tauri/Cargo.lock',
    'clients/web-overlay/src/extension/background.js', 'scripts/verify-public-tree.mjs',
    'clients/web-overlay/src/extension/shared-core-entry.js.fixture',
    'PUBLIC-SOURCE-MANIFEST.json',
  ]) assert.equal((await stat(path.join(output, relative))).isFile(), true, relative);

  for (const relative of [
    '.git', '.task-logs', 'archive', 'release', 'extension/dist', 'test-results',
    'app/node_modules', 'clients/web-overlay/node_modules', 'TASK-EXECUTION-STATUS.md',
    'AI-HANDOFF-TASKS-4-9.md', 'PROJECT-TASKS-4-9.md', 'docs/specs', 'design',
    'clients/web-overlay/src/extension/shared-core-entry.js', 'desktop/src-tauri/gen',
    'load-tests/results',
  ]) await assert.rejects(lstat(path.join(output, relative)), { code: 'ENOENT' }, relative);

  const manifestText = await readFile(path.join(output, 'PUBLIC-SOURCE-MANIFEST.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.license, 'LicenseRef-Stock-Danmaku-NC-Network-Copyleft-1.0');
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 100);
  assert.deepEqual(manifest.files.map((entry) => entry.path), [...manifest.files.map((entry) => entry.path)].sort());
  assert.equal(manifest.files.some((entry) => /generatedAt|sourcePath|workspace|task-logs/i.test(JSON.stringify(entry))), false);
  assert.equal((await stat(path.join(output, 'android/gradlew'))).mode & 0o111, 0o111);

  const verify = run(path.join(output, 'scripts/verify-public-tree.mjs'), ['--source', output], output);
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);
});

test('export refuses a non-empty target and never overwrites existing data', async (t) => {
  const output = await temporaryDirectory('danmaku-nonempty-export-');
  t.after(() => rm(output, { recursive: true, force: true }));
  const sentinel = path.join(output, 'keep.txt');
  await writeFile(sentinel, 'keep me');
  const result = run(exportScript, ['--output', output]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /empty|non-empty|not overwrite/i);
  assert.equal(await readFile(sentinel, 'utf8'), 'keep me');
});

test('verifier rejects symlinks, credential URLs, private keys, release binaries, and manifest drift', async (t) => {
  const parent = await temporaryDirectory('danmaku-public-negative-');
  t.after(() => rm(parent, { recursive: true, force: true }));
  const baseline = path.join(parent, 'baseline');
  assert.equal(run(exportScript, ['--output', baseline]).status, 0);

  const cases = [
    ['symlink', async (root) => symlink('/etc/passwd', path.join(root, 'app/escape-link'))],
    ['credential-url', async (root) => writeFile(path.join(root, 'app/credential-url.txt'), 'https://alice:supersecret@example.invalid')],
    ['private-key', async (root) => writeFile(path.join(root, 'app/private-key.txt'), '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----')],
    ['binary', async (root) => writeFile(path.join(root, 'app/release.apk'), Buffer.from([0, 1, 2, 3]))],
    ['extra', async (root) => writeFile(path.join(root, 'EXTRA.md'), 'not in manifest')],
    ['tamper', async (root) => writeFile(path.join(root, 'README.md'), 'tampered')],
  ];

  for (const [name, mutate] of cases) {
    const candidate = path.join(parent, name);
    await mkdir(candidate);
    const copied = spawnSync('cp', ['-a', `${baseline}/.`, candidate], { encoding: 'utf8' });
    assert.equal(copied.status, 0, copied.stderr);
    await mutate(candidate);
    const result = run(path.join(candidate, 'scripts/verify-public-tree.mjs'), ['--source', candidate], candidate);
    assert.notEqual(result.status, 0, `${name} unexpectedly passed`);
  }
});
