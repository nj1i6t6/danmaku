import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = path.join(root, 'extension', 'dist');
const rcVerifier = path.join(root, 'scripts', 'verify-release-candidate.mjs');
const extensionVerifier = path.join(root, 'clients', 'web-overlay', 'scripts', 'verify-extension.mjs');

function walk(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(path.join(directory, entry.name), relative) : [relative];
  }).sort();
}

function referencedPackageMembers() {
  const manifest = JSON.parse(readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
  const members = new Set(['manifest.json']);
  members.add(manifest.background.service_worker);
  for (const script of manifest.content_scripts) for (const file of script.js || []) members.add(file);
  if (manifest.action?.default_popup) members.add(manifest.action.default_popup);
  if (manifest.options_ui?.page) members.add(manifest.options_ui.page);
  for (const value of Object.values(manifest.icons || {})) members.add(value);
  for (const value of Object.values(manifest.action?.default_icon || {})) members.add(value);

  for (const html of [...members].filter((file) => file.endsWith('.html'))) {
    const source = readFileSync(path.join(dist, html), 'utf8');
    for (const match of source.matchAll(/<(?:script|link)\b[^>]+(?:src|href)=["']([^"']+)["']/gi)) {
      if (!/^(?:https?:|data:|#|\/)/i.test(match[1])) members.add(match[1]);
    }
  }
  return [...members].sort();
}

test('extension ZIP contains only manifest-reachable runtime files', () => {
  assert.deepEqual(walk(dist), referencedPackageMembers());
});

test('content bundle cannot access credential storage or receive credential values', () => {
  const source = readFileSync(path.join(dist, 'content.js'), 'utf8');
  assert.doesNotMatch(source, /EXTENSION_CREDENTIALS_KEY|setOwnerCredential|getOwnerCredential|danmaku\.extension\.credentials/);
  assert.doesNotMatch(source, /ownerCredential\s*[:=]|raw\.ownerCredential|payload\.ownerCredential/);
  assert.doesNotMatch(source, /chrome\.storage|storage\.local/);
});

test('extension checksum is portable and verifies the exact ZIP bytes', () => {
  const release = path.join(root, 'release', 'browser-extension');
  const checksum = readdirSync(release).find((name) => name.endsWith('.zip.sha256'));
  assert.ok(checksum, 'missing checksum');
  const line = readFileSync(path.join(release, checksum), 'utf8').trim();
  assert.match(line, /^[a-f0-9]{64}  [^/\\]+\.zip$/);
  const result = spawnSync('sha256sum', ['--check', checksum], { cwd: release, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('extension verifier rejects an extra CSP connect origin', (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'danmaku-extension-csp-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const candidate = path.join(parent, 'dist');
  cpSync(dist, candidate, { recursive: true });
  const manifestPath = path.join(candidate, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.content_security_policy.extension_pages += ' https://unexpected.example';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const result = spawnSync(process.execPath, [extensionVerifier, '--dist', candidate], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /connect-src|unexpected|endpoint pair/i);
});

test('generated outputs and local verification evidence are excluded from source control', () => {
  const source = readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const entry of [
    'desktop/frontend/generated/', 'extension/dist/', 'release/', 'artifacts/', 'releases/', '.task-logs/', '.task-artifacts/',
    'test-results/', '**/test-results/', '**/playwright-report/',
  ]) {
    assert.match(source, new RegExp(`(?:^|\\n)${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\n|$)`));
  }
});

test('release-candidate verifier exists and passes the current local tree', () => {
  assert.equal(statSync(rcVerifier).isFile(), true);
  const result = spawnSync(process.execPath, [rcVerifier, '--root', root], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /release-candidate verification passed/i);
});
