#!/usr/bin/env node
/**
 * Narrow production write: overlay aws/functions/api/esign.mjs only.
 * Stops if live Files SHA or API Lambda SHA drifted from the accepted pins.
 * Does not write Files, DTP, CCC, DJN, stamp Lambdas, or write allowlists.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PINNED_CURRENT_LIVE } from './lib/live-sig-baseline.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BUCKET = 'checksops-production-frontend-806168576068';
const LAMBDA = 'checksops-production-prep-api';
const EXPECTED_LAMBDA_SHA = 'ckWsXcgMUWvXvwKhcZ7ZEpbpUZWH3g7Wi5wwbZunQjU=';
const EXPECTED_FILES_SHA = 'b5aa88c2be4359d1c3d78b316f7b791e3783f9793e161ac0d6bce8f5dc783598';
const FILES_KEY = 'assets/CheckFilesSection-0Fmhwbep.js';
const ESIGN_SRC = path.resolve('aws/functions/api/esign.mjs');
const WORK = '/tmp/sig-field-uuid-normalize';
const APPLY = process.argv.includes('--apply');
const GRAPH_B_ASSETS = [
  'circle-check-big-DbOxWV8k.js',
  'chevron-left-DsjQvYNH.js',
  'chevron-right-CTYLC974.js',
  'index-C5ku3IDF.js',
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

const awsJson = (args, { allowLambdaUpdate = false } = {}) => {
  const joined = args.join(' ');
  if (/create-function|publish-version/i.test(joined)) {
    throw new Error(`forbidden Lambda mutation: ${joined}`);
  }
  if (/update-function-code/i.test(joined)) {
    if (!allowLambdaUpdate || !joined.includes(LAMBDA)) {
      throw new Error(`forbidden Lambda mutation: ${joined}`);
    }
  }
  if (joined.includes('--delete') || joined.includes('s3 sync') || joined.includes('put-object') || joined.includes('create-invalidation')) {
    throw new Error(`forbidden frontend/destructive write: ${joined}`);
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
    '--role-arn', 'arn:aws:iam::806168576068:role/ChecksOpsProductionSpaDeploy',
    '--role-session-name', 'sig-field-uuid-ro',
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
  if (filesSha !== EXPECTED_FILES_SHA) {
    console.error(JSON.stringify({
      stop: 'files_drift',
      label,
      expected: EXPECTED_FILES_SHA,
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

const zipNames = (zipPath) => String(execFileSync('zipinfo', ['-1', zipPath], { encoding: 'utf8' }))
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const overlayEsign = (liveZip, destZip) => {
  const unpack = path.join(WORK, 'lambda-live');
  fs.rmSync(unpack, { recursive: true, force: true });
  fs.mkdirSync(unpack, { recursive: true });
  execFileSync('unzip', ['-o', '-q', liveZip, '-d', unpack]);
  const candidates = [
    path.join(unpack, 'esign.mjs'),
    path.join(unpack, 'functions/api/esign.mjs'),
    path.join(unpack, 'api/esign.mjs'),
  ];
  const target = candidates.find((file) => fs.existsSync(file));
  if (!target) {
    throw new Error(`live Lambda zip has no esign.mjs; names=${zipNames(liveZip).filter((n) => /esign/.test(n)).join(',')}`);
  }
  const before = fs.readFileSync(target, 'utf8');
  if (before.includes('createSignatureRequestRows') === false) {
    throw new Error('live esign.mjs lost createSignatureRequestRows; refusing overlay');
  }
  if (before.includes('field.id || null') === false && before.includes('optionalUuid(field.id)') === false) {
    throw new Error('live field insert site not found; refusing overlay');
  }
  const beforeSha = sha256File(target);
  const nextSrc = fs.readFileSync(ESIGN_SRC, 'utf8');
  if (nextSrc.includes('.catch(() => {})') && nextSrc.slice(nextSrc.indexOf('const fieldData = request.field_data'), nextSrc.indexOf('if (skipEmail)')).includes('.catch(() => {})')) {
    throw new Error('source still swallows signature_fields INSERT');
  }
  if (!nextSrc.includes('optionalUuid(field.id)')) {
    throw new Error('source missing optionalUuid(field.id) normalize');
  }
  fs.writeFileSync(target, nextSrc);
  const afterSha = sha256(nextSrc);
  execFileSync('bash', ['-lc', `cd ${JSON.stringify(unpack)} && zip -qr ${JSON.stringify(destZip)} .`]);
  return {
    esign_path: path.relative(unpack, target),
    esign_before_sha256: beforeSha,
    esign_after_sha256: afterSha,
    esign_changed: beforeSha !== afterSha,
  };
};

const filesInvariants = (source) => ({
  no_graph_b_icons: GRAPH_B_ASSETS.every((name) => !source.includes(name)),
  has_ss_fn: source.includes('function Ss({claimId:r,claim:p,checkIntakeItemId:j=null})'),
  class_a_create: source.includes('functions.invoke("send-signature-request",{body:{claim_id:r,check_intake_item_id:j||null'),
  no_generic_request_insert: !source.includes('.from("signature_requests").insert'),
  no_generic_signer_insert: !source.includes('.from("signature_signers").insert'),
  check_scoped_k: source.includes('const K=`check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${s.fileName}`,H=new Blob([S],{type:P}),{error:U}='),
  check_scoped_c: source.includes('const c=`check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${a}`,{error:S}='),
  files_tab: source.includes('check-intake/${l}/files/${Date.now()}-${crypto.randomUUID()}-${i}'),
  no_signatures: !source.includes('signatures/${'),
  has_ze_wrapper: source.includes('const Ze=({open:o,onOpenChange:n'),
  send_button: source.includes('Send for Signature'),
});

const main = async () => {
  fs.mkdirSync(WORK, { recursive: true });
  await assumeCursor('sig-field-uuid-preflight');
  const lambdaBefore = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  const functions = awsJson(['lambda', 'list-functions', '--max-items', '200']);
  const stampFns = (functions.Functions || []).filter((fn) => /stamp|final-pdf|final_pdf/i.test(fn.FunctionName || ''));
  const stampBefore = {};
  for (const fn of stampFns) {
    stampBefore[fn.FunctionName] = fn.CodeSha256;
  }

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

  const report = {
    ok: true,
    applied: false,
    expected_files_sha256: EXPECTED_FILES_SHA,
    expected_lambda_sha: EXPECTED_LAMBDA_SHA,
    before_files_sha256: filesBeforeSha,
    files_unchanged: filesBeforeSha === EXPECTED_FILES_SHA,
    lambda_before: lambdaBefore.CodeSha256,
    stamp_before: stampBefore,
    ...filesInvariants(filesBefore),
  };

  if (!APPLY) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  await assumeCursor('sig-field-uuid-lambda');
  const lambdaAgain = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  if (lambdaAgain.CodeSha256 !== EXPECTED_LAMBDA_SHA) {
    console.error(JSON.stringify({ stop: 'lambda_drift', label: 'toctou-lambda', live: lambdaAgain.CodeSha256 }, null, 2));
    process.exit(3);
  }
  await assumeSpa();
  const filesAgainSha = sha256File(getObject(FILES_KEY, path.join(WORK, 'files-toctou.js')));
  if (filesAgainSha !== EXPECTED_FILES_SHA) {
    console.error(JSON.stringify({ stop: 'files_drift', label: 'toctou-files', live: filesAgainSha }, null, 2));
    process.exit(3);
  }

  await assumeCursor('sig-field-uuid-lambda-apply');
  const liveFn = awsJson(['lambda', 'get-function', '--function-name', LAMBDA]);
  const liveZip = path.join(WORK, 'lambda-live.zip');
  execFileSync('curl', ['-fsSL', liveFn.Code.Location, '-o', liveZip]);
  const destZip = path.join(WORK, 'lambda-updated.zip');
  const overlay = overlayEsign(liveZip, destZip);
  report.lambda_overlay = overlay;
  if (!overlay.esign_changed) {
    console.error(JSON.stringify({ stop: 'esign_unchanged_in_live_zip', overlay }, null, 2));
    process.exit(3);
  }
  const updated = awsJson([
    'lambda', 'update-function-code',
    '--function-name', LAMBDA,
    '--zip-file', `fileb://${destZip}`,
  ], { allowLambdaUpdate: true });
  try {
    execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', LAMBDA], { encoding: 'utf8' });
  } catch { /* describe below */ }
  const lambdaAfter = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  report.lambda_update = { CodeSha256: updated.CodeSha256 || lambdaAfter.CodeSha256 };
  report.lambda_after = lambdaAfter.CodeSha256;
  report.lambda_changed = lambdaAfter.CodeSha256 !== EXPECTED_LAMBDA_SHA;

  const stampAfter = {};
  for (const name of Object.keys(stampBefore)) {
    const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', name]);
    stampAfter[name] = cfg.CodeSha256;
    if (cfg.CodeSha256 !== stampBefore[name]) {
      console.error(JSON.stringify({ stop: 'stamp_lambda_changed', name, before: stampBefore[name], after: cfg.CodeSha256 }, null, 2));
      process.exit(3);
    }
  }
  report.stamp_after = stampAfter;

  await assumeSpa();
  const afterFilesSha = sha256File(getObject(FILES_KEY, path.join(WORK, 'files-after.js')));
  const afterHtml = sha256File(getObject('index.html', path.join(WORK, 'index-after.html')));
  const afterEntry = sha256File(getObject('assets/index-DJNHggvS.js', path.join(WORK, 'index-after.js')));
  const afterCcc = sha256File(getObject('assets/CheckCommandCenter-M7p55m49.js', path.join(WORK, 'ccc-after.js')));
  const afterDtp = sha256File(getObject('assets/SharedCheckPaymentDirection-CxW2noA2.js', path.join(WORK, 'dtp-after.js')));
  const afterFiles = fs.readFileSync(path.join(WORK, 'files-after.js'), 'utf8');
  Object.assign(report, filesInvariants(afterFiles));
  report.applied = true;
  report.after_files_sha256 = afterFilesSha;
  report.files_still_pinned = afterFilesSha === EXPECTED_FILES_SHA;
  report.untouched = {
    index_html: afterHtml === PINNED_CURRENT_LIVE.index_html_sha256,
    djnh: afterEntry === PINNED_CURRENT_LIVE.djnh_sha256,
    ccc: afterCcc === PINNED_CURRENT_LIVE.ccc_sha256,
    dtp: afterDtp === PINNED_CURRENT_LIVE.dtp_sha256,
  };
  report.ok = report.files_still_pinned
    && report.class_a_create
    && report.no_generic_request_insert
    && report.no_generic_signer_insert
    && report.check_scoped_k
    && report.check_scoped_c
    && report.files_tab
    && report.no_signatures
    && report.has_ze_wrapper
    && report.has_ss_fn
    && report.send_button
    && report.lambda_changed
    && report.untouched.index_html
    && report.untouched.djnh
    && report.untouched.ccc
    && report.untouched.dtp;

  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/sig-field-uuid-normalize-promote.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
