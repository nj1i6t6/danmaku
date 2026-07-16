import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const argumentIndex = process.argv.indexOf('--dist');
const dist = argumentIndex >= 0 ? path.resolve(process.argv[argumentIndex + 1]) : path.join(root, 'extension', 'dist');
const storePackage = process.argv.includes('--store-package');
const errors = [];
const allowed = [
  'background.js', 'content.js',
  'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png',
  'manifest.json', 'options.css', 'options.html', 'options.js',
  'popup.css', 'popup.html', 'popup.js',
].sort();
const files = walk(dist).map((file) => path.relative(dist, file).replaceAll(path.sep, '/')).sort();
for (const required of allowed) if (!files.includes(required)) errors.push(`missing ${required}`);
for (const extra of files.filter((file) => !allowed.includes(file))) errors.push(`unexpected package member ${extra}`);

let manifest;
try { manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8')); }
catch { errors.push('manifest.json is missing or invalid'); }
if (manifest) {
  if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
  if (JSON.stringify(manifest.permissions) !== JSON.stringify(['storage'])) errors.push('only storage API permission is allowed');
  if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['http://*/*', 'https://*/*'])) errors.push('host permissions must be exactly HTTP and HTTPS');
  if (manifest.background?.service_worker !== 'background.js' || manifest.background?.type !== 'module') errors.push('background service worker is invalid');
  const content = manifest.content_scripts;
  if (!Array.isArray(content) || content.length !== 1) errors.push('exactly one content script declaration is required');
  else {
    if (JSON.stringify(content[0].matches) !== JSON.stringify(['http://*/*', 'https://*/*'])) errors.push('content script matches are invalid');
    if (JSON.stringify(content[0].js) !== JSON.stringify(['content.js'])) errors.push('content script bundle is invalid');
    if (content[0].all_frames !== false) errors.push('content script must be top-frame only');
  }
  if (manifest.action?.default_popup !== 'popup.html') errors.push('popup is not wired');
  if (manifest.options_ui?.page !== 'options.html') errors.push('options page is not wired');
  const csp = String(manifest.content_security_policy?.extension_pages || '');
  if (/unsafe-eval|unsafe-inline/i.test(csp)) errors.push('extension CSP must not allow unsafe-eval or unsafe-inline');
  const directives = new Map();
  for (const rawDirective of csp.split(';').map((value) => value.trim()).filter(Boolean)) {
    const [rawName, ...values] = rawDirective.split(/\s+/);
    const name = rawName.toLowerCase();
    if (directives.has(name)) errors.push(`extension CSP contains duplicate ${name}`);
    directives.set(name, values);
  }
  if (JSON.stringify(directives.get('script-src')) !== JSON.stringify(["'self'"])) errors.push("extension CSP script-src must be exactly 'self'");
  if (JSON.stringify(directives.get('object-src')) !== JSON.stringify(["'self'"])) errors.push("extension CSP object-src must be exactly 'self'");
  const connectSources = directives.get('connect-src') || [];
  const remoteSources = connectSources.filter((source) => source !== "'self'");
  if (connectSources.length !== 3 || remoteSources.length !== 2 || !connectSources.includes("'self'")) {
    errors.push('extension CSP connect-src must contain self and exactly one HTTP/WS endpoint pair');
  } else {
    const httpSource = remoteSources.find((source) => /^https?:\/\//.test(source));
    const wsSource = remoteSources.find((source) => /^wss?:\/\//.test(source));
    try {
      const httpUrl = new URL(httpSource);
      const wsUrl = new URL(wsSource);
      const expectedWsProtocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      if (httpUrl.username || httpUrl.password || httpUrl.pathname !== '/' || httpUrl.search || httpUrl.hash
        || wsUrl.username || wsUrl.password || wsUrl.pathname !== '/' || wsUrl.search || wsUrl.hash
        || wsUrl.protocol !== expectedWsProtocol || wsUrl.host !== httpUrl.host) {
        errors.push('extension CSP HTTP and WebSocket endpoints must be the same credential-free origin pair');
      }
    } catch {
      errors.push('extension CSP contains an invalid HTTP/WebSocket endpoint pair');
    }
  }
  if (directives.size !== 3) errors.push('extension CSP contains unexpected directives');
  if (storePackage) {
    if (Object.hasOwn(manifest, 'key')) errors.push('store package manifest must omit the development key');
  } else if (typeof manifest.key !== 'string' || manifest.key.length < 200 || /PRIVATE KEY/.test(manifest.key)) {
    errors.push('stable development identity must contain public key material only');
  }
}

for (const file of walk(dist)) {
  const relative = path.relative(dist, file).replaceAll(path.sep, '/');
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) errors.push(`symlink is forbidden: ${relative}`);
  if (/\.map$/i.test(relative)) errors.push(`sourcemap is forbidden: ${relative}`);
  if (/(^|\/)node_modules\//.test(relative)) errors.push(`node_modules is forbidden: ${relative}`);
  if (/\.(pem|key|p12|pfx|db|sqlite|log)$/i.test(relative)) errors.push(`private/runtime file is forbidden: ${relative}`);
  if (/\.(?:js|mjs|html|css|json)$/i.test(relative)) {
    const source = fs.readFileSync(file, 'utf8');
    if (/\beval\s*\(|new\s+Function\s*\(/.test(source)) errors.push(`dynamic code is forbidden: ${relative}`);
    if (/sourceMappingURL/.test(source)) errors.push(`source map reference is forbidden: ${relative}`);
    if (/(?:<script[^>]+src|import\s*\(|importScripts\s*\()[^\n]*(?:https?:)?\/\//i.test(source)) errors.push(`remote executable code is forbidden: ${relative}`);
    if (/https?:\/\/(?:fonts\.googleapis|fonts\.gstatic|cdn\.)/i.test(source)) errors.push(`remote resource is forbidden: ${relative}`);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(source)) errors.push(`private key is forbidden: ${relative}`);
  }
}
const contentBundle = safeRead(path.join(dist, 'content.js'));
for (const [pattern, message] of [
  [/\bdocument\.cookie\b/, 'content script must not read cookies'],
  [/\blocalStorage\b/, 'content script must not access page localStorage'],
  [/\bsessionStorage\b/, 'content script must not access page sessionStorage'],
  [/\bwindow\.postMessage\b|\bpostMessage\s*\(/, 'content script must not expose a postMessage bridge'],
  [/\blocation\.(?:search|hash)\b/, 'content script must not read URL parameters'],
  [/\binnerText\b|\btextContent\s*\+?=\s*document\.(?:body|documentElement)/, 'content script must not collect page text'],
]) if (pattern.test(contentBundle)) errors.push(message);

if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`extension verification passed (${files.length} files)`);

function safeRead(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [target];
    return entry.isDirectory() ? walk(target) : [target];
  });
}
