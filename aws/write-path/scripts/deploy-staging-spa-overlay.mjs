/**
 * Overlay staging SPA from vite --mode aws. Staging bucket/distribution only.
 * Does not touch production CloudFront E1B0ZWWO5559U5 or production DNS.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BUCKET = 'checksops-staging-frontend-c48b';
const DISTRIBUTION = 'E1CG52WRQZI7X1';
const FORBIDDEN_DIST = /E1B0ZWWO5559U5|production/i;
const DIST_DIR = path.join(ROOT, 'dist');

if (FORBIDDEN_DIST.test(DISTRIBUTION) || FORBIDDEN_DIST.test(BUCKET)) {
  throw new Error('refusing production frontend overlay');
}

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
  throw new Error('dist/index.html missing; run npm run build:aws first');
}

const indexHtml = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8');
const assets = [...indexHtml.matchAll(/\/assets\/([A-Za-z0-9._-]+\.js)/g)].map((m) => m[1]);
const css = [...indexHtml.matchAll(/\/assets\/([A-Za-z0-9._-]+\.css)/g)].map((m) => m[1]);

execFileSync(AWS, [
  's3', 'sync', DIST_DIR, `s3://${BUCKET}`,
  '--delete',
  '--region', REGION,
], { stdio: 'inherit' });

const invalidation = awsJson([
  'cloudfront', 'create-invalidation',
  '--distribution-id', DISTRIBUTION,
  '--paths', '/*',
]);
if (FORBIDDEN_DIST.test(invalidation.Invalidation?.Id || '')) {
  throw new Error('unexpected production invalidation');
}

const report = {
  productionUntouched: true,
  bucket: BUCKET,
  distribution: DISTRIBUTION,
  assets,
  css,
  invalidation: {
    id: invalidation.Invalidation?.Id || null,
    status: invalidation.Invalidation?.Status || null,
    createTime: invalidation.Invalidation?.CreateTime || null,
  },
};
fs.writeFileSync('/opt/cursor/artifacts/phase2_integration_spa_deploy.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
