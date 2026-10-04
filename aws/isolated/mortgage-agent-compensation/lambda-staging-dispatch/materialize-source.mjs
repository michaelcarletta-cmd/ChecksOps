/**
 * Official writer confinement requires the overlay source to resolve at
 * aws/functions/api/app-services.mjs. Materialize the patched LIVE
 * staging dispatcher there at apply time only, then restore origin/main.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchLiveAppServices } from './patch-app-services.mjs';
import { LIVE_APP_SERVICES_SHA256 } from './constants.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const DEST = path.join(ROOT, 'aws/functions/api/app-services.mjs');
const LIVE_FIXTURE = path.join(HERE, 'fixtures/app-services.live.mjs');
const PATCHED_FIXTURE = path.join(HERE, 'fixtures/app-services.patched.mjs');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function readPatchedDispatcher() {
  const live = fs.readFileSync(LIVE_FIXTURE);
  if (sha256(live) !== LIVE_APP_SERVICES_SHA256) {
    throw new Error(`live fixture drifted: ${sha256(live)}`);
  }
  const patched = patchLiveAppServices(live.toString('utf8'));
  const expected = fs.readFileSync(PATCHED_FIXTURE, 'utf8');
  if (patched !== expected) {
    throw new Error('patched fixture does not match live+surgical transform');
  }
  return patched;
}

export function materializePatchedAppServices() {
  const patched = readPatchedDispatcher();
  fs.writeFileSync(DEST, patched);
  return { path: DEST, sha256: sha256(patched) };
}

export function restoreRepoAppServices() {
  execFileSync('git', ['-C', ROOT, 'checkout', '--', 'aws/functions/api/app-services.mjs'], { stdio: 'pipe' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] || 'materialize';
  if (mode === 'restore') {
    restoreRepoAppServices();
    process.stdout.write('restored aws/functions/api/app-services.mjs\n');
  } else {
    const out = materializePatchedAppServices();
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  }
}
