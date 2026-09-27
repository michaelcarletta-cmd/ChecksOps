#!/usr/bin/env node
/**
 * Production SPA-only promotion for Mortgage Desk Return-to-Tenant.
 *
 * Starts from the current live production baseline (index-Cm6yZxRJ.js) plus
 * the accepted 11-file overlay. Uploads hashed assets first and index.html
 * last. Never uses s3 sync --delete. Has ZERO Lambda write authority.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole, oidcToken } from './cognito-staging-token.mjs';
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
const SPA_DEPLOY_ROLE = 'arn:aws:iam::806168576068:role/ChecksOpsProductionSpaDeploy';
const EXPECTED_LAMBDA_SHA = '9OLR9DMhuDrAUp5/TmT6+8bfQC2I6USFk+zwFkluJLQ=';
const PREFLIGHT_INDEX_SHA = '48be97748993c2fe55178e96a9a3450020d0249464528a96f30a958c9d654c07';
const PREFLIGHT_VERSION = 'XoLp7k58JuZ8r22Xs1u1iZWxrxvoGD2_';
const PREFLIGHT_ENTRY = '/assets/index-Cm6yZxRJ.js';
const PREFLIGHT_ENTRY_SHA = '25573f789c57ec25ba18efc951dd77612b598f247c7996fabbc4c1e1e25b636c';
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

const applyCreds = (creds) => {
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
};

const assumeProductionSpaDeployRole = async () => {
  const session = 'return-to-tenant-prod-spa';
  try {
    const creds = JSON.parse(execFileSync(AWS, [
      'sts', 'assume-role-with-web-identity',
      '--role-arn', SPA_DEPLOY_ROLE,
      '--role-session-name', session,
      '--web-identity-token', String(await oidcToken()),
      '--duration-seconds', '3600',
      '--output', 'json',
    ], { encoding: 'utf8' })).Credentials;
    applyCreds(creds);
    return { ok: true, method: 'oidc', role: SPA_DEPLOY_ROLE };
  } catch (oidcError) {
    await assumeCursorRole('return-to-tenant-prod-spa-bridge');
    try {
      const creds = JSON.parse(execFileSync(AWS, [
        'sts', 'assume-role',
        '--role-arn', SPA_DEPLOY_ROLE,
        '--role-session-name', session,
        '--duration-seconds', '3600',
        '--output', 'json',
      ], { encoding: 'utf8' })).Credentials;
      applyCreds(creds);
      return { ok: true, method: 'role-chain', role: SPA_DEPLOY_ROLE };
    } catch (chainError) {
      return {
        ok: false,
        role: SPA_DEPLOY_ROLE,
        oidc: String(oidcError.stderr || oidcError.message || oidcError).slice(0, 400),
        chain: String(chainError.stderr || chainError.message || chainError).slice(0, 400),
      };
    }
  }
};

const headIndex = () => {
  const head = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', 'index.html']);
  return {
    etag: head.ETag || null,
    versionId: head.VersionId || null,
    lastModified: head.LastModified || null,
    contentLength: head.ContentLength || null,
  };
};

const downloadIndex = () => {
  const tmp = `/tmp/prod-index-prewrite-${Date.now()}.html`;
  execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', BUCKET, '--key', 'index.html', tmp], {
    encoding: 'utf8',
  });
  const html = fs.readFileSync(tmp, 'utf8');
  const sha = sha256File(tmp);
  fs.rmSync(tmp, { force: true });
  const entry = (html.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1] || null;
  return { sha, html, entry };
};

const readLambdaPins = () => awsJson([
  'lambda', 'get-function-configuration',
  '--function-name', LAMBDA,
  '--query', '{CodeSha256:CodeSha256,RevisionId:RevisionId,LastModified:LastModified}',
]);

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
    deploy_mode: 'per_object_put',
    bucket: BUCKET,
    distribution: DISTRIBUTION,
    dist: distDir,
    indexSha256: sha256File(path.join(distDir, 'index.html')),
    entry: (fs.readFileSync(path.join(distDir, 'index.html'), 'utf8').match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1] || null,
    uploadSequenceCount: sequence.length,
    indexLast: sequence.at(-1),
    lambdaAuthority: false,
    syncDelete: false,
    based_on_baseline: {
      spa_bundle: PREFLIGHT_ENTRY,
      spa_sha256: PREFLIGHT_ENTRY_SHA,
      index_html_sha256: PREFLIGHT_INDEX_SHA,
      s3_version: PREFLIGHT_VERSION,
    },
  };

  if (dryRun) {
    report.ok = true;
    report.note = 'dry-run only; set CHECKSOPS_PRODUCTION_SPA_PROMOTE=1 to write SPA objects';
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  await assumeCursorRole('return-to-tenant-prod-lambda-ro');
  const lambdaBefore = readLambdaPins();
  if (lambdaBefore.CodeSha256 !== EXPECTED_LAMBDA_SHA) {
    report.ok = false;
    report.stopped = 'PRODUCTION LAMBDA DRIFT';
    report.prewrite = { lambda: lambdaBefore };
    console.error(JSON.stringify(report, null, 2));
    process.exit(3);
  }

  const assumed = await assumeProductionSpaDeployRole();
  if (!assumed.ok) {
    report.ok = false;
    report.stopped = 'PRODUCTION SPA DEPLOY ROLE NOT ASSUMABLE';
    report.assume = assumed;
    report.prewrite = { lambda: lambdaBefore };
    console.error(JSON.stringify(report, null, 2));
    process.exit(3);
  }
  report.assume = assumed;
  const liveHead = headIndex();
  const liveIndex = downloadIndex();
  report.prewrite = {
    head: liveHead,
    sha256: liveIndex.sha,
    entry: liveIndex.entry,
    lambda: lambdaBefore,
  };
  if (
    liveIndex.sha !== PREFLIGHT_INDEX_SHA
    || liveHead.versionId !== PREFLIGHT_VERSION
    || liveIndex.entry !== PREFLIGHT_ENTRY
  ) {
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
  const afterIndex = downloadIndex();
  await assumeCursorRole('return-to-tenant-prod-lambda-ro-after');
  const lambdaAfter = readLambdaPins();
  report.ok = afterIndex.sha === report.indexSha256
    && lambdaAfter.CodeSha256 === lambdaBefore.CodeSha256
    && lambdaAfter.RevisionId === lambdaBefore.RevisionId
    && lambdaAfter.CodeSha256 === EXPECTED_LAMBDA_SHA;
  report.uploaded = uploaded.length;
  report.after = { head: afterHead, sha256: afterIndex.sha, entry: afterIndex.entry, lambda: lambdaAfter };
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
