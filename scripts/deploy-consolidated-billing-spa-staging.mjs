#!/usr/bin/env node
/**
 * Phase 2B: build CURRENT staging SPA (r1 claim-check baseline) + Phase 2 billing UI overlay.
 * Deploy to staging S3/CloudFront only. Does not use --delete.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, cp } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const BUCKET = 'checksops-staging-frontend-c48b';
const DISTRIBUTION = 'E1CG52WRQZI7X1';
const OUT = '/opt/cursor/artifacts/consolidated-billing-staging';
const SPA_SRC = '/tmp/phase2b-spa-r1';
const R1_REF = 'origin/cursor/r1-claim-check-forward-port-c9f0';
const BILLING_FILES = [
  'src/lib/billing/tenantBilling.ts',
  'src/components/admin/MonthlyTenantBillingPanel.tsx',
  'src/components/billing/ConsolidatedInvoicePreview.tsx',
  'src/components/billing/TenantUsageTracker.tsx',
  'src/components/billing/CheckUsageCard.tsx',
  'src/pages/admin/AdminTenants.tsx',
  'src/components/settings/TenantUsageDashboard.tsx',
];

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
};
const hashFile = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const main = async () => {
  await mkdir(OUT, { recursive: true });
  execFileSync('git', ['fetch', 'origin', 'cursor/r1-claim-check-forward-port-c9f0'], { cwd: ROOT, stdio: 'inherit' });
  if (fs.existsSync(SPA_SRC)) {
    execFileSync('rm', ['-rf', SPA_SRC]);
  }
  execFileSync('git', ['worktree', 'add', '--force', SPA_SRC, R1_REF], { cwd: ROOT, stdio: 'inherit' });

  const copied = [];
  for (const rel of BILLING_FILES) {
    const from = path.join(ROOT, rel);
    const to = path.join(SPA_SRC, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied.push(rel);
  }
  fs.copyFileSync(path.join(ROOT, '.env.aws'), path.join(SPA_SRC, '.env.aws'));
  if (!fs.existsSync(path.join(SPA_SRC, 'node_modules'))) {
    if (fs.existsSync(path.join(ROOT, 'node_modules'))) {
      execFileSync('ln', ['-s', path.join(ROOT, 'node_modules'), path.join(SPA_SRC, 'node_modules')]);
    } else {
      execFileSync('npm', ['ci'], { cwd: SPA_SRC, stdio: 'inherit' });
    }
  }

  execFileSync('npx', ['vite', 'build', '--mode', 'aws'], { cwd: SPA_SRC, stdio: 'inherit', env: { ...process.env } });
  const dist = path.join(SPA_SRC, 'dist');
  const index = path.join(dist, 'index.html');
  const indexHtml = fs.readFileSync(index, 'utf8');
  const indexJs = assets.find((name) => name.startsWith('index-') && name.endsWith('.js'));
  const indexJsText = indexJs ? fs.readFileSync(path.join(dist, 'assets', indexJs), 'utf8') : '';
  const haystack = `${indexHtml}\n${indexJsText}`;
  const productionLeak = /kiqojucc02|E1B0ZWWO5559U5|checksops-production-prep-api|41cb5d67-4911-4bef-aad5-d8ee9c582208/.test(haystack);
  const hasStagingApi = /psr19uhop4|staging\.checksops\.com/.test(haystack);
  const assets = fs.readdirSync(path.join(dist, 'assets'));
  const assetHashes = Object.fromEntries(
    assets.map((name) => [name, hashFile(path.join(dist, 'assets', name))]),
  );
  const indexRefs = [...indexHtml.matchAll(/\/assets\/[A-Za-z0-9._-]+/g)].map((m) => m[0]);
  const hasMonthly = assets.some((name) => {
    if (!name.startsWith('AdminTenants-') && !name.includes('Monthly')) return false;
    const text = fs.readFileSync(path.join(dist, 'assets', name), 'utf8');
    return text.includes('Monthly tenant billing') || text.includes('next_day_rate') || text.includes('Same Day');
  }) || fs.readFileSync(path.join(dist, 'assets', assets.find((n) => n.startsWith('index-') && n.endsWith('.js')) || assets[0]), 'utf8').includes('Monthly');

  await assumeCursorRole('phase2b-spa-deploy');
  execFileSync(AWS, ['--region', REGION, 's3', 'sync', dist, `s3://${BUCKET}`, '--exact-timestamps', '--only-show-errors'], { stdio: 'inherit' });
  execFileSync(AWS, [
    '--region', REGION, 's3', 'cp', index, `s3://${BUCKET}/index.html`,
    '--content-type', 'text/html',
    '--cache-control', 'no-cache, no-store, must-revalidate',
  ], { stdio: 'inherit' });
  const invalidation = awsJson([
    'cloudfront', 'create-invalidation',
    '--distribution-id', DISTRIBUTION,
    '--paths', '/*',
  ]);
  const head = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', 'index.html']);
  const report = {
    generatedAt: new Date().toISOString(),
    baselineRef: R1_REF,
    billingOverlay: copied,
    bucket: BUCKET,
    distribution: DISTRIBUTION,
    usedDelete: false,
    productionUrlsEmbedded: productionLeak,
    hasStagingApi,
    hasMonthlyBillingUi: hasMonthly,
    indexSha256: hashFile(index),
    indexRefs,
    indexEtag: head.ETag || null,
    lastModified: head.LastModified || null,
    assets: assetHashes,
    invalidation: {
      id: invalidation.Invalidation?.Id || null,
      status: invalidation.Invalidation?.Status || null,
    },
    productionSpaUntouched: true,
  };
  await writeFile(path.join(OUT, 'phase2b-spa-deploy.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (productionLeak) process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
