#!/usr/bin/env node
/**
 * Required production SPA build/deploy mechanism from this point forward.
 *
 *   node scripts/deploy-production-spa.mjs
 *
 * Always:
 *   1. `vite build --mode production-aws` (Cognito + /prep + production pool/client)
 *   2. validate the compiled artifact (not source .env)
 *   3. record Git commit → bundle → Cognito pool/client → API target → timestamp
 *
 * `--apply` (S3 sync / CloudFront invalidation) is refused until the final
 * cutover gate. Do not use `npm run build` or a raw `aws s3 sync` for production.
 *
 * Intended apply target after the cutover gate (not executed here):
 *   s3://checksops-production-frontend-806168576068
 *   CloudFront E1B0ZWWO5559U5
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProductionSpaArtifact } from './validate-production-spa-artifact.mjs';
import { recordProductionSpaFingerprint } from './record-production-spa-fingerprint.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const DIST = path.join(ROOT, 'dist');

if (APPLY) {
  console.error(JSON.stringify({
    error: 'production_spa_deploy_refused_this_phase',
    message: 'Do not deploy the production SPA. Use this script without --apply to build, validate, and fingerprint only.',
    requiredMechanism: 'node scripts/deploy-production-spa.mjs',
    applyTargetWhenAuthorized: {
      bucket: 's3://checksops-production-frontend-806168576068',
      cloudFrontDistributionId: 'E1B0ZWWO5559U5',
    },
  }, null, 2));
  process.exit(2);
}

const viteBin = path.join(ROOT, 'node_modules', '.bin', 'vite');
const build = spawnSync(viteBin, ['build', '--mode', 'production-aws'], {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (build.status !== 0) {
  console.error(JSON.stringify({
    error: 'production_spa_build_failed',
    status: build.status,
    stderr: build.stderr.slice(-2000),
  }, null, 2));
  process.exit(build.status || 1);
}

const validation = scanProductionSpaArtifact(DIST);
if (!validation.ok) {
  console.error(JSON.stringify({
    error: 'production_spa_artifact_rejected',
    ...validation,
  }, null, 2));
  process.exit(1);
}

const fingerprint = recordProductionSpaFingerprint({
  distDir: DIST,
  outPath: path.join(ROOT, 'aws/cutover/production-spa-fingerprints/latest.json'),
  deployed: false,
});

console.log(JSON.stringify({
  ok: true,
  deployed: false,
  mechanism: 'node scripts/deploy-production-spa.mjs',
  mode: 'production-aws',
  validation,
  fingerprint: {
    gitCommit: fingerprint.gitCommit,
    recordedAt: fingerprint.recordedAt,
    authProvider: fingerprint.authProvider,
    cognito: fingerprint.cognito,
    apiTarget: fingerprint.apiTarget,
    bundleFileCount: fingerprint.bundle.fileCount,
  },
}, null, 2));
