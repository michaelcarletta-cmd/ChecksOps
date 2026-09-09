#!/usr/bin/env node
/**
 * Phase 3A.2 — production SPA-only deploy of the #178 merge.
 *
 * Builds vite --mode aws with production Cognito + same-origin /prep.
 * Syncs checksops-production-frontend-806168576068 and invalidates CloudFront.
 *
 * Does NOT: update Lambda code/config, apply SQL, create secrets, set flags,
 * call CheckAlt, submit a deposit, or change auto-approve.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const FN = 'checksops-production-prep-api';
const BUCKET = 'checksops-production-frontend-806168576068';
const DISTRO = 'E1B0ZWWO5559U5';
const ARTIFACTS = '/opt/cursor/artifacts';
const ROOT = path.resolve(import.meta.dirname, '../../..');
const DIST = path.join(ROOT, 'dist');
const CF = 'https://checksops.com';
const RAW = 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com';

const FLAG_KEYS = [
  'CHECKSOPS_ENV',
  'AWS_WRITES_ENABLED',
  'AWS_CHECK_WORKFLOW_WRITES_ENABLED',
  'AWS_STORAGE_WRITES_ENABLED',
  'AWS_APPLICATION_WORKFLOW_WRITES_ENABLED',
  'AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED',
  'AWS_PROVIDER_EXECUTION_ENABLED',
  'AWS_MOOV_ENABLED',
  'AWS_CHECKALT_ENABLED',
  'AWS_PLAID_ENABLED',
  'AWS_ACTUM_ENABLED',
  'AWS_QUICKBOOKS_ENABLED',
  'AWS_PROVIDER_LIVE_READS_ENABLED',
  'AWS_PROVIDER_WEBHOOK_DRY_RUN',
  'AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED',
  'AWS_FINANCIAL_PERMISSIONS_ACTIVATED',
  'AWS_COGNITO_MFA_PREFERRED',
];

const PRODUCTION_VITE = {
  VITE_AUTH_PROVIDER: 'cognito',
  VITE_APP_URL: 'https://checksops.com',
  VITE_CHECKSOPS_API_URL: '/prep',
  VITE_AWS_REGION: 'us-east-1',
  VITE_COGNITO_USER_POOL_ID: 'us-east-1_h00WorYMT',
  VITE_COGNITO_USER_POOL_CLIENT_ID: '3ja9fqaq2fjkv3i6up2varcqpe',
};

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}));

const safeLambdaSnapshot = (cfg) => {
  const env = cfg.Environment?.Variables || {};
  return {
    functionName: cfg.FunctionName,
    codeSha256: cfg.CodeSha256,
    lastModified: cfg.LastModified,
    lastUpdateStatus: cfg.LastUpdateStatus,
    flags: Object.fromEntries(FLAG_KEYS.map((key) => [key, env[key] ?? null])),
    providerSecretsArnSet: Boolean(env.PROVIDER_SECRETS_ARN),
    checkAltUsernameSet: Boolean(env.CHECKALT_USERNAME || env.CHECKALT_PASSWORD || env.CHECKALT_FI_KEY),
    checkAltUatSet: Boolean(env.CHECKALT_UAT_USER_ID || env.CHECKALT_UAT_PASSWORD || env.CHECKALT_UAT_FI_KEY),
    cognitoUserPoolId: env.COGNITO_USER_POOL_ID || null,
    cognitoClientId: env.COGNITO_CLIENT_ID || null,
  };
};

const probe = async (url, init = {}) => {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { url, status: res.status, ms: Date.now() - started, json, bytes: text.length };
  } catch (error) {
    return { url, status: null, error: String(error.message || error).slice(0, 200), ms: Date.now() - started };
  }
};

const sha256File = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const listJs = (dir) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.js')).sort();
};

const grepFiles = (files, needles) => {
  const found = {};
  for (const needle of needles) found[needle] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const needle of needles) {
      if (text.includes(needle)) found[needle].push(path.relative(DIST, file));
    }
  }
  return found;
};

const mustInclude = [
  '/auth/mfa/step-up',
  'check_intake_item_id',
  'deposit.submit',
  'checkalt-dual-control',
  'us-east-1_h00WorYMT',
  '3ja9fqaq2fjkv3i6up2varcqpe',
];

const mustExclude = [
  'psr19uhop4.execute-api',
  'us-east-1_vPmQ7cL1F',
  '71bb7a192cbl6o6s8m259tl589',
  'kiqojucc02.execute-api',
  'staging.checksops.com',
  'uatapi.checkalt.com',
  'api2.checkalt.com',
];

const snapshotLambda = (label) => {
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', FN]);
  return { label, capturedAt: new Date().toISOString(), ...safeLambdaSnapshot(cfg) };
};

const liveIndexRefs = async () => {
  const res = await fetch(`${CF}/`, { redirect: 'manual' });
  const html = await res.text();
  return {
    status: res.status,
    lastModified: res.headers.get('last-modified'),
    etag: res.headers.get('etag'),
    cacheControl: res.headers.get('cache-control'),
    refs: [...html.matchAll(/\/assets\/[^"']+/g)].map((m) => m[0]),
  };
};

const mode = process.argv[2] || 'all';

if (mode === 'snapshot' || mode === 'all') {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const before = snapshotLambda('before');
  const live = await liveIndexRefs();
  const health = await probe(`${CF}/prep/health`);
  const raw = await probe(`${RAW}/prep/health`);
  const readiness = await probe(`${CF}/prep/ops/readiness`);
  const out = { before, live, health, raw, readiness };
  fs.writeFileSync(path.join(ARTIFACTS, 'phase3a2-pre-snapshot.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    step: 'pre-snapshot',
    codeSha256: before.codeSha256,
    lastModified: before.lastModified,
    providerSecretsArnSet: before.providerSecretsArnSet,
    liveRefs: live.refs,
    health: health.status,
    raw: raw.status,
    flags: {
      AWS_CHECKALT_ENABLED: before.flags.AWS_CHECKALT_ENABLED,
      AWS_PROVIDER_EXECUTION_ENABLED: before.flags.AWS_PROVIDER_EXECUTION_ENABLED,
      AWS_FINANCIAL_PERMISSIONS_ACTIVATED: before.flags.AWS_FINANCIAL_PERMISSIONS_ACTIVATED,
      AWS_PROVIDER_WEBHOOK_DRY_RUN: before.flags.AWS_PROVIDER_WEBHOOK_DRY_RUN,
      AWS_COGNITO_MFA_PREFERRED: before.flags.AWS_COGNITO_MFA_PREFERRED,
    },
  }, null, 2));
  if (mode === 'snapshot') process.exit(0);
}

if (mode === 'build' || mode === 'all') {
  const env = {
    ...process.env,
    ...PRODUCTION_VITE,
    NODE_ENV: 'production',
  };
  const built = spawnSync('npm', ['run', 'build:aws'], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (built.status !== 0) {
    console.error('vite_build_failed');
    process.exit(built.status || 1);
  }
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/\/assets\/[^"']+/g)].map((m) => m[0]);
  const jsFiles = listJs(path.join(DIST, 'assets')).map((name) => path.join(DIST, 'assets', name));
  const hits = grepFiles(jsFiles, [...mustInclude, ...mustExclude, '/prep', 'nbcqwpysqgyxrrbgtmkw.supabase.co']);
  const missing = mustInclude.filter((needle) => hits[needle].length === 0);
  const leaked = mustExclude.filter((needle) => hits[needle].length > 0);
  const indexJs = refs.find((ref) => /\/assets\/index-.*\.js$/.test(ref));
  const indexPath = indexJs ? path.join(DIST, indexJs.replace(/^\//, '')) : null;
  const summary = {
    step: 'build',
    refs,
    indexJs,
    indexSha256: indexPath && fs.existsSync(indexPath) ? sha256File(indexPath) : null,
    indexBytes: indexPath && fs.existsSync(indexPath) ? fs.statSync(indexPath).size : null,
    missing,
    leaked,
    supabaseUrlPresent: hits['nbcqwpysqgyxrrbgtmkw.supabase.co']?.length > 0,
    includeHits: Object.fromEntries(mustInclude.map((n) => [n, hits[n]])),
    excludeHits: Object.fromEntries(mustExclude.map((n) => [n, hits[n]])),
  };
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACTS, 'phase3a2-build.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (missing.length || leaked.length) {
    console.error('bundle_gate_failed');
    process.exit(2);
  }
  if (mode === 'build') process.exit(0);
}

if (mode === 'deploy' || mode === 'all') {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('dist_missing');
    process.exit(3);
  }
  const before = snapshotLambda('pre-sync');
  const syncAssets = spawnSync(AWS, [
    '--region', REGION, 's3', 'sync', `${DIST}/`, `s3://${BUCKET}/`,
    '--delete',
    '--exclude', 'index.html',
    '--cache-control', 'public, max-age=31536000, immutable',
  ], { stdio: 'inherit' });
  if (syncAssets.status !== 0) {
    console.error('s3_sync_assets_failed');
    process.exit(syncAssets.status || 4);
  }
  const cpIndex = spawnSync(AWS, [
    '--region', REGION, 's3', 'cp', path.join(DIST, 'index.html'), `s3://${BUCKET}/index.html`,
    '--cache-control', 'no-cache, no-store, must-revalidate',
    '--content-type', 'text/html',
  ], { stdio: 'inherit' });
  if (cpIndex.status !== 0) {
    console.error('s3_cp_index_failed');
    process.exit(cpIndex.status || 5);
  }
  const invalidation = awsJson([
    'cloudfront', 'create-invalidation',
    '--distribution-id', DISTRO,
    '--paths', '/*',
  ]);
  const after = snapshotLambda('post-sync');
  const lambdaUnchanged = before.codeSha256 === after.codeSha256
    && JSON.stringify(before.flags) === JSON.stringify(after.flags)
    && before.providerSecretsArnSet === after.providerSecretsArnSet
    && before.lastModified === after.lastModified;
  const result = {
    step: 'deploy',
    bucket: BUCKET,
    distributionId: DISTRO,
    invalidationId: invalidation.Invalidation?.Id || null,
    invalidationStatus: invalidation.Invalidation?.Status || null,
    lambdaUnchanged,
    beforeSha: before.codeSha256,
    afterSha: after.codeSha256,
    beforeLastModified: before.lastModified,
    afterLastModified: after.lastModified,
    providerSecretsArnSet: after.providerSecretsArnSet,
    flags: after.flags,
  };
  fs.writeFileSync(path.join(ARTIFACTS, 'phase3a2-deploy.json'), JSON.stringify({ before, after, invalidation, result }, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!lambdaUnchanged) {
    console.error('lambda_changed_unexpectedly');
    process.exit(6);
  }
  if (mode === 'deploy') process.exit(0);
}

if (mode === 'verify' || mode === 'all') {
  const build = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, 'phase3a2-build.json'), 'utf8'));
  const expected = build.indexJs;
  let live = await liveIndexRefs();
  for (let i = 0; i < 12 && !live.refs.includes(expected); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    live = await liveIndexRefs();
  }
  const health = await probe(`${CF}/prep/health`);
  const raw = await probe(`${RAW}/prep/health`);
  const options = await probe(`${CF}/prep/health`, { method: 'OPTIONS' });
  const readiness = await probe(`${CF}/prep/ops/readiness`);
  const bundleUrl = expected ? `${CF}${expected}` : null;
  let bundle = null;
  if (bundleUrl) {
    const res = await fetch(bundleUrl, { redirect: 'manual' });
    const text = await res.text();
    bundle = {
      url: bundleUrl,
      status: res.status,
      bytes: text.length,
      sha256: crypto.createHash('sha256').update(text).digest('hex'),
      hasStepUp: text.includes('/auth/mfa/step-up'),
      hasCheckId: text.includes('check_intake_item_id'),
      hasDepositSubmit: text.includes('deposit.submit'),
      hasStagingApi: text.includes('psr19uhop4.execute-api'),
      hasRawApi: text.includes('kiqojucc02.execute-api'),
      hasProdPool: text.includes('us-east-1_h00WorYMT'),
    };
  }
  const after = snapshotLambda('verify');
  const out = {
    step: 'verify',
    expectedIndex: expected,
    live,
    bundle,
    health: { status: health.status, json: health.json },
    raw: { status: raw.status },
    options: { status: options.status },
    readiness: { status: readiness.status, json: readiness.json },
    lambda: after,
  };
  fs.writeFileSync(path.join(ARTIFACTS, 'phase3a2-verify.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    step: 'verify',
    liveRefs: live.refs,
    expectedIndex: expected,
    bundleMatched: Boolean(live.refs.includes(expected)),
    bundle,
    health: health.status,
    raw: raw.status,
    options: options.status,
    lambdaSha: after.codeSha256,
    providerSecretsArnSet: after.providerSecretsArnSet,
  }, null, 2));
}
