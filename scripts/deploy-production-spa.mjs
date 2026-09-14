#!/usr/bin/env node
/**
 * Required production SPA build/deploy mechanism from this point forward.
 *
 *   node scripts/deploy-production-spa.mjs
 *   node scripts/deploy-production-spa.mjs --apply
 *
 * Always:
 *   1. `vite build --mode production-aws` (Cognito + /prep + production pool/client)
 *   2. validate the compiled artifact (not source .env)
 *   3. record Git commit → bundle → Cognito pool/client → API target → timestamp
 *
 * `--apply` is refused after the successful cutover lock.
 * Rollback of the locked artifact is the only apply path, and it requires
 * CHECKSOPS_PRODUCTION_SPA_UNLOCK=RELEASE_CUTOVER_LOCK plus
 * --from-fingerprint pointing at a previously validated AWS/Cognito
 * fingerprint. Do not use `npm run build` or a raw `aws s3 sync`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProductionSpaArtifact } from './validate-production-spa-artifact.mjs';
import { recordProductionSpaFingerprint } from './record-production-spa-fingerprint.mjs';
import {
  PRODUCTION_SPA_LOCK,
  assertNotSupabaseArtifact,
  assertProductionSpaApplyAllowed,
} from './production-spa-lock.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const DIST = path.join(ROOT, 'dist');
const PRODUCTION_SPA_S3_BUCKET = PRODUCTION_SPA_LOCK.knownGood.s3Bucket;
const PRODUCTION_CLOUDFRONT_DISTRIBUTION_ID = PRODUCTION_SPA_LOCK.knownGood.cloudfrontDistributionId;
const AWS = process.env.AWS_CLI || 'aws';

const fail = (payload, status = 1) => {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(status);
};

if (APPLY) {
  try {
    assertProductionSpaApplyAllowed({ argv: process.argv, env: process.env });
  } catch (error) {
    fail({
      error: error.code || error.message,
      productionSpaLocked: true,
      knownGood: PRODUCTION_SPA_LOCK.knownGood,
      ...(error.extra || {}),
    }, 2);
  }
}

const runAws = (args, label) => {
  const result = spawnSync(AWS, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    fail({
      error: label,
      status: result.status,
      stderr: (result.stderr || '').slice(-2000),
      stdout: (result.stdout || '').slice(-500),
    });
  }
  return result;
};

const viteBin = path.join(ROOT, 'node_modules', '.bin', 'vite');
const build = spawnSync(viteBin, ['build', '--mode', 'production-aws'], {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (build.status !== 0) {
  fail({
    error: 'production_spa_build_failed',
    status: build.status,
    stderr: (build.stderr || '').slice(-2000),
  }, build.status || 1);
}

const validation = scanProductionSpaArtifact(DIST);
if (!validation.ok) {
  fail({
    error: 'production_spa_artifact_rejected',
    ...validation,
  });
}
try {
  assertNotSupabaseArtifact(validation);
} catch (error) {
  fail({
    error: error.code || error.message,
    ...validation,
    ...(error.extra || {}),
  });
}

const indexHtml = path.join(DIST, 'index.html');
if (!fs.existsSync(indexHtml)) {
  fail({ error: 'production_spa_index_missing', path: indexHtml });
}

let invalidationId = null;
if (APPLY) {
  try {
    assertProductionSpaApplyAllowed({ argv: process.argv, env: process.env, validation });
  } catch (error) {
    fail({
      error: error.code || error.message,
      productionSpaLocked: true,
      ...(error.extra || {}),
    }, 2);
  }
  const bucketUri = `s3://${PRODUCTION_SPA_S3_BUCKET}`;
  runAws([
    's3',
    'sync',
    `${DIST}/`,
    `${bucketUri}/`,
    '--delete',
    '--cache-control',
    'public,max-age=31536000,immutable',
  ], 'production_spa_s3_sync_failed');
  runAws([
    's3',
    'cp',
    indexHtml,
    `${bucketUri}/index.html`,
    '--cache-control',
    'no-cache, no-store, must-revalidate',
    '--content-type',
    'text/html',
  ], 'production_spa_index_upload_failed');
  const invalidation = runAws([
    'cloudfront',
    'create-invalidation',
    '--distribution-id',
    PRODUCTION_CLOUDFRONT_DISTRIBUTION_ID,
    '--paths',
    '/*',
  ], 'production_spa_cloudfront_invalidation_failed');
  try {
    invalidationId = JSON.parse(invalidation.stdout || '{}')?.Invalidation?.Id || null;
  } catch {
    invalidationId = null;
  }
}

const fingerprintDir = path.join(ROOT, 'aws/cutover/production-spa-fingerprints');
const fingerprint = recordProductionSpaFingerprint({
  distDir: DIST,
  outPath: path.join(fingerprintDir, 'latest.json'),
  deployed: APPLY,
  deployMeta: {
    s3Bucket: PRODUCTION_SPA_S3_BUCKET,
    cloudfrontDistributionId: PRODUCTION_CLOUDFRONT_DISTRIBUTION_ID,
    invalidationId,
  },
});

if (APPLY && fingerprint.gitCommit) {
  const stamp = `${fingerprint.recordedAt.replace(/[:.]/g, '-')}`;
  fs.writeFileSync(
    path.join(fingerprintDir, `production-spa-${fingerprint.gitCommit.slice(0, 12)}-${stamp}.json`),
    `${JSON.stringify(fingerprint, null, 2)}\n`,
  );
}

console.log(JSON.stringify({
  ok: true,
  deployed: APPLY,
  mechanism: 'node scripts/deploy-production-spa.mjs',
  mode: 'production-aws',
  validation,
  s3Bucket: PRODUCTION_SPA_S3_BUCKET,
  cloudfrontDistributionId: PRODUCTION_CLOUDFRONT_DISTRIBUTION_ID,
  invalidationId,
  fingerprint: {
    gitCommit: fingerprint.gitCommit,
    recordedAt: fingerprint.recordedAt,
    authProvider: fingerprint.authProvider,
    cognito: fingerprint.cognito,
    apiTarget: fingerprint.apiTarget,
    bundleFileCount: fingerprint.bundle.fileCount,
    deployed: fingerprint.deployed,
  },
}, null, 2));
