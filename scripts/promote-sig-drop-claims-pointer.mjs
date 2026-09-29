#!/usr/bin/env node
/**
 * Narrow production write: overlay current live Lambda esign.mjs only.
 * Removes unused claims.latest_signature_request_id UPDATEs from
 * runSendSignatureRequest. Baseline is live package SHA s7fEdoI9...
 * Stops if Files SHA or Lambda SHA drifted. Does not GRANT claims UPDATE.
 * Does not write Files, DTP, CCC, C9Qr, stamp Lambdas, or allowlists.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BUCKET = 'checksops-production-frontend-806168576068';
const LAMBDA = 'checksops-production-prep-api';
const EXPECTED_LAMBDA_SHA = 's7fEdoI9HXCQhheLoa6i08Zl4UJ+tyU1HDUk5StoVqs=';
const EXPECTED_FILES_SHA = 'df1b95f4a85d04901d2d707e2feae7f3c77e605744cc5ffe9011d2872a4fb969';
const EXPECTED_ESIGN_SHA = '630b92b2b60c32637c7065b150b9b5757a0a4e67dd41f9e066f39f6577cd05aa';
const FILES_KEY = 'assets/CheckFilesSection-BJZPqPpX.js';
const ESIGN_SRC = path.resolve('aws/functions/api/esign.mjs');
const WORK = '/tmp/sig-drop-claims-pointer';
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
  if (/grant|revoke/i.test(joined)) {
    throw new Error(`forbidden privilege change: ${joined}`);
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
    '--role-session-name', 'sig-drop-claims-files-ro',
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

const zipNames = (zipPath) => String(execFileSync('zipinfo', ['-1', zipPath], { encoding: 'utf8' }))
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const esignInvariants = (src) => {
  const start = src.indexOf('export const runSendSignatureRequest');
  const end = src.indexOf('export const handleSendSignatureRequest');
  const block = src.slice(start, end);
  return {
    optionalUuid: src.includes('optionalUuid(field.id)'),
    create_branch: src.includes('createSignatureRequestRows'),
    token_mint: src.includes('SET access_token = $2, token_hash = $3'),
    no_access_token_null: !src.includes('access_token = NULL'),
    check_files_link: src.includes('UPDATE public.check_files') && src.includes('SET signature_request_id = $1::uuid'),
    sent_delivery: src.includes("delivery_status = 'sent'") && src.includes('email_sent_at = now()'),
    failed_delivery: src.includes("delivery_status = 'failed'") && src.includes('delivery_error = $2'),
    no_claims_pointer_in_send: !block.includes('latest_signature_request_id') && !block.includes('UPDATE public.claims'),
    no_claims_pointer_in_file: !src.includes('latest_signature_request_id'),
  };
};

const assertLiveBaseline = (src, label) => {
  const inv = esignInvariants(src);
  if (!inv.optionalUuid || !inv.create_branch || !inv.token_mint) {
    console.error(JSON.stringify({ stop: 'accepted_esign_fixes_missing', label, inv }, null, 2));
    process.exit(3);
  }
};

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
  assertLiveBaseline(before, 'live-esign-before-overlay');
  const beforeSha = sha256(before);
  if (beforeSha !== EXPECTED_ESIGN_SHA) {
    throw new Error(`live esign.mjs drifted ${beforeSha} != ${EXPECTED_ESIGN_SHA}`);
  }
  if ((before.match(/UPDATE public\.claims SET latest_signature_request_id/g) || []).length !== 2) {
    throw new Error('live esign.mjs does not have the two unused claims pointer updates');
  }
  const nextSrc = fs.readFileSync(ESIGN_SRC, 'utf8');
  const nextInv = esignInvariants(nextSrc);
  assertLiveBaseline(nextSrc, 'workspace-esign');
  if (!nextInv.no_claims_pointer_in_send || !nextInv.no_claims_pointer_in_file) {
    throw new Error('workspace esign.mjs still updates claims.latest_signature_request_id');
  }
  if (!nextInv.check_files_link || !nextInv.sent_delivery || !nextInv.failed_delivery || !nextInv.no_access_token_null) {
    throw new Error('workspace esign.mjs lost an accepted send invariant');
  }
  fs.writeFileSync(target, nextSrc);
  execFileSync('bash', ['-lc', `cd ${JSON.stringify(unpack)} && zip -qr ${JSON.stringify(destZip)} .`]);

  const liveUnpack = path.join(WORK, 'compare-live');
  const nextUnpack = path.join(WORK, 'compare-next');
  fs.rmSync(liveUnpack, { recursive: true, force: true });
  fs.rmSync(nextUnpack, { recursive: true, force: true });
  fs.mkdirSync(liveUnpack, { recursive: true });
  fs.mkdirSync(nextUnpack, { recursive: true });
  execFileSync('unzip', ['-o', '-q', liveZip, '-d', liveUnpack]);
  execFileSync('unzip', ['-o', '-q', destZip, '-d', nextUnpack]);
  let diff = '';
  try {
    execFileSync('diff', ['-rq', liveUnpack, nextUnpack], { encoding: 'utf8' });
  } catch (error) {
    if (error.status !== 1) throw error;
    diff = String(error.stdout || '').trim();
  }
  const onlyEsign = Boolean(diff) && diff.split('\n').every((line) => (
    /esign\.mjs/.test(line) && /^Files /.test(line)
  ));
  if (!onlyEsign) {
    throw new Error(`overlay changed more than esign.mjs: ${diff || '(empty)'}`);
  }
  return {
    esign_path: path.relative(unpack, target),
    esign_before_sha256: beforeSha,
    esign_after_sha256: sha256(nextSrc),
    esign_changed: before !== nextSrc,
    zip_diff: diff,
    only_esign_changed: onlyEsign,
    next: nextInv,
  };
};

const filesInvariants = (source) => ({
  still_bjz: source.includes('function _s({claimId:r,claim:p,checkIntakeItemId:w=null})'),
  class_a_create: source.includes('functions.invoke("send-signature-request",{body:{claim_id:r,check_intake_item_id:w||null'),
  no_generic_request_insert: !source.includes('.from("signature_requests").insert'),
  no_generic_signer_insert: !source.includes('.from("signature_signers").insert'),
  check_scoped: source.includes('check-intake/${w}/files/${Date.now()}-${crypto.randomUUID()}'),
});

const main = async () => {
  fs.mkdirSync(WORK, { recursive: true });
  await assumeCursor('sig-drop-claims-preflight');
  const lambdaBefore = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  if (lambdaBefore.CodeSha256 !== EXPECTED_LAMBDA_SHA) {
    console.error(JSON.stringify({
      stop: 'lambda_drift',
      label: 'before-write',
      expected: EXPECTED_LAMBDA_SHA,
      live: lambdaBefore.CodeSha256,
    }, null, 2));
    process.exit(3);
  }

  const functions = awsJson(['lambda', 'list-functions', '--max-items', '200']);
  const stampFns = (functions.Functions || []).filter((fn) => /stamp|final-pdf|final_pdf/i.test(fn.FunctionName || ''));
  const stampBefore = {};
  for (const fn of stampFns) stampBefore[fn.FunctionName] = fn.CodeSha256;

  await assumeSpa();
  const filesBeforePath = getObject(FILES_KEY, path.join(WORK, 'files-before.js'));
  const filesBefore = fs.readFileSync(filesBeforePath, 'utf8');
  const filesBeforeSha = sha256(filesBefore);
  if (filesBeforeSha !== EXPECTED_FILES_SHA) {
    console.error(JSON.stringify({
      stop: 'files_drift',
      label: 'before-write',
      expected: EXPECTED_FILES_SHA,
      live: filesBeforeSha,
    }, null, 2));
    process.exit(3);
  }

  const report = {
    ok: true,
    applied: false,
    expected_lambda_sha: EXPECTED_LAMBDA_SHA,
    expected_files_sha256: EXPECTED_FILES_SHA,
    expected_esign_sha256: EXPECTED_ESIGN_SHA,
    lambda_before: lambdaBefore.CodeSha256,
    before_files_sha256: filesBeforeSha,
    stamp_before: stampBefore,
    grants_changed: false,
    ...filesInvariants(filesBefore),
  };

  if (!APPLY) {
    const liveFn = await (async () => {
      await assumeCursor('sig-drop-claims-dry-download');
      return awsJson(['lambda', 'get-function', '--function-name', LAMBDA]);
    })();
    if (liveFn.Configuration.CodeSha256 !== EXPECTED_LAMBDA_SHA) {
      console.error(JSON.stringify({ stop: 'lambda_drift', label: 'dry-download', live: liveFn.Configuration.CodeSha256 }, null, 2));
      process.exit(3);
    }
    const liveZip = path.join(WORK, 'lambda-live.zip');
    execFileSync('curl', ['-fsSL', liveFn.Code.Location, '-o', liveZip]);
    const destZip = path.join(WORK, 'lambda-updated.zip');
    report.lambda_overlay = overlayEsign(liveZip, destZip);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  await assumeCursor('sig-drop-claims-toctou');
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

  await assumeCursor('sig-drop-claims-apply');
  const liveFn = awsJson(['lambda', 'get-function', '--function-name', LAMBDA]);
  if (liveFn.Configuration.CodeSha256 !== EXPECTED_LAMBDA_SHA) {
    console.error(JSON.stringify({ stop: 'lambda_drift', label: 'apply-download', live: liveFn.Configuration.CodeSha256 }, null, 2));
    process.exit(3);
  }
  const liveZip = path.join(WORK, 'lambda-live.zip');
  execFileSync('curl', ['-fsSL', liveFn.Code.Location, '-o', liveZip]);
  const destZip = path.join(WORK, 'lambda-updated.zip');
  const overlay = overlayEsign(liveZip, destZip);
  report.lambda_overlay = overlay;
  if (!overlay.esign_changed || !overlay.only_esign_changed || !overlay.next.no_claims_pointer_in_send) {
    console.error(JSON.stringify({ stop: 'overlay_invalid', overlay }, null, 2));
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

  const afterFn = awsJson(['lambda', 'get-function', '--function-name', LAMBDA]);
  const afterZip = path.join(WORK, 'lambda-after.zip');
  execFileSync('curl', ['-fsSL', afterFn.Code.Location, '-o', afterZip]);
  const afterUnpack = path.join(WORK, 'lambda-after');
  fs.rmSync(afterUnpack, { recursive: true, force: true });
  fs.mkdirSync(afterUnpack, { recursive: true });
  execFileSync('unzip', ['-o', '-q', afterZip, '-d', afterUnpack]);
  const afterEsign = [
    path.join(afterUnpack, 'esign.mjs'),
    path.join(afterUnpack, 'functions/api/esign.mjs'),
    path.join(afterUnpack, 'api/esign.mjs'),
  ].find((file) => fs.existsSync(file));
  const afterSrc = fs.readFileSync(afterEsign, 'utf8');
  report.after_esign = {
    path: path.relative(afterUnpack, afterEsign),
    sha256: sha256(afterSrc),
    ...esignInvariants(afterSrc),
  };

  await assumeSpa();
  const afterFilesSha = sha256File(getObject(FILES_KEY, path.join(WORK, 'files-after.js')));
  const afterFiles = fs.readFileSync(path.join(WORK, 'files-after.js'), 'utf8');
  Object.assign(report, filesInvariants(afterFiles));
  report.applied = true;
  report.after_files_sha256 = afterFilesSha;
  report.files_still_pinned = afterFilesSha === EXPECTED_FILES_SHA;
  report.ok = report.files_still_pinned
    && report.class_a_create
    && report.no_generic_request_insert
    && report.no_generic_signer_insert
    && report.check_scoped
    && report.still_bjz
    && report.lambda_changed
    && report.after_esign.optionalUuid
    && report.after_esign.token_mint
    && report.after_esign.create_branch
    && report.after_esign.check_files_link
    && report.after_esign.sent_delivery
    && report.after_esign.failed_delivery
    && report.after_esign.no_access_token_null
    && report.after_esign.no_claims_pointer_in_send
    && report.after_esign.no_claims_pointer_in_file
    && report.lambda_overlay.only_esign_changed
    && report.grants_changed === false;

  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/sig-drop-claims-pointer-promote.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
