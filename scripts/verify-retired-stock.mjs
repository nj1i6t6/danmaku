import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, '..');
const rootIndex = process.argv.indexOf('--root');
const root = rootIndex >= 0 ? path.resolve(process.argv[rootIndex + 1] || '') : defaultRoot;
if (!root || !fs.existsSync(root)) throw new Error(`source root does not exist: ${root}`);

const retiredPaths = [
  'app/symbols.json',
  'app/public/manifest.webmanifest',
  'app/public/sw.js',
  ...['app', 'socket-client', 'input', 'send-state', 'room-manager', 'room-model', 'safe-render', 'router', 'tradingview', 'search', 'menu', 'history', 'danmaku']
    .map((name) => `app/public/js/${name}.js`),
  'desktop/frontend/css/overlay.css',
  ...['room-manager', 'room-model', 'safe-render', 'send-state']
    .map((name) => `desktop/frontend/js/${name}.js`),
];

const scanRoots = [
  'app', 'android/app/src', 'clients/web-overlay/src', 'clients/web-overlay/scripts',
  'clients/web-overlay/tests', 'desktop/frontend', 'desktop/src-tauri', 'desktop/tests',
  'extension/dist', 'release/browser-extension', 'deploy',
];
const publicDocs = [
  'README.md', 'INDEX.md', 'BUILD-NOTES.md', 'CONTRIBUTING.md', 'PRIVACY.md', 'SECURITY.md',
  'docs/architecture.md', 'docs/extension-permissions.md', 'docs/self-hosting.md',
];
const ignoredDirectories = new Set(['node_modules', 'target', 'build', '.gradle', '.idea', 'test-results']);
const textExtensions = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.txt', '.xml', '.kt', '.kts', '.toml', '.yml', '.yaml', '.service']);
const forbidden = [
  { label: 'TradingView integration', expression: /\bTradingView\b/i },
  { label: 'retired stock search route', expression: /\/api\/search(?:\?|\b)/i },
  { label: 'retired symbols asset', expression: /(?:^|[/'"`])symbols\.json\b/i },
  { label: 'retired TradingView module', expression: /(?:^|[/'"`])tradingview\.js\b/i },
  { label: 'retired market router', expression: /(?:^|[/'"`])(?:router|search|menu)\.js\b/i },
  { label: 'retired PWA manifest', expression: /manifest\.webmanifest\b/i },
  { label: 'retired service-worker registration', expression: /serviceWorker\s*\.\s*register\s*\(/i },
  { label: 'Google Fonts dependency', expression: /fonts\.(?:googleapis|gstatic)\.com/i },
  { label: 'stock-market product positioning', expression: /stock market danmaku|stock chart|股票(?:搜尋|行情|看盤)|行情圖/i },
];
const negativeTestContext = /(?:retired|removed|forbid|reject|404|doesNotMatch|not\.|不存在|移除|禁止|不得|不接受|不恢復|退役)/i;
const migrationPolicyContext = /(?:retired|removed|archive|migration|histor|不接受重新加入|不恢復|已移除|退役|舊產品)/i;
const errors = [];

for (const relative of retiredPaths) {
  if (fs.existsSync(path.join(root, relative))) errors.push(`retired path still exists: ${relative}`);
}

const files = new Set();
for (const relative of scanRoots) collect(path.join(root, relative), files);
for (const relative of publicDocs) {
  const absolute = path.join(root, relative);
  if (fs.existsSync(absolute)) files.add(absolute);
}

for (const absolute of [...files].sort()) {
  const relative = normalize(path.relative(root, absolute));
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    errors.push(`symlink is forbidden in active product tree: ${relative}`);
    continue;
  }
  if (relative.endsWith('.zip')) {
    inspectZip(absolute, relative);
    continue;
  }
  if (!textExtensions.has(path.extname(relative).toLowerCase()) && !relative.endsWith('.service')) continue;
  const source = fs.readFileSync(absolute, 'utf8');
  inspectText(source, relative);
}

if (errors.length) {
  console.error(`retired-stock verification failed (${errors.length} finding${errors.length === 1 ? '' : 's'})`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`retired-stock verification passed (${files.size} active files, ${retiredPaths.length} retired paths absent)`);

function inspectText(source, relative) {
  const isTest = /(?:^|\/)tests?\//.test(relative) || /\.test\.[cm]?js$/.test(relative) || /\.spec\.[cm]?js$/.test(relative);
  const isPolicyDoc = ['CONTRIBUTING.md', 'docs/architecture.md'].includes(relative);
  source.split(/\r?\n/).forEach((line, index) => {
    for (const rule of forbidden) {
      if (!rule.expression.test(line)) continue;
      if (isTest && negativeTestContext.test(line)) continue;
      if (isPolicyDoc && migrationPolicyContext.test(line)) continue;
      if (relative === 'clients/web-overlay/scripts/verify-extension.mjs' && /service_worker/.test(line)) continue;
      errors.push(`${relative}:${index + 1}: ${rule.label}`);
    }
  });
}

function inspectZip(zipPath, relative) {
  let members;
  try {
    members = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  } catch (error) {
    errors.push(`${relative}: unreadable ZIP (${error.message})`);
    return;
  }
  for (const member of members) {
    const normalized = normalize(member);
    if (retiredPaths.some((retired) => normalized === retired || normalized.endsWith(`/${retired}`))) {
      errors.push(`${relative}: retired ZIP member ${normalized}`);
    }
    if (/manifest\.webmanifest$|(?:^|\/)symbols\.json$|(?:^|\/)tradingview\.js$/i.test(normalized)) {
      errors.push(`${relative}: retired ZIP member ${normalized}`);
    }
    if (!textExtensions.has(path.extname(normalized).toLowerCase())) continue;
    try {
      const source = execFileSync('unzip', ['-p', zipPath, member], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      inspectText(source, `${relative}!/${normalized}`);
    } catch (error) {
      errors.push(`${relative}!/${normalized}: cannot inspect (${error.message})`);
    }
  }
}

function collect(target, output) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || stat.isFile()) {
    output.add(target);
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    collect(path.join(target, entry.name), output);
  }
}

function normalize(value) {
  return value.split(path.sep).join('/');
}
