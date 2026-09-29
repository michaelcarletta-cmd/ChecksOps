#!/usr/bin/env node
/**
 * Narrow production write: same-URL CheckFilesSection-0Fmhwbep.js only.
 * Two-character repair: ,if(!j) → ;if(!j) at both Signature upload sites.
 * Stops if live Files SHA is not the accepted broken overlay.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PINNED_CURRENT_LIVE } from './lib/live-sig-baseline.mjs';
import {
  COMMA_IF,
  SEMICOLON_IF,
  repairLiveFilesCommaIf,
} from './lib/sig-upload-check-prefix-patch.mjs';

const require = createRequire(import.meta.url);
const acorn = require('acorn');

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BUCKET = 'checksops-production-frontend-806168576068';
const DISTRIBUTION = 'E1B0ZWWO5559U5';
const LAMBDA = 'checksops-production-prep-api';
const SPA_DEPLOY_ROLE = 'arn:aws:iam::806168576068:role/ChecksOpsProductionSpaDeploy';
const EXPECTED_LAMBDA_SHA = 'nJup1+WVcsX99QzhmLvEpG+CRurINFAXLn+3osQBeQc=';
const EXPECTED_BROKEN_FILES_SHA = '982c3768d68c13adcc7676415699dceb9de27d25da77ecd17ef8f9db2964ff9a';
const FILES_KEY = 'assets/CheckFilesSection-0Fmhwbep.js';
const WORK = '/tmp/sig-upload-semicolon-fix';
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

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha256File = (filePath) => sha256(fs.readFileSync(filePath));

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
    '--role-session-name', 'sig-upload-semicolon-fix',
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

const stopOnDrift = (filesSha, lambdaSha, unrelated, label) => {
  if (filesSha !== EXPECTED_BROKEN_FILES_SHA) {
    console.error(JSON.stringify({
      stop: 'files_drift',
      label,
      expected: EXPECTED_BROKEN_FILES_SHA,
      live: filesSha,
    }, null, 2));
    process.exit(3);
  }
  if (lambdaSha !== EXPECTED_LAMBDA_SHA) {
    console.error(JSON.stringify({
      stop: 'lambda_drift',
      label,
      expected: EXPECTED_LAMBDA_SHA,
      live: lambdaSha,
    }, null, 2));
    process.exit(3);
  }
  const drifted = Object.entries(unrelated).filter(([, ok]) => !ok).map(([key]) => key);
  if (drifted.length) {
    console.error(JSON.stringify({ stop: 'host_drift', label, drifted }, null, 2));
    process.exit(3);
  }
};

const parseOk = (source) => {
  acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
};

const main = async () => {
  fs.mkdirSync(WORK, { recursive: true });
  await assumeCursor('sig-semicolon-preflight');
  const lambdaBefore = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  await assumeSpa();

  const filesBeforePath = getObject(FILES_KEY, path.join(WORK, 'files-before.js'));
  const htmlBefore = sha256File(getObject('index.html', path.join(WORK, 'index.html')));
  const entryBefore = sha256File(getObject('assets/index-DJNHggvS.js', path.join(WORK, 'index-DJNHggvS.js')));
  const cccBefore = sha256File(getObject('assets/CheckCommandCenter-M7p55m49.js', path.join(WORK, 'ccc.js')));
  const dtpBefore = sha256File(getObject('assets/SharedCheckPaymentDirection-CxW2noA2.js', path.join(WORK, 'dtp.js')));
  const filesBefore = fs.readFileSync(filesBeforePath, 'utf8');
  const filesBeforeSha = sha256(filesBefore);
  const unrelatedBefore = {
    index_html: htmlBefore === PINNED_CURRENT_LIVE.index_html_sha256,
    djnh: entryBefore === PINNED_CURRENT_LIVE.djnh_sha256,
    ccc: cccBefore === PINNED_CURRENT_LIVE.ccc_sha256,
    dtp: dtpBefore === PINNED_CURRENT_LIVE.dtp_sha256,
  };
  stopOnDrift(filesBeforeSha, lambdaBefore.CodeSha256, unrelatedBefore, 'before-write');

  const repaired = repairLiveFilesCommaIf(filesBefore);
  parseOk(repaired);
  const repairedPath = path.join(WORK, 'files-repaired.js');
  fs.writeFileSync(repairedPath, repaired);
  const repairedSha = sha256(repaired);

  const report = {
    ok: true,
    applied: false,
    deploy_mode: 'per_object_put',
    target: FILES_KEY,
    expected_broken_sha256: EXPECTED_BROKEN_FILES_SHA,
    before_files_sha256: filesBeforeSha,
    repaired_files_sha256: repairedSha,
    bytes_changed: 2,
    lambda_before: lambdaBefore.CodeSha256,
    parse_ok_before: false,
    parse_ok_repaired: true,
  };
  try {
    parseOk(filesBefore);
    report.parse_ok_before = true;
  } catch {
    report.parse_ok_before = false;
  }

  if (!APPLY) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const filesAgainPath = getObject(FILES_KEY, path.join(WORK, 'files-toctou.js'));
  const filesAgainSha = sha256File(filesAgainPath);
  stopOnDrift(filesAgainSha, lambdaBefore.CodeSha256, unrelatedBefore, 'toctou-before-write');

  const put = awsJson([
    's3api', 'put-object',
    '--bucket', BUCKET,
    '--key', FILES_KEY,
    '--body', repairedPath,
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

  await assumeCursor('sig-semicolon-after');
  const lambdaAfter = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  await assumeSpa();
  const afterFilesPath = getObject(FILES_KEY, path.join(WORK, 'files-after.js'));
  const afterHtml = sha256File(getObject('index.html', path.join(WORK, 'index-after.html')));
  const afterEntry = sha256File(getObject('assets/index-DJNHggvS.js', path.join(WORK, 'index-after.js')));
  const afterCcc = sha256File(getObject('assets/CheckCommandCenter-M7p55m49.js', path.join(WORK, 'ccc-after.js')));
  const afterDtp = sha256File(getObject('assets/SharedCheckPaymentDirection-CxW2noA2.js', path.join(WORK, 'dtp-after.js')));
  const afterSig = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', 'assets/SignatureRequests-ipdlcpz2.js']);
  const afterFiles = fs.readFileSync(afterFilesPath, 'utf8');
  const afterSha = sha256(afterFiles);

  let parseAfter = false;
  try {
    parseOk(afterFiles);
    parseAfter = true;
  } catch (error) {
    report.parse_after_error = String(error.message || error);
  }

  const cf = await fetch('https://checksops.com/assets/CheckFilesSection-0Fmhwbep.js', {
    headers: { 'cache-control': 'no-cache' },
  });
  const cfBytes = Buffer.from(await cf.arrayBuffer());

  report.applied = true;
  report.files_version = put.VersionId || null;
  report.after_files_sha256 = afterSha;
  report.after_matches_repaired = afterSha === repairedSha;
  report.lambda_after = lambdaAfter.CodeSha256;
  report.lambda_unchanged = lambdaAfter.CodeSha256 === EXPECTED_LAMBDA_SHA;
  report.invalidation_id = invalidation.Invalidation?.Id || null;
  report.invalidation_error = invalidation.error || null;
  report.parse_ok_after = parseAfter;
  report.semicolon_if_sites = afterFiles.split(SEMICOLON_IF).length - 1;
  report.comma_if_sites = afterFiles.split(COMMA_IF).length - 1;
  report.live_has_check_scoped_sig_upload = afterFiles.includes('check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}');
  report.live_has_signatures_claim_upload = afterFiles.includes('signatures/${r}/');
  report.live_files_tab_upload_unchanged = afterFiles.includes('check-intake/${l}/files/${Date.now()}-${crypto.randomUUID()}-${i}');
  report.cloudfront = {
    status: cf.status,
    sha256: sha256(cfBytes),
    matches_after: sha256(cfBytes) === afterSha,
  };
  report.untouched = {
    index_html: afterHtml === PINNED_CURRENT_LIVE.index_html_sha256,
    djnh: afterEntry === PINNED_CURRENT_LIVE.djnh_sha256,
    ccc: afterCcc === PINNED_CURRENT_LIVE.ccc_sha256,
    dtp: afterDtp === PINNED_CURRENT_LIVE.dtp_sha256,
    leftover_sig_js: Boolean(afterSig.ETag),
  };
  report.ok = report.after_matches_repaired
    && report.parse_ok_after
    && report.semicolon_if_sites === 2
    && report.comma_if_sites === 0
    && report.live_has_check_scoped_sig_upload
    && !report.live_has_signatures_claim_upload
    && report.live_files_tab_upload_unchanged
    && report.lambda_unchanged
    && report.untouched.index_html
    && report.untouched.djnh
    && report.untouched.ccc
    && report.untouched.dtp;

  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/sig-upload-semicolon-fix-promote.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(4);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
