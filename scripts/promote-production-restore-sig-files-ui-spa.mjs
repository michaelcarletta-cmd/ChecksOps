#!/usr/bin/env node
/**
 * Narrow production overlay of the Files-tab Signature UI onto live index-DJNHggvS.js.
 * Uploads only the rewired entry/CCC/Files + new SignatureRequests assets.
 * Does not wholesale-put a main/staging SPA. No Lambda/SQL writes.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REFUSE_OLDER_SPA, REFUSE_PROD_DEPLOY } from './lib/live-sig-baseline.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BUCKET = 'checksops-production-frontend-806168576068';
const DISTRIBUTION = 'E1B0ZWWO5559U5';
const LAMBDA = 'checksops-production-prep-api';
const SPA_DEPLOY_ROLE = 'arn:aws:iam::806168576068:role/ChecksOpsProductionSpaDeploy';
const LIVE_DIR = '/tmp/prod-sig-overlay/live';
const DIST = process.env.CHECKSOPS_SPA_OUTDIR || '/tmp/prod-sig-overlay/dist';
const LIVE_ENTRY = '/assets/index-DJNHggvS.js';
const LIVE_ENTRY_SHA = 'f7d5696b275fe6d2dbd1227c8e054c67a5ae5f3696708d685d6de9a583c18f94';
const LIVE_INDEX_SHA = 'badfee4ae6331d5b3080f9cad174218f1cd62d0e419ee8fd06f3fc8063f2cc20';
const LIVE_VERSION = 'l7jbBJFMdg6glEyXkcUuUaSJlLiZGkZi';
const LIVE_FILES = '/assets/CheckFilesSection-DC3uOrqc.js';
const LIVE_DTP = '/assets/SharedCheckPaymentDirection-CxW2noA2.js';
const FORBIDDEN = [
  'checksops-staging-frontend-c48b',
  'E1CG52WRQZI7X1',
  'index-Ci-gXTsO.js',
  'index-CHCA-uIh.js',
  'index-D6clKLTq.js',
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
  return 'application/octet-stream';
};

const cacheControlFor = (key) => (
  key === 'index.html'
    ? 'no-cache, no-store, must-revalidate'
    : 'public, max-age=31536000, immutable'
);

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
      '--role-session-name', 'restore-sig-files-ui-prod',
      '--web-identity-token', String(await oidcToken()),
      '--duration-seconds', '3600',
      '--output', 'json',
    ], { encoding: 'utf8' })).Credentials;
    applyCreds(creds);
    return { ok: true, method: 'oidc' };
  } catch (oidcError) {
    await assumeCursor('restore-sig-files-ui-prod-bridge');
    try {
      const creds = JSON.parse(execFileSync(AWS, [
        'sts', 'assume-role',
        '--role-arn', SPA_DEPLOY_ROLE,
        '--role-session-name', 'restore-sig-files-ui-prod',
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

const readLivePins = ({ downloadGraph = false } = {}) => {
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  const htmlTmp = path.join(LIVE_DIR, 'index.html');
  execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', BUCKET, '--key', 'index.html', htmlTmp], { encoding: 'utf8' });
  const html = fs.readFileSync(htmlTmp, 'utf8');
  const entry = (html.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1];
  const head = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', 'index.html']);
  const entryTmp = path.join(LIVE_DIR, path.basename(entry || 'missing.js'));
  if (entry) {
    execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', BUCKET, '--key', entry.replace(/^\//, ''), entryTmp], { encoding: 'utf8' });
  }
  if (downloadGraph && entry === LIVE_ENTRY) {
    const filesTmp = path.join(LIVE_DIR, 'CheckFilesSection-DC3uOrqc.js');
    execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', BUCKET, '--key', LIVE_FILES.replace(/^\//, ''), filesTmp], { encoding: 'utf8' });
    const cccTmp = path.join(LIVE_DIR, 'CheckCommandCenter-B-yV-W5w.js');
    execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', BUCKET, '--key', 'assets/CheckCommandCenter-B-yV-W5w.js', cccTmp], { encoding: 'utf8' });
  }
  return {
    entry,
    html,
    indexSha: sha256File(htmlTmp),
    entrySha: entry && fs.existsSync(entryTmp) ? sha256File(entryTmp) : null,
    version: head.VersionId || null,
  };
};

const assertLiveBaseline = (pins) => {
  if (
    pins.entry !== LIVE_ENTRY
    || pins.indexSha !== LIVE_INDEX_SHA
    || pins.entrySha !== LIVE_ENTRY_SHA
    || pins.version !== LIVE_VERSION
  ) {
    console.error(JSON.stringify({
      stop: 'spa_drift',
      liveEntry: pins.entry,
      liveIndexSha: pins.indexSha,
      liveEntrySha: pins.entrySha,
      liveVersion: pins.version,
      expectedEntry: LIVE_ENTRY,
      expectedIndexSha: LIVE_INDEX_SHA,
      expectedEntrySha: LIVE_ENTRY_SHA,
      expectedVersion: LIVE_VERSION,
    }, null, 2));
    process.exit(3);
  }
};

const main = async () => {
  throw new Error(`${REFUSE_OLDER_SPA} ${REFUSE_PROD_DEPLOY}`);
  await assumeCursor('restore-sig-files-ui-prod-preflight');
  const lambdaBefore = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);

  const assumed = await assumeSpa();
  if (!assumed.ok) {
    console.error(JSON.stringify({ stop: 'spa_role', assumed }, null, 2));
    process.exit(3);
  }

  const liveBefore = readLivePins({ downloadGraph: true });
  assertLiveBaseline(liveBefore);

  const built = spawnSync('node', ['scripts/build-production-restore-sig-files-overlay.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, CHECKSOPS_LIVE_SPA_DIR: LIVE_DIR, CHECKSOPS_SPA_OUTDIR: DIST },
  });
  if (built.status !== 0) {
    console.error(built.stdout);
    console.error(built.stderr);
    throw new Error('overlay build failed');
  }

  const indexHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const entry = (indexHtml.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1];
  const filesChunk = fs.readdirSync(path.join(DIST, 'assets')).find((name) => name.startsWith('CheckFilesSection-') && name.endsWith('.js'));
  const sigChunk = fs.readdirSync(path.join(DIST, 'assets')).find((name) => name.startsWith('SignatureRequests-') && name.endsWith('.js'));
  const cccChunk = fs.readdirSync(path.join(DIST, 'assets')).find((name) => name.startsWith('CheckCommandCenter-') && name.endsWith('.js'));
  if (!entry || !filesChunk || !sigChunk || !cccChunk) throw new Error('overlay dist incomplete');
  if (entry === LIVE_ENTRY) throw new Error('candidate entry was not rewired');
  const filesText = fs.readFileSync(path.join(DIST, 'assets', filesChunk), 'utf8');
  const sigText = fs.readFileSync(path.join(DIST, 'assets', sigChunk), 'utf8');
  const cccText = fs.readFileSync(path.join(DIST, 'assets', cccChunk), 'utf8');
  if (!filesText.includes('sigReq') || !sigText.includes('Send for Signature') || !sigText.includes('Use Existing Claim/Check File')) {
    throw new Error('overlay missing restored Signature UI');
  }
  if (!cccText.includes(LIVE_DTP.replace('/assets/', '')) || cccText.includes('CheckFilesSection-DC3uOrqc.js')) {
    throw new Error('overlay lost DTP or failed to rewire Files');
  }
  if (indexHtml.includes('index-CHCA-uIh') || indexHtml.includes('index-Ci-gXTsO') || sigText.includes('index-CHCA-uIh')) {
    throw new Error('overlay looks like a wholesale candidate');
  }

  const keys = fs.readdirSync(path.join(DIST, 'assets')).map((name) => `assets/${name}`);
  keys.push('index.html');
  if (keys.length > 8) throw new Error(`overlay uploaded too many keys: ${keys.join(',')}`);

  const liveAgain = readLivePins({ downloadGraph: false });
  assertLiveBaseline(liveAgain);

  const uploaded = [];
  let indexVersion = null;
  const sequence = [...keys.filter((key) => key !== 'index.html').sort(), 'index.html'];
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

  await assumeCursor('restore-sig-files-ui-prod-after');
  const lambdaAfter = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  const afterTmp = '/tmp/prod-restore-sig-index-after.html';
  execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', BUCKET, '--key', 'index.html', afterTmp], { encoding: 'utf8' });
  const afterHtml = fs.readFileSync(afterTmp, 'utf8');
  const afterEntry = (afterHtml.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1];
  const afterHead = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', 'index.html']);
  const afterFiles = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', `assets/${filesChunk}`]);
  const afterDtp = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', LIVE_DTP.replace(/^\//, '')]);

  const report = {
    ok: uploaded.at(-1) === 'index.html'
      && afterEntry === entry
      && sha256File(afterTmp) === sha256File(path.join(DIST, 'index.html'))
      && lambdaAfter.CodeSha256 === lambdaBefore.CodeSha256
      && afterDtp.ETag,
    deploy_mode: 'narrow_overlay_per_object_put',
    uploaded: uploaded.length,
    uploaded_keys: uploaded,
    index_last: uploaded.at(-1),
    live_before_entry: liveBefore.entry,
    live_before_index_sha: liveBefore.indexSha,
    live_before_entry_sha: liveBefore.entrySha,
    live_before_version: liveBefore.version,
    candidate_entry: entry,
    candidate_index_sha: sha256File(path.join(DIST, 'index.html')),
    candidate_entry_sha: sha256File(path.join(DIST, entry.replace(/^\//, ''))),
    candidate_files: `/assets/${filesChunk}`,
    candidate_ccc: `/assets/${cccChunk}`,
    candidate_sig: `/assets/${sigChunk}`,
    live_after_entry: afterEntry,
    live_after_index_sha: sha256File(afterTmp),
    index_version_id: indexVersion || afterHead.VersionId || null,
    dtp_untouched: LIVE_DTP,
    dtp_etag: afterDtp.ETag || null,
    files_head: afterFiles.ETag || null,
    invalidation_id: invalidation.Invalidation?.Id || null,
    invalidation_status: invalidation.Invalidation?.Status || null,
    lambda_name: LAMBDA,
    lambda_before: lambdaBefore.CodeSha256,
    lambda_after: lambdaAfter.CodeSha256,
    lambda_unchanged: lambdaAfter.CodeSha256 === lambdaBefore.CodeSha256,
    assume: assumed,
    not_staging_wholesale: true,
    not_main_wholesale: true,
  };
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/prod-restore-sig-files-ui-upload.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(4);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
