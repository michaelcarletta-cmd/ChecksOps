#!/usr/bin/env node
/**
 * Non-destructive production SPA promotion for the signature overlay.
 * per_object_put, index.html last, CloudFront invalidate. No Lambda writes.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BUCKET = 'checksops-production-frontend-806168576068';
const DISTRIBUTION = 'E1B0ZWWO5559U5';
const LAMBDA = 'checksops-production-prep-api';
const SPA_DEPLOY_ROLE = 'arn:aws:iam::806168576068:role/ChecksOpsProductionSpaDeploy';
const DIST = process.env.CHECKSOPS_SPA_OUTDIR || '/tmp/prod-spa-candidate-dist';
const EXPECTED_SPA_ENTRY = '/assets/index-CNfFeGaT.js';
const EXPECTED_SPA_ENTRY_SHA = 'e203c755318928afd25a50e92525de819dd7550755a69ced110509646850676c';
const EXPECTED_SPA_INDEX_SHA = '2d5393baf7ecc3d9db8636d906eb4c8c01506f57cb075a8d5f659903d1ba78de';
const EXPECTED_LAMBDA_SHA = 'gHoAYTlh/WLTAovN7/hfwuvmBNuMjKZaC+zMzBsAOSw=';
const CANDIDATE_ENTRY = '/assets/index-BMBDIhiu.js';
const CANDIDATE_INDEX_SHA = 'd9e183e01851a7dd8624da1f7799073129cc0ca4e5934473016e65bcf3baacda';

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

const assumeSpa = async () => {
  try {
    const creds = JSON.parse(execFileSync(AWS, [
      'sts', 'assume-role-with-web-identity',
      '--role-arn', SPA_DEPLOY_ROLE,
      '--role-session-name', 'signature-prod-spa',
      '--web-identity-token', String(await oidcToken()),
      '--duration-seconds', '3600',
      '--output', 'json',
    ], { encoding: 'utf8' })).Credentials;
    applyCreds(creds);
    return { ok: true, method: 'oidc' };
  } catch (oidcError) {
    await assumeCursor('signature-prod-spa-bridge');
    try {
      const creds = JSON.parse(execFileSync(AWS, [
        'sts', 'assume-role',
        '--role-arn', SPA_DEPLOY_ROLE,
        '--role-session-name', 'signature-prod-spa',
        '--duration-seconds', '3600',
        '--output', 'json',
      ], { encoding: 'utf8' })).Credentials;
      applyCreds(creds);
      return { ok: true, method: 'role-chain' };
    } catch (chainError) {
      return {
        ok: false,
        oidc: String(oidcError.stderr || oidcError.message || oidcError).slice(0, 400),
        chain: String(chainError.stderr || chainError.message || chainError).slice(0, 400),
      };
    }
  }
};

const main = async () => {
  const indexHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const entry = (indexHtml.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1];
  const indexSha = sha256File(path.join(DIST, 'index.html'));
  if (entry !== CANDIDATE_ENTRY || indexSha !== CANDIDATE_INDEX_SHA) {
    throw new Error(`candidate pin mismatch ${entry} ${indexSha}`);
  }
  const keys = walk(DIST);
  if (!keys.includes('index.html')) throw new Error('index.html missing');
  const assets = keys.filter((key) => key !== 'index.html').sort();
  const sequence = [...assets, 'index.html'];

  await assumeCursor('signature-prod-spa-preflight');
  const lambdaBefore = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  if (lambdaBefore.CodeSha256 !== EXPECTED_LAMBDA_SHA) {
    console.error(JSON.stringify({ stop: 'lambda_drift', live: lambdaBefore.CodeSha256 }, null, 2));
    process.exit(3);
  }

  const assumed = await assumeSpa();
  if (!assumed.ok) {
    console.error(JSON.stringify({ stop: 'spa_role', assumed }, null, 2));
    process.exit(3);
  }

  const liveTmp = '/tmp/prod-index-prewrite.html';
  execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', BUCKET, '--key', 'index.html', liveTmp], { encoding: 'utf8' });
  const liveHtml = fs.readFileSync(liveTmp, 'utf8');
  const liveSha = sha256File(liveTmp);
  const liveEntry = (liveHtml.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1];
  if (liveSha !== EXPECTED_SPA_INDEX_SHA || liveEntry !== EXPECTED_SPA_ENTRY) {
    console.error(JSON.stringify({ stop: 'spa_drift', liveEntry, liveSha }, null, 2));
    process.exit(3);
  }

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

  const invalidation = awsJson([
    'cloudfront', 'create-invalidation',
    '--distribution-id', DISTRIBUTION,
    '--paths', '/*',
  ]);

  await assumeCursor('signature-prod-spa-after');
  const lambdaAfter = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  const report = {
    ok: uploaded.at(-1) === 'index.html' && lambdaAfter.CodeSha256 === EXPECTED_LAMBDA_SHA,
    deploy_mode: 'per_object_put',
    uploaded: uploaded.length,
    index_last: uploaded.at(-1),
    candidate_entry: entry,
    candidate_index_sha: indexSha,
    invalidation_id: invalidation.Invalidation?.Id || null,
    invalidation_status: invalidation.Invalidation?.Status || null,
    lambda_before: lambdaBefore.CodeSha256,
    lambda_after: lambdaAfter.CodeSha256,
    assume: assumed,
  };
  fs.writeFileSync('/opt/cursor/artifacts/prod-spa-upload.json', JSON.stringify({ ...report, uploaded_keys: uploaded }, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(4);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
