#!/usr/bin/env node
/**
 * INV7 frontend-only SPA deploy. Never updates Lambda, SQL, or env vars.
 * Usage: node scripts/deploy-invoice-inv7-spa.mjs staging|production
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = '/opt/cursor/artifacts/invoice-inv7';
const LAST_INV6 = 'pW7tqE0f6qRpDw4UeYIVP3FgbFS+3l4jchwKCqxcowI=';
const TARGET = process.argv[2];

const TARGETS = {
  staging: {
    bucket: 'checksops-staging-frontend-c48b',
    distribution: 'E1CG52WRQZI7X1',
    env: {
      VITE_AUTH_PROVIDER: 'cognito',
      VITE_APP_URL: 'https://staging.checksops.com',
      VITE_CHECKSOPS_API_URL: 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging',
      VITE_AWS_REGION: 'us-east-1',
      VITE_COGNITO_USER_POOL_ID: 'us-east-1_vPmQ7cL1F',
      VITE_COGNITO_USER_POOL_CLIENT_ID: '71bb7a192cbl6o6s8m259tl589',
    },
    requiredLive: ['us-east-1_vPmQ7cL1F', '71bb7a192cbl6o6s8m259tl589'],
    forbiddenLive: ['us-east-1_h00WorYMT', 'kiqojucc02.execute-api'],
    lambda: 'checksops-staging-api',
  },
  production: {
    bucket: 'checksops-production-frontend-806168576068',
    distribution: 'E1B0ZWWO5559U5',
    env: {
      VITE_AUTH_PROVIDER: 'cognito',
      VITE_APP_URL: 'https://checksops.com',
      VITE_CHECKSOPS_API_URL: '/prep',
      VITE_AWS_REGION: 'us-east-1',
      VITE_COGNITO_USER_POOL_ID: 'us-east-1_h00WorYMT',
      VITE_COGNITO_USER_POOL_CLIENT_ID: '3ja9fqaq2fjkv3i6up2varcqpe',
    },
    requiredLive: ['us-east-1_h00WorYMT', '3ja9fqaq2fjkv3i6up2varcqpe', '/prep'],
    forbiddenLive: ['us-east-1_vPmQ7cL1F', 'psr19uhop4.execute-api', 'kiqojucc02.execute-api'],
    lambda: 'checksops-production-prep-api',
    requireInv6Sha: true,
  },
};

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
}));

const spaIndex = (bucket) => {
  const html = execFileSync(AWS, ['--region', REGION, 's3', 'cp', `s3://${bucket}/index.html`, '-'], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    html,
    sha256: createHash('sha256').update(html).digest('hex'),
    js: html.match(/\/assets\/(index-[A-Za-z0-9._-]+\.js)/)?.[1] || null,
    css: html.match(/\/assets\/(index-[A-Za-z0-9._-]+\.css)/)?.[1] || null,
  };
};

const downloadLiveJs = (bucket, jsName, dest) => {
  execFileSync(AWS, ['--region', REGION, 's3', 'cp', `s3://${bucket}/assets/${jsName}`, dest], {
    stdio: 'inherit',
  });
  return fs.readFileSync(dest, 'utf8');
};

const main = async () => {
  if (!TARGETS[TARGET]) {
    throw new Error('usage: node scripts/deploy-invoice-inv7-spa.mjs staging|production');
  }
  const cfg = TARGETS[TARGET];
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole(`invoice-inv7-spa-${TARGET}`);
  const lambda = awsJson(['lambda', 'get-function-configuration', '--function-name', cfg.lambda]);
  if (cfg.requireInv6Sha && lambda.CodeSha256 !== LAST_INV6) {
    throw new Error(`production_lambda_drift ${lambda.CodeSha256}`);
  }
  const before = spaIndex(cfg.bucket);
  const liveJsPath = path.join(OUT, `${TARGET}-live-${before.js || 'index.js'}`);
  const liveJs = before.js ? downloadLiveJs(cfg.bucket, before.js, liveJsPath) : '';
  const missing = cfg.requiredLive.filter((needle) => !liveJs.includes(needle));
  const leaked = cfg.forbiddenLive.filter((needle) => liveJs.includes(needle));
  if (missing.length || leaked.length) {
    const report = { ok: false, reason: 'live_env_mismatch', missing, leaked, before, lambdaSha: lambda.CodeSha256 };
    await writeFile(`${OUT}/${TARGET}-spa-skip.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(3);
  }

  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv7-spa-'));
  const envFile = path.join(envDir, '.env.aws');
  fs.writeFileSync(envFile, Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  execFileSync('npm', ['run', 'build:aws'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...cfg.env },
  });
  const dist = path.join(ROOT, 'dist');
  const builtIndex = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const builtJs = builtIndex.match(/\/assets\/(index-[A-Za-z0-9._-]+\.js)/)?.[1];
  const builtCss = builtIndex.match(/\/assets\/(index-[A-Za-z0-9._-]+\.css)/)?.[1];
  const builtJsText = builtJs ? fs.readFileSync(path.join(dist, 'assets', builtJs), 'utf8') : '';
  const builtMissing = cfg.requiredLive.filter((needle) => needle !== '/prep' && !builtJsText.includes(needle) && !builtIndex.includes(needle));
  const builtLeaked = cfg.forbiddenLive.filter((needle) => builtJsText.includes(needle));
  if (TARGET === 'production' && !builtJsText.includes('"/prep"') && !builtJsText.includes("'/prep'")) {
    builtMissing.push('/prep');
  }
  if (builtMissing.length || builtLeaked.length) {
    throw new Error(`built_env_mismatch missing=${builtMissing} leaked=${builtLeaked}`);
  }
  if (!builtJsText.includes('Invoice Branding') && !builtJsText.includes('No logo configured')) {
    throw new Error('built_bundle_missing_invoice_branding');
  }

  await writeFile(`${OUT}/${TARGET}-index-before.html`, before.html);
  execFileSync(AWS, [
    '--region', REGION, 's3', 'sync', path.join(dist, 'assets'), `s3://${cfg.bucket}/assets`,
    '--cache-control', 'public,max-age=31536000,immutable',
  ], { stdio: 'inherit' });
  execFileSync(AWS, [
    '--region', REGION, 's3', 'cp', path.join(dist, 'index.html'), `s3://${cfg.bucket}/index.html`,
    '--cache-control', 'no-cache,no-store,must-revalidate',
    '--content-type', 'text/html',
  ], { stdio: 'inherit' });
  const invalidation = awsJson([
    'cloudfront', 'create-invalidation',
    '--distribution-id', cfg.distribution,
    '--paths', '/*',
  ]);
  const after = spaIndex(cfg.bucket);
  const lambdaAfter = awsJson(['lambda', 'get-function-configuration', '--function-name', cfg.lambda]);
  const report = {
    ok: true,
    target: TARGET,
    lambdaUnchanged: lambdaAfter.CodeSha256 === lambda.CodeSha256,
    lambdaSha: lambdaAfter.CodeSha256,
    before,
    after,
    builtJs,
    builtCss,
    invalidationId: invalidation.Invalidation?.Id || null,
    invoiceCreated: false,
  };
  await writeFile(`${OUT}/${TARGET}-spa-deploy.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await rm(envDir, { recursive: true, force: true });
  if (!report.lambdaUnchanged) process.exit(4);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
