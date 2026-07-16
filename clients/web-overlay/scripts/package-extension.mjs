import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const dist = path.join(root, 'extension', 'dist');
const releaseDir = path.join(root, 'release', 'browser-extension');
const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
const baseName = `danmaku-overlay-extension-${manifest.version}`;
const zipPath = path.join(releaseDir, `${baseName}.zip`);
const checksumPath = `${zipPath}.sha256`;

execFileSync(process.execPath, [path.join(here, 'verify-extension.mjs')], { stdio: 'inherit' });
fs.mkdirSync(releaseDir, { recursive: true });
fs.rmSync(zipPath, { force: true });
fs.rmSync(checksumPath, { force: true });
const files = walk(dist).map((file) => path.relative(dist, file).replaceAll(path.sep, '/')).sort();
const stagingDir = fs.mkdtempSync(path.join(releaseDir, '.package-'));
try {
  fs.cpSync(dist, stagingDir, { recursive: true });
  const storeManifestPath = path.join(stagingDir, 'manifest.json');
  const storeManifest = JSON.parse(fs.readFileSync(storeManifestPath, 'utf8'));
  delete storeManifest.key;
  fs.writeFileSync(storeManifestPath, `${JSON.stringify(storeManifest, null, 2)}\n`);
  const reproducibleTime = new Date('1980-01-01T00:00:00.000Z');
  for (const file of walk(stagingDir)) {
    fs.chmodSync(file, 0o644);
    fs.utimesSync(file, reproducibleTime, reproducibleTime);
  }
  execFileSync('zip', ['-X', '-D', '-q', zipPath, '-@'], {
    cwd: stagingDir,
    env: { ...process.env, TZ: 'UTC' },
    input: `${files.join('\n')}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
} finally {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
const members = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean).sort();
if (JSON.stringify(members) !== JSON.stringify(files)) throw new Error('ZIP member list does not exactly match verified dist files');
const testDir = fs.mkdtempSync(path.join(releaseDir, '.verify-'));
try {
  execFileSync('unzip', ['-q', zipPath, '-d', testDir], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(here, 'verify-extension.mjs'), '--dist', testDir, '--store-package'], { stdio: 'inherit' });
} finally {
  fs.rmSync(testDir, { recursive: true, force: true });
}
const checksumLine = execFileSync('sha256sum', [path.basename(zipPath)], { cwd: releaseDir, encoding: 'utf8' });
fs.writeFileSync(checksumPath, checksumLine);
console.log(zipPath);
console.log(checksumPath);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}
