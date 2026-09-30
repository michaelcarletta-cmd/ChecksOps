#!/usr/bin/env node
/**
 * Narrow production write: overlay current live Lambda documents.mjs only.
 * Replaces staging Retry PDF with completed-request stamp regeneration.
 * Baseline is live package SHA y7pbc5mtPDLq...
 * Stops if Files SHA, Lambda SHA, signature-submit.mjs, or esign.mjs drifted.
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
const EXPECTED_LAMBDA_SHA = 'y7pbc5mtPDLq57ksnZWJSniV9RkEv0E3+3pAiRoOplk=';
const EXPECTED_FILES_SHA = 'df1b95f4a85d04901d2d707e2feae7f3c77e605744cc5ffe9011d2872a4fb969';
const EXPECTED_SUBMIT_SHA = '24845b4cfbce74de6163a7f94174d5c56af2e5828cfbdeca99c791175150f38d';
const EXPECTED_ESIGN_SHA = '7c60b6462f7e0caa21800481a68735a44fc38bde19d74f78c64bc5ca97956b74';
const EXPECTED_DOCUMENTS_SHA = '8722563c75ee2988e37e456e5cd1f354659e95d31ae258972cdbfd9a5f37bf9f';
const FILES_KEY = 'assets/CheckFilesSection-BJZPqPpX.js';
const DOCUMENTS_SRC = path.resolve('aws/functions/api/documents.mjs');
const WORK = '/tmp/sig-retry-pdf';
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
    '--role-session-name', 'sig-retry-pdf-files-ro',
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

const findInUnpack = (root, names) => names
  .map((name) => [
    path.join(root, name),
    path.join(root, 'functions/api', name),
    path.join(root, 'api', name),
  ])
  .flat()
  .find((file) => fs.existsSync(file));

const esignInvariants = (src) => {
  const start = src.indexOf('export const runSendSignatureRequest');
  const end = src.indexOf('export const handleSendSignatureRequest');
  const block = src.slice(start, end);
  return {
    optionalUuid: src.includes('optionalUuid(field.id)'),
    create_branch: src.includes('createSignatureRequestRows'),
    token_mint: src.includes('SET access_token = $2, token_hash = $3'),
    no_access_token_null: !src.includes('access_token = NULL'),
    no_claims_pointer_in_send: !block.includes('latest_signature_request_id') && !block.includes('UPDATE public.claims'),
    no_claims_pointer_in_file: !src.includes('latest_signature_request_id'),
  };
};

const submitInvariants = (src) => ({
  mapping: src.includes('export const buildSubmitSignersWithValues'),
  map_values: src.includes('export const mapSubmittedFieldValues'),
  db_reread: src.includes('deps.signersWithValues || await loadMergedSignerFieldValues'),
  token_hash_rpc: src.includes('aws_public_signature_by_token_hash'),
});

const documentsInvariants = (src) => ({
  reconstruct: src.includes('reconstructRetrySignersWithValues'),
  attach: src.includes('attachCompletedSignatureDocument'),
  final_pdf: src.includes('final_pdf_path'),
  completion_completed: src.includes("completion_status = 'completed'"),
  no_certificate_column: !src.includes('certificate_pdf_path'),
  no_dummy_certificate: !src.includes('Signature certificate (staging retry)'),
  no_swallowed_retry_update: !/certificate_pdf_path[\s\S]{0,80}\.catch\(\(\) => \{\}\)/.test(src),
});

const filesInvariants = (source) => ({
  still_bjz: source.includes('function _s({claimId:r,claim:p,checkIntakeItemId:w=null})'),
  class_a_create: source.includes('functions.invoke("send-signature-request",{body:{claim_id:r,check_intake_item_id:w||null'),
  check_scoped: source.includes('check-intake/${w}/files/${Date.now()}-${crypto.randomUUID()}'),
});

const overlayDocuments = (liveZip, destZip) => {
  const unpack = path.join(WORK, 'lambda-live');
  fs.rmSync(unpack, { recursive: true, force: true });
  fs.mkdirSync(unpack, { recursive: true });
  execFileSync('unzip', ['-o', '-q', liveZip, '-d', unpack]);
  const target = findInUnpack(unpack, ['documents.mjs']);
  if (!target) {
    throw new Error(`live Lambda zip has no documents.mjs; names=${zipNames(liveZip).filter((n) => /documents/.test(n)).join(',')}`);
  }
  const submitTarget = findInUnpack(unpack, ['signature-submit.mjs']);
  const esignTarget = findInUnpack(unpack, ['esign.mjs']);
  const before = fs.readFileSync(target, 'utf8');
  const beforeSha = sha256(before);
  if (beforeSha !== EXPECTED_DOCUMENTS_SHA) {
    throw new Error(`live documents.mjs drifted ${beforeSha} != ${EXPECTED_DOCUMENTS_SHA}`);
  }
  if (sha256File(submitTarget) !== EXPECTED_SUBMIT_SHA) {
    throw new Error('live signature-submit.mjs drifted before overlay');
  }
  if (sha256File(esignTarget) !== EXPECTED_ESIGN_SHA) {
    throw new Error('live esign.mjs drifted before overlay');
  }
  const nextSrc = fs.readFileSync(DOCUMENTS_SRC, 'utf8');
  const nextInv = documentsInvariants(nextSrc);
  if (!nextInv.reconstruct || !nextInv.attach || !nextInv.final_pdf || !nextInv.completion_completed) {
    throw new Error('workspace documents.mjs is missing the retry regeneration fix');
  }
  if (!nextInv.no_certificate_column || !nextInv.no_dummy_certificate) {
    throw new Error('workspace documents.mjs still has staging retry leftovers');
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
  const onlyDocuments = Boolean(diff) && diff.split('\n').every((line) => (
    /documents\.mjs/.test(line) && /^Files /.test(line)
  ));
  if (!onlyDocuments) {
    throw new Error(`overlay changed more than documents.mjs: ${diff || '(empty)'}`);
  }
  if (sha256File(findInUnpack(nextUnpack, ['signature-submit.mjs'])) !== EXPECTED_SUBMIT_SHA) {
    throw new Error('overlay mutated signature-submit.mjs');
  }
  if (sha256File(findInUnpack(nextUnpack, ['esign.mjs'])) !== EXPECTED_ESIGN_SHA) {
    throw new Error('overlay mutated esign.mjs');
  }
  return {
    documents_path: path.relative(unpack, target),
    documents_before_sha256: beforeSha,
    documents_after_sha256: sha256(nextSrc),
    documents_changed: before !== nextSrc,
    zip_diff: diff,
    only_documents_changed: onlyDocuments,
    next: nextInv,
    submit_unchanged: true,
    esign_unchanged: true,
  };
};

const main = async () => {
  fs.mkdirSync(WORK, { recursive: true });
  await assumeCursor('sig-retry-pdf-preflight');
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
  const html = fs.readFileSync(getObject('index.html', path.join(WORK, 'index-before.html')), 'utf8');

  const report = {
    ok: true,
    applied: false,
    expected_lambda_sha: EXPECTED_LAMBDA_SHA,
    expected_files_sha256: EXPECTED_FILES_SHA,
    expected_submit_sha256: EXPECTED_SUBMIT_SHA,
    expected_esign_sha256: EXPECTED_ESIGN_SHA,
    expected_documents_sha256: EXPECTED_DOCUMENTS_SHA,
    lambda_before: lambdaBefore.CodeSha256,
    before_files_sha256: filesBeforeSha,
    html_index_js: (html.match(/index-[A-Za-z0-9]+\.js/) || [])[0] || null,
    ...filesInvariants(filesBefore),
  };

  if (!APPLY) {
    const liveFn = await (async () => {
      await assumeCursor('sig-retry-pdf-dry-download');
      return awsJson(['lambda', 'get-function', '--function-name', LAMBDA]);
    })();
    if (liveFn.Configuration.CodeSha256 !== EXPECTED_LAMBDA_SHA) {
      console.error(JSON.stringify({ stop: 'lambda_drift', label: 'dry-download', live: liveFn.Configuration.CodeSha256 }, null, 2));
      process.exit(3);
    }
    const liveZip = path.join(WORK, 'lambda-live.zip');
    execFileSync('curl', ['-fsSL', liveFn.Code.Location, '-o', liveZip]);
    const destZip = path.join(WORK, 'lambda-updated.zip');
    report.lambda_overlay = overlayDocuments(liveZip, destZip);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  await assumeCursor('sig-retry-pdf-toctou');
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

  await assumeCursor('sig-retry-pdf-apply');
  const liveFn = awsJson(['lambda', 'get-function', '--function-name', LAMBDA]);
  if (liveFn.Configuration.CodeSha256 !== EXPECTED_LAMBDA_SHA) {
    console.error(JSON.stringify({ stop: 'lambda_drift', label: 'apply-download', live: liveFn.Configuration.CodeSha256 }, null, 2));
    process.exit(3);
  }
  const liveZip = path.join(WORK, 'lambda-live.zip');
  execFileSync('curl', ['-fsSL', liveFn.Code.Location, '-o', liveZip]);
  const destZip = path.join(WORK, 'lambda-updated.zip');
  const overlay = overlayDocuments(liveZip, destZip);
  report.lambda_overlay = overlay;
  if (!overlay.documents_changed || !overlay.only_documents_changed) {
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
  report.lambda_after = lambdaAfter.CodeSha256;
  report.lambda_changed = lambdaAfter.CodeSha256 !== EXPECTED_LAMBDA_SHA;
  report.lambda_update = { CodeSha256: updated.CodeSha256 || lambdaAfter.CodeSha256 };

  const afterFn = awsJson(['lambda', 'get-function', '--function-name', LAMBDA]);
  const afterZip = path.join(WORK, 'lambda-after.zip');
  execFileSync('curl', ['-fsSL', afterFn.Code.Location, '-o', afterZip]);
  const afterUnpack = path.join(WORK, 'lambda-after');
  fs.rmSync(afterUnpack, { recursive: true, force: true });
  fs.mkdirSync(afterUnpack, { recursive: true });
  execFileSync('unzip', ['-o', '-q', afterZip, '-d', afterUnpack]);
  const afterDocuments = findInUnpack(afterUnpack, ['documents.mjs']);
  const afterSubmit = findInUnpack(afterUnpack, ['signature-submit.mjs']);
  const afterEsign = findInUnpack(afterUnpack, ['esign.mjs']);
  const afterSrc = fs.readFileSync(afterDocuments, 'utf8');
  const afterSubmitSrc = fs.readFileSync(afterSubmit, 'utf8');
  const afterEsignSrc = fs.readFileSync(afterEsign, 'utf8');
  report.after_documents = {
    path: path.relative(afterUnpack, afterDocuments),
    sha256: sha256(afterSrc),
    ...documentsInvariants(afterSrc),
  };
  report.after_submit = {
    sha256: sha256(afterSubmitSrc),
    unchanged: sha256(afterSubmitSrc) === EXPECTED_SUBMIT_SHA,
    ...submitInvariants(afterSubmitSrc),
  };
  report.after_esign = {
    sha256: sha256(afterEsignSrc),
    unchanged: sha256(afterEsignSrc) === EXPECTED_ESIGN_SHA,
    ...esignInvariants(afterEsignSrc),
  };

  await assumeSpa();
  const afterFilesSha = sha256File(getObject(FILES_KEY, path.join(WORK, 'files-after.js')));
  const afterFiles = fs.readFileSync(path.join(WORK, 'files-after.js'), 'utf8');
  Object.assign(report, filesInvariants(afterFiles));
  report.applied = true;
  report.after_files_sha256 = afterFilesSha;
  report.files_still_pinned = afterFilesSha === EXPECTED_FILES_SHA;
  report.ok = report.files_still_pinned
    && report.still_bjz
    && report.class_a_create
    && report.check_scoped
    && report.lambda_changed
    && report.after_submit.unchanged
    && report.after_submit.mapping
    && report.after_esign.unchanged
    && report.after_esign.optionalUuid
    && report.after_esign.create_branch
    && report.after_esign.token_mint
    && report.after_esign.no_access_token_null
    && report.after_esign.no_claims_pointer_in_send
    && report.after_documents.reconstruct
    && report.after_documents.no_certificate_column
    && report.after_documents.no_dummy_certificate
    && report.lambda_overlay.only_documents_changed;

  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/sig-retry-pdf-promote.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
