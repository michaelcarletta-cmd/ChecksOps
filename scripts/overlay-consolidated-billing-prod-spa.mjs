#!/usr/bin/env node
/**
 * Phase 3A Steps 11-13: current production SPA (r1 claim-check) + billing UI overlay.
 * Builds with production Cognito /prep. Does not use --delete. Does not touch staging.
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
const OUT = '/opt/cursor/artifacts/consolidated-billing-prod-safe';
const SPA_SRC = '/tmp/phase3a-spa-r1';
const R1_REF = 'origin/cursor/r1-claim-check-forward-port-c9f0';
const PROD_BUCKET = 'checksops-production-frontend-806168576068';
const PROD_CF = 'E1B0ZWWO5559U5';
const PROD_POOL = 'us-east-1_h00WorYMT';
const PROD_CLIENT = '3ja9fqaq2fjkv3i6up2varcqpe';
const BILLING_FILES = [
  'src/lib/billing/tenantBilling.ts',
  'src/components/admin/MonthlyTenantBillingPanel.tsx',
  'src/components/billing/ConsolidatedInvoicePreview.tsx',
  'src/components/billing/TenantUsageTracker.tsx',
  'src/components/billing/CheckUsageCard.tsx',
  'src/pages/admin/AdminTenants.tsx',
  'src/components/settings/TenantUsageDashboard.tsx',
];

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};
const awsTry = (args, { json = true } = {}) => {
  try {
    const out = execFileSync(AWS, ['--region', REGION, ...(json ? ['--output', 'json'] : []), ...args], {
      encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    });
    if (!json) return { ok: true, data: { raw: String(out).trim().slice(0, 400) } };
    return { ok: true, data: out.trim() ? JSON.parse(out) : {} };
  } catch (error) {
    const text = String(error.stderr || error.stdout || error.message || error);
    return {
      ok: false,
      denied: /AccessDenied|not authorized|explicit deny/i.test(text),
      error: text.replace(/\s+/g, ' ').trim().slice(0, 700),
    };
  }
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  const baseline = JSON.parse(fs.readFileSync(path.join(OUT, 'phase3a-baseline.json'), 'utf8'));
  const expectedIndexSha = baseline.productionSpa.indexSha256;
  const expectedAssets = baseline.productionSpa.assets;

  execFileSync('git', ['fetch', 'origin', 'cursor/r1-claim-check-forward-port-c9f0'], { cwd: ROOT, stdio: 'inherit' });
  if (fs.existsSync(SPA_SRC)) execFileSync('rm', ['-rf', SPA_SRC]);
  execFileSync('git', ['worktree', 'add', '--force', '--detach', SPA_SRC, R1_REF], { cwd: ROOT, stdio: 'inherit' });

  const copied = [];
  for (const rel of BILLING_FILES) {
    const from = path.join(ROOT, rel);
    const to = path.join(SPA_SRC, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied.push({ file: rel, sha256: sha256(from) });
  }
  if (!fs.existsSync(path.join(SPA_SRC, 'node_modules'))) {
    if (fs.existsSync(path.join(ROOT, 'node_modules'))) {
      execFileSync('ln', ['-s', path.join(ROOT, 'node_modules'), path.join(SPA_SRC, 'node_modules')]);
    } else {
      execFileSync('npm', ['ci'], { cwd: SPA_SRC, stdio: 'inherit' });
    }
  }

  // Current production SPA is a Vite --mode production build. It does not bake
  // VITE_AUTH_PROVIDER=cognito; ChecksOps.com routing stays on the accepted
  // hostname adapter. Forcing Cognito here would replace that production config.
  const built = spawnSync('npx', ['vite', 'build', '--mode', 'production'], {
    cwd: SPA_SRC,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 180000,
  });
  if (built.status !== 0) {
    throw new Error(`vite failed: ${String(built.stderr || built.stdout || '').slice(0, 1200)}`);
  }

  const dist = path.join(SPA_SRC, 'dist');
  const index = path.join(dist, 'index.html');
  const indexHtml = fs.readFileSync(index, 'utf8');
  const assets = fs.readdirSync(path.join(dist, 'assets'));
  const haystack = [indexHtml];
  for (const name of assets) {
    if (!/\.(js|css|html)$/.test(name)) continue;
    haystack.push(fs.readFileSync(path.join(dist, 'assets', name), 'utf8'));
  }
  const text = haystack.join('\n');
  const leaks = {
    stagingApi: /psr19uhop4/.test(text),
    stagingCloudFront: /E1CG52WRQZI7X1/.test(text),
    stagingCognitoPool: /us-east-1_vPmQ7cL1F/.test(text),
    stagingCognitoClient: /71bb7a192cbl6o6s8m259tl589/.test(text),
    rawExecuteApi: /kiqojucc02/.test(text),
    sandboxMerchant: /36b79957-ce7a-4ca7-a68f-30986c9e47bb/.test(text),
  };
  const preserves = {
    sameOriginPrep: /\/prep/.test(text),
    noForcedCognitoBake: !text.includes(PROD_POOL) && !text.includes(PROD_CLIENT),
    monthlyBilling: /Monthly tenant billing|next_day_rate/.test(text),
    matchesCurrentProductionAuthShape: /nbcqwpysqgyxrrbgtmkw/.test(text),
  };
  if (Object.values(leaks).some(Boolean)) {
    throw new Error(`staging_or_raw_endpoint_leak:${JSON.stringify(leaks)}`);
  }
  if (!preserves.sameOriginPrep || !preserves.monthlyBilling) {
    throw new Error(`missing_production_api_or_billing:${JSON.stringify(preserves)}`);
  }

  await assumeCursorRole('phase3a-spa-deploy');
  const liveHead = awsTry(['s3api', 'head-object', '--bucket', PROD_BUCKET, '--key', 'index.html']);
  const liveCopy = path.join(OUT, 'production-live-index-toctou.html');
  awsTry(['s3', 'cp', `s3://${PROD_BUCKET}/index.html`, liveCopy], { json: false });
  const liveHtml = fs.existsSync(liveCopy) ? fs.readFileSync(liveCopy, 'utf8') : '';
  const liveSha = liveHtml ? createHash('sha256').update(liveHtml).digest('hex') : null;
  const liveAssets = [...liveHtml.matchAll(/\/assets\/[A-Za-z0-9._-]+/g)].map((m) => m[0]);
  if (liveSha !== expectedIndexSha) {
    const report = {
      ok: false,
      error: 'spa_toctou_changed',
      expectedIndexSha,
      actualIndexSha: liveSha,
      expectedAssets,
      liveAssets,
      liveHead: liveHead.ok ? { etag: liveHead.data.ETag, lastModified: liveHead.data.LastModified } : liveHead,
    };
    await writeFile(path.join(OUT, 'phase3a-spa-toctou-stop.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(3);
  }

  const sync = awsTry(['s3', 'sync', dist, `s3://${PROD_BUCKET}`, '--exact-timestamps', '--only-show-errors'], { json: false });
  const forceIndex = awsTry([
    's3', 'cp', index, `s3://${PROD_BUCKET}/index.html`,
    '--content-type', 'text/html',
    '--cache-control', 'no-cache, no-store, must-revalidate',
  ], { json: false });
  let invalidation = { ok: false, skipped: true };
  if (sync.ok && forceIndex.ok) {
    invalidation = awsTry(['cloudfront', 'create-invalidation', '--distribution-id', PROD_CF, '--paths', '/*']);
  }

  const operatorDir = path.join(OUT, 'spa-operator-package');
  await rm(operatorDir, { recursive: true, force: true });
  execFileSync('mkdir', ['-p', operatorDir]);
  execFileSync('cp', ['-r', '--no-preserve=mode', `${dist}/.`, operatorDir]);
  execFileSync('tar', ['-czf', path.join(OUT, 'checksops-production-consolidated-billing-spa.tar.gz'), '-C', OUT, 'spa-operator-package']);

  const head = awsTry(['s3api', 'head-object', '--bucket', PROD_BUCKET, '--key', 'index.html']);
  const report = {
    generatedAt: new Date().toISOString(),
    baselineRef: R1_REF,
    billingOverlay: copied,
    usedDelete: false,
    mode: 'production',
    forcedCognito: false,
    leaks,
    preserves,
    indexSha256: sha256(index),
    indexRefs: [...indexHtml.matchAll(/\/assets\/[A-Za-z0-9._-]+/g)].map((m) => m[0]),
    assets: Object.fromEntries(assets.map((name) => [name, sha256(path.join(dist, 'assets', name))])),
    toctou: { expectedIndexSha, liveSha, passed: liveSha === expectedIndexSha },
    deploy: {
      syncOk: sync.ok,
      indexOk: forceIndex.ok,
      denied: sync.denied || forceIndex.denied,
      error: sync.error || forceIndex.error || null,
    },
    invalidation: invalidation.ok
      ? { id: invalidation.data?.Invalidation?.Id || null, status: invalidation.data?.Invalidation?.Status || null }
      : { ok: false, error: invalidation.error || null, skipped: invalidation.skipped || false },
    liveHeadAfter: head.ok ? { etag: head.data.ETag, lastModified: head.data.LastModified } : head,
    operatorPackage: path.join(OUT, 'checksops-production-consolidated-billing-spa.tar.gz'),
  };
  await writeFile(path.join(OUT, 'phase3a-spa-deploy.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!sync.ok || !forceIndex.ok) process.exit(sync.denied || forceIndex.denied ? 4 : 2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
