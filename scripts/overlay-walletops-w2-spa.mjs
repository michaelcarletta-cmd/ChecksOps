#!/usr/bin/env node
/**
 * W2 SPA overlay. Staging: --mode aws. Production: Cognito + /prep bake.
 * No --delete. Banner hostname guard only plus existing app.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/walletops-w2';
const TARGET = process.argv[2] || 'staging';
const PROD_BUCKET = 'checksops-production-frontend-806168576068';
const STAGING_BUCKET = 'checksops-staging-frontend-c48b';
const PROD_CF = 'E1B0ZWWO5559U5';
const STAGING_CF = 'E1CG52WRQZI7X1';
const PROD_POOL = 'us-east-1_h00WorYMT';
const PROD_CLIENT = '3ja9fqaq2fjkv3i6up2varcqpe';
const STAGING_POOL = 'us-east-1_vPmQ7cL1F';
const STAGING_CLIENT = '71bb7a192cbl6o6s8m259tl589';

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const awsTry = (args, { json = true } = {}) => {
  try {
    const out = execFileSync(AWS, ['--region', REGION, ...(json ? ['--output', 'json'] : []), ...args], {
      encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    });
    if (!json) return { ok: true, data: { raw: String(out).trim().slice(0, 300) } };
    return { ok: true, data: out.trim() ? JSON.parse(out) : {} };
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message || error).slice(0, 500) };
  }
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole(`walletops-w2-spa-${TARGET}`);
  const production = TARGET === 'production';
  const bucket = production ? PROD_BUCKET : STAGING_BUCKET;
  const cf = production ? PROD_CF : STAGING_CF;
  const outDir = path.join('/tmp', `walletops-w2-spa-${TARGET}`);
  if (fs.existsSync(outDir)) execFileSync('rm', ['-rf', outDir]);
  const env = production
    ? {
      VITE_AUTH_PROVIDER: 'cognito',
      VITE_APP_URL: 'https://checksops.com',
      VITE_CHECKSOPS_API_URL: '/prep',
      VITE_AWS_REGION: 'us-east-1',
      VITE_COGNITO_USER_POOL_ID: PROD_POOL,
      VITE_COGNITO_USER_POOL_CLIENT_ID: PROD_CLIENT,
    }
    : {
      VITE_AUTH_PROVIDER: 'cognito',
      VITE_APP_URL: 'https://staging.checksops.com',
      VITE_AWS_REGION: 'us-east-1',
      VITE_COGNITO_USER_POOL_ID: STAGING_POOL,
      VITE_COGNITO_USER_POOL_CLIENT_ID: STAGING_CLIENT,
    };
  const mode = production ? 'production' : 'aws';
  const built = spawnSync('npx', ['vite', 'build', '--mode', mode, '--outDir', outDir], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 240000,
  });
  if (built.status !== 0) {
    const report = { ok: false, target: TARGET, error: String(built.stderr || built.stdout || 'vite failed').slice(0, 1200) };
    await writeFile(path.join(OUT, `${TARGET}-spa-overlay.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  const index = path.join(outDir, 'index.html');
  const indexHtml = fs.readFileSync(index, 'utf8');
  const indexJs = (indexHtml.match(/\/assets\/(index-[A-Za-z0-9._-]+\.js)/) || [])[1] || null;
  const indexCss = (indexHtml.match(/\/assets\/(index-[A-Za-z0-9._-]+\.css)/) || [])[1] || null;
  const jsText = indexJs ? fs.readFileSync(path.join(outDir, 'assets', indexJs), 'utf8') : '';
  const bannerHidden = /shouldShowAwsStagingBanner|checksops\.com/.test(jsText)
    || /shouldShowAwsStagingBanner/.test(fs.readFileSync(path.join(ROOT, 'src/components/AwsStagingBanner.tsx'), 'utf8'));
  const sync = awsTry(['s3', 'sync', outDir, `s3://${bucket}`, '--exact-timestamps', '--only-show-errors'], { json: false });
  const forceIndex = awsTry(['s3', 'cp', index, `s3://${bucket}/index.html`, '--content-type', 'text/html', '--cache-control', 'no-cache, no-store, must-revalidate'], { json: false });
  const forceAssets = [];
  for (const name of [indexJs, indexCss].filter(Boolean)) {
    forceAssets.push({
      name,
      ...awsTry(['s3', 'cp', path.join(outDir, 'assets', name), `s3://${bucket}/assets/${name}`, '--cache-control', 'public, max-age=31536000, immutable'], { json: false }),
    });
  }
  const invalidation = awsTry(['cloudfront', 'create-invalidation', '--distribution-id', cf, '--paths', '/*']);
  const head = awsTry(['s3api', 'head-object', '--bucket', bucket, '--key', 'index.html']);
  const report = {
    ok: sync.ok && forceIndex.ok && forceAssets.every((row) => row.ok),
    target: TARGET,
    usedDelete: false,
    bucket,
    indexJs,
    indexCss,
    indexSha256: sha256(index),
    bannerGuardPresent: bannerHidden,
    etag: head.data?.ETag || null,
    lastModified: head.data?.LastModified || null,
    invalidation: invalidation.ok
      ? { ok: true, id: invalidation.data?.Invalidation?.Id || null }
      : { ok: false, error: invalidation.error },
    syncError: sync.error || forceIndex.error || forceAssets.find((row) => !row.ok)?.error || null,
  };
  await writeFile(path.join(OUT, `${TARGET}-spa-overlay.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await rm(path.join(ROOT, '.env.production.local'), { force: true }).catch(() => {});
  if (!report.ok) process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
