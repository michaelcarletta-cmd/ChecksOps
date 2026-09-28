#!/usr/bin/env node
/**
 * Production SPA-only promotion of the accepted signature check-file selector.
 * Overlay candidate only. per_object_put, index.html last, CloudFront invalidate.
 * No Lambda/SQL/RLS writes. TOCTOU against the current accepted production pins.
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
const DIST = process.env.CHECKSOPS_SPA_OUTDIR || '/tmp/prod-spa-selector-dist';
const LIVE_ENTRY = '/assets/index-BMBDIhiu.js';
const LIVE_ENTRY_SHA = '6308df1089d59ef1bb0a6a1a2c58b2772a01b18f0d0279160d20b9b23730ac45';
const LIVE_INDEX_SHA = 'd9e183e01851a7dd8624da1f7799073129cc0ca4e5934473016e65bcf3baacda';
const EXPECTED_LAMBDA_SHA = 'gHoAYTlh/WLTAovN7/hfwuvmBNuMjKZaC+zMzBsAOSw=';
const CANDIDATE_ENTRY = '/assets/index-DRoG4LeT.js';
const CANDIDATE_ENTRY_SHA = '97998b6014bdbd1ddc387bf18c68cd6347ca5fea0bdf85321f59a2a0d11e64aa';
const CANDIDATE_INDEX_SHA = 'a21d4bfb3481978e1328c0d39ebf2a387901faa21810bd978be65e77900135d1';
const FORBIDDEN = [
  'checksops-staging-frontend-c48b',
  'E1CG52WRQZI7X1',
  'index-gNnhTSog.js',
];

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
  if (FORBIDDEN.some((item) => joined.includes(item))) {
    throw new Error(`forbidden staging/wholesale target: ${joined}`);
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
      '--role-session-name', 'sig-check-file-prod-spa',
      '--web-identity-token', String(await oidcToken()),
      '--duration-seconds', '3600',
      '--output', 'json',
    ], { encoding: 'utf8' })).Credentials;
    applyCreds(creds);
    return { ok: true, method: 'oidc' };
  } catch (oidcError) {
    await assumeCursor('sig-check-file-prod-spa-bridge');
    try {
      const creds = JSON.parse(execFileSync(AWS, [
        'sts', 'assume-role',
        '--role-arn', SPA_DEPLOY_ROLE,
        '--role-session-name', 'sig-check-file-prod-spa',
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
  const entrySha = sha256File(path.join(DIST, entry.replace(/^\//, '')));
  const chunk = fs.readFileSync(path.join(DIST, 'assets/CheckFilesSection-DUBE66-X.js'), 'utf8');
  if (entry !== CANDIDATE_ENTRY || indexSha !== CANDIDATE_INDEX_SHA || entrySha !== CANDIDATE_ENTRY_SHA) {
    throw new Error(`candidate pin mismatch ${entry} ${entrySha} ${indexSha}`);
  }
  if (!chunk.includes('Select a file from claim/check files') || !chunk.includes('signature-source-files')) {
    throw new Error('candidate missing accepted selector copy');
  }
  if (chunk.includes('file_name.ilike') || indexHtml.includes('gNnhTSog')) {
    throw new Error('candidate looks like staging wholesale SPA');
  }

  const keys = walk(DIST);
  if (!keys.includes('index.html')) throw new Error('index.html missing');
  const assets = keys.filter((key) => key !== 'index.html').sort();
  const sequence = [...assets, 'index.html'];

  await assumeCursor('sig-check-file-prod-preflight');
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

  const liveTmp = '/tmp/prod-selector-index-prewrite.html';
  execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', BUCKET, '--key', 'index.html', liveTmp], { encoding: 'utf8' });
  const liveHtml = fs.readFileSync(liveTmp, 'utf8');
  const liveSha = sha256File(liveTmp);
  const liveEntry = (liveHtml.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1];
  const liveHead = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', 'index.html']);
  const liveJsTmp = '/tmp/prod-selector-entry-prewrite.js';
  execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', BUCKET, '--key', LIVE_ENTRY.replace(/^\//, ''), liveJsTmp], { encoding: 'utf8' });
  const liveEntrySha = sha256File(liveJsTmp);
  if (liveSha !== LIVE_INDEX_SHA || liveEntry !== LIVE_ENTRY || liveEntrySha !== LIVE_ENTRY_SHA) {
    console.error(JSON.stringify({
      stop: 'spa_drift',
      liveEntry,
      liveSha,
      liveEntrySha,
      expectedEntry: LIVE_ENTRY,
      expectedIndexSha: LIVE_INDEX_SHA,
      expectedEntrySha: LIVE_ENTRY_SHA,
    }, null, 2));
    process.exit(3);
  }

  const uploaded = [];
  let indexVersion = null;
  for (const key of sequence) {
    const put = awsJson([
      's3api', 'put-object',
      '--bucket', BUCKET,
      '--key', key,
      '--body', path.join(DIST, key),
      '--content-type', contentTypeFor(key),
      '--cache-control', cacheControlFor(key),
    ]);
    uploaded.push(key);
    if (key === 'index.html') indexVersion = put.VersionId || null;
  }
  if (uploaded.at(-1) !== 'index.html') throw new Error('index.html was not last');

  const invalidation = awsJson([
    'cloudfront', 'create-invalidation',
    '--distribution-id', DISTRIBUTION,
    '--paths', '/*',
  ]);

  await assumeCursor('sig-check-file-prod-after');
  const lambdaAfter = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  const afterTmp = '/tmp/prod-selector-index-after.html';
  execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', BUCKET, '--key', 'index.html', afterTmp], { encoding: 'utf8' });
  const afterSha = sha256File(afterTmp);
  const afterHtml = fs.readFileSync(afterTmp, 'utf8');
  const afterEntry = (afterHtml.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1];
  const afterHead = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', 'index.html']);

  const report = {
    ok: uploaded.at(-1) === 'index.html'
      && afterEntry === CANDIDATE_ENTRY
      && afterSha === CANDIDATE_INDEX_SHA
      && lambdaAfter.CodeSha256 === EXPECTED_LAMBDA_SHA
      && lambdaBefore.CodeSha256 === EXPECTED_LAMBDA_SHA,
    deploy_mode: 'per_object_put',
    uploaded: uploaded.length,
    index_last: uploaded.at(-1),
    candidate_entry: entry,
    candidate_entry_sha: entrySha,
    candidate_index_sha: indexSha,
    index_version_id: indexVersion || afterHead.VersionId || null,
    live_before_entry: liveEntry,
    live_before_index_sha: liveSha,
    live_before_entry_sha: liveEntrySha,
    live_before_version: liveHead.VersionId || null,
    live_after_entry: afterEntry,
    live_after_index_sha: afterSha,
    invalidation_id: invalidation.Invalidation?.Id || null,
    invalidation_status: invalidation.Invalidation?.Status || null,
    lambda_before: lambdaBefore.CodeSha256,
    lambda_after: lambdaAfter.CodeSha256,
    assume: assumed,
  };
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/prod-selector-spa-upload.json', JSON.stringify({
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
