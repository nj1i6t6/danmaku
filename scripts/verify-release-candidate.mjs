import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootIndex = process.argv.indexOf('--root');
const root = path.resolve(rootIndex >= 0 ? (process.argv[rootIndex + 1] || '') : path.join(here, '..'));
const errors = [];
const checks = [];

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`release-candidate root is not a directory: ${root}`);
  process.exit(2);
}

const expectedLicenseSha256 = '05a907829bd5b950017f82ce1f5f97a1d7886c8f8a139fd5040ab7ac75f233de';
const activeRoots = [
  '.github/workflows', 'android', 'app', 'clients/web-overlay', 'deploy', 'desktop', 'extension/dist', 'scripts',
];
const rootDocs = [
  '.env.example', '.gitignore', 'ACCEPTABLE-USE.md', 'BUILD-NOTES.md', 'CONTRIBUTING.md', 'INDEX.md', 'LICENSE',
  'PRIVACY.md', 'README.md', 'SECURITY.md', 'TERMS-OF-SERVICE.md', 'TRADEMARK.md',
  'docs/architecture.md', 'docs/extension-permissions.md', 'docs/self-hosting.md',
];
const skippedSegments = new Set(['node_modules', '.gradle', 'build', 'target', '.task-logs', 'test-results']);
const allowedBinary = [
  /^android\/gradle\/wrapper\/gradle-wrapper\.jar$/,
  /^app\/public\/icons\/[A-Za-z0-9._-]+\.png$/,
  /^clients\/web-overlay\/src\/extension\/icons\/icon-(?:16|32|48|128)\.png$/,
  /^desktop\/src-tauri\/icons\/[A-Za-z0-9@._-]+\.(?:png|ico|icns)$/,
  /^extension\/dist\/icons\/icon-(?:16|32|48|128)\.png$/,
];
const textExtensions = new Set([
  '.css', '.html', '.js', '.json', '.kt', '.kts', '.md', '.mjs', '.service', '.toml', '.txt', '.xml', '.yaml', '.yml',
]);

runVerifier('extension verifier', process.execPath, ['clients/web-overlay/scripts/verify-extension.mjs']);
runVerifier('retired-product verifier', process.execPath, ['scripts/verify-retired-stock.mjs', '--root', root]);
runVerifier('public-source verifier', process.execPath, ['scripts/verify-public-tree.mjs', '--source', root]);

const licensePath = path.join(root, 'LICENSE');
if (!fs.existsSync(licensePath)) errors.push('LICENSE is missing');
else if (sha256File(licensePath) !== expectedLicenseSha256) errors.push('custom LICENSE bytes changed');
else checks.push('custom LICENSE preserved');

verifyGeneratedDesktop();
verifyExtensionPackage();
verifyLanding();
verifyActiveTree();
verifyIgnorePolicy();
verifyRequiredModes();

if (errors.length) {
  console.error(`release-candidate verification failed (${errors.length} finding${errors.length === 1 ? '' : 's'})`);
  for (const finding of errors) console.error(`- ${finding}`);
  process.exit(1);
}
console.log(`release-candidate verification passed (${checks.length} checks)`);
for (const check of checks) console.log(`- ${check}`);

function runVerifier(label, command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    errors.push(`${label} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
    return;
  }
  checks.push(label);
}

function verifyGeneratedDesktop() {
  const generated = path.join(root, 'desktop', 'frontend', 'generated');
  const expected = ['overlay.css', 'shared-core.js'];
  const actual = regularFiles(generated).map((file) => normalize(path.relative(generated, file))).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(`desktop generated output must be exactly ${expected.join(', ')} (found: ${actual.join(', ') || 'none'})`);
    return;
  }
  for (const relative of expected) {
    const source = fs.readFileSync(path.join(generated, relative), 'utf8');
    if (/sourceMappingURL|\beval\s*\(|new\s+Function\s*\(/.test(source)) errors.push(`desktop/frontend/generated/${relative}: dynamic code or sourcemap`);
    if (/danmaku\.kolvid\.app/i.test(source)) errors.push(`desktop/frontend/generated/${relative}: hosted endpoint is forbidden in handoff RC`);
  }
  const shared = fs.readFileSync(path.join(generated, 'shared-core.js'), 'utf8');
  if (!/http:\/\/127\.0\.0\.1:3999/.test(shared)) errors.push('desktop generated shared core is not the fail-safe loopback build');
  checks.push('desktop generated output boundary');
}

function verifyExtensionPackage() {
  const dist = path.join(root, 'extension', 'dist');
  const release = path.join(root, 'release', 'browser-extension');
  const distFiles = regularFiles(dist).map((file) => normalize(path.relative(dist, file))).sort();
  const releaseFiles = fs.existsSync(release)
    ? fs.readdirSync(release).filter((name) => fs.statSync(path.join(release, name)).isFile()).sort()
    : [];
  const zips = releaseFiles.filter((name) => name.endsWith('.zip'));
  const checksums = releaseFiles.filter((name) => name.endsWith('.zip.sha256'));
  if (zips.length !== 1 || checksums.length !== 1 || checksums[0] !== `${zips[0]}.sha256`) {
    errors.push(`extension release must contain exactly one ZIP and matching SHA-256 file (found: ${releaseFiles.join(', ') || 'none'})`);
    return;
  }
  const checksumText = fs.readFileSync(path.join(release, checksums[0]), 'utf8');
  const escaped = escapeRegExp(zips[0]);
  if (!new RegExp(`^[a-f0-9]{64}  ${escaped}\\n$`).test(checksumText)) errors.push('extension checksum is not a portable basename record');
  const checksum = spawnSync('sha256sum', ['--check', checksums[0]], { cwd: release, encoding: 'utf8' });
  if (checksum.status !== 0) errors.push(`extension checksum failed: ${(checksum.stderr || checksum.stdout).trim()}`);

  const zipPath = path.join(release, zips[0]);
  const members = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
  if (members.status !== 0) errors.push(`extension ZIP cannot be listed: ${(members.stderr || members.stdout).trim()}`);
  else {
    const memberList = members.stdout.split(/\r?\n/).filter(Boolean).sort();
    if (JSON.stringify(memberList) !== JSON.stringify(distFiles)) errors.push('extension ZIP members differ from verified dist tree');
  }

  const manifest = readJson(path.join(dist, 'manifest.json'), 'extension manifest');
  if (manifest) {
    const referenced = new Set(['manifest.json']);
    if (manifest.background?.service_worker) referenced.add(manifest.background.service_worker);
    for (const declaration of manifest.content_scripts || []) for (const file of declaration.js || []) referenced.add(file);
    if (manifest.action?.default_popup) referenced.add(manifest.action.default_popup);
    if (manifest.options_ui?.page) referenced.add(manifest.options_ui.page);
    for (const file of Object.values(manifest.icons || {})) referenced.add(file);
    for (const file of Object.values(manifest.action?.default_icon || {})) referenced.add(file);
    for (const html of [...referenced].filter((file) => file.endsWith('.html'))) {
      const source = safeRead(path.join(dist, html));
      for (const match of source.matchAll(/<(?:script|link)\b[^>]+(?:src|href)=["']([^"']+)["']/gi)) {
        if (!/^(?:https?:|data:|#|\/)/i.test(match[1])) referenced.add(match[1]);
      }
    }
    const expected = [...referenced].sort();
    if (JSON.stringify(distFiles) !== JSON.stringify(expected)) errors.push('extension dist contains a file not reachable from manifest/runtime HTML');
    const csp = String(manifest.content_security_policy?.extension_pages || '');
    if (/danmaku\.kolvid\.app/i.test(csp)) errors.push('extension manifest contains hosted endpoint in handoff RC');
    if (!/connect-src 'self' http:\/\/127\.0\.0\.1:3999 ws:\/\/127\.0\.0\.1:3999/.test(csp)) errors.push('extension manifest is not the fail-safe loopback build');
  }

  const content = safeRead(path.join(dist, 'content.js'));
  for (const [pattern, label] of [
    [/chrome\.storage|storage\.local/, 'content bundle accesses extension storage'],
    [/EXTENSION_CREDENTIALS_KEY|setOwnerCredential|getOwnerCredential|danmaku\.extension\.credentials/, 'content bundle references credential storage'],
    [/ownerCredential\s*[:=]|raw\.ownerCredential|payload\.ownerCredential/, 'content bundle can receive credential values'],
    [/\bdocument\.cookie\b|\blocalStorage\b|\bsessionStorage\b/, 'content bundle reads host storage'],
    [/\bwindow\.postMessage\b|\bpostMessage\s*\(/, 'content bundle exposes a page bridge'],
  ]) if (pattern.test(content)) errors.push(label);
  checks.push('extension package, checksum, reachability, and credential isolation');
}

function verifyLanding() {
  const publicRoot = path.join(root, 'app', 'public');
  const html = safeRead(path.join(publicRoot, 'index.html'));
  const status = safeRead(path.join(publicRoot, 'status.js'));
  if (!html) {
    errors.push('landing index.html is missing');
    return;
  }
  // Canonical/OG metadata may use absolute https URLs; only remote executable assets are forbidden.
  if (/<script\b[^>]*\bsrc=["']https?:\/\//i.test(html)) errors.push('landing loads a remote script or stylesheet');
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = /rel=["']([^"']+)["']/i.exec(tag)?.[1] || '';
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1] || '';
    const isStylesheet = rel.split(/\s+/).some((token) => token.toLowerCase() === 'stylesheet');
    if (isStylesheet && /^https?:\/\//i.test(href)) {
      errors.push('landing loads a remote script or stylesheet');
      break;
    }
  }
  if (/socket\.io|io\s*\(/i.test(`${html}\n${status}`)) errors.push('landing initializes a chat Socket');
  if (/google-analytics|googletagmanager|segment|mixpanel|hotjar/i.test(`${html}\n${status}`)) errors.push('landing contains analytics code');
  if (/\bfetch\s*\(|\/healthz|new\s+WebSocket|new\s+EventSource/i.test(status)) errors.push('landing script performs a backend or network request');
  if (!/data-static-only/.test(html)) errors.push('landing does not declare its static-only boundary');
  checks.push('minimal static local-only landing');
}

function verifyActiveTree() {
  const files = new Set();
  for (const relative of activeRoots) collect(path.join(root, relative), files);
  for (const relative of rootDocs) {
    const absolute = path.join(root, relative);
    if (fs.existsSync(absolute)) files.add(absolute);
    else errors.push(`required RC file is missing: ${relative}`);
  }

  for (const absolute of [...files].sort()) {
    const relative = normalize(path.relative(root, absolute));
    const metadata = fs.lstatSync(absolute);
    if (metadata.isSymbolicLink()) {
      errors.push(`${relative}: symlink is forbidden in active RC tree`);
      continue;
    }
    const buffer = fs.readFileSync(absolute);
    if (buffer.includes(0)) {
      if (!allowedBinary.some((pattern) => pattern.test(relative))) errors.push(`${relative}: unexpected binary in active RC tree`);
      continue;
    }
    const extension = path.extname(relative).toLowerCase();
    if (!textExtensions.has(extension) && path.basename(relative) !== '.env.example' && path.basename(relative) !== '.gitignore' && path.basename(relative) !== 'LICENSE') continue;
    inspectText(relative, buffer.toString('utf8'));
  }
  checks.push(`active source secret/symlink/binary scan (${files.size} files)`);
}

function inspectText(relative, source) {
  const scannerFixture = relative === 'scripts/tests/public-export.test.mjs';
  const scannerImplementation = ['scripts/public-tree-policy.mjs', 'scripts/verify-release-candidate.mjs'].includes(relative);
  source.split(/\r?\n/).forEach((line, index) => {
    const location = `${relative}:${index + 1}`;
    if (/[\u202A-\u202E\u2066-\u2069]/u.test(line)) errors.push(`${location}: bidirectional control character`);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line) && !scannerFixture && !scannerImplementation) errors.push(`${location}: private key material`);
    if (/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i.test(line) && !scannerFixture) errors.push(`${location}: credential-bearing URL`);
    const tokens = [
      /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, /\bgithub_pat_[A-Za-z0-9_]{40,}\b/, /\bAKIA[0-9A-Z]{16}\b/,
      /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/,
    ];
    if (tokens.some((pattern) => pattern.test(line)) && !scannerFixture && !scannerImplementation) errors.push(`${location}: token-like secret`);
  });
}

function verifyIgnorePolicy() {
  const source = safeRead(path.join(root, '.gitignore'));
  const required = [
    'desktop/frontend/generated/', 'extension/dist/', 'release/', '.task-logs/', '.task-artifacts/',
    'test-results/', '**/test-results/', '**/playwright-report/', 'android/.gradle/', 'android/app/build/',
  ];
  for (const entry of required) {
    const pattern = new RegExp(`(?:^|\\n)${escapeRegExp(entry)}(?:\\n|$)`);
    if (!pattern.test(source)) errors.push(`.gitignore is missing generated/runtime exclusion: ${entry}`);
  }
  checks.push('generated/runtime ignore policy');
}

function verifyRequiredModes() {
  const gradlew = path.join(root, 'android', 'gradlew');
  if (!fs.existsSync(gradlew) || (fs.statSync(gradlew).mode & 0o111) === 0) errors.push('android/gradlew is missing or not executable');
  else checks.push('required executable bits');
}

function collect(target, output) {
  if (!fs.existsSync(target)) return;
  const metadata = fs.lstatSync(target);
  if (metadata.isSymbolicLink() || metadata.isFile()) {
    output.add(target);
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedSegments.has(entry.name)) continue;
    collect(path.join(target, entry.name), output);
  }
}

function regularFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(`${normalize(path.relative(root, target))}: symlink is forbidden`);
      return [];
    }
    return entry.isDirectory() ? regularFiles(target) : [target];
  });
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { errors.push(`${label} is missing or invalid: ${error.message}`); return null; }
}

function safeRead(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { return ''; }
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function normalize(value) {
  return value.split(path.sep).join('/');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
