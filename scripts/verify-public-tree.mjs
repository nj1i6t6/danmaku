import path from 'node:path';
import { verifyPublicTree } from './public-tree-policy.mjs';

const sourceIndex = process.argv.indexOf('--source');
if (sourceIndex < 0 || !process.argv[sourceIndex + 1]) {
  console.error('Usage: node scripts/verify-public-tree.mjs --source <directory>');
  process.exit(2);
}

const source = path.resolve(process.argv[sourceIndex + 1]);
const requireManifest = process.argv.includes('--require-manifest');
try {
  const result = await verifyPublicTree(source, { requireManifest });
  console.log(`public-tree verification passed (${result.files} files, manifest=${result.manifest ? 'verified' : 'source-allowlist'})`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
