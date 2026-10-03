#!/usr/bin/env node
/**
 * Narrow production repair for the Files-tab Signature overlay.
 * Writes only:
 *   assets/CheckFilesSection-0Fmhwbep.js
 *   assets/index-DJNHggvS.js  (QKetcACR overlay content, canonical URL)
 *   index.html               (points back at DJNHggvS)
 * Does not delete index-QKetcACR.js or other assets.
 * No Lambda/SQL/DTP/CCC rewrite. No wholesale SPA.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  CANONICAL_ENTRY,
  LIVE_DTP,
  OVERLAY_CCC,
  OVERLAY_ENTRY,
  OVERLAY_FILES,
  PINNED_LIVE,
  buildSingleEntryRepair,
  comparePinnedLive,
  parseHtmlEntry,
  sha256,
} from './lib/repair-sig-single-entry.mjs';
import { REFUSE_PROD_DEPLOY } from './lib/live-sig-baseline.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BUCKET = 'checksops-production-frontend-806168576068';
const DISTRIBUTION = 'E1B0ZWWO5559U5';
const LAMBDA = 'checksops-production-prep-api';
const SPA_DEPLOY_ROLE = 'arn:aws:iam::806168576068:role/ChecksOpsProductionSpaDeploy';
const LIVE_DIR = '/tmp/prod-sig-single-entry/live';
const DIST = process.env.CHECKSOPS_SPA_OUTDIR || '/tmp/prod-sig-single-entry/dist';
const FORBIDDEN = [
  'checksops-staging-frontend-c48b',
  'E1CG52WRQZI7X1',
  'index-Ci-gXTsO.js',
  'index-CHCA-uIh.js',
  'index-D6clKLTq.js',
  's3 sync',
  '--delete',
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
  if (FORBIDDEN.some((item) => joined.includes(item))) {
    throw new Error(`forbidden target or destructive deploy: ${joined}`);
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
      '--role-session-name', 'sig-single-entry-fix',
      '--web-identity-token', String(await oidcToken()),
      '--duration-seconds', '3600',
      '--output', 'json',
    ], { encoding: 'utf8' })).Credentials;
    applyCreds(creds);
    return { ok: true, method: 'oidc' };
  } catch (oidcError) {
    await assumeCursor('sig-single-entry-fix-bridge');
    try {
      const creds = JSON.parse(execFileSync(AWS, [
        'sts', 'assume-role',
        '--role-arn', SPA_DEPLOY_ROLE,
        '--role-session-name', 'sig-single-entry-fix',
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

const getObject = (key, dest) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', BUCKET, '--key', key, dest], { encoding: 'utf8' });
  return dest;
};

const readLivePins = () => {
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  const htmlTmp = getObject('index.html', path.join(LIVE_DIR, 'index.html'));
  const html = fs.readFileSync(htmlTmp, 'utf8');
  const htmlHead = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', 'index.html']);
  const qketTmp = getObject(OVERLAY_ENTRY.replace(/^\//, ''), path.join(LIVE_DIR, 'index-QKetcACR.js'));
  const djnhTmp = getObject(CANONICAL_ENTRY.replace(/^\//, ''), path.join(LIVE_DIR, 'index-DJNHggvS.js'));
  const cccTmp = getObject(OVERLAY_CCC.replace(/^\//, ''), path.join(LIVE_DIR, 'CheckCommandCenter-M7p55m49.js'));
  const filesTmp = getObject(OVERLAY_FILES.replace(/^\//, ''), path.join(LIVE_DIR, 'CheckFilesSection-0Fmhwbep.js'));
  const dtpTmp = getObject(LIVE_DTP.replace(/^\//, ''), path.join(LIVE_DIR, 'SharedCheckPaymentDirection-CxW2noA2.js'));
  const cccText = fs.readFileSync(cccTmp, 'utf8');
  return {
    html_entry: parseHtmlEntry(html),
    index_html_sha256: sha256File(htmlTmp),
    qketcacr_sha256: sha256File(qketTmp),
    djnh_sha256: sha256File(djnhTmp),
    ccc_sha256: sha256File(cccTmp),
    files_sha256: sha256File(filesTmp),
    dtp_sha256: sha256File(dtpTmp),
    index_version: htmlHead.VersionId || null,
    html,
    qketcacrJs: fs.readFileSync(qketTmp, 'utf8'),
    filesJs: fs.readFileSync(filesTmp, 'utf8'),
    ccc_has_overlay_files: cccText.includes('CheckFilesSection-0Fmhwbep.js'),
    ccc_has_dtp: cccText.includes('SharedCheckPaymentDirection-CxW2noA2.js'),
    ccc_lost_old_files: !cccText.includes('CheckFilesSection-DC3uOrqc.js'),
  };
};

const stopOnDrift = (live, label) => {
  const errors = comparePinnedLive(live);
  if (!live.ccc_has_overlay_files || !live.ccc_has_dtp || !live.ccc_lost_old_files) {
    errors.push('CheckCommandCenter-M7p55m49.js Files/DTP graph drifted');
  }
  if (errors.length) {
    console.error(JSON.stringify({ stop: 'spa_drift', label, errors, live }, null, 2));
    process.exit(3);
  }
};

const main = async () => {
  throw new Error(REFUSE_PROD_DEPLOY);
  await assumeCursor('sig-single-entry-fix-preflight');
  const lambdaBefore = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);

  const assumed = await assumeSpa();
  if (!assumed.ok) {
    console.error(JSON.stringify({ stop: 'spa_role', assumed }, null, 2));
    process.exit(3);
  }

  const liveBefore = readLivePins();
  stopOnDrift(liveBefore, 'before-build');

  const repair = buildSingleEntryRepair({
    indexHtml: liveBefore.html,
    qketcacrJs: liveBefore.qketcacrJs,
    filesJs: liveBefore.filesJs,
  });

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });
  for (const [rel, body] of Object.entries(repair.writes)) {
    fs.writeFileSync(path.join(DIST, rel), body);
  }

  const liveAgain = readLivePins();
  stopOnDrift(liveAgain, 'toctou-before-write');

  const sequence = [
    'assets/CheckFilesSection-0Fmhwbep.js',
    'assets/index-DJNHggvS.js',
    'index.html',
  ];
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
    '--paths', '/index.html', '/', '/assets/index-DJNHggvS.js', '/assets/CheckFilesSection-0Fmhwbep.js',
  ]);

  await assumeCursor('sig-single-entry-fix-after');
  const lambdaAfter = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  const afterHtmlTmp = getObject('index.html', path.join(LIVE_DIR, 'index-after.html'));
  const afterDjnhTmp = getObject(CANONICAL_ENTRY.replace(/^\//, ''), path.join(LIVE_DIR, 'index-DJNHggvS-after.js'));
  const afterFilesTmp = getObject(OVERLAY_FILES.replace(/^\//, ''), path.join(LIVE_DIR, 'CheckFilesSection-0Fmhwbep-after.js'));
  const afterQket = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', OVERLAY_ENTRY.replace(/^\//, '')]);
  const afterCcc = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', OVERLAY_CCC.replace(/^\//, '')]);
  const afterDtp = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', LIVE_DTP.replace(/^\//, '')]);
  const afterHtml = fs.readFileSync(afterHtmlTmp, 'utf8');
  const afterFiles = fs.readFileSync(afterFilesTmp, 'utf8');

  const report = {
    ok: uploaded.at(-1) === 'index.html'
      && parseHtmlEntry(afterHtml) === CANONICAL_ENTRY
      && sha256File(afterHtmlTmp) === repair.report.index_html_sha256
      && sha256File(afterDjnhTmp) === PINNED_LIVE.qketcacr_sha256
      && sha256File(afterFilesTmp) === repair.report.files_sha256
      && afterFiles.includes('return s??[]}}),{data:checkClaim}=T(')
      && afterFiles.includes('.select("id, claim_id")')
      && !afterFiles.includes('claims:claim_id')
      && lambdaAfter.CodeSha256 === lambdaBefore.CodeSha256
      && afterQket.ETag
      && afterCcc.ETag
      && afterDtp.ETag,
    deploy_mode: 'narrow_single_entry_repair_per_object_put',
    uploaded,
    uploaded_keys: uploaded,
    index_last: uploaded.at(-1),
    qketcacr_not_deleted: true,
    live_before: {
      html_entry: liveBefore.html_entry,
      index_html_sha256: liveBefore.index_html_sha256,
      qketcacr_sha256: liveBefore.qketcacr_sha256,
      djnh_sha256: liveBefore.djnh_sha256,
      ccc_sha256: liveBefore.ccc_sha256,
      files_sha256: liveBefore.files_sha256,
      dtp_sha256: liveBefore.dtp_sha256,
      index_version: liveBefore.index_version,
    },
    live_after: {
      html_entry: parseHtmlEntry(afterHtml),
      index_html_sha256: sha256File(afterHtmlTmp),
      djnh_sha256: sha256File(afterDjnhTmp),
      files_sha256: sha256File(afterFilesTmp),
      index_version: indexVersion,
      qketcacr_still_present: Boolean(afterQket.ETag),
      ccc_untouched: OVERLAY_CCC,
      dtp_untouched: LIVE_DTP,
      dtp_etag: afterDtp.ETag || null,
      ccc_etag: afterCcc.ETag || null,
    },
    candidate: repair.report,
    invalidation_id: invalidation.Invalidation?.Id || null,
    invalidation_status: invalidation.Invalidation?.Status || null,
    lambda_name: LAMBDA,
    lambda_before: lambdaBefore.CodeSha256,
    lambda_after: lambdaAfter.CodeSha256,
    lambda_unchanged: lambdaAfter.CodeSha256 === lambdaBefore.CodeSha256,
    assume: assumed,
  };
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/prod-sig-single-entry-fix-upload.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(4);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
