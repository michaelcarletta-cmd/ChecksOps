#!/usr/bin/env node
/**
 * Production SPA-only promotion for the accepted tenant Email Preview.
 *
 * Uploads hashed assets first and index.html last. Never uses s3 sync --delete.
 * Has ZERO Lambda authority: no UpdateFunctionCode, no packaging, no esign.mjs.
 * The preview worktree's historical esign.mjs must have no effect.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';
import {
  assertNoSyncDelete,
  localManifest,
  planUploadOrder,
  simulatePromotion,
} from './lib/spa-promote-guard.mjs';
import { assertProductionSpaBuild } from './lib/spa-production-build-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BUCKET = 'checksops-production-frontend-806168576068';
const DISTRIBUTION = 'E1B0ZWWO5559U5';
const LAMBDA = 'checksops-production-prep-api';
const PREFLIGHT_SHA = '6b211037ae70b510a9b5cfe316f006dbbc308ee3c94687ccea943b24cfd09f2e';
const PREFLIGHT_VERSION = 'advEv5N0JfqM41odUraOM7kCH6Z2snP3';
const FORBIDDEN_AWS = new Set([
  'UpdateFunctionCode',
  'UpdateFunctionConfiguration',
  'PublishVersion',
  'CreateFunction',
  'UpdateAlias',
]);

const contentTypeFor = (key) => {
  if (key.endsWith('.html')) return 'text/html; charset=utf-8';
  if (key.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (key.endsWith('.css')) return 'text/css; charset=utf-8';
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.svg')) return 'image/svg+xml';
  if (key.endsWith('.webp')) return 'image/webp';
  if (key.endsWith('.woff2')) return 'font/woff2';
  if (key.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
};

const cacheControlFor = (key) => (
  key === 'index.html'
    ? 'no-cache, no-store, must-revalidate'
    : 'public, max-age=31536000, immutable'
);

const awsJson = (args) => {
  const verb = args.find((item) => /^[A-Z][A-Za-z]+$/.test(item)) || args[1] || args[0];
  if (FORBIDDEN_AWS.has(String(verb)) || args.some((item) => FORBIDDEN_AWS.has(String(item)))) {
    throw new Error(`forbidden Lambda mutation: ${args.join(' ')}`);
  }
  if (args[0] === 'lambda' && /update-function|publish-version|create-function/i.test(args.join(' '))) {
    throw new Error(`forbidden Lambda CLI: ${args.join(' ')}`);
  }
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const sha256File = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const headIndex = () => {
  const head = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', 'index.html']);
  return {
    etag: head.ETag || null,
    versionId: head.VersionId || null,
    lastModified: head.LastModified || null,
    contentLength: head.ContentLength || null,
  };
};

const downloadIndexSha = () => {
  const tmp = `/tmp/prod-index-prewrite-${Date.now()}.html`;
  execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', BUCKET, '--key', 'index.html', tmp], {
    encoding: 'utf8',
  });
  const sha = sha256File(tmp);
  fs.rmSync(tmp, { force: true });
  return sha;
};

const readLambdaPins = () => {
  const cfg = awsJson([
    'lambda', 'get-function-configuration',
    '--function-name', LAMBDA,
    '--query', '{CodeSha256:CodeSha256,RevisionId:RevisionId,LastModified:LastModified}',
  ]);
  return cfg;
};

export const assertSpaOnlyArgv = (argv = []) => {
  const joined = argv.join(' ');
  const errors = [];
  if (/\bUpdateFunctionCode\b/i.test(joined) || /\bupdate-function-code\b/i.test(joined)) {
    errors.push('SPA promotion cannot call UpdateFunctionCode');
  }
  if (/\bUpdateFunctionConfiguration\b/i.test(joined) || /\bupdate-function-configuration\b/i.test(joined)) {
    errors.push('SPA promotion cannot call UpdateFunctionConfiguration');
  }
  if (/\besign\.mjs\b/.test(joined) || /aws\/functions\/api/.test(joined)) {
    errors.push('SPA promotion cannot package or deploy Lambda source');
  }
  errors.push(...assertNoSyncDelete(argv).errors);
  return { ok: errors.length === 0, errors };
};

const putObject = (distDir, key) => {
  const local = path.join(distDir, key);
  awsJson([
    's3api', 'put-object',
    '--bucket', BUCKET,
    '--key', key,
    '--body', local,
    '--content-type', contentTypeFor(key),
    '--cache-control', cacheControlFor(key),
  ]);
};

const main = async () => {
  const distDir = path.resolve(process.env.CHECKSOPS_SPA_OUTDIR || path.join(ROOT, 'dist'));
  const dryRun = process.env.CHECKSOPS_PRODUCTION_SPA_PROMOTE !== '1';
  const argvGuard = assertSpaOnlyArgv(process.argv);
  if (!argvGuard.ok) {
    console.error(argvGuard.errors.join('\n'));
    process.exit(1);
  }

  const builder = fs.readFileSync(path.join(ROOT, 'scripts/build-production-aws-spa.mjs'), 'utf8');
  const buildGuard = assertProductionSpaBuild({
    mode: 'production',
    env: {
      VITE_AUTH_PROVIDER: 'cognito',
      VITE_APP_URL: 'https://checksops.com',
      VITE_CHECKSOPS_API_URL: '/prep',
      VITE_COGNITO_USER_POOL_ID: 'us-east-1_h00WorYMT',
      VITE_COGNITO_USER_POOL_CLIENT_ID: '3ja9fqaq2fjkv3i6up2varcqpe',
    },
  });
  if (!buildGuard.ok) {
    console.error(buildGuard.errors.join('\n'));
    process.exit(2);
  }
  if (/update-function-code/.test(builder) || /aws\/functions\/api/.test(builder)) {
    console.error('production builder must remain SPA-only');
    process.exit(2);
  }

  const candidate = localManifest(distDir);
  if (!candidate.ok) {
    console.error(candidate.errors.join('\n'));
    process.exit(2);
  }
  const simulated = simulatePromotion({ distDir });
  if (!simulated.ok) {
    console.error(simulated.errors.join('\n'));
    process.exit(2);
  }
  const order = planUploadOrder(candidate);
  const sequence = [...order.assetsFirst, order.indexLast];
  if (sequence.at(-1) !== 'index.html') {
    console.error('index.html must be last');
    process.exit(2);
  }

  const distFiles = fs.readdirSync(distDir, { recursive: true }).map(String);
  if (distFiles.some((name) => name.includes('aws/functions') || name.endsWith('esign.mjs'))) {
    console.error('dist contains Lambda source; refuse SPA promotion');
    process.exit(2);
  }

  const report = {
    ok: false,
    dryRun,
    bucket: BUCKET,
    distribution: DISTRIBUTION,
    dist: distDir,
    indexSha256: sha256File(path.join(distDir, 'index.html')),
    entry: (fs.readFileSync(path.join(distDir, 'index.html'), 'utf8').match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1] || null,
    uploadSequenceCount: sequence.length,
    indexLast: sequence.at(-1),
    lambdaAuthority: false,
    syncDelete: false,
  };

  if (dryRun) {
    report.ok = true;
    report.note = 'dry-run only; set CHECKSOPS_PRODUCTION_SPA_PROMOTE=1 to write SPA objects';
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  await assumeCursorRole('tenant-email-preview-prod-spa');
  const lambdaBefore = readLambdaPins();
  const liveHead = headIndex();
  const liveSha = downloadIndexSha();
  report.prewrite = { head: liveHead, sha256: liveSha, lambda: lambdaBefore };
  if (liveSha !== PREFLIGHT_SHA || liveHead.versionId !== PREFLIGHT_VERSION) {
    report.ok = false;
    report.stopped = 'PRODUCTION SPA MOVED';
    console.error(JSON.stringify(report, null, 2));
    process.exit(3);
  }

  const uploaded = [];
  for (const key of order.assetsFirst) {
    putObject(distDir, key);
    uploaded.push(key);
  }
  putObject(distDir, 'index.html');
  uploaded.push('index.html');

  const invalidation = awsJson([
    'cloudfront', 'create-invalidation',
    '--distribution-id', DISTRIBUTION,
    '--paths', '/*',
  ]);
  const afterHead = headIndex();
  const afterSha = downloadIndexSha();
  const lambdaAfter = readLambdaPins();
  report.ok = afterSha === report.indexSha256
    && lambdaAfter.CodeSha256 === lambdaBefore.CodeSha256
    && lambdaAfter.RevisionId === lambdaBefore.RevisionId;
  report.uploaded = uploaded.length;
  report.after = { head: afterHead, sha256: afterSha, lambda: lambdaAfter };
  report.invalidation = {
    id: invalidation.Invalidation?.Id || null,
    status: invalidation.Invalidation?.Status || null,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(4);
};

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
