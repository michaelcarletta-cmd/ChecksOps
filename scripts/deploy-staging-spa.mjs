#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BUCKET = 'checksops-staging-frontend-c48b';
const DIST = path.resolve('dist');
const OUT = '/opt/cursor/artifacts/moov-monthly-billing-preprod';
const DISTRIBUTION = 'E1CG52WRQZI7X1';

const awsTry = (args) => {
  try {
    const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
    return { ok: true, data: out.trim() ? JSON.parse(out) : {} };
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message || error).slice(0, 400) };
  }
};

const hashFile = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const main = async () => {
  await assumeCursorRole('moov-billing-spa-deploy');
  const index = path.join(DIST, 'index.html');
  const assets = fs.readdirSync(path.join(DIST, 'assets')).filter((name) => name.startsWith('AdminTenants-') || name.startsWith('index-'));
  const sync = awsTry(['s3', 'sync', DIST, `s3://${BUCKET}`, '--delete', '--exact-timestamps', '--only-show-errors']);
  const forceIndex = awsTry(['s3', 'cp', index, `s3://${BUCKET}/index.html`]);
  const invalidation = awsTry([
    'cloudfront', 'create-invalidation',
    '--distribution-id', DISTRIBUTION,
    '--paths', '/*',
  ]);
  const head = awsTry(['s3api', 'head-object', '--bucket', BUCKET, '--key', 'index.html']);
  const report = {
    generatedAt: new Date().toISOString(),
    bucket: BUCKET,
    distribution: DISTRIBUTION,
    sync: { ok: sync.ok && forceIndex.ok, error: sync.error || forceIndex.error || null },
    invalidation: invalidation.ok
      ? { ok: true, id: invalidation.data?.Invalidation?.Id || null, status: invalidation.data?.Invalidation?.Status || null }
      : { ok: false, error: invalidation.error },
    indexSha256: hashFile(index),
    indexEtag: head.data?.ETag || null,
    lastModified: head.data?.LastModified || null,
    assets: Object.fromEntries(assets.map((name) => [name, hashFile(path.join(DIST, 'assets', name))])),
    urls: [
      'https://staging.checksops.com/admin/tenants',
      `http://${BUCKET}.s3-website-us-east-1.amazonaws.com/admin/tenants`,
    ],
    productionSpaUntouched: true,
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, 'staging-spa-deploy.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
