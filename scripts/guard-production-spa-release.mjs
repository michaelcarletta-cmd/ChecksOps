#!/usr/bin/env node
/**
 * Pre-upload production SPA release guard.
 *
 *   node scripts/guard-production-spa-release.mjs --dir dist
 *   node scripts/guard-production-spa-release.mjs --dir path/to/artifact --apply
 *
 * `--apply` is refused by this module even after a green scan: uploading or
 * invalidating CloudFront is out of scope for the auth/API gate PR.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardProductionSpaRelease } from './lib/production-spa-auth-api-gate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const idx = process.argv.indexOf('--dir');
const distDir = path.resolve(ROOT, idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : 'dist');
const apply = process.argv.includes('--apply');
const result = guardProductionSpaRelease({ distDir, apply: false, requireProof: true });
if (!result.ok) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
if (apply) {
  console.error(JSON.stringify({
    error: 'production_spa_apply_refused',
    uploaded: false,
    cloudfrontInvalidated: false,
    hint: 'Auth/API gate passed locally but this command does not upload or invalidate CloudFront.',
    validation: result.validation,
  }, null, 2));
  process.exit(2);
}
console.log(JSON.stringify(result, null, 2));
