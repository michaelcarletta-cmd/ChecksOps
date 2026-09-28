#!/usr/bin/env node
/**
 * Staging-only SPA deploy for the signature composer mobile layout fix.
 * per_object_put to checksops-staging-frontend-c48b, index.html last,
 * CloudFront invalidate E1CG52WRQZI7X1. No Lambda writes. No production writes.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BUCKET = 'checksops-staging-frontend-c48b';
const DISTRIBUTION = 'E1CG52WRQZI7X1';
const LAMBDA = 'checksops-staging-api';
const DIST = process.env.CHECKSOPS_SPA_OUTDIR || path.resolve('dist');
const FORBIDDEN_BUCKETS = [
  'checksops-production-frontend-806168576068',
];
const FORBIDDEN_DISTRIBUTIONS = [
  'E1B0ZWWO5559U5',
];

if (FORBIDDEN_BUCKETS.includes(BUCKET) || FORBIDDEN_DISTRIBUTIONS.includes(DISTRIBUTION)) {
  throw new Error('refusing production SPA target');
}

const oidcToken = () => new Promise((resolve, reject) => {
  const req = http.request({
    socketPath: '/run/cursor/api.sock',
    path: '/v1/tokens/oidc',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).token); }
      catch (error) { reject(error); }
    });
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

const applyCreds = (creds) => {
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
};

const awsJson = (args) => {
  const joined = args.join(' ');
  if (/update-function|create-function|publish-version/i.test(joined)) {
    throw new Error(`forbidden Lambda mutation: ${joined}`);
  }
  if (/\bs3\s+sync\b/.test(joined) || /--delete/.test(joined)) {
    throw new Error(`forbidden destructive deploy: ${joined}`);
  }
  if (FORBIDDEN_BUCKETS.some((name) => joined.includes(name))) {
    throw new Error(`forbidden production bucket: ${joined}`);
  }
  if (FORBIDDEN_DISTRIBUTIONS.some((id) => joined.includes(id))) {
    throw new Error(`forbidden production CloudFront: ${joined}`);
  }
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const sha256File = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

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

const walk = (dir, prefix = '') => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
};

const assumeCursor = async (session) => {
  const creds = JSON.parse(execFileSync(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN,
    '--role-session-name', session,
    '--web-identity-token', String(await oidcToken()),
    '--duration-seconds', '3600',
    '--output', 'json',
  ], { encoding: 'utf8' })).Credentials;
  applyCreds(creds);
};

const main = async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`staging dist missing index.html at ${DIST}`);
  }
  const indexHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const entry = (indexHtml.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1];
  const css = (indexHtml.match(/href="(\/assets\/index-[^"]+\.css)"/) || [])[1];
  const indexSha = sha256File(path.join(DIST, 'index.html'));
  const entrySha = entry ? sha256File(path.join(DIST, entry.replace(/^\//, ''))) : null;
  if (!entry || !entry.startsWith('/assets/index-')) {
    throw new Error(`unexpected staging entry ${entry}`);
  }

  const keys = walk(DIST);
  if (!keys.includes('index.html')) throw new Error('index.html missing');
  const assets = keys.filter((key) => key !== 'index.html').sort();
  const sequence = [...assets, 'index.html'];

  await assumeCursor('sig-mobile-composer-staging-spa');
  const identity = awsJson(['sts', 'get-caller-identity']);
  const lambdaBefore = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);

  const liveTmp = '/tmp/staging-index-prewrite.html';
  execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', BUCKET, '--key', 'index.html', liveTmp], { encoding: 'utf8' });
  const liveHtml = fs.readFileSync(liveTmp, 'utf8');
  const liveSha = sha256File(liveTmp);
  const liveEntry = (liveHtml.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1];

  const uploaded = [];
  for (const key of sequence) {
    awsJson([
      's3api', 'put-object',
      '--bucket', BUCKET,
      '--key', key,
      '--body', path.join(DIST, key),
      '--content-type', contentTypeFor(key),
      '--cache-control', cacheControlFor(key),
    ]);
    uploaded.push(key);
  }
  if (uploaded.at(-1) !== 'index.html') throw new Error('index.html was not last');

  let invalidation = null;
  try {
    invalidation = awsJson([
      'cloudfront', 'create-invalidation',
      '--distribution-id', DISTRIBUTION,
      '--paths', '/*',
    ]);
  } catch (error) {
    invalidation = { error: String(error.stderr || error.message || error).slice(0, 400) };
  }

  const lambdaAfter = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  const afterTmp = '/tmp/staging-index-after.html';
  execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', BUCKET, '--key', 'index.html', afterTmp], { encoding: 'utf8' });
  const afterSha = sha256File(afterTmp);
  const afterHtml = fs.readFileSync(afterTmp, 'utf8');
  const afterEntry = (afterHtml.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1];

  const report = {
    ok: uploaded.at(-1) === 'index.html'
      && afterEntry === entry
      && afterSha === indexSha
      && lambdaAfter.CodeSha256 === lambdaBefore.CodeSha256
      && BUCKET === 'checksops-staging-frontend-c48b',
    env: 'staging',
    deploy_mode: 'per_object_put',
    identity: identity.Arn,
    bucket: BUCKET,
    distribution: DISTRIBUTION,
    uploaded: uploaded.length,
    index_last: uploaded.at(-1),
    candidate_entry: entry,
    candidate_css: css,
    candidate_entry_sha: entrySha,
    candidate_index_sha: indexSha,
    live_before_entry: liveEntry,
    live_before_index_sha: liveSha,
    live_after_entry: afterEntry,
    live_after_index_sha: afterSha,
    invalidation_id: invalidation?.Invalidation?.Id || null,
    invalidation_status: invalidation?.Invalidation?.Status || invalidation?.error || null,
    lambda_name: LAMBDA,
    lambda_before: lambdaBefore.CodeSha256,
    lambda_after: lambdaAfter.CodeSha256,
    production_untouched: true,
  };
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/staging-sig-mobile-composer-spa.json', JSON.stringify({
    ...report,
    uploaded_keys: uploaded,
  }, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(4);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
