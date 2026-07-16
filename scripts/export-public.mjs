import { copyFile, mkdir, chmod, lstat, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PUBLIC_LICENSE_ID,
  PUBLIC_MANIFEST_NAME,
  listPublicSourceFiles,
  sha256File,
  verifyPublicTree,
} from './public-tree-policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..');
const outputIndex = process.argv.indexOf('--output');
if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
  console.error('Usage: node scripts/export-public.mjs --output <empty-or-new-directory>');
  process.exit(2);
}
const output = path.resolve(process.argv[outputIndex + 1]);

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

try {
  if (isInside(source, output)) throw new Error('public export output must be outside the source tree');
  const existing = await lstat(output).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    if (!existing.isDirectory()) throw new Error('public export output exists and is not a directory');
    if ((await readdir(output)).length !== 0) throw new Error('public export output is non-empty; refusing to overwrite existing data');
  } else {
    await mkdir(output, { recursive: true, mode: 0o755 });
  }

  await verifyPublicTree(source);
  const files = await listPublicSourceFiles(source);
  const manifestFiles = [];
  for (const relative of files) {
    const sourceFile = path.join(source, relative);
    const destination = path.join(output, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    await copyFile(sourceFile, destination);
    const sourceStat = await stat(sourceFile);
    await chmod(destination, sourceStat.mode & 0o777);
    const destinationStat = await stat(destination);
    const entry = {
      path: relative,
      size: destinationStat.size,
      sha256: await sha256File(destination),
    };
    if ((destinationStat.mode & 0o111) !== 0) entry.executable = true;
    manifestFiles.push(entry);
  }

  const manifest = {
    formatVersion: 1,
    license: PUBLIC_LICENSE_ID,
    files: manifestFiles,
  };
  await writeFile(path.join(output, PUBLIC_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
  const verified = await verifyPublicTree(output, { requireManifest: true });
  console.log(`public export created (${verified.files} files): ${output}`);
} catch (error) {
  console.error(`public export failed: ${error.message}`);
  process.exit(1);
}
