import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const PUBLIC_MANIFEST_NAME = 'PUBLIC-SOURCE-MANIFEST.json';
export const PUBLIC_LICENSE_ID = 'LicenseRef-Stock-Danmaku-NC-Network-Copyleft-1.0';

const ROOT_FILES = [
  '.env.example',
  '.gitignore',
  'ACCEPTABLE-USE.md',
  'BUILD-NOTES.md',
  'CONTRIBUTING.md',
  'INDEX.md',
  'LICENSE',
  'PRIVACY.md',
  'README.md',
  'SECURITY.md',
  'TERMS-OF-SERVICE.md',
  'TRADEMARK.md',
  'deploy/stock-danmaku.service',
  'docs/architecture.md',
  'docs/extension-permissions.md',
  'docs/self-hosting.md',
];

const DIRECTORY_RULES = [
  { root: '.github/workflows', include: (relative) => /\.ya?ml$/i.test(relative) },
  { root: 'android', excludeSegments: new Set(['.gradle', 'build']), excludeNames: new Set(['local.properties']) },
  { root: 'app', excludeSegments: new Set(['node_modules', 'test-results', 'playwright-report']), excludeExtensions: new Set(['.db', '.sqlite', '.sqlite3', '.log']) },
  {
    root: 'clients/web-overlay',
    excludeSegments: new Set(['node_modules', 'test-results', 'playwright-report']),
    excludePaths: new Set(['clients/web-overlay/src/extension/shared-core-entry.js']),
  },
  {
    root: 'desktop',
    excludeSegments: new Set(['target', 'test-results', 'playwright-report']),
    excludePrefixes: ['desktop/frontend/generated/', 'desktop/src-tauri/gen/'],
  },
  { root: 'load-tests', excludeSegments: new Set(['results']) },
  { root: 'scripts', include: (relative) => /\.mjs$/i.test(relative) },
];

const FORBIDDEN_SEGMENTS = new Set([
  '.git', '.hermes', '.task-logs', 'node_modules', 'target', 'build', '.gradle',
  'release', 'archive', 'reference', 'research', 'test-results', 'reports',
]);
const FORBIDDEN_FILENAMES = new Set(['local.properties', '.env']);
const FORBIDDEN_EXTENSIONS = new Set([
  '.apk', '.aab', '.exe', '.msi', '.dmg', '.zip', '.7z', '.rar', '.tar', '.gz',
  '.db', '.sqlite', '.sqlite3', '.log', '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore',
]);
const ALLOWED_BINARY = [
  /^android\/gradle\/wrapper\/gradle-wrapper\.jar$/,
  /^app\/public\/icons\/[A-Za-z0-9._-]+\.png$/,
  /^clients\/web-overlay\/src\/extension\/icons\/icon-(?:16|32|48|128)\.png$/,
  /^desktop\/src-tauri\/icons\/[A-Za-z0-9@._-]+\.(?:png|ico|icns)$/,
];
const MAX_PUBLIC_FILE_BYTES = 5 * 1024 * 1024;

function normalize(relative) {
  return relative.split(path.sep).join('/');
}

function pathSegments(relative) {
  return normalize(relative).split('/').filter(Boolean);
}

function isRuleExcluded(relative, rule) {
  const normalized = normalize(relative);
  const segments = pathSegments(normalized);
  if (rule.excludeSegments && segments.some((segment) => rule.excludeSegments.has(segment))) return true;
  if (rule.excludePaths && rule.excludePaths.has(normalized)) return true;
  if (rule.excludeNames && rule.excludeNames.has(path.posix.basename(normalized))) return true;
  if (rule.excludeExtensions && rule.excludeExtensions.has(path.posix.extname(normalized).toLowerCase())) return true;
  if (rule.excludePrefixes && rule.excludePrefixes.some((prefix) => normalized.startsWith(prefix))) return true;
  return false;
}

async function collectRule(root, rule, output, current = rule.root) {
  const absolute = path.join(root, current);
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`required public path is missing: ${normalize(current)}`);
    throw error;
  }
  if (metadata.isSymbolicLink()) throw new Error(`symlink is forbidden in public allowlist: ${normalize(current)}`);
  if (metadata.isFile()) {
    const relative = normalize(current);
    if (!isRuleExcluded(relative, rule) && (!rule.include || rule.include(relative))) output.add(relative);
    return;
  }
  if (!metadata.isDirectory()) throw new Error(`unsupported public path type: ${normalize(current)}`);
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = normalize(path.join(current, entry.name));
    if (isRuleExcluded(relative, rule)) continue;
    await collectRule(root, rule, output, relative);
  }
}

export async function listPublicSourceFiles(root) {
  const resolved = path.resolve(root);
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) throw new Error(`public source root is not a directory: ${resolved}`);
  const output = new Set();
  for (const relative of ROOT_FILES) {
    const absolute = path.join(resolved, relative);
    const entry = await lstat(absolute).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error(`required public file is missing: ${relative}`);
      throw error;
    });
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`required public file is not a regular file: ${relative}`);
    output.add(relative);
  }
  for (const rule of DIRECTORY_RULES) await collectRule(resolved, rule, output);
  return [...output].sort();
}

async function walkAll(root, current = '', output = []) {
  const absolute = current ? path.join(root, current) : root;
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink()) {
    output.push({ path: normalize(current), kind: 'symlink' });
    return output;
  }
  if (metadata.isFile()) {
    output.push({ path: normalize(current), kind: 'file' });
    return output;
  }
  if (!metadata.isDirectory()) {
    output.push({ path: normalize(current), kind: 'other' });
    return output;
  }
  for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    await walkAll(root, path.join(current, entry.name), output);
  }
  return output;
}

function isAllowedBinary(relative) {
  return ALLOWED_BINARY.some((expression) => expression.test(relative));
}

function validatePath(relative, errors) {
  const normalized = normalize(relative);
  if (!normalized || normalized.startsWith('/') || normalized.includes('../') || normalized.includes('\\')) {
    errors.push(`${normalized || '<root>'}: invalid relative path`);
    return;
  }
  const segments = pathSegments(normalized);
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) errors.push(`${normalized}: forbidden private/build directory`);
  if (FORBIDDEN_FILENAMES.has(path.posix.basename(normalized))) errors.push(`${normalized}: forbidden private filename`);
  const extension = path.posix.extname(normalized).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(extension)) errors.push(`${normalized}: forbidden release/private artifact`);
}

function inspectText(relative, text, errors) {
  const scannerFixture = relative === 'scripts/tests/public-export.test.mjs';
  const scannerImplementation = relative === 'scripts/public-tree-policy.mjs';
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const location = `${relative}:${index + 1}`;
    if (/[\u202A-\u202E\u2066-\u2069]/u.test(line)) errors.push(`${location}: bidirectional control character`);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line) && !scannerFixture && !scannerImplementation) {
      errors.push(`${location}: private key material`);
    }
    if (/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i.test(line) && !scannerFixture) {
      errors.push(`${location}: credential-bearing URL`);
    }
    const tokenPatterns = [
      /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
      /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
      /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/,
    ];
    if (tokenPatterns.some((pattern) => pattern.test(line)) && !scannerFixture && !scannerImplementation) {
      errors.push(`${location}: token-like secret`);
    }
    const assignment = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'`]([^"'`]{20,})["'`]/i.exec(line);
    if (assignment && !/(?:placeholder|example|change-me|not-a-real|never-public|owner-secret|supersecret|\$\{|<)/i.test(assignment[1]) && !scannerImplementation) {
      errors.push(`${location}: secret-like assignment`);
    }
  });
}

async function inspectFile(root, relative, errors) {
  validatePath(relative, errors);
  const absolute = path.join(root, relative);
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink()) {
    errors.push(`${relative}: symlink is forbidden`);
    return;
  }
  if (!metadata.isFile()) {
    errors.push(`${relative}: not a regular file`);
    return;
  }
  if (metadata.size > MAX_PUBLIC_FILE_BYTES) errors.push(`${relative}: file exceeds ${MAX_PUBLIC_FILE_BYTES} bytes`);
  const buffer = await readFile(absolute);
  const binary = buffer.includes(0);
  if (binary && !isAllowedBinary(relative)) {
    errors.push(`${relative}: unexpected binary file`);
    return;
  }
  if (!binary) inspectText(relative, buffer.toString('utf8'), errors);
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
}

function validateManifestShape(manifest, errors) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push(`${PUBLIC_MANIFEST_NAME}: invalid object`);
    return [];
  }
  if (manifest.formatVersion !== 1) errors.push(`${PUBLIC_MANIFEST_NAME}: unsupported formatVersion`);
  if (manifest.license !== PUBLIC_LICENSE_ID) errors.push(`${PUBLIC_MANIFEST_NAME}: incorrect license identifier`);
  if (!Array.isArray(manifest.files)) {
    errors.push(`${PUBLIC_MANIFEST_NAME}: files must be an array`);
    return [];
  }
  const paths = manifest.files.map((entry) => entry?.path);
  if (paths.some((entry) => typeof entry !== 'string')) errors.push(`${PUBLIC_MANIFEST_NAME}: every entry requires a path`);
  if (new Set(paths).size !== paths.length) errors.push(`${PUBLIC_MANIFEST_NAME}: duplicate paths`);
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort())) errors.push(`${PUBLIC_MANIFEST_NAME}: paths are not sorted`);
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object') continue;
    const keys = Object.keys(entry).sort();
    if (keys.some((key) => !['executable', 'path', 'sha256', 'size'].includes(key))) errors.push(`${PUBLIC_MANIFEST_NAME}: unsanitized field in ${entry.path || '<unknown>'}`);
    if (!Number.isInteger(entry.size) || entry.size < 0) errors.push(`${PUBLIC_MANIFEST_NAME}: invalid size for ${entry.path}`);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 || '')) errors.push(`${PUBLIC_MANIFEST_NAME}: invalid sha256 for ${entry.path}`);
    if (entry.executable !== undefined && entry.executable !== true) errors.push(`${PUBLIC_MANIFEST_NAME}: executable may only be true or omitted`);
  }
  return manifest.files;
}

export async function verifyPublicTree(root, { requireManifest = false } = {}) {
  const resolved = path.resolve(root);
  const rootStat = await stat(resolved).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`public tree does not exist: ${resolved}`);
    throw error;
  });
  if (!rootStat.isDirectory()) throw new Error(`public tree is not a directory: ${resolved}`);
  const errors = [];
  const manifestPath = path.join(resolved, PUBLIC_MANIFEST_NAME);
  const hasManifest = await lstat(manifestPath).then((entry) => entry.isFile()).catch((error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (requireManifest && !hasManifest) errors.push(`${PUBLIC_MANIFEST_NAME}: required for exported tree`);

  let files;
  if (hasManifest && requireManifest) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      errors.push(`${PUBLIC_MANIFEST_NAME}: unreadable JSON (${error.message})`);
      manifest = null;
    }
    const entries = validateManifestShape(manifest, errors);
    const walked = await walkAll(resolved);
    for (const entry of walked) {
      if (entry.kind === 'symlink') errors.push(`${entry.path}: symlink is forbidden`);
      if (entry.kind === 'other') errors.push(`${entry.path}: unsupported filesystem entry`);
    }
    const actual = walked.filter((entry) => entry.kind === 'file' && entry.path !== PUBLIC_MANIFEST_NAME).map((entry) => entry.path).sort();
    const declared = entries.map((entry) => entry.path).filter((entry) => typeof entry === 'string');
    if (JSON.stringify(actual) !== JSON.stringify(declared)) {
      const missing = declared.filter((entry) => !actual.includes(entry));
      const extra = actual.filter((entry) => !declared.includes(entry));
      if (missing.length) errors.push(`${PUBLIC_MANIFEST_NAME}: missing files: ${missing.join(', ')}`);
      if (extra.length) errors.push(`${PUBLIC_MANIFEST_NAME}: undeclared files: ${extra.join(', ')}`);
    }
    files = actual;
    for (const entry of entries) {
      if (typeof entry?.path !== 'string' || !actual.includes(entry.path)) continue;
      const absolute = path.join(resolved, entry.path);
      const metadata = await stat(absolute);
      if (metadata.size !== entry.size) errors.push(`${entry.path}: size differs from manifest`);
      if (await sha256File(absolute) !== entry.sha256) errors.push(`${entry.path}: sha256 differs from manifest`);
      if (entry.executable === true && (metadata.mode & 0o111) === 0) errors.push(`${entry.path}: executable bit was not preserved`);
    }
  } else {
    files = await listPublicSourceFiles(resolved);
  }

  for (const relative of files) await inspectFile(resolved, relative, errors);

  const antiZombie = path.join(resolved, 'scripts/verify-retired-stock.mjs');
  if (await lstat(antiZombie).then((entry) => entry.isFile()).catch(() => false)) {
    const result = spawnSync(process.execPath, [antiZombie, '--root', resolved], { encoding: 'utf8' });
    if (result.status !== 0) errors.push(`retired-product verification failed: ${(result.stderr || result.stdout).trim()}`);
  } else {
    errors.push('scripts/verify-retired-stock.mjs: required verifier is missing');
  }

  if (errors.length) {
    const error = new Error(`public-tree verification failed (${errors.length} finding${errors.length === 1 ? '' : 's'})\n${errors.map((entry) => `- ${entry}`).join('\n')}`);
    error.findings = errors;
    throw error;
  }
  return { files: files.length, manifest: hasManifest && requireManifest };
}
