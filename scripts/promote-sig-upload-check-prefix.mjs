#!/usr/bin/env node
/**
 * Narrow production write: same-URL CheckFilesSection-0Fmhwbep.js only.
 * Retargets inlined Signature upload paths to check-intake/{checkId}/files/.
 * Does not write index.html, DJN, CCC, DTP, CSS, leftover SignatureRequests JS, or Lambda.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  CANONICAL_ENTRY,
  LIVE_CCC,
  LIVE_DTP,
  LIVE_FILES,
  PINNED_CURRENT_LIVE,
  assertCurrentLiveGraph,
} from './lib/live-sig-baseline.mjs';
import { patchLiveFilesSignatureUploads } from './lib/sig-upload-check-prefix-patch.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BUCKET = 'checksops-production-frontend-806168576068';
const DISTRIBUTION = 'E1B0ZWWO5559U5';
const LAMBDA = 'checksops-production-prep-api';
const SPA_DEPLOY_ROLE = 'arn:aws:iam::806168576068:role/ChecksOpsProductionSpaDeploy';
const EXPECTED_LAMBDA_SHA = 'nJup1+WVcsX99QzhmLvEpG+CRurINFAXLn+3osQBeQc=';
const FILES_KEY = 'assets/CheckFilesSection-0Fmhwbep.js';
const WORK = '/tmp/sig-upload-check-prefix';
const APPLY = process.argv.includes('--apply');

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
  if (joined.includes('--delete') || joined.includes('s3 sync')) {
    throw new Error(`forbidden destructive deploy: ${joined}`);
  }
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const sha256File = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

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
  const creds = JSON.parse(execFileSync(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', SPA_DEPLOY_ROLE,
    '--role-session-name', 'sig-upload-check-prefix',
    '--web-identity-token', String(await oidcToken()),
    '--duration-seconds', '3600',
    '--output', 'json',
  ], { encoding: 'utf8' })).Credentials;
  applyCreds(creds);
};

const getObject = (key, dest) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', BUCKET, '--key', key, dest], {
    encoding: 'utf8',
  });
  return dest;
};

const readLive = () => {
  fs.mkdirSync(WORK, { recursive: true });
  const html = fs.readFileSync(getObject('index.html', path.join(WORK, 'index.html')), 'utf8');
  const entry = fs.readFileSync(getObject('assets/index-DJNHggvS.js', path.join(WORK, 'index-DJNHggvS.js')), 'utf8');
  const ccc = fs.readFileSync(getObject('assets/CheckCommandCenter-M7p55m49.js', path.join(WORK, 'ccc.js')), 'utf8');
  const files = fs.readFileSync(getObject(FILES_KEY, path.join(WORK, 'files.js')), 'utf8');
  const dtp = fs.readFileSync(getObject('assets/SharedCheckPaymentDirection-CxW2noA2.js', path.join(WORK, 'dtp.js')), 'utf8');
  return { html, entry, ccc, files, dtp };
};

const stopOnDrift = (live, lambdaSha, label) => {
  try {
    assertCurrentLiveGraph({
      indexHtml: live.html,
      entryJs: live.entry,
      cccJs: live.ccc,
      filesJs: live.files,
      dtpJs: live.dtp,
    });
  } catch (error) {
    console.error(JSON.stringify({ stop: 'host_drift', label, error: String(error) }, null, 2));
    process.exit(3);
  }
  if (lambdaSha !== EXPECTED_LAMBDA_SHA) {
    console.error(JSON.stringify({ stop: 'lambda_drift', label, expected: EXPECTED_LAMBDA_SHA, live: lambdaSha }, null, 2));
    process.exit(3);
  }
};

const main = async () => {
  await assumeCursor('sig-upload-check-prefix-preflight');
  const lambdaBefore = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  await assumeSpa();
  const liveBefore = readLive();
  stopOnDrift(liveBefore, lambdaBefore.CodeSha256, 'before-write');

  const patched = patchLiveFilesSignatureUploads(liveBefore.files);
  const patchedPath = path.join(WORK, 'files-patched.js');
  fs.writeFileSync(patchedPath, patched);

  const report = {
    ok: true,
    applied: false,
    deploy_mode: 'per_object_put',
    target: FILES_KEY,
    expected_files_sha256: PINNED_CURRENT_LIVE.files_sha256,
    before_files_sha256: createHash('sha256').update(liveBefore.files).digest('hex'),
    patched_files_sha256: sha256File(patchedPath),
    lambda_before: lambdaBefore.CodeSha256,
    canonical_entry: CANONICAL_ENTRY,
    live_ccc: LIVE_CCC,
    live_files: LIVE_FILES,
    live_dtp: LIVE_DTP,
  };

  if (!APPLY) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const liveAgain = readLive();
  stopOnDrift(liveAgain, lambdaBefore.CodeSha256, 'toctou-before-write');

  const put = awsJson([
    's3api', 'put-object',
    '--bucket', BUCKET,
    '--key', FILES_KEY,
    '--body', patchedPath,
    '--content-type', 'application/javascript; charset=utf-8',
    '--cache-control', 'public, max-age=31536000, immutable',
  ]);

  let invalidation = {};
  try {
    invalidation = awsJson([
      'cloudfront', 'create-invalidation',
      '--distribution-id', DISTRIBUTION,
      '--paths', '/assets/CheckFilesSection-0Fmhwbep.js',
    ]);
  } catch (error) {
    invalidation = { error: String(error.stderr || error.message || error).slice(0, 400) };
  }

  await assumeCursor('sig-upload-check-prefix-after');
  const lambdaAfter = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  await assumeSpa();
  const afterFilesPath = path.join(WORK, 'files-after.js');
  getObject(FILES_KEY, afterFilesPath);
  const afterHtml = sha256File(getObject('index.html', path.join(WORK, 'index-after.html')));
  const afterEntry = sha256File(getObject('assets/index-DJNHggvS.js', path.join(WORK, 'index-after.js')));
  const afterCcc = sha256File(getObject('assets/CheckCommandCenter-M7p55m49.js', path.join(WORK, 'ccc-after.js')));
  const afterDtp = sha256File(getObject('assets/SharedCheckPaymentDirection-CxW2noA2.js', path.join(WORK, 'dtp-after.js')));
  const afterSig = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', 'assets/SignatureRequests-ipdlcpz2.js']);
  const afterFiles = fs.readFileSync(afterFilesPath, 'utf8');

  report.applied = true;
  report.files_version = put.VersionId || null;
  report.patched_files_sha256 = sha256File(afterFilesPath);
  report.lambda_after = lambdaAfter.CodeSha256;
  report.lambda_unchanged = lambdaAfter.CodeSha256 === EXPECTED_LAMBDA_SHA;
  report.invalidation_id = invalidation.Invalidation?.Id || null;
  report.invalidation_error = invalidation.error || null;
  report.untouched = {
    index_html: afterHtml === PINNED_CURRENT_LIVE.index_html_sha256,
    djnh: afterEntry === PINNED_CURRENT_LIVE.djnh_sha256,
    ccc: afterCcc === PINNED_CURRENT_LIVE.ccc_sha256,
    dtp: afterDtp === PINNED_CURRENT_LIVE.dtp_sha256,
    leftover_sig_js: Boolean(afterSig.ETag),
  };
  report.live_has_check_scoped_sig_upload = afterFiles.includes('check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}');
  report.live_has_signatures_claim_upload = afterFiles.includes('signatures/${r}/');
  report.live_files_tab_upload_unchanged = afterFiles.includes('check-intake/${l}/files/${Date.now()}-${crypto.randomUUID()}-${i}');
  report.ok = report.lambda_unchanged
    && report.untouched.index_html
    && report.untouched.djnh
    && report.untouched.ccc
    && report.untouched.dtp
    && report.live_has_check_scoped_sig_upload
    && !report.live_has_signatures_claim_upload
    && report.live_files_tab_upload_unchanged;

  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/sig-upload-check-prefix-promote.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(4);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
